'use strict';
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');
const db        = require('../config/db');
const cache     = require('../config/cache');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL     = 'claude-sonnet-4-20250514';

// Safe JSON parse with fallback
function safeJSON(text, fallback = {}) {
  try {
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    return JSON.parse(clean);
  } catch {
    return fallback;
  }
}

async function callClaude(prompt, maxTokens = 800) {
  const res = await anthropic.messages.create({
    model:      MODEL,
    max_tokens: maxTokens,
    messages:   [{ role: 'user', content: prompt }],
  });
  return res.content?.[0]?.text || '';
}

// ---------------------------------------------------------------------------
// Feature 1: AI Lead Scoring
// ---------------------------------------------------------------------------
async function scoreContact(contact, org) {
  const icp = org?.settings?.icp || 'B2B SaaS companies with 50-500 employees, Series A+';
  const prompt = `Score this B2B contact 0-100 for ICP fit.
ICP: ${icp}
Contact JSON: ${JSON.stringify({
    email: contact.email, company: contact.company, job_title: contact.job_title,
    industry: contact.industry, country: contact.country,
    employee_count: contact.employee_count, revenue_range: contact.revenue_range,
    research_summary: contact.research_summary,
  })}
Return ONLY JSON (no markdown): { "score": number, "reason": string, "signals": string[] }`;

  const text   = await callClaude(prompt, 400);
  const parsed = safeJSON(text, { score: 50, reason: 'Unable to parse', signals: [] });
  const score  = Math.max(0, Math.min(100, Number(parsed.score) || 50));

  await db.query(
    `UPDATE contacts SET ai_score=?, ai_score_reason=?, ai_scored_at=NOW() WHERE id=?`,
    [score, parsed.reason || '', contact.id],
  );
  return { score, reason: parsed.reason, signals: parsed.signals || [] };
}

// ---------------------------------------------------------------------------
// Feature 2: AI Business Research
// ---------------------------------------------------------------------------
async function researchContact(contact) {
  const prompt = `Research this company for cold B2B outreach.
Company: ${contact.company || ''}
Website: ${contact.website || ''}
Contact: ${contact.first_name || ''} ${contact.last_name || ''}, ${contact.job_title || ''}
Find: what they sell, their customers, recent news (funding/hiring/launches), tech stack if visible, pain points.
Write 5 specific sentences. End with: best personalisation angle.`;

  const summary = await callClaude(prompt, 500);
  await db.query(
    `UPDATE contacts SET research_summary=?, research_done=TRUE, enriched_at=NOW() WHERE id=?`,
    [summary, contact.id],
  );
  return summary;
}

// ---------------------------------------------------------------------------
// Feature 3: AI Email Personalisation
// ---------------------------------------------------------------------------
async function personalizeEmail(contact, template, campaign) {
  const prompt = `Personalise this email for ${contact.first_name || ''} at ${contact.company || ''}.
Research: ${contact.research_summary || 'Not available'}
Template subject: ${template.subject}
Template body: ${template.body_html}
Rules:
- Fill ALL {{variable}} placeholders with real personalised content
- Reference 1 specific fact from the research in the opening line
- Keep total under 180 words
- Sound human, not AI-generated
- CTA links to: ${campaign.booking_url || process.env.BOOKING_URL || ''}
Return ONLY JSON (no markdown): { "subject": "...", "body_html": "..." }`;

  const text   = await callClaude(prompt, 900);
  const parsed = safeJSON(text, { subject: template.subject, body_html: template.body_html });
  return {
    subject:   parsed.subject   || template.subject,
    body_html: parsed.body_html || template.body_html,
  };
}

// ---------------------------------------------------------------------------
// Feature 4: AI A/B Test Generator
// ---------------------------------------------------------------------------
async function generateABVariants(templateId, objective) {
  const row = await db.query('SELECT * FROM templates WHERE id=?', [templateId]);
  if (!row.rows.length) throw new Error('Template not found');
  const tpl = row.rows[0];

  const prompt = `Create 2 email A/B variants for testing.
Original subject: ${tpl.subject}
Original body: ${tpl.body_html}
Test objective: ${objective || 'improve open rate'}
Variant A: change the subject line only.
Variant B: change the CTA / body only.
Return ONLY JSON (no markdown): {
  "variantA": { "subject": string, "body_html": string, "hypothesis": string },
  "variantB": { "subject": string, "body_html": string, "hypothesis": string }
}`;

  const text   = await callClaude(prompt, 1200);
  const parsed = safeJSON(text, {});
  if (!parsed.variantA || !parsed.variantB) throw new Error('Invalid AI response for A/B variants');

  // Save as child templates
  const saveVariant = async (variant, label) => {
    const newId = uuidv4();
    await db.query(
      `INSERT INTO templates (id, name, subject, body_html, parent_id, variant_label, ai_generated, org_id, created_by)
       VALUES (?,?,?,?,?,?,TRUE,?,?)`,
      [
        newId,
        `${tpl.name} — Variant ${label}`,
        variant.subject,
        variant.body_html,
        templateId,
        label,
        tpl.org_id,
        tpl.created_by,
      ],
    );
    return { id: newId, hypothesis: variant.hypothesis, label };
  };

  const [a, b] = await Promise.all([
    saveVariant(parsed.variantA, 'A'),
    saveVariant(parsed.variantB, 'B'),
  ]);
  return { variantA: a, variantB: b };
}

