'use strict';
const express = require('express');
const router  = express.Router();
const c       = require('../controllers/templateController');
const { requirePermission } = require('../middleware/rbac');
const ai      = require('../services/aiService');

const DEFAULT_ORG = '00000000-0000-0000-0000-000000000001';

router.get('/',     requirePermission('templates.view'),   c.index);
router.get('/new',  requirePermission('templates.create'), c.newPage);
router.post('/',    requirePermission('templates.create'), c.create);
router.post('/preview', requirePermission('templates.view'), c.preview);

// AI template generator
router.post('/ai-generate', requirePermission('templates.create'), async (req, res) => {
  try {
    const orgId  = req.org?.id || DEFAULT_ORG;
    const result = await ai.generateTemplate(req.body, orgId, req.user.id);
    req.flash('success', 'AI template generated successfully');
    res.redirect(`/templates/${result.templateId}/edit`);
  } catch (err) {
    req.flash('error', err.message || 'AI generation failed');
    res.redirect('/templates/new');
  }
});

router.post('/:id/preview', requirePermission('templates.view'), c.preview);

// Safety net: handle _method=DELETE / _method=PUT from HTML forms
router.post('/:id', (req, res, next) => {
  const method = (req.body._method || '').toUpperCase();
  if (method === 'DELETE') {
    req.method = 'DELETE';
    return router.handle(req, res, next);
  }
  if (method === 'PUT' || method === 'PATCH') {
    req.method = 'PUT';
    return router.handle(req, res, next);
  }
  next();
});

router.get('/:id/edit',     requirePermission('templates.edit'),   c.editPage);
router.put('/:id',          requirePermission('templates.edit'),   c.update);
router.delete('/:id',       requirePermission('templates.delete'), c.remove);

// A/B variants list
router.get('/:id/variants', requirePermission('templates.view'), async (req, res) => {
  try {
    const rows = await require('../config/db').query(
      `SELECT id, name, variant_label, subject, ai_generated, created_at
       FROM templates WHERE parent_id=? ORDER BY variant_label`,
      [req.params.id],
    );
    res.json({ variants: rows.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', requirePermission('templates.view'), c.detail);

module.exports = router;
