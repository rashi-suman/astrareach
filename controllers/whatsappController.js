'use strict';
const { v4: uuidv4 } = require('uuid');
const db  = require('../config/db');
const { connection: redis } = require('../config/redis');
const { encrypt, decrypt } = require('../services/encryption');
const { WaBspService }     = require('../services/waBspService');
const { addToWaQueue }     = require('../services/waQueueService');
const { getPagination }    = require('../middleware/paginate');
const { generateWhatsAppTemplateDraft } = require('../services/aiService');

const DEFAULT_ORG = '00000000-0000-0000-0000-000000000001';

function orgId(req) {
  return req.user?.org_id || req.org?.id || DEFAULT_ORG;
}

/** Prefer dedicated WhatsApp field; fall back to general `phone` (many contacts only fill that). */
function effectiveWhatsAppNumberFromRow(row) {
  if (!row) return null;
  const wa = row.whatsapp_phone != null ? String(row.whatsapp_phone).trim() : '';
  if (wa) return wa;
  const ph = row.phone != null ? String(row.phone).trim() : '';
  return ph || null;
}

/**
 * Fetch contact for WA opt-in/out. Do NOT require org_id match in SQL — many rows have NULL org_id
 * (legacy / import) while the session org is set; strict AND org_id=$n returned no row → false "no phone" errors.
 */
async function loadContactForWaOpt(req, contactId) {
  const { rows } = await db.query(
    `SELECT id, whatsapp_phone, phone, org_id FROM contacts WHERE id = ?`,
    [contactId],
  );
  const row = rows[0];
  if (!row) return { ok: false, code: 'not_found' };
  const sessionOrg = String(orgId(req));
  const rowOrg = row.org_id != null ? String(row.org_id) : null;
  if (rowOrg !== null && rowOrg !== sessionOrg) return { ok: false, code: 'wrong_org' };
  return { ok: true, contact: row };
}

const SQL_EFFECTIVE_WA =
  'COALESCE(NULLIF(TRIM(c.whatsapp_phone), \'\'), NULLIF(TRIM(c.phone), \'\'))';

/**
 * Populate wa_campaign_contacts from optional segment + audience_source.
 * contacts_opted_in: contacts.whatsapp_opted_in + optional segment filters.
 * wa_registry: must have wa_opt_ins opted_in row for contact + optional segment.
 */