// ---------------------------------------------------------------------------
// Feature 5: AI Segment Builder (natural language → filter JSON)
// ---------------------------------------------------------------------------
async function buildSegmentFromQuery(naturalLanguageQuery, orgId) {
  // Sample distinct values for context
  const [industries, countries, statuses] = await Promise.all([
    db.query(`SELECT DISTINCT industry FROM contacts WHERE org_id=? AND industry IS NOT NULL LIMIT 20`, [orgId]),
    db.query(`SELECT DISTINCT country  FROM contacts WHERE org_id=? AND country  IS NOT NULL LIMIT 20`, [orgId]),
    db.query(`SELECT DISTINCT status   FROM contacts WHERE org_id=? LIMIT 10`, [orgId]),
  ]);

  const fieldSamples = {
    industry:      industries.rows.map(r => r.industry),
    country:       countries.rows.map(r => r.country),
    status:        statuses.rows.map(r => r.status),
    employee_count: ['1-10','11-50','51-200','201-500','500+'],
    revenue_range:  ['<$1M','$1M-$10M','$10M-$50M','$50M+'],
  };

  const prompt = `Convert this request into a contact filter JSON array.
Request: "${naturalLanguageQuery}"
Available fields: industry, country, status, company, job_title, tags, employee_count, revenue_range, ai_score, created_at, email
Sample values: ${JSON.stringify(fieldSamples)}
Operators: equals | contains | in | not_in | gt | lt | gte | lte | is_empty | contains_any
Return ONLY a JSON array (no markdown):
[{ "field": string, "operator": string, "value": string|string[]|number }]`;

  const text   = await callClaude(prompt, 600);
  const rules  = safeJSON(text, []);
  if (!Array.isArray(rules) || !rules.length) throw new Error('Could not parse segment filters from AI response');

  // Save segment
  const newId = uuidv4();
  await db.query(
    `INSERT INTO segments (id, name, filters, ai_generated, ai_rationale, org_id, is_dynamic, contact_count)
     VALUES (?,?,TRUE,?,?,TRUE,0)`,
    [
      newId,
      `AI: ${naturalLanguageQuery.slice(0, 60)}`,
      JSON.stringify({ rules, logic: 'AND' }),
      naturalLanguageQuery,
      orgId,
    ],
  );
  return { segmentId: newId, rules };
}

