'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const db = require('../config/db');
const { v4: uuidv4 } = require('uuid');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CONFIDENCE_THRESHOLD = parseInt(process.env.ENRICHMENT_CONFIDENCE_THRESHOLD || '70', 10);

// ─── Phase 1: Build context string from existing contact data ─────────────────
function buildContactContext(contact) {
  const emailDomain = contact.email ? contact.email.split('@')[1] : null;
  const parts = [
    `Name: ${contact.first_name || ''} ${contact.last_name || ''}`.trim(),
    `Email: ${contact.email || 'unknown'}`,
    emailDomain ? `Email domain: ${emailDomain}` : null,
    contact.company    ? `Company: ${contact.company}` : null,
    contact.job_title  ? `Job title: ${contact.job_title}` : null,
    contact.website    ? `Known website: ${contact.website}` : null,
    contact.industry   ? `Industry: ${contact.industry}` : null,
    contact.city       ? `City: ${contact.city}` : null,
    contact.country    ? `Country: ${contact.country}` : null,
    contact.linkedin_url ? `Known LinkedIn: ${contact.linkedin_url}` : null,
    contact.phone      ? `Phone: ${contact.phone}` : null,
    contact.revenue_range   ? `Known revenue range: ${contact.revenue_range}` : null,
    contact.employee_count  ? `Known employee count: ${contact.employee_count}` : null,
  ].filter(Boolean);

  // Add custom fields if any
  if (contact.custom_fields && typeof contact.custom_fields === 'object') {
    Object.entries(contact.custom_fields).forEach(([k, v]) => {
      if (v) parts.push(`${k}: ${v}`);
    });
  }

  return parts.join('\n');
}

