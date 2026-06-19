const db = require('../config/db');
const { connection } = require('../config/redis');
const { getPagination } = require('../middleware/paginate');
const { parseHeaders, detectColumnMapping, importContacts } = require('../services/importService');
const { v4: uuidv4 } = require('uuid');

// Parse a filter value that may be comma-separated (multi-select) into an array
function parseMulti(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(Boolean);
  return val.split(',').map(v => v.trim()).filter(Boolean);
}

// Accepts either a req object (reads req.query) or a plain filter object
function buildContactWhere(reqOrFilters) {
  const f = reqOrFilters.query || reqOrFilters;
  const params = [];
  const clauses = [];

  const statuses = parseMulti(f.status);
  if (statuses.length) {
    params.push(statuses);
    clauses.push(`status IN (?)`);
  } else {
    clauses.push(`status != 'invalid'`);
  }

  if (f.search) {
    const p = `%${f.search}%`;
    params.push(p, p, p, p);
    clauses.push(`(email LIKE ? OR company LIKE ? OR first_name LIKE ? OR last_name LIKE ?)`);
  }

  const industries = parseMulti(f.industry);
  if (industries.length) { params.push(industries); clauses.push(`industry IN (?)`); }

  const countries = parseMulti(f.country);
  if (countries.length) { params.push(countries); clauses.push(`country IN (?)`); }

  if (f.tags) {
    const tagList = typeof f.tags === 'string' ? f.tags.split(',') : f.tags;
    tagList.forEach(tag => {
      params.push(tag);
      clauses.push(`JSON_CONTAINS(tags, JSON_QUOTE(?))`);
    });
  }

  const sources = parseMulti(f.source);
  if (sources.length) { params.push(sources); clauses.push(`source IN (?)`); }

  return { where: clauses.join(' AND '), params };
}