// ---------------------------------------------------------------------------
// Feature 6: AI Campaign Performance Analyzer
// ---------------------------------------------------------------------------
async function analyzeCampaignPerformance(campaignId, orgId) {
  const cKey = cache.keys(orgId).aiAnalysis(campaignId);
  const cached = await cache.getJSON(cKey);
  if (cached) return cached;

  // Fetch aggregate stats from MySQL
  const stats = await db.query(
    `SELECT
       cam.name, cam.emails_sent, cam.total_contacts,
       COUNT(DISTINCT CASE WHEN ee.event_type='opened' THEN ee.contact_id END)      AS opens,
       COUNT(DISTINCT CASE WHEN ee.event_type='clicked' THEN ee.contact_id END)     AS clicks,
       COUNT(DISTINCT CASE WHEN ee.event_type='bounced' THEN ee.contact_id END)     AS bounces,
       COUNT(DISTINCT CASE WHEN ee.event_type='unsubscribed' THEN ee.contact_id END) AS unsubs,
       COUNT(DISTINCT CASE WHEN ee.event_type='booked' THEN ee.contact_id END)      AS bookings
     FROM campaigns cam
     LEFT JOIN email_events ee ON ee.campaign_id = cam.id
     WHERE cam.id=? AND cam.org_id=?
     GROUP BY cam.name, cam.emails_sent, cam.total_contacts`,
    [campaignId, orgId],
  );

  const s   = stats.rows[0] || {};
  const sent = parseInt(s.emails_sent || '0', 10) || 1;
  const statsObj = {
    name:        s.name,
    sent,
    total:       s.total_contacts,
    open_rate:   ((parseInt(s.opens || '0', 10) / sent) * 100).toFixed(1),
    click_rate:  ((parseInt(s.clicks || '0', 10) / sent) * 100).toFixed(1),
    bounce_rate: ((parseInt(s.bounces || '0', 10) / sent) * 100).toFixed(1),
    unsub_rate:  ((parseInt(s.unsubs || '0', 10) / sent) * 100).toFixed(1),
    booking_rate:((parseInt(s.bookings || '0', 10) / sent) * 100).toFixed(1),
  };

  const prompt = `Analyze this email campaign and give 5 actionable improvements.
Campaign stats: ${JSON.stringify(statsObj)}
Industry benchmarks: open 35%, click 12%, bounce <2%
Return ONLY JSON (no markdown): {
  "overall_grade": "A"|"B"|"C"|"D",
  "summary": string,
  "recommendations": [{ "title": string, "description": string, "priority": "high"|"med"|"low" }],
  "best_send_time": string,
  "audience_insights": string
}`;

  const text   = await callClaude(prompt, 900);
  const result = safeJSON(text, {
    overall_grade: 'B',
    summary: 'Analysis unavailable',
    recommendations: [],
    best_send_time: '9:00 AM',
    audience_insights: '',
  });

  await cache.setJSON(cKey, result, cache.TTL.AI_ANALYSIS);
  return result;
}