// ─── Phase 2a: Call Claude with web_search ────────────────────────────────────
async function callClaudeWithSearch(prompt, maxTokens = 2500) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{ role: 'user', content: prompt }],
  });

  // Extract the final text block (Claude may emit tool use first, then text)
  const textBlock = response.content.filter(b => b.type === 'text').pop();
  if (!textBlock) throw new Error('No text response from Claude');

  // Strip markdown code fences
  const clean = textBlock.text.replace(/```json\n?|```\n?/g, '').trim();

  // Find the first { or [ and parse from there
  const jsonStart = clean.search(/[{\[]/);
  if (jsonStart === -1) throw new Error(`Claude returned non-JSON: ${clean.slice(0, 300)}`);

  try {
    return JSON.parse(clean.slice(jsonStart));
  } catch {
    // Try to extract JSON between the first { and last }
    const lastBrace = clean.lastIndexOf('}');
    if (lastBrace > jsonStart) {
      return JSON.parse(clean.slice(jsonStart, lastBrace + 1));
    }
    throw new Error(`Claude returned invalid JSON: ${clean.slice(0, 300)}`);
  }
}

// ─── Phase 2b: 3-pass research ───────────────────────────────────────────────
async function runEnrichmentPasses(contact) {
  const ctx = buildContactContext(contact);
  const rawResults = {};

  // ── Pass 1: Company intelligence ──────────────────────────────────────────
  const pass1Prompt = `You are a B2B data enrichment agent. Research this company and extract ONLY verified information from public sources.

Contact context:
${ctx}

STRICT RULES:
1. Only include data found from a real URL you searched.
2. Every field MUST have a source_url — if you cannot provide one, set value to null.
3. Never guess, estimate, or infer.
4. Revenue and funding must come from Crunchbase, a news article, or SEC filing.
5. Employee count must come from LinkedIn, their website, or a credible directory.
6. Confidence: 95-100=official source, 80-94=credible third-party, 70-79=implied by multiple sources. Below 70 → null.
7. ARRAY FIELDS: company_tech_stack, company_investors, signal_hiring_roles must be JSON arrays of strings, NOT comma-separated strings.

Return ONLY valid JSON (no markdown, no explanation, no text before or after):
{
  "company_website": { "value": null, "source_url": null, "confidence": 0 },
  "company_linkedin_url": { "value": null, "source_url": null, "confidence": 0 },
  "company_description": { "value": null, "source_url": null, "confidence": 0 },
  "company_founded_year": { "value": null, "source_url": null, "confidence": 0 },
  "company_employee_range": { "value": null, "source_url": null, "confidence": 0 },
  "company_revenue_range": { "value": null, "source_url": null, "confidence": 0 },
  "company_funding_stage": { "value": null, "source_url": null, "confidence": 0 },
  "company_total_funding": { "value": null, "source_url": null, "confidence": 0 },
  "company_investors": { "value": ["investor1", "investor2"], "source_url": null, "confidence": 0 },
  "company_hq_city": { "value": null, "source_url": null, "confidence": 0 },
  "company_hq_country": { "value": null, "source_url": null, "confidence": 0 },
  "company_tech_stack": { "value": ["tech1", "tech2", "tech3"], "source_url": null, "confidence": 0 },
  "company_recent_news": { "value": [{"title": "...", "url": "https://...", "date": "..."}], "source_url": null, "confidence": 0 },
  "signal_recently_funded": { "value": false, "source_url": null, "confidence": 0 },
  "signal_hiring_roles": { "value": ["role1", "role2"], "source_url": null, "confidence": 0 }
}

IMPORTANT: Replace example values (investor1, tech1, role1, etc.) with null if not found. Array fields must always be JSON arrays, never strings.`;

  try {
    const p1 = await callClaudeWithSearch(pass1Prompt);
    Object.assign(rawResults, p1);
  } catch (e) {
    console.warn('[enrichment] Pass 1 error:', e.message);
  }

  // ── Pass 2: Person intelligence ───────────────────────────────────────────
  const companyWebsite = rawResults.company_website?.value || contact.website || '';
  const pass2Prompt = `You are a B2B data enrichment agent. Research this specific person's professional profile from public sources.

Contact context:
${ctx}
${companyWebsite ? `Company website found: ${companyWebsite}` : ''}

STRICT RULES:
1. Search for this person by name + company + job title.
2. Only include if you find a clear match (same person at same company).
3. For common names (e.g. "Raj Patel"), require strong company context match.
4. LinkedIn: only include if the profile clearly matches this person at this company.
5. Bio: summarize from their actual LinkedIn/About page — do not fabricate.
6. If you cannot verify with ≥70 confidence, set value to null.
7. ARRAY FIELDS: person_skills, person_past_companies, person_languages, person_publications, signal_tech_adoption, signal_pain_keywords must be JSON arrays of strings, NOT comma-separated strings.

Return ONLY valid JSON (no markdown, no explanation, no text before or after):
{
  "person_linkedin_url": { "value": null, "source_url": null, "confidence": 0 },
  "person_twitter_url": { "value": null, "source_url": null, "confidence": 0 },
  "person_bio": { "value": null, "source_url": null, "confidence": 0 },
  "person_location": { "value": null, "source_url": null, "confidence": 0 },
  "person_skills": { "value": ["skill1", "skill2"], "source_url": null, "confidence": 0 },
  "person_past_companies": { "value": ["company1", "company2"], "source_url": null, "confidence": 0 },
  "person_education": { "value": null, "source_url": null, "confidence": 0 },
  "person_publications": { "value": ["pub1"], "source_url": null, "confidence": 0 },
  "signal_job_change": { "value": false, "source_url": null, "confidence": 0 },
  "signal_tech_adoption": { "value": ["tech1", "tech2"], "source_url": null, "confidence": 0 },
  "signal_pain_keywords": { "value": ["keyword1", "keyword2"], "source_url": null, "confidence": 0 }
}

IMPORTANT: Replace example values (skill1, company1, etc.) with null if not found. Array fields must always be JSON arrays, never strings.`;

  try {
    const p2 = await callClaudeWithSearch(pass2Prompt);
    Object.assign(rawResults, p2);
  } catch (e) {
    console.warn('[enrichment] Pass 2 error:', e.message);
  }

  // ── Pass 3: Cross-verify high-value uncertain fields ──────────────────────
  const highValue = ['company_linkedin_url', 'person_linkedin_url', 'company_revenue_range', 'company_total_funding', 'company_employee_range'];
  const toVerify = highValue.filter(f =>
    rawResults[f]?.value !== null &&
    rawResults[f]?.value !== undefined &&
    rawResults[f]?.confidence >= 70 &&
    rawResults[f]?.confidence < 90
  );

  if (toVerify.length > 0) {
    const fieldList = toVerify.map(f => `${f}: ${rawResults[f].value}`).join('\n');
    const pass3Prompt = `Verify these specific data points about ${contact.first_name} ${contact.last_name} at ${contact.company}. Search each one and confirm or deny with a source.

Fields to verify:
${fieldList}

Return ONLY valid JSON:
{
  "field_name": { "verified": true, "source_url": "string", "confidence": 95 }
}`;

    try {
      const p3 = await callClaudeWithSearch(pass3Prompt, 1500);
      for (const [field, result] of Object.entries(p3)) {
        if (!rawResults[field]) continue;
        if (result.verified === false) {
          rawResults[field] = { value: null, source_url: null, confidence: 0 };
        } else if (result.verified === true && result.confidence) {
          rawResults[field].confidence = Math.min(100, result.confidence);
          rawResults[field].verification_url = result.source_url;
        }
      }
    } catch (e) {
      console.warn('[enrichment] Pass 3 error:', e.message);
    }
  }

  return rawResults;
}

// ─── Phase 3: Confidence filter + validation ─────────────────────────────────
function applyConfidenceFilter(rawResults) {
  const accepted = {};
  const fieldConfidence = {};
  const fieldSources = {};
  const discarded = [];

  for (const [field, data] of Object.entries(rawResults)) {
    if (!data || data.value === null || data.value === undefined || data.value === '') {
      discarded.push({ field, reason: 'no_data_found' });
      continue;
    }
    if ((data.confidence || 0) < CONFIDENCE_THRESHOLD) {
      discarded.push({ field, reason: 'low_confidence', score: data.confidence });
      continue;
    }
    if (!data.source_url) {
      discarded.push({ field, reason: 'no_source_url' });
      continue;
    }

    // Per-field validation
    if (field === 'company_linkedin_url' && !String(data.value).includes('linkedin.com')) {
      discarded.push({ field, reason: 'invalid_linkedin_url' }); continue;
    }
    if (field === 'person_linkedin_url' && !String(data.value).includes('linkedin.com/in/')) {
      discarded.push({ field, reason: 'invalid_person_linkedin' }); continue;
    }
    if (field === 'company_founded_year') {
      const yr = parseInt(data.value, 10);
      if (isNaN(yr) || yr < 1800 || yr > new Date().getFullYear()) {
        discarded.push({ field, reason: 'invalid_year' }); continue;
      }
      data.value = yr;
    }
    if (field === 'company_recent_news' && Array.isArray(data.value)) {
      data.value = data.value.filter(n => n && n.url && n.url.startsWith('http') && n.title);
      if (data.value.length === 0) { discarded.push({ field, reason: 'no_valid_news' }); continue; }
    }
    if (field === 'company_g2_rating') {
      const r = parseFloat(data.value);
      if (isNaN(r) || r < 0 || r > 5) { discarded.push({ field, reason: 'invalid_rating' }); continue; }
      data.value = r;
    }

    // Normalize the value to match the expected MySQL type (handles all edge cases)
    data.value = normalizeFieldValue(field, data.value);
    if (data.value === null || data.value === undefined) {
      discarded.push({ field, reason: 'failed_normalization' });
      continue;
    }
    // Empty arrays after normalization
    if (Array.isArray(data.value) && data.value.length === 0) {
      discarded.push({ field, reason: 'empty_array' });
      continue;
    }

    accepted[field] = data.value;
    fieldConfidence[field] = {
      score: data.confidence,
      verified_at: new Date().toISOString(),
      ...(data.verification_url ? { verification_url: data.verification_url } : {}),
    };
    fieldSources[field] = {
      url: data.source_url,
      snippet: data.source_snippet || null,
    };
  }

  return { accepted, fieldConfidence, fieldSources, discarded };
}

// Fields that must be stored as JSON arrays in MySQL
const PG_ARRAY_FIELDS = new Set([
  'company_tech_stack', 'company_investors',
  'person_skills', 'person_past_companies', 'person_languages', 'person_publications',
  'signal_hiring_roles', 'signal_tech_adoption', 'signal_pain_keywords',
]);

// Normalize a single field value to match its expected MySQL type
function normalizeFieldValue(field, value) {
  if (value === null || value === undefined) return null;

  // Array fields: must be a proper JS array
  if (PG_ARRAY_FIELDS.has(field)) {
    if (Array.isArray(value)) {
      return value.map(v => String(v).trim()).filter(Boolean);
    }
    if (typeof value === 'string' && value.trim()) {
      // Split by comma or semicolon
      return value.split(/[,;]/).map(s => s.trim()).filter(Boolean);
    }
    return null; // discard invalid array values
  }

  // JSONB fields
  if (field === 'company_recent_news') {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try { return JSON.parse(value); } catch { return null; }
    }
    return null;
  }

  // Boolean fields
  if (field === 'signal_recently_funded' || field === 'signal_job_change') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.toLowerCase() === 'true';
    return Boolean(value);
  }

  // Integer fields
  if (field === 'company_founded_year' || field === 'company_alexa_rank') {
    const n = parseInt(value, 10);
    return isNaN(n) ? null : n;
  }

  // Numeric fields
  if (field === 'company_g2_rating') {
    const n = parseFloat(value);
    return isNaN(n) ? null : n;
  }

  // Everything else: string
  return typeof value === 'string' ? value.trim() || null : String(value);
}