module.exports = {
  index: async (req, res) => {
    try {
      const { page, limit, offset } = getPagination(req, 50);
      const { where, params } = buildContactWhere(req);
      const sortAllowed = ['email', 'company', 'industry', 'country', 'created_at'];
      const sort = sortAllowed.includes(req.query.sort) ? req.query.sort : 'created_at';
      const order = (req.query.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

      const rows = (await db.query(`SELECT * FROM contacts WHERE ${where} ORDER BY ${sort} ${order} LIMIT ? OFFSET ?`, [...params, limit, offset])).rows;
      const total = (await db.query(`SELECT COUNT(*) AS count FROM contacts WHERE ${where}`, params)).rows[0].count;
      const sources = (await db.query(`SELECT DISTINCT source FROM contacts WHERE source IS NOT NULL AND source <> '' ORDER BY source ASC LIMIT 200`)).rows.map((r) => r.source);
      const industries = (await db.query(`SELECT DISTINCT industry FROM contacts WHERE industry IS NOT NULL AND industry <> '' ORDER BY industry ASC LIMIT 200`)).rows.map((r) => r.industry);
      const countries = (await db.query(`SELECT DISTINCT country FROM contacts WHERE country IS NOT NULL AND country <> '' ORDER BY country ASC LIMIT 200`)).rows.map((r) => r.country);

      res.render('contacts/index', {
        title: 'Contacts', page: 'contacts', breadcrumbs: ['Contacts'],
        contacts: rows, total, pageNo: page, limit, query: req.query, sources, industries, countries,
      });
    } catch (e) { res.status(500).send(e.message); }
  },

  newPage: async (req, res) => {
    try { res.render('contacts/new', { title: 'New Contact', page: 'contacts', breadcrumbs: ['Contacts', 'New'] }); }
    catch (e) { res.status(500).send(e.message); }
  },

  create: async (req, res) => {
    try {
      const { email, first_name, last_name, company, job_title, phone, website, industry, city, country, linkedin_url, whatsapp_phone } = req.body;
      if (!email) { req.flash('error', 'Email address is required'); return res.redirect('/contacts/new'); }
      const wa = (whatsapp_phone && String(whatsapp_phone).trim()) || null;
      await db.query(
        'INSERT INTO contacts(email, first_name, last_name, company, job_title, phone, website, industry, city, country, linkedin_url, whatsapp_phone, source, status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [email, first_name, last_name, company, job_title, phone, website, industry, city, country, linkedin_url, wa, 'manual', 'active'],
      );
      req.flash('success', `Contact ${email} added successfully`);
      res.redirect('/contacts');
    } catch (e) {
      req.flash('error', e.code === 'ER_DUP_ENTRY' ? 'A contact with this email already exists' : e.message);
      res.redirect('/contacts/new');
    }
  },

  importPage: async (req, res) => {
    try {
      const batches = (await db.query('SELECT * FROM import_batches ORDER BY created_at DESC LIMIT 3')).rows;
      res.render('contacts/import', { title: 'Import Contacts', page: 'contacts', breadcrumbs: ['Contacts', 'Import'], batches });
    } catch (e) { res.status(500).send(e.message); }
  },

  importUpload: async (req, res) => {
    try {
      if (!req.file) { req.flash('error', 'Please select a CSV or Excel file to import'); return res.redirect('/contacts/import'); }
      const ext = req.file.originalname.split('.').pop().toLowerCase();
      const parsed = await parseHeaders(req.file.path, ext);
      const mapping = await detectColumnMapping(parsed.headers, parsed.sampleRows);

      req.session.importDraft = {
        filePath:  req.file.path,
        fileType:  ext,
        headers:   parsed.headers,
        sampleRows: parsed.sampleRows,
        totalRows: parsed.totalRows || parsed.sampleRows?.length || 0,
        mapping,
        filename:  req.file.originalname,
        batchId:   null, // assigned after confirm
      };
      res.redirect('/contacts/import/confirm');
    } catch (e) { res.status(500).send(e.message); }
  },

  importConfirmPage: async (req, res) => {
    try {
      if (!req.session.importDraft) return res.redirect('/contacts/import');
      const draft = req.session.importDraft;
      const sampleRows = draft.sampleRows || draft.preview || [];

      // Build sampleData: { colHeader: [val1, val2, val3] } — used by the mapping table
      const sampleData = {};
      (draft.headers || []).forEach((h) => {
        sampleData[h] = sampleRows.map((row) => (row[h] != null ? String(row[h]).trim() : '')).filter(Boolean);
      });

      res.render('contacts/import-confirm', {
        title: 'Confirm Import',
        page: 'contacts',
        breadcrumbs: ['Contacts', 'Import', 'Confirm'],
        draft,
        filename:   draft.filename   || '',
        totalRows:  draft.totalRows  || draft.total_rows || 0,
        headers:    draft.headers    || [],
        mapping:    draft.mapping    || {},
        preview:    sampleRows,
        sampleData,
        fileType:   draft.fileType   || '',
        filePath:   draft.filePath   || '',
        batchId:    draft.batchId    || '',
      });
    } catch (e) { res.status(500).send(e.message); }
  },

  importConfirm: async (req, res) => {
    try {
      const draft = req.session.importDraft;
      if (!draft) return res.redirect('/contacts/import');

      // ── Build finalMapping from the form's dropdown selections ──────────────
      // The form sends mapping[first_name]=ContactCol, mapping[email]=EmailCol etc.
      // An empty value means "Skip" — filter those out.
      let finalMapping = {};

      if (req.body.mapping && typeof req.body.mapping === 'object') {
        // User submitted the confirm form with their manual selections
        for (const [crmField, fileCol] of Object.entries(req.body.mapping)) {
          const col = (fileCol || '').trim();
          if (col && col !== '__skip__' && draft.headers.includes(col)) {
            finalMapping[crmField] = col;
          }
        }
      } else if (req.body.mapping_json) {
        // Legacy JSON path (kept for safety)
        const parsed = JSON.parse(req.body.mapping_json);
        finalMapping = Object.fromEntries(
          Object.entries(parsed || {}).filter(([, v]) => v && draft.headers.includes(v))
        );
      } else {
        // Absolute fallback: use AI-detected mapping
        finalMapping = draft.mapping || {};
      }

      if (!finalMapping.email) return res.status(400).send('Email column mapping is required. Please map the email field.');

      // ── Determine which custom fields (unmapped columns) to include ──────────
      // customFields[] is an array of column names the user checked.
      // If nothing was checked, allowedCustomFields is empty → import no custom cols.
      const customFieldsRaw = req.body.customFields || [];
      const allowedCustomFields = Array.isArray(customFieldsRaw)
        ? customFieldsRaw
        : [customFieldsRaw];

      // Use the user-edited label if provided, otherwise strip extension from original filename
      const rawLabel = (req.body.importLabel || '').trim() || draft.filename || '';
      const importLabel = rawLabel.replace(/\.[^/.]+$/, '').trim() || rawLabel;

      const newBatchId = uuidv4();
      await db.query('INSERT INTO import_batches(id, filename, status, uploaded_by, column_mapping) VALUES(?,?,?,?,?)', [newBatchId, importLabel, 'processing', req.user.id, JSON.stringify(finalMapping)]);
      const batch = { id: newBatchId };

      const duplicateStrategy = (req.body.duplicateHandling || req.body.duplicate_strategy) === 'skip' ? 'skip' : 'update';
      await connection.set(`import:${batch.id}`, JSON.stringify({
        total: 0,
        imported: 0,
        duplicates: 0,
        skipped_invalid_email: 0,
        errors: 0,
        status: 'processing',
        last_error: null,
      }), 'EX', 3600);

      importContacts(draft.filePath, draft.fileType, finalMapping, batch.id, req.user.id, {
        source: importLabel,
        duplicateStrategy,
        allowedCustomFields,   // pass user's checkbox selection to the import service
      }).catch(async (err) => {
        await db.query('UPDATE import_batches SET status=?, completed_at=NOW() WHERE id=?', ['failed', batch.id]);
        await connection.set(`import:${batch.id}`, JSON.stringify({ status: 'failed', error: err.message }), 'EX', 3600);
      });

      delete req.session.importDraft;
      res.redirect(`/contacts/import/progress/${batch.id}`);
    } catch (e) { res.status(500).send(e.message); }
  },

  importProgressPage: async (req, res) => {
    try { res.render('contacts/import-progress', { title: 'Import Progress', page: 'contacts', breadcrumbs: ['Contacts', 'Import', 'Progress'], batchId: req.params.batchId }); }
    catch (e) { res.status(500).send(e.message); }
  },

  importProgressSSE: async (req, res) => {
    try {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const timer = setInterval(async () => {
        const data = await connection.get(`import:${req.params.batchId}`);
        if (data) {
          res.write(`data: ${data}\n\n`);
          return;
        }
        const b = (await db.query('SELECT total_rows, imported_rows, duplicate_rows, error_rows, status FROM import_batches WHERE id=?', [req.params.batchId])).rows[0];
        if (!b) {
          res.write(`data: ${JSON.stringify({ status: 'processing', imported: 0, total: 0, duplicates: 0, errors: 0 })}\n\n`);
          return;
        }
        res.write(`data: ${JSON.stringify({
          status: b.status || 'processing',
          imported: b.imported_rows || 0,
          total: b.total_rows || 0,
          duplicates: b.duplicate_rows || 0,
          errors: b.error_rows || 0,
        })}\n\n`);
      }, 1000);

      req.on('close', () => { clearInterval(timer); res.end(); });
    } catch (e) { res.status(500).end(); }
  },

  importProgressStatus: async (req, res) => {
    try {
      let progress = null;
      const redis = await connection.get(`import:${req.params.batchId}`);
      if (redis) progress = JSON.parse(redis);
      if (!progress) {
        const b = (await db.query('SELECT id, total_rows, imported_rows, duplicate_rows, error_rows, skipped_rows, status, error_log FROM import_batches WHERE id=?', [req.params.batchId])).rows[0];
        if (!b) return res.status(404).json({ error: 'Batch not found' });
        progress = {
          status:                b.status         || 'processing',
          imported:              b.imported_rows  || 0,
          total:                 b.total_rows     || 0,
          duplicates:            b.duplicate_rows || 0,
          errors:                b.error_rows     || 0,
          skipped_invalid_email: b.skipped_rows   || 0,
          last_error:            b.error_log?.error || null,
        };
      }

      const contacts = (await db.query(
        `SELECT id, first_name, last_name, email, company, created_at
         FROM contacts
         WHERE import_batch_id=?
         ORDER BY created_at DESC
         LIMIT 100`,
        [req.params.batchId]
      )).rows;

      res.json({ progress, contacts });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },

  detail: async (req, res) => {
    try {
      const contact = (await db.query('SELECT * FROM contacts WHERE id=?', [req.params.id])).rows[0];
      if (!contact) return res.status(404).send('Contact not found');
      const history = (await db.query('SELECT cc.*, c.name AS campaign_name FROM campaign_contacts cc JOIN campaigns c ON c.id = cc.campaign_id WHERE cc.contact_id=? ORDER BY cc.created_at DESC', [req.params.id])).rows;
      const events = (await db.query(`
        SELECT ee.*, c.name AS campaign_name
        FROM email_events ee
        LEFT JOIN campaigns c ON c.id = ee.campaign_id
        WHERE ee.contact_id=?
        ORDER BY ee.created_at DESC LIMIT 50`, [req.params.id])).rows;
      const similar = (await db.query('SELECT id, first_name, last_name, email, company FROM contacts WHERE company = ? AND id <> ? ORDER BY created_at DESC LIMIT 10', [contact.company || '', contact.id])).rows;

      // Enrichment data
      const enrichmentRow = (await db.query('SELECT * FROM contact_enrichments WHERE contact_id=?', [req.params.id])).rows[0] || null;
      const fieldMeta = {};
      if (enrichmentRow?.field_confidence) {
        for (const [field, conf] of Object.entries(enrichmentRow.field_confidence)) {
          fieldMeta[field] = {
            confidence: conf.score,
            verifiedAt: conf.verified_at,
            sourceUrl: enrichmentRow.field_sources?.[field]?.url || null,
            snippet:   enrichmentRow.field_sources?.[field]?.snippet || null,
          };
        }
      }

      res.render('contacts/detail', {
        title: 'Contact Detail', page: 'contacts',
        breadcrumbs: ['Contacts', contact.email],
        contact, history, events, similar,
        enrichment: enrichmentRow,
        fieldMeta,
      });
    } catch (e) { res.status(500).send(e.message); }
  },

  editPage: async (req, res) => {
    try {
      const contact = (await db.query('SELECT * FROM contacts WHERE id=?', [req.params.id])).rows[0];
      if (!contact) return res.status(404).send('Contact not found');
      res.render('contacts/edit', { title: 'Edit Contact', page: 'contacts', breadcrumbs: ['Contacts', 'Edit'], contact });
    } catch (e) { res.status(500).send(e.message); }
  },

  update: async (req, res) => {
    try {
      const { email, first_name, last_name, company, job_title, phone, website, industry, city, country, linkedin_url, status, whatsapp_phone } = req.body;
      const wa = (whatsapp_phone && String(whatsapp_phone).trim()) || null;
      await db.query(
        'UPDATE contacts SET email=?, first_name=?, last_name=?, company=?, job_title=?, phone=?, website=?, industry=?, city=?, country=?, linkedin_url=?, status=?, whatsapp_phone=?, updated_at=NOW() WHERE id=?',
        [email, first_name, last_name, company, job_title, phone, website, industry, city, country, linkedin_url, status || 'active', wa, req.params.id],
      );
      req.flash('success', 'Contact updated successfully');
      res.redirect(`/contacts/${req.params.id}`);
    } catch (e) {
      req.flash('error', e.message);
      res.redirect(`/contacts/${req.params.id}/edit`);
    }
  },

  updateCustomFields: async (req, res) => {
    try {
      // Expect body: { fields: [{key, value}, ...] }  (array from client)
      // or body: { key: 'fieldName', value: 'fieldValue', action: 'set'|'delete' }  (single op)
      const contact = (await db.query('SELECT custom_fields FROM contacts WHERE id=?', [req.params.id])).rows[0];
      if (!contact) return res.status(404).json({ error: 'Contact not found' });

      let cf = contact.custom_fields || {};

      if (req.body.action === 'delete') {
        // Delete single key
        const key = (req.body.key || '').trim();
        if (key) delete cf[key];
      } else if (Array.isArray(req.body.fields)) {
        // Full replace from form submission: array of {key, value} pairs
        cf = {};
        for (const f of req.body.fields) {
          const k = (f.key || '').trim();
          if (k) cf[k] = (f.value || '').trim();
        }
      } else if (req.body.key) {
        // Single upsert
        const key = (req.body.key || '').trim();
        if (key) cf[key] = (req.body.value || '').trim();
      }

      await db.query('UPDATE contacts SET custom_fields=?, updated_at=NOW() WHERE id=?', [JSON.stringify(cf), req.params.id]);
      return res.json({ ok: true, custom_fields: cf });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  },

  remove: async (req, res) => {
    try {
      await db.query("UPDATE contacts SET status='invalid', updated_at=NOW() WHERE id=?", [req.params.id]);
      req.flash('success', 'Contact deleted');
      res.redirect('/contacts');
    } catch (e) {
      req.flash('error', e.message);
      res.redirect('/contacts');
    }
  },

  bulkDelete: async (req, res) => {
    try {
      if (req.body.selectAll === 'true' || req.body.selectAll === true) {
        const filters = req.body.filters || {};
        const { where, params } = buildContactWhere(filters);
        await db.query(`UPDATE contacts SET status='invalid', updated_at=NOW() WHERE ${where}`, params);
        return res.json({ ok: true, all: true });
      }
      const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
      if (!ids.length) return res.status(400).json({ error: 'ids required' });
      await db.query("UPDATE contacts SET status='invalid', updated_at=NOW() WHERE id IN (?)", [ids]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  },

  bulkTag: async (req, res) => {
    try {
      const tag = (req.body.tag || '').trim();
      if (!tag) return res.status(400).json({ error: 'tag required' });

      if (req.body.selectAll === 'true' || req.body.selectAll === true) {
        const filters = req.body.filters || {};
        const { where, params } = buildContactWhere(filters);
        await db.query(
          `UPDATE contacts SET tags = JSON_ARRAY_APPEND(COALESCE(tags, JSON_ARRAY()), '$', ?), updated_at=NOW()
           WHERE ${where} AND NOT JSON_CONTAINS(COALESCE(tags, JSON_ARRAY()), JSON_QUOTE(?))`,
          [...params, tag, tag],
        );
        return res.json({ ok: true, all: true });
      }

      const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
      if (!ids.length || !tag) return res.status(400).json({ error: 'ids and tag required' });
      await db.query(
        'UPDATE contacts SET tags = JSON_ARRAY_APPEND(COALESCE(tags, JSON_ARRAY()), \'$\', ?), updated_at=NOW() WHERE id IN (?) AND NOT JSON_CONTAINS(COALESCE(tags, JSON_ARRAY()), JSON_QUOTE(?))',
        [tag, ids, tag]
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  },

  exportCSV: async (req, res) => {
    try {
      const { where, params } = buildContactWhere(req);
      const rows = (await db.query(`SELECT email, first_name, last_name, company, industry, country, status, created_at FROM contacts WHERE ${where} ORDER BY created_at DESC`, params)).rows;
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
      res.write('email,first_name,last_name,company,industry,country,status,created_at\n');
      rows.forEach((r) => {
        const line = [r.email, r.first_name, r.last_name, r.company, r.industry, r.country, r.status, r.created_at].map((v) => `"${String(v || '').replace(/"/g, '""')}"`).join(',');
        res.write(`${line}\n`);
      });
      res.end();
    } catch (e) { res.status(500).send(e.message); }
  },
};