// ---------------------------------------------------------------------------
// Feature 7: AI Lead Finder / ICP Generator
// ---------------------------------------------------------------------------
async function generateICPFromTopContacts(orgId) {
  const topContacts = await db.query(
    `SELECT c.id, c.company, c.job_title, c.industry, c.country, c.employee_count,
            c.revenue_range, c.ai_score,
            COUNT(DISTINCT CASE WHEN ee.event_type='opened'  THEN ee.id END) AS opens,
            COUNT(DISTINCT CASE WHEN ee.event_type='clicked' THEN ee.id END) AS clicks,
            COUNT(DISTINCT CASE WHEN ee.event_type='booked'  THEN ee.id END) AS bookings
     FROM contacts c
     LEFT JOIN email_events ee ON ee.contact_id = c.id AND ee.org_id = ?
     WHERE c.org_id = ? AND c.status = 'active'
     ORDER BY c.ai_score IS NULL, c.ai_score DESC
     LIMIT 50`,
    [orgId, orgId],
  );

  if (!topContacts.rows.length) {
    return { error: 'Not enough contact data for ICP generation' };
  }

  const prompt = `Analyze these top contacts and define the Ideal Customer Profile (ICP).
Contact data: ${JSON.stringify(topContacts.rows.slice(0, 30))}
Return ONLY JSON (no markdown): {
  "icp_description": string,
  "top_industries": string[],
  "company_size_range": string,
  "job_titles": string[],
  "geography": string[],
  "pain_points": string[],
  "search_terms": string[]
}`;

  const text   = await callClaude(prompt, 1000);
  const result = safeJSON(text, {});

  if (result.icp_description) {
    const org = await db.query('SELECT settings FROM organisations WHERE id=?', [orgId]);
    const current = org.rows[0]?.settings || {};
    await db.query(
      `UPDATE organisations SET settings=? WHERE id=?`,
      [JSON.stringify({ ...current, icp: result }), orgId],
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Feature 8: AI Template Generator
// ---------------------------------------------------------------------------
async function generateTemplate(brief, orgId, userId) {
  const {
    industry          = 'SaaS',
    tone              = 'professional',
    goal              = 'book call',
    avg_contact_job_title = 'Decision Maker',
    company_size      = '50-500 employees',
  } = brief || {};

  const prompt = `Write a cold B2B outreach email template.
Target: ${avg_contact_job_title} at ${company_size} companies in ${industry}
Tone: ${tone} (professional|friendly|direct)
Goal: ${goal} (book call|demo|reply)
Booking link: {{booking_url}}
Rules:
- Use {{first_name}}, {{company}}, {{industry}}, {{job_title}} as variables
- Add placeholders: {{research_hook}} and {{pain_point}}
- Subject line under 50 chars, curiosity-driven
- Body under 150 words
- One clear CTA
Return ONLY JSON (no markdown): {
  "name": string,
  "subject": string,
  "body_html": string,
  "preview_text": string,
  "variables": string[]
}`;

  const text   = await callClaude(prompt, 1000);
  const parsed = safeJSON(text, null);
  if (!parsed?.subject) throw new Error('AI failed to generate template');

  const newId = uuidv4();
  await db.query(
    `INSERT INTO templates (id, name, subject, body_html, preview_text, variables, ai_generated, org_id, created_by)
     VALUES (?,?,?,?,?,?,TRUE,?,?)`,
    [
      newId,
      parsed.name,
      parsed.subject,
      parsed.body_html,
      parsed.preview_text || '',
      JSON.stringify(parsed.variables || []),
      orgId,
      userId,
    ],
  );
  return { templateId: newId, ...parsed };
}

// ---------------------------------------------------------------------------
// Feature 9: WhatsApp message template draft (same Anthropic stack as email AI)
// ---------------------------------------------------------------------------
function sanitizeWaTemplateName(name) {
  return String(name || 'generated_template')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 512) || 'generated_template';
}

/**
 * @param {{ prompt: string, category?: string, tone?: string, language?: string }} opts
 */
async function generateWhatsAppTemplateDraft(opts) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Set ANTHROPIC_API_KEY in your environment to use AI template generation.');
  }
  const { prompt, category = 'MARKETING', tone = 'professional', language = 'en' } = opts;

  const fullPrompt = `You are an expert at WhatsApp Business API message templates.
Rules:
- Template name: lowercase snake_case, only letters digits underscore, max 50 chars.
- Body: WhatsApp allows *bold* with asterisks. Variables must be exactly {{1}}, {{2}}, etc. in order (no gaps if possible). Keep body under 900 characters.
- Category is ${category} — match tone: ${tone}.
- Language code for the template will be: ${language} (do not translate the code; write message text appropriate for that locale).
- Optional footer: max 60 chars, no variables.
- Optional header: only type TEXT with short text and optional variables {{1}} etc. if needed; or omit header (header_type null).
- Buttons: at most 3. Each has type QUICK_REPLY, URL, or PHONE_NUMBER. URL must be https. For PHONE_NUMBER include "phone_number" E.164 digits only (no +).
Return ONLY JSON (no markdown): {
  "name": string,
  "body_text": string,
  "footer_text": string,
  "header_type": null | "TEXT",
  "header_content": string | null,
  "buttons": [{ "type": string, "text": string, "url"?: string, "phone_number"?: string }]
}

User request:
${String(prompt).trim().slice(0, 4000)}`;

  const text   = await callClaude(fullPrompt, 1200);
  const parsed = safeJSON(text, null);
  if (!parsed || typeof parsed !== 'object') throw new Error('Could not parse AI response as JSON.');

  const name = sanitizeWaTemplateName(parsed.name);
  const body_text = String(parsed.body_text || '').trim().slice(0, 1024);
  if (!body_text) throw new Error('AI returned an empty body.');

  const footer_text = parsed.footer_text ? String(parsed.footer_text).trim().slice(0, 60) : '';
  let header_type   = parsed.header_type === 'TEXT' ? 'TEXT' : null;
  let header_content = parsed.header_content ? String(parsed.header_content).trim().slice(0, 200) : null;
  if (header_type === 'TEXT' && !header_content) {
    header_type    = null;
    header_content = null;
  }

  let buttons = Array.isArray(parsed.buttons) ? parsed.buttons : [];
  buttons = buttons.slice(0, 3).map((b) => {
    const type = String(b.type || 'QUICK_REPLY').toUpperCase();
    const btnText = String(b.text || 'OK').slice(0, 25);
    if (type === 'URL') return { type: 'URL', text: btnText, url: String(b.url || 'https://example.com').slice(0, 2000) };
    if (type === 'PHONE_NUMBER') {
      const digits = String(b.phone_number || b.phone || '').replace(/\D/g, '');
      return { type: 'PHONE_NUMBER', text: btnText, phone_number: digits };
    }
    return { type: 'QUICK_REPLY', text: btnText };
  }).filter((b) => b.text);

  return {
    name,
    body_text,
    footer_text: footer_text || null,
    header_type,
    header_content,
    buttons,
  };
}

module.exports = {
  scoreContact,
  researchContact,
  personalizeEmail,
  generateABVariants,
  buildSegmentFromQuery,
  analyzeCampaignPerformance,
  generateICPFromTopContacts,
  generateTemplate,
  generateWhatsAppTemplateDraft,
};