// ─── Phase 4: Save to DB (upsert, never overwrite existing contact data) ──────
async function saveEnrichment(contactId, orgId, accepted, fieldConfidence, fieldSources, tokensUsed) {
  if (Object.keys(accepted).length === 0) {
    await db.query(
      `UPDATE contact_enrichments SET enrichment_status='partial',
        error_message='No fields met confidence threshold',
        enrichment_completed_at=NOW(), updated_at=NOW()
       WHERE contact_id=?`,
      [contactId]
    );
    return;
  }

  // Build upsert dynamically
  const allFields = Object.keys(accepted);
  const allValues = [contactId, orgId];

  // Final safety normalization — ensure EVERY field is DB-safe before INSERT
  allFields.forEach(f => {
    accepted[f] = normalizeFieldValue(f, accepted[f]);
  });
  // Remove any fields that failed normalization
  const validFields = allFields.filter(f => accepted[f] !== null && accepted[f] !== undefined);
  if (validFields.length === 0) {
    await db.query(
      `UPDATE contact_enrichments SET enrichment_status='partial',
        error_message='All fields failed normalization',
        enrichment_completed_at=NOW(), updated_at=NOW()
       WHERE contact_id=?`,
      [contactId]
    );
    return;
  }

  // For array fields, serialize to JSON string for MySQL JSON columns
  const insertCols  = ['contact_id', 'org_id', ...validFields, 'field_confidence', 'field_sources', 'enrichment_status', 'enrichment_completed_at', 'tokens_used'];
  const insertPlaceholders = insertCols.map(() => '?');
  allValues.push(...validFields.map(f => {
    const v = accepted[f];
    return (PG_ARRAY_FIELDS.has(f) && Array.isArray(v)) ? JSON.stringify(v) : v;
  }));
  allValues.push(JSON.stringify(fieldConfidence));
  allValues.push(JSON.stringify(fieldSources));
  allValues.push('completed');
  allValues.push(new Date());
  allValues.push(tokensUsed || null);

  // ON DUPLICATE KEY UPDATE: update every enriched field + metadata
  const updateClauses = [
    ...validFields.map(f => `${f} = VALUES(${f})`),
    `field_confidence = VALUES(field_confidence)`,
    `field_sources = VALUES(field_sources)`,
    `enrichment_status = 'completed'`,
    `enrichment_completed_at = NOW()`,
    `tokens_used = VALUES(tokens_used)`,
    `updated_at = NOW()`,
  ];

  const insertQuery = `
    INSERT INTO contact_enrichments (${insertCols.join(', ')})
    VALUES (${insertPlaceholders.join(', ')})
    ON DUPLICATE KEY UPDATE
      ${updateClauses.join(',\n      ')}
  `;

  // Try insert; if a specific field fails (e.g. malformed array), strip it and retry
  try {
    await db.query(insertQuery, allValues);
  } catch (insertErr) {
    console.error('[enrichment] saveEnrichment INSERT error:', insertErr.message);

    // Identify the bad field from the error message and remove it, then retry without it
    const badFieldMatch = insertErr.message.match(/column "([^"]+)"/);
    if (badFieldMatch) {
      const badField = badFieldMatch[1];
      console.warn(`[enrichment] Dropping bad field "${badField}" and retrying`);
      delete accepted[badField];
      if (Object.keys(accepted).length > 0) {
        return saveEnrichment(contactId, orgId, accepted, fieldConfidence, fieldSources, tokensUsed);
      }
    }

    // If we can't identify the bad field, save with only safe scalar fields
    const SAFE_SCALAR_FIELDS = [
      'company_website', 'company_linkedin_url', 'company_description', 'company_founded_year',
      'company_employee_range', 'company_revenue_range', 'company_industry', 'company_hq_city',
      'company_hq_country', 'company_funding_stage', 'company_total_funding',
      'person_linkedin_url', 'person_twitter_url',
      'person_bio', 'person_location', 'person_education', 'signal_recently_funded', 'signal_job_change',
    ];
    const safeAccepted = {};
    for (const f of SAFE_SCALAR_FIELDS) {
      if (accepted[f] !== undefined && accepted[f] !== null) safeAccepted[f] = accepted[f];
    }
    if (Object.keys(safeAccepted).length > 0) {
      console.warn('[enrichment] Retrying with scalar fields only after error:', insertErr.message);
      return saveEnrichment(contactId, orgId, safeAccepted, fieldConfidence, fieldSources, tokensUsed);
    }
    throw insertErr;
  }

  // Back-fill matching base contact fields if they are currently empty
  const contact = (await db.query('SELECT * FROM contacts WHERE id=?', [contactId])).rows[0];
  if (!contact) return;

  const contactUpdates = {};
  const backfillMap = {
    company_website:        'website',
    company_industry:       'industry',
    company_employee_range: 'employee_count',
    company_revenue_range:  'revenue_range',
    person_linkedin_url:    'linkedin_url',
    company_hq_city:        'city',
    company_hq_country:     'country',
  };
  for (const [enrichField, contactField] of Object.entries(backfillMap)) {
    if (accepted[enrichField] && !contact[contactField]) {
      contactUpdates[contactField] = accepted[enrichField];
    }
  }

  if (Object.keys(contactUpdates).length > 0) {
    const setCols = Object.keys(contactUpdates).map(k => `${k}=?`).join(', ');
    await db.query(
      `UPDATE contacts SET ${setCols}, updated_at=NOW() WHERE id=?`,
      [...Object.values(contactUpdates), contactId]
    );
  }

  await db.query(
    `UPDATE contacts SET research_done=true, enriched_at=NOW() WHERE id=?`,
    [contactId]
  );
}

