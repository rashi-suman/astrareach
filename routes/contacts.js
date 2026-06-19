'use strict';
const express = require('express');
const router  = express.Router();
const upload  = require('../middleware/upload');
const c       = require('../controllers/contactController');
const { requirePermission, applyFieldFilter } = require('../middleware/rbac');
const { logAction } = require('../middleware/audit');
const ai      = require('../services/aiService');
const { aiQueue } = require('../services/queueService');
const db      = require('../config/db');

const DEFAULT_ORG = '00000000-0000-0000-0000-000000000001';

router.get('/',   requirePermission('contacts.view'), applyFieldFilter('contacts'), c.index);
router.get('/new', requirePermission('contacts.create'), c.newPage);
router.post('/',  requirePermission('contacts.create'), logAction('contact.create','contact'), c.create);

// Fast search endpoint for campaign audience picker
router.get('/search', requirePermission('contacts.view'), async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const like = `%${q}%`;
    const tags = q.split(',').map(t => t.trim()).filter(Boolean);
    // Build a JSON_CONTAINS check for each tag, OR-ed together
    let tagConditions = '';
    const tagParams = [];
    if (tags.length > 0) {
      tagConditions = tags.map(() => 'JSON_CONTAINS(tags, JSON_QUOTE(?))').join(' OR ');
      tags.forEach(t => tagParams.push(t));
    }
    const baseParams = [like, like, like, like];
    let sql = `SELECT id, first_name, last_name, email, company, job_title, tags, status
       FROM contacts
       WHERE status != 'invalid'
         AND (email LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR company LIKE ?`;
    if (tagConditions) {
      sql += `\n              OR (${tagConditions})`;
    }
    sql += `)\n       ORDER BY first_name, last_name\n       LIMIT 30`;
    const rows = (await require('../config/db').query(sql, [...baseParams, ...tagParams])).rows;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/import',         requirePermission('import.create'), c.importPage);
router.post('/import',        requirePermission('import.create'), upload.single('file'), c.importUpload);
router.get('/import/confirm', requirePermission('import.create'), c.importConfirmPage);
router.post('/import/confirm',requirePermission('import.create'), c.importConfirm);
router.get('/import/progress/:batchId', requirePermission('import.create'), c.importProgressPage);
router.get('/import/:batchId/progress', requirePermission('import.create'), c.importProgressSSE);
router.get('/import/:batchId/status',   requirePermission('import.create'), c.importProgressStatus);

// Delete an import batch and all its contacts (idempotent — safe to retry)
router.delete('/import/:batchId', requirePermission('import.create'), async (req, res) => {
  const { batchId } = req.params;
  try {
    const batch = await db.query('SELECT id, filename FROM import_batches WHERE id=?', [batchId]);
    if (!batch.rows.length) return res.status(404).json({ error: 'Batch not found' });
    await db.query('DELETE FROM contacts WHERE import_batch_id=?', [batchId]);
    await db.query('DELETE FROM import_batches WHERE id=?', [batchId]);
    res.json({ ok: true, message: `Import "${batch.rows[0].filename}" and all its contacts have been removed.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export is restricted to admin and superadmin only — blocked at both route and UI level
router.get('/export', requirePermission('export.*'), async (req, res, next) => {
  const role = req.user?.role;
  if (role !== 'admin' && role !== 'superadmin') {
    return res.status(403).json({ error: 'Export is only available to Admin and Super Admin users.' });
  }
  next();
}, logAction('contact.export', 'contact'), c.exportCSV);
router.post('/bulk-delete', requirePermission('contacts.delete'), logAction('contact.bulk_delete','contact'), c.bulkDelete);
router.post('/bulk-tag',    requirePermission('contacts.edit'),   c.bulkTag);
router.post('/bulk/assign-campaign', requirePermission('campaigns.edit'), async (req, res) => {
  const { contactIds, campaignId } = req.body;
  if (!contactIds || !campaignId) return res.status(400).json({ error: 'contactIds and campaignId required' });
  const ids = Array.isArray(contactIds) ? contactIds : [contactIds];
  let added = 0;
  for (const cid of ids) {
    try {
      await db.query(
        `INSERT IGNORE INTO campaign_contacts (campaign_id, contact_id, org_id)
         VALUES (?,?,?)`,
        [campaignId, cid, req.org?.id || DEFAULT_ORG],
      );
      added++;
    } catch { /* skip duplicates */ }
  }
  res.json({ added });
});

// AI: create segment from natural language
router.post('/ai-segment', requirePermission('segments.create'), async (req, res) => {
  try {
    const orgId = req.org?.id || DEFAULT_ORG;
    const result = await ai.buildSegmentFromQuery(req.body.query, orgId);
    req.flash('success', `AI segment created with ${result.rules.length} filters`);
    res.redirect(`/segments/${result.segmentId}`);
  } catch (err) {
    req.flash('error', err.message);
    res.redirect('/contacts');
  }
});

// Safety net: if method-override didn't fire (body not yet parsed, misconfigured proxy, etc.)
// this catches raw POST to /:id and re-routes to the correct verb handler
router.post('/:id/enrichment', (req, res, next) => {
  const override = (req.body._method || '').toUpperCase();
  if (override === 'DELETE') {
    return require('../controllers/enrichmentController').deleteEnrichment(req, res, next);
  }
  next();
});

router.post('/:id/custom-fields', requirePermission('contacts.edit'), c.updateCustomFields);

router.post('/:id', requirePermission('contacts.edit'), (req, res, next) => {
  const override = (req.body._method || '').toUpperCase();
  if (override === 'DELETE') {
    return c.remove(req, res, next);
  }
  if (override === 'PUT') {
    return c.update(req, res, next);
  }
  // Unknown — just redirect back
  res.redirect(`/contacts/${req.params.id}`);
});

router.get('/:id',      requirePermission('contacts.view'), applyFieldFilter('contacts'), c.detail);
router.get('/:id/edit', requirePermission('contacts.edit'), c.editPage);
router.put('/:id',      requirePermission('contacts.edit'), logAction('contact.update','contact'), c.update);
router.delete('/:id',   requirePermission('contacts.delete'), logAction('contact.delete','contact'), c.remove);

// Trigger AI rescore
router.post('/:id/rescore', requirePermission('contacts.edit'), async (req, res) => {
  try {
    const orgId = req.org?.id || DEFAULT_ORG;
    await aiQueue.add('ai-rescore', { type: 'score', contactId: req.params.id, orgId });
    res.json({ queued: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Contact event timeline (JSON)
router.get('/:id/timeline', requirePermission('contacts.view'), async (req, res) => {
  try {
    const events = await db.query(
      `SELECT ee.event_type, ee.created_at, ee.url, ee.metadata,
              cam.name AS campaign_name
       FROM email_events ee
       LEFT JOIN campaigns cam ON cam.id = ee.campaign_id
       WHERE ee.contact_id=?
       ORDER BY ee.created_at DESC LIMIT 100`,
      [req.params.id],
    );
    res.json({ events: events.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