async function populateWaCampaignAudience(cam) {
  const { buildFilterWhere, offsetSqlParams } = require('../utils/segmentQueryBuilder');
  const org       = cam.org_id;
  const segmentId = cam.segment_id || null;
  const audience  = cam.audience_source || 'contacts_opted_in';

  let segmentFrag = 'TRUE';
  const segParams   = [];

  if (segmentId) {
    const { rows: [seg] } = await db.query(
      `SELECT filters FROM segments WHERE id=? AND (org_id = ? OR org_id IS NULL)`,
      [segmentId, org],
    );
    if (!seg) throw new Error('Segment not found for this organisation');
    const built = buildFilterWhere(seg.filters || {});
    segmentFrag = offsetSqlParams(built.where, 2);
    segParams.push(...built.params);
  }

  const joinRegistry = audience === 'wa_registry'
    ? ` INNER JOIN wa_opt_ins oi ON oi.contact_id = c.id AND oi.org_id = c.org_id AND oi.status = 'opted_in' `
    : '';

  const consentFrag = audience === 'wa_registry' ? '' : ' AND c.whatsapp_opted_in = true ';

  await db.query(
    `INSERT IGNORE INTO wa_campaign_contacts (org_id, campaign_id, contact_id, phone_number)
     SELECT ?, ?, c.id, ${SQL_EFFECTIVE_WA}
     FROM contacts c
     ${joinRegistry}
     WHERE c.org_id = ? AND ${SQL_EFFECTIVE_WA} IS NOT NULL ${consentFrag}
       AND (${segmentFrag})`,
    [org, cam.id, org, ...segParams],
  );

  if (audience === 'wa_registry') {
    await db.query(
      `UPDATE contacts c
       INNER JOIN wa_campaign_contacts w ON w.campaign_id = ? AND w.contact_id = c.id AND c.org_id = ?
       SET c.whatsapp_opted_in = TRUE,
           c.whatsapp_opted_in_at = COALESCE(c.whatsapp_opted_in_at, NOW())
       WHERE c.whatsapp_opted_in IS NOT TRUE`,
      [cam.id, org],
    );
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// PHONE NUMBERS
// ══════════════════════════════════════════════════════════════════════════════

async function phonesIndex(req, res) {
  try {
    const { rows } = await db.query(
      `SELECT id, display_name, phone_number, phone_number_id, bsp, tier, daily_limit,
              quality_score, quality_updated_at, is_active, is_paused, pause_reason,
              messages_sent_today, last_reset_date, created_at
       FROM wa_phone_numbers WHERE org_id=? ORDER BY created_at DESC`,
      [orgId(req)],
    );
    res.render('whatsapp/phones/index', {
      title: 'WhatsApp Numbers', page: 'whatsapp',
      breadcrumbs: ['WhatsApp', 'Phone Numbers'],
      phones: rows, user: req.user,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function phoneCreate(req, res) {
  try {
    const { display_name, phone_number, phone_number_id, waba_id, bsp, bsp_api_key, access_token, tier } = req.body;
    const tierInt   = parseInt(tier || 1);
    const dailyLimit = { 1: 1000, 2: 10000, 3: 100000, 4: 999999 }[tierInt] || 1000;
    await db.query(
      `INSERT INTO wa_phone_numbers (org_id, display_name, phone_number, phone_number_id, waba_id, bsp, bsp_api_key, access_token, tier, daily_limit)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [orgId(req), display_name, phone_number, phone_number_id, waba_id, bsp,
       bsp_api_key ? encrypt(bsp_api_key) : null,
       access_token ? encrypt(access_token) : null,
       tierInt, dailyLimit],
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function phoneUpdate(req, res) {
  try {
    const {
      display_name, phone_number, phone_number_id, waba_id, bsp,
      bsp_api_key, access_token, tier,
    } = req.body;
    const tierInt    = parseInt(tier || 1, 10);
    const dailyLimit = { 1: 1000, 2: 10000, 3: 100000, 4: 999999 }[tierInt] || 1000;

    const { rows: [row] } = await db.query(
      `SELECT id FROM wa_phone_numbers WHERE id=? AND org_id=?`,
      [req.params.id, orgId(req)],
    );
    if (!row) return res.status(404).json({ error: 'Not found' });

    const encKey = bsp_api_key && String(bsp_api_key).trim() ? encrypt(String(bsp_api_key).trim()) : null;
    const encTok = access_token && String(access_token).trim() ? encrypt(String(access_token).trim()) : null;

    await db.query(
      `UPDATE wa_phone_numbers SET
         display_name    = ?,
         phone_number    = ?,
         phone_number_id = ?,
         waba_id         = ?,
         bsp               = ?,
         tier              = ?,
         daily_limit       = ?,
         bsp_api_key       = COALESCE(?, bsp_api_key),
         access_token      = COALESCE(?, access_token)
       WHERE id=? AND org_id=?`,
      [
        display_name,
        phone_number,
        phone_number_id,
        waba_id,
        bsp,
        tierInt,
        dailyLimit,
        encKey,
        encTok,
        req.params.id,
        orgId(req),
      ],
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function phoneDelete(req, res) {
  try {
    await db.query(`UPDATE wa_phone_numbers SET is_active=false WHERE id=? AND org_id=?`, [req.params.id, orgId(req)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function phoneQuality(req, res) {
  try {
    const { rows: [phone] } = await db.query(`SELECT * FROM wa_phone_numbers WHERE id=? AND org_id=?`, [req.params.id, orgId(req)]);
    if (!phone) return res.status(404).json({ error: 'Not found' });
    const bsp   = new WaBspService(phone);
    const score = await bsp.getQualityRating();
    await db.query(`UPDATE wa_phone_numbers SET quality_score=?, quality_updated_at=NOW() WHERE id=?`, [score, phone.id]);
    res.json({ quality_score: score });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// ══════════════════════════════════════════════════════════════════════════════
// TEMPLATES
// ══════════════════════════════════════════════════════════════════════════════

async function templatesIndex(req, res) {
  try {
    const q = (req.query.q || '').trim();
    const { page: pageNo, limit, offset } = getPagination(req);
    const filter = q ? `AND (name LIKE ? OR body_text LIKE ?)` : '';
    const params = q ? [orgId(req), `%${q}%`, `%${q}%`] : [orgId(req)];

    const [dataRes, countRes] = await Promise.all([
      db.query(`SELECT id, name, category, language, status, header_type, header_content, body_text, footer_text, buttons, variables, created_at, rejected_reason
                FROM wa_templates WHERE org_id=? ${filter}
                ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`, params),
      db.query(`SELECT COUNT(*) FROM wa_templates WHERE org_id=? ${filter}`, params),
    ]);
    const phones = (await db.query(
      `SELECT id, display_name, phone_number_id, bsp FROM wa_phone_numbers WHERE org_id=? AND is_active=true ORDER BY created_at DESC`,
      [orgId(req)],
    )).rows;

    res.render('whatsapp/templates/index', {
      title: 'WA Templates', page: 'whatsapp', breadcrumbs: ['WhatsApp', 'Templates'],
      templates: dataRes.rows, total: parseInt(countRes.rows[0].count),
      pageNo, limit, query: q, phones, user: req.user,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function templateNewPage(req, res) {
  try {
    const phones = (await db.query(
      `SELECT id, display_name, phone_number_id, bsp FROM wa_phone_numbers WHERE org_id=? AND is_active=true ORDER BY created_at DESC`,
      [orgId(req)],
    )).rows;
    res.render('whatsapp/templates/new', {
      title: 'New WA Template', page: 'whatsapp', breadcrumbs: ['WhatsApp', 'Templates', 'New'],
      phones, user: req.user,
      aiEnabled: Boolean(process.env.ANTHROPIC_API_KEY),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

/** POST JSON { prompt, category?, tone?, language? } → AI draft fields for the form */
async function templateAiGenerate(req, res) {
  try {
    const { prompt, category, tone, language } = req.body || {};
    const p = String(prompt || '').trim();
    if (p.length < 12) return res.status(400).json({ error: 'Enter at least 12 characters describing what the template should say.' });
    if (p.length > 4000) return res.status(400).json({ error: 'Prompt is too long.' });
    const draft = await generateWhatsAppTemplateDraft({
      prompt:   p,
      category: ['MARKETING', 'UTILITY'].includes(String(category || '').toUpperCase()) ? String(category).toUpperCase() : 'MARKETING',
      tone:     String(tone || 'professional').slice(0, 40),
      language: String(language || 'en').slice(0, 20),
    });
    res.json({ ok: true, draft });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

async function templateCreate(req, res) {
  try {
    const { phone_number_id, name, category, language, header_type, header_content, body_text, footer_text, buttons } = req.body;
    const normName   = String(name || '').toLowerCase().replace(/\s+/g, '_');
    const vars       = (body_text.match(/\{\{\d+\}\}/g) || []).map(v => v.replace(/[{}]/g, ''));
    const buttonsArr = buttons ? (Array.isArray(buttons) ? buttons : JSON.parse(buttons)) : [];
    const lang        = language || 'en';

    const newTemplateId = uuidv4();
    await db.query(
      `INSERT INTO wa_templates (id, org_id, phone_number_id, name, category, language, header_type, header_content, body_text, footer_text, buttons, variables, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [newTemplateId, orgId(req), phone_number_id, normName, category, lang, header_type || null, header_content || null, body_text,
       footer_text || null, JSON.stringify(buttonsArr), JSON.stringify(vars), req.user.id],
    );
    const inserted = { id: newTemplateId };

    const { rows: [phone] } = await db.query(
      `SELECT * FROM wa_phone_numbers WHERE org_id=? AND phone_number_id=? AND is_active=true LIMIT 1`,
      [orgId(req), phone_number_id],
    );

    let meta = { submitted: false };
    if (phone && ['meta_cloud', '360dialog'].includes(phone.bsp)) {
      const result = await WaBspService.submitMessageTemplateCreate(phone, {
        name:           normName,
        category,
        language:       lang,
        header_type:    header_type || null,
        header_content,
        body_text,
        footer_text,
        buttons:        buttonsArr,
      });
      if (result.ok) {
        const dbStatus = WaBspService.mapMetaManagementStatusToDb(result.status);
        await db.query(
          `UPDATE wa_templates SET meta_template_id = COALESCE(?, meta_template_id), status = ?, rejected_reason = NULL WHERE id = ?`,
          [result.id != null ? String(result.id) : null, dbStatus, inserted.id],
        );
        meta = { submitted: true, status: dbStatus, meta_template_id: result.id };
      } else {
        await db.query(
          `UPDATE wa_templates SET rejected_reason = ? WHERE id = ?`,
          [String(result.message || 'Meta error').slice(0, 2000), inserted.id],
        );
        meta = { submitted: false, error: result.message };
      }
    } else if (phone) {
      meta = {
        submitted: false,
        skipped:   true,
        message:   'This number uses Twilio or another BSP. Create the template in that provider, then add it here or switch the number to Meta Cloud / 360dialog for one-click submission.',
      };
    }

    if (req.accepts('json')) return res.json({ ok: true, meta });
    req.flash('success', meta.submitted ? 'Template submitted to Meta for review.' : 'Template saved.');
    if (meta.error) req.flash('error', meta.error);
    res.redirect('/whatsapp/templates');
  } catch (e) {
    if (req.accepts('json')) return res.status(500).json({ error: e.message });
    req.flash('error', e.message);
    res.redirect('/whatsapp/templates/new');
  }
}

/** Pull template statuses from Meta / 360dialog Graph and update wa_templates. */
async function templatesSyncFromMeta(req, res) {
  try {
    const waPhoneId = req.body.wa_phone_id || req.query.wa_phone_id || null;
    const q         = waPhoneId
      ? `SELECT * FROM wa_phone_numbers WHERE id=? AND org_id=? AND is_active=true`
      : `SELECT * FROM wa_phone_numbers WHERE org_id=? AND is_active=true`;
    const params = waPhoneId ? [waPhoneId, orgId(req)] : [orgId(req)];
    const { rows: phones } = await db.query(q, params);

    let updated = 0;
    for (const phone of phones) {
      if (!['meta_cloud', '360dialog'].includes(phone.bsp)) continue;
      const list = await WaBspService.fetchAllMessageTemplates(phone);
      for (const mt of list) {
        const metaLang = mt.language || '';
        const st       = WaBspService.mapMetaManagementStatusToDb(mt.status);
        const { rows: locals } = await db.query(
          `SELECT id, language FROM wa_templates WHERE org_id=? AND phone_number_id=? AND lower(trim(name)) = lower(trim(?))`,
          [orgId(req), phone.phone_number_id, mt.name],
        );
        for (const loc of locals) {
          if (!WaBspService.languagesMatchForSync(loc.language, metaLang)) continue;
          const r = await db.query(
            `UPDATE wa_templates SET
               status = ?,
               meta_template_id = COALESCE(?, meta_template_id),
               rejected_reason = CASE WHEN ? = 'REJECTED' THEN COALESCE(rejected_reason, 'Rejected by Meta') ELSE NULL END
             WHERE id = ?`,
            [st, mt.id != null ? String(mt.id) : null, st, loc.id],
          );
          updated += r.rowCount || 0;
        }
      }
    }
    res.json({ ok: true, updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

async function templateDelete(req, res) {
  try {
    const { rows: [t] } = await db.query(`SELECT status FROM wa_templates WHERE id=? AND org_id=?`, [req.params.id, orgId(req)]);
    if (!t) return res.status(404).json({ error: 'Not found' });
    if (!['PENDING','REJECTED'].includes(t.status)) return res.status(400).json({ error: 'Only PENDING or REJECTED templates can be deleted' });
    await db.query(`DELETE FROM wa_templates WHERE id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// ══════════════════════════════════════════════════════════════════════════════
// OPT-INS
// ══════════════════════════════════════════════════════════════════════════════

async function optInsIndex(req, res) {
  try {
    const { page: pageNo, limit, offset } = getPagination(req);
    const status = req.query.status || '';
    const filter = status ? `AND oi.status=?` : '';
    const countFilter = status ? `AND status=?` : '';
    const params = status ? [orgId(req), status] : [orgId(req)];

    const [dataRes, countRes] = await Promise.all([
      db.query(`SELECT oi.*, c.first_name, c.last_name, c.email
                FROM wa_opt_ins oi LEFT JOIN contacts c ON c.id=oi.contact_id
                WHERE oi.org_id=? ${filter} ORDER BY COALESCE(oi.opted_in_at, oi.opted_out_at) DESC
                LIMIT ${limit} OFFSET ${offset}`, params),
      db.query(`SELECT COUNT(*) AS count FROM wa_opt_ins WHERE org_id=? ${countFilter}`, params),
    ]);

    const segments = (await db.query(
      `SELECT id, name, contact_count FROM segments WHERE org_id=? OR org_id IS NULL ORDER BY name`,
      [orgId(req)],
    )).rows;

    res.render('whatsapp/optins/index', {
      title: 'WA Opt-ins', page: 'whatsapp', breadcrumbs: ['WhatsApp', 'Opt-ins'],
      optins: dataRes.rows, total: parseInt(countRes.rows[0].count),
      pageNo, limit, filterStatus: status, segments, user: req.user,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function optInRecord(req, res) {
  try {
    const loaded = await loadContactForWaOpt(req, req.params.contactId);
    if (!loaded.ok && loaded.code === 'not_found') return res.status(404).json({ error: 'Contact not found' });
    if (!loaded.ok && loaded.code === 'wrong_org') return res.status(403).json({ error: 'This contact is not in your workspace.' });
    const { contact } = loaded;
    const num = effectiveWhatsAppNumberFromRow(contact);
    if (!num) {
      return res.status(400).json({
        error: 'No usable WhatsApp number on this contact. Set the Phone or WhatsApp number field (Edit contact), then try again.',
      });
    }
    await db.query(
      `INSERT INTO wa_opt_ins (org_id, contact_id, phone_number, status, source, opted_in_at)
       VALUES (?,?,?,'opted_in','agent_recorded',NOW())
       ON DUPLICATE KEY UPDATE status='opted_in', opted_in_at=NOW()`,
      [orgId(req), contact.id, num],
    );
    await db.query(
      `UPDATE contacts SET whatsapp_opted_in=true, whatsapp_opted_in_at=NOW(),
         whatsapp_phone = COALESCE(NULLIF(TRIM(COALESCE(whatsapp_phone,'')), ''), ?),
         org_id = COALESCE(org_id, ?)
       WHERE id=?`,
      [num, orgId(req), contact.id],
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function optOutRecord(req, res) {
  try {
    const loaded = await loadContactForWaOpt(req, req.params.contactId);
    if (!loaded.ok && loaded.code === 'not_found') return res.status(404).json({ error: 'Contact not found' });
    if (!loaded.ok && loaded.code === 'wrong_org') return res.status(403).json({ error: 'This contact is not in your workspace.' });
    const { contact } = loaded;
    const num = effectiveWhatsAppNumberFromRow(contact);
    if (!num) {
      return res.status(400).json({
        error: 'No usable WhatsApp number on this contact. Set the Phone or WhatsApp number field (Edit contact), then try again.',
      });
    }
    await db.query(
      `INSERT INTO wa_opt_ins (org_id, contact_id, phone_number, status, source, opted_out_at, opted_out_reason)
       VALUES (?,?,?,'opted_out','agent_recorded',NOW(),'manual')
       ON DUPLICATE KEY UPDATE status='opted_out', opted_out_at=NOW(), opted_out_reason='manual'`,
      [orgId(req), contact.id, num],
    );
    await db.query(`UPDATE contacts SET whatsapp_opted_in=false WHERE id=?`, [contact.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

/** Bulk opt-in: segment contacts with WhatsApp, or all org contacts with whatsapp_phone set. */
async function optInsImportSegment(req, res) {
  try {
    const body = req.body || {};
    const importAll = body.import_all_with_whatsapp === true || body.import_all_with_whatsapp === 'true';
    const { segment_id } = body;

    let whereFrag = '1=1';
    let params = [];

    if (importAll) {
      whereFrag = '1=1';
      params = [];
    } else if (segment_id) {
      const { rows: [seg] } = await db.query(
        `SELECT id, filters FROM segments WHERE id=? AND (org_id=? OR org_id IS NULL)`,
        [segment_id, orgId(req)],
      );
      if (!seg) return res.status(404).json({ error: 'Segment not found' });
      const { buildFilterWhere, offsetSqlParams } = require('../utils/segmentQueryBuilder');
      const built = buildFilterWhere(seg.filters || {});
      whereFrag = offsetSqlParams(built.where, 1);
      params = built.params;
    } else {
      return res.status(400).json({ error: 'Send segment_id or import_all_with_whatsapp: true' });
    }

    // MySQL has no RETURNING; we use INSERT ... ON DUPLICATE KEY UPDATE, then SELECT affected contacts
    await db.query(
      `INSERT INTO wa_opt_ins (org_id, contact_id, phone_number, status, source, opted_in_at)
       SELECT ?, c.id, ${SQL_EFFECTIVE_WA}, 'opted_in', ${importAll ? `'bulk_all_wa'` : `'segment_import'`}, NOW()
       FROM contacts c
       WHERE c.org_id = ? AND ${SQL_EFFECTIVE_WA} IS NOT NULL
         AND (${whereFrag})
       ON DUPLICATE KEY UPDATE
         status = 'opted_in',
         contact_id = VALUES(contact_id),
         source = VALUES(source),
         opted_in_at = NOW(),
         opted_out_at = NULL,
         opted_out_reason = NULL`,
      [orgId(req), orgId(req), ...params],
    );

    // Fetch the contact_ids that are now opted_in for this org to update contacts table
    const { rows: affectedRows } = await db.query(
      `SELECT contact_id FROM wa_opt_ins WHERE org_id = ? AND status = 'opted_in'`,
      [orgId(req)],
    );

    const ids = [...new Set(affectedRows.map((r) => r.contact_id).filter(Boolean))];
    if (ids.length) {
      await db.query(
        `UPDATE contacts SET whatsapp_opted_in = TRUE, whatsapp_opted_in_at = COALESCE(whatsapp_opted_in_at, NOW())
         WHERE org_id = ? AND id IN (?)`,
        [orgId(req), ids],
      );
    }

    res.json({ ok: true, imported: affectedRows.length, contacts_updated: ids.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// ══════════════════════════════════════════════════════════════════════════════
// CAMPAIGNS
// ══════════════════════════════════════════════════════════════════════════════

async function campaignsIndex(req, res) {
  try {
    const q      = (req.query.q || '').trim();
    const status = req.query.status || '';
    const { page: pageNo, limit, offset } = getPagination(req);

    let where = 'WHERE c.org_id=?', params = [orgId(req)];
    if (q) { where += ` AND c.name LIKE ?`; params.push(`%${q}%`); }
    if (status) { where += ` AND c.status=?`; params.push(status); }

    const [dataRes, countRes, summaryRes] = await Promise.all([
      db.query(`SELECT c.id, c.name, c.status, c.messages_sent, c.total_contacts,
                       c.messages_sent_today, c.daily_limit, c.send_time, c.created_at,
                       pn.phone_number, pn.display_name AS phone_name, pn.quality_score,
                       t.name AS template_name
                FROM wa_campaigns c
                LEFT JOIN wa_phone_numbers pn ON pn.id=c.phone_number_id
                LEFT JOIN wa_templates t ON t.id=c.template_id
                ${where} ORDER BY c.created_at DESC LIMIT ${limit} OFFSET ${offset}`, params),
      db.query(`SELECT COUNT(*) FROM wa_campaigns c ${where}`, params),
      db.query(`SELECT status, COUNT(*) AS cnt FROM wa_campaigns WHERE org_id=? GROUP BY status`, [orgId(req)]),
    ]);
    const summary = Object.fromEntries(summaryRes.rows.map(r => [r.status, parseInt(r.cnt)]));

    res.render('whatsapp/campaigns/index', {
      title: 'WA Campaigns', page: 'whatsapp', breadcrumbs: ['WhatsApp', 'Campaigns'],
      campaigns: dataRes.rows, total: parseInt(countRes.rows[0].count),
      pageNo, limit, query: q, filterStatus: status, summary, user: req.user,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function campaignWizardStep(req, res) {
  const step = parseInt(req.params.step) || 1;
  try {
    const phones    = (await db.query(`SELECT id, display_name, phone_number, tier, daily_limit, quality_score, is_paused FROM wa_phone_numbers WHERE org_id=? AND is_active=true AND is_paused=false`, [orgId(req)])).rows;
    const templates = (await db.query(`SELECT id, name, category, language, body_text, variables, buttons FROM wa_templates WHERE org_id=? AND status='APPROVED'`, [orgId(req)])).rows;
    const segments = (await db.query(
      `SELECT id, name, contact_count FROM segments WHERE org_id=? OR org_id IS NULL ORDER BY name`,
      [orgId(req)],
    )).rows;

    res.render(`whatsapp/campaigns/wizard/step${step}`, {
      title: `Create Campaign — Step ${step}`, page: 'whatsapp',
      breadcrumbs: ['WhatsApp', 'Campaigns', 'New', `Step ${step}`],
      phones, templates, segments, step,
      draft: req.session.waCampaignDraft || {},
      user: req.user,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function campaignWizardStepPost(req, res) {
  const step = parseInt(req.params.step) || 1;
  if (!req.session.waCampaignDraft) req.session.waCampaignDraft = {};
  Object.assign(req.session.waCampaignDraft, req.body);

  if (step < 4) return res.redirect(`/whatsapp/campaigns/new/step/${step + 1}`);

  // Step 4: create campaign
  try {
    const d = req.session.waCampaignDraft;
    const variableMapping = {};
    for (const [k, v] of Object.entries(d)) {
      if (k.startsWith('var_')) variableMapping[k.replace('var_', '')] = v;
    }

    const segmentId = d.segment_id && String(d.segment_id).trim() ? d.segment_id : null;
    const audienceSource = d.audience_source === 'wa_registry' ? 'wa_registry' : 'contacts_opted_in';

    const { scheduledInstantFromParts } = require('../utils/scheduleHelpers');
    const tzWA = d.timezone || 'Asia/Kolkata';
    const dateWA = (d.schedule_date || '').trim() || new Date().toISOString().slice(0, 10);
    const rawTime = (d.send_time || '10:00').toString();
    const timeWA = rawTime.length === 5 ? rawTime : rawTime.slice(0, 8);
    const scheduledWaAt = scheduledInstantFromParts(dateWA, timeWA, tzWA);

    const newCamId = uuidv4();
    await db.query(
      `INSERT INTO wa_campaigns
         (id, org_id, name, description, phone_number_id, template_id, segment_id, audience_source,
          daily_limit, messages_per_second, send_time, timezone, variable_mapping, booking_url, scheduled_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [newCamId, orgId(req), d.name, d.description || null,
       d.phone_number_id, d.template_id, segmentId, audienceSource,
       parseInt(d.daily_limit || 1000),
       parseFloat(d.messages_per_second || 1),
       timeWA, tzWA,
       JSON.stringify(variableMapping), d.booking_url || null,
       scheduledWaAt,
       req.user.id],
    );
    const cam = { id: newCamId };

    delete req.session.waCampaignDraft;
    req.flash('success', 'Campaign created. Click Start to begin sending.');
    res.redirect(`/whatsapp/campaigns/${cam.id}`);
  } catch (e) {
    req.flash('error', e.message);
    res.redirect('/whatsapp/campaigns/new/step/4');
  }
}

async function campaignDetail(req, res) {
  try {
    const { rows: [cam] } = await db.query(`
      SELECT c.*, pn.phone_number, pn.display_name AS phone_name, pn.quality_score,
             t.name AS template_name, t.body_text, t.header_type, t.header_content,
             t.buttons, t.language, t.variables, t.category
      FROM wa_campaigns c
      LEFT JOIN wa_phone_numbers pn ON pn.id=c.phone_number_id
      LEFT JOIN wa_templates t ON t.id=c.template_id
      WHERE c.id=? AND c.org_id=?`, [req.params.id, orgId(req)]);

    if (!cam) return res.status(404).render('404', { user: req.user, page: 'whatsapp' });

    const { rows: contacts } = await db.query(`
      SELECT wacc.id, wacc.status, wacc.phone_number, wacc.sent_at, wacc.delivered_at,
             wacc.read_at, wacc.replied_at, wacc.failure_reason,
             c.first_name, c.last_name, c.company, c.email
      FROM wa_campaign_contacts wacc
      JOIN contacts c ON c.id=wacc.contact_id
      WHERE wacc.campaign_id=? ORDER BY wacc.created_at LIMIT 200`, [req.params.id]);

    const statsRes = await db.query(`
      SELECT event_type, COUNT(*) AS cnt FROM wa_events WHERE campaign_id=? GROUP BY event_type`,
      [req.params.id]);
    const stats = Object.fromEntries(statsRes.rows.map(r => [r.event_type, parseInt(r.cnt)]));

    const activity = (await db.query(`
      SELECT we.event_type, we.created_at, we.phone_number,
             c.first_name, c.last_name
      FROM wa_events we LEFT JOIN contacts c ON c.id=we.contact_id
      WHERE we.campaign_id=? ORDER BY we.created_at DESC LIMIT 20`, [req.params.id])).rows;

    res.render('whatsapp/campaigns/detail', {
      title: cam.name, page: 'whatsapp',
      breadcrumbs: ['WhatsApp', 'Campaigns', cam.name],
      cam, contacts, stats, activity, user: req.user,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function campaignStats(req, res) {
  try {
    const statsRes = await db.query(`
      SELECT event_type, COUNT(*) AS cnt FROM wa_events WHERE campaign_id=? GROUP BY event_type`,
      [req.params.id]);
    const { rows: [cam] } = await db.query(
      `SELECT status, messages_sent, total_contacts FROM wa_campaigns WHERE id=?`, [req.params.id]);
    res.json({ stats: Object.fromEntries(statsRes.rows.map(r => [r.event_type, parseInt(r.cnt)])), campaign: cam });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function campaignStart(req, res) {
  try {
    const { rows: [cam] } = await db.query(
      `SELECT * FROM wa_campaigns WHERE id=? AND org_id=?`, [req.params.id, orgId(req)],
    );
    if (!cam) return res.status(404).json({ error: 'Not found' });
    if (!['draft', 'paused'].includes(cam.status)) return res.status(400).json({ error: 'Campaign cannot be started' });

    if (cam.total_contacts === 0) {
      try {
        await populateWaCampaignAudience(cam);
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
      const { rows: [cnt] } = await db.query(
        `SELECT COUNT(*) AS n FROM wa_campaign_contacts WHERE campaign_id=?`,
        [cam.id],
      );
      await db.query(`UPDATE wa_campaigns SET total_contacts=? WHERE id=?`, [cnt.n, cam.id]);
    }

    await db.query(`UPDATE wa_campaigns SET status='active', started_at=COALESCE(started_at,NOW()) WHERE id=?`, [cam.id]);

    // Enqueue pending contacts
    const { rows: pending } = await db.query(
      `SELECT id FROM wa_campaign_contacts WHERE campaign_id=? AND status='pending'`, [cam.id]);
    const { rows: [pn] } = await db.query(`SELECT phone_number_id, tier FROM wa_phone_numbers WHERE id=?`, [cam.phone_number_id]);
    let delayMs = 0;
    if (cam.scheduled_at) {
      const t = new Date(cam.scheduled_at).getTime();
      if (t > Date.now()) delayMs = Math.max(0, t - Date.now());
    }
    for (const cc of pending) {
      await db.query(`UPDATE wa_campaign_contacts SET status='queued' WHERE id=?`, [cc.id]);
      await addToWaQueue(cc.id, pn.phone_number_id, pn.tier || 1, delayMs);
    }

    res.json({ ok: true, queued: pending.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function campaignPause(req, res) {
  try {
    await db.query(`UPDATE wa_campaigns SET status='paused' WHERE id=? AND org_id=? AND status='active'`, [req.params.id, orgId(req)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function campaignResume(req, res) {
  try {
    await db.query(`UPDATE wa_campaigns SET status='active' WHERE id=? AND org_id=? AND status='paused'`, [req.params.id, orgId(req)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function campaignStop(req, res) {
  try {
    await db.query(`UPDATE wa_campaigns SET status='stopped', completed_at=NOW() WHERE id=? AND org_id=?`, [req.params.id, orgId(req)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// ══════════════════════════════════════════════════════════════════════════════
// ANALYTICS
// ══════════════════════════════════════════════════════════════════════════════

async function analyticsIndex(req, res) {
  try {
    const days = parseInt(req.query.days || 30);
    const since = `NOW() - INTERVAL ${days} DAY`;

    const [overview, daily, campaigns, optoutTrend] = await Promise.all([
      db.query(`SELECT event_type, COUNT(*) AS cnt FROM wa_events WHERE org_id=? AND created_at >= ${since} GROUP BY event_type`, [orgId(req)]),
      db.query(`SELECT DATE(created_at) AS date, event_type, COUNT(*) AS cnt FROM wa_events WHERE org_id=? AND created_at >= ${since} GROUP BY date, event_type ORDER BY date`, [orgId(req)]),
      db.query(`SELECT c.id, c.name, c.status, c.messages_sent, c.total_contacts,
                       COUNT(CASE WHEN we.event_type='delivered' THEN we.id END) AS delivered,
                       COUNT(CASE WHEN we.event_type='read' THEN we.id END) AS read_count,
                       COUNT(CASE WHEN we.event_type='replied' THEN we.id END) AS replied,
                       COUNT(CASE WHEN we.event_type='opted_out' THEN we.id END) AS opted_out
                FROM wa_campaigns c LEFT JOIN wa_events we ON we.campaign_id=c.id AND we.created_at >= ${since}
                WHERE c.org_id=? GROUP BY c.id ORDER BY c.created_at DESC LIMIT 20`, [orgId(req)]),
      db.query(`SELECT DATE(created_at) AS date, COUNT(*) AS cnt FROM wa_events WHERE org_id=? AND event_type='opted_out' AND created_at >= ${since} GROUP BY date ORDER BY date`, [orgId(req)]),
    ]);

    const stats = Object.fromEntries(overview.rows.map(r => [r.event_type, parseInt(r.cnt)]));

    res.render('whatsapp/analytics/index', {
      title: 'WA Analytics', page: 'whatsapp', breadcrumbs: ['WhatsApp', 'Analytics'],
      stats, daily: daily.rows, campaigns: campaigns.rows,
      optoutTrend: optoutTrend.rows, days, user: req.user,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// ══════════════════════════════════════════════════════════════════════════════
// INBOX
// ══════════════════════════════════════════════════════════════════════════════

async function inboxIndex(req, res) {
  try {
    const { rows: threads } = await db.query(`
      SELECT m.from_phone, m.message_body, m.created_at, m.session_expires_at,
        c.id AS contact_id, c.first_name, c.last_name, c.company
      FROM wa_inbound_messages m
      LEFT JOIN contacts c ON c.id=m.contact_id
      WHERE m.org_id=?
        AND (m.from_phone, m.created_at) IN (
          SELECT from_phone, MAX(created_at)
          FROM wa_inbound_messages
          WHERE org_id=?
          GROUP BY from_phone
        )
      ORDER BY m.created_at DESC`, [orgId(req), orgId(req)]);

    res.render('whatsapp/inbox/index', {
      title: 'WA Inbox', page: 'whatsapp', breadcrumbs: ['WhatsApp', 'Inbox'],
      threads, activePhone: null, messages: [], user: req.user,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

async function inboxContact(req, res) {
  try {
    const { rows: [contact] } = await db.query(`SELECT * FROM contacts WHERE id=? AND org_id=?`, [req.params.contactId, orgId(req)]);
    if (!contact) return res.status(404).json({ error: 'Not found' });

    const { rows: threads } = await db.query(`
      SELECT m.from_phone, m.message_body, m.created_at, m.session_expires_at,
             c.id AS contact_id, c.first_name, c.last_name, c.company
      FROM wa_inbound_messages m LEFT JOIN contacts c ON c.id=m.contact_id
      WHERE m.org_id=?
        AND (m.from_phone, m.created_at) IN (
          SELECT from_phone, MAX(created_at)
          FROM wa_inbound_messages
          WHERE org_id=?
          GROUP BY from_phone
        )
      ORDER BY m.created_at DESC`, [orgId(req), orgId(req)]);

    const { rows: messages } = await db.query(`
      SELECT * FROM wa_inbound_messages WHERE contact_id=? ORDER BY created_at ASC LIMIT 100`,
      [contact.id]);

    res.render('whatsapp/inbox/index', {
      title: `Inbox — ${contact.first_name}`, page: 'whatsapp',
      breadcrumbs: ['WhatsApp', 'Inbox', contact.first_name],
      threads, activePhone: contact.whatsapp_phone, messages, contact, user: req.user,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

module.exports = {
  phonesIndex, phoneCreate, phoneUpdate, phoneDelete, phoneQuality,
  templatesIndex, templateNewPage, templateAiGenerate, templateCreate, templateDelete, templatesSyncFromMeta,
  optInsIndex, optInRecord, optOutRecord, optInsImportSegment,
  campaignsIndex, campaignWizardStep, campaignWizardStepPost,
  campaignDetail, campaignStats, campaignStart, campaignPause, campaignResume, campaignStop,
  analyticsIndex,
  inboxIndex, inboxContact,
};