// ─── Main export: enrich a single contact ─────────────────────────────────────
async function enrichContact(contactId, orgId, enrichmentJobId) {
  // Ensure enrichment row exists
  await db.query(`
    INSERT INTO contact_enrichments (contact_id, org_id, enrichment_status)
    VALUES (?, ?, 'running')
    ON DUPLICATE KEY UPDATE enrichment_status='running', enrichment_started_at=NOW(), updated_at=NOW()
  `, [contactId, orgId]);

  const contactRow = (await db.query('SELECT * FROM contacts WHERE id=?', [contactId])).rows[0];
  if (!contactRow) throw new Error(`Contact ${contactId} not found`);

  let tokensUsed = 0;
  try {
    const rawResults = await runEnrichmentPasses(contactRow);
    const { accepted, fieldConfidence, fieldSources, discarded } = applyConfidenceFilter(rawResults);

    console.log(`[enrichment] ${contactId}: accepted=${Object.keys(accepted).length}, discarded=${discarded.length}`);

    await saveEnrichment(contactId, orgId, accepted, fieldConfidence, fieldSources, tokensUsed);

    if (enrichmentJobId) {
      await db.query('UPDATE enrichment_jobs SET completed=completed+1 WHERE id=?', [enrichmentJobId]);
    }

    return { accepted: Object.keys(accepted).length, discarded: discarded.length };
  } catch (err) {
    await db.query(`
      UPDATE contact_enrichments SET enrichment_status='failed', error_message=?, enrichment_completed_at=NOW(), updated_at=NOW()
      WHERE contact_id=?
    `, [err.message.slice(0, 500), contactId]);
    if (enrichmentJobId) {
      await db.query('UPDATE enrichment_jobs SET failed=failed+1 WHERE id=?', [enrichmentJobId]);
    }
    throw err;
  }
}

module.exports = { enrichContact, buildContactContext, applyConfidenceFilter };
