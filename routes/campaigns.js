'use strict';
const express = require('express');
const router  = express.Router();
const c       = require('../controllers/campaignController');
const { requirePermission } = require('../middleware/rbac');
const { logAction }         = require('../middleware/audit');
const ai      = require('../services/aiService');
const { aiQueue } = require('../services/queueService');

const DEFAULT_ORG = '00000000-0000-0000-0000-000000000001';

router.get('/',           requirePermission('campaigns.view'),   c.index);
router.get('/new',        requirePermission('campaigns.create'), c.newRedirect);
router.get('/new/step/:n',requirePermission('campaigns.create'), c.stepPage);
router.post('/new/step/1',requirePermission('campaigns.create'), c.step1);
router.post('/new/step/2',requirePermission('campaigns.create'), c.step2);
router.post('/new/step/3',requirePermission('campaigns.create'), c.step3);
router.post('/new/step/4',requirePermission('campaigns.create'), logAction('campaign.create','campaign'), c.step4);

router.get('/:id/stats',       requirePermission('campaigns.view'), c.stats);
router.get('/:id/events-chart',requirePermission('campaigns.view'), c.eventsChart);

router.post('/:id/start',  requirePermission('campaigns.edit'), logAction('campaign.start','campaign'), c.start);
router.post('/:id/pause',  requirePermission('campaigns.edit'), logAction('campaign.pause','campaign'), c.pause);
router.post('/:id/resume', requirePermission('campaigns.edit'), logAction('campaign.resume','campaign'), c.resume);
router.post('/:id/stop',   requirePermission('campaigns.edit'), logAction('campaign.stop','campaign'),  c.stop);
router.delete('/:id',      requirePermission('campaigns.delete'), logAction('campaign.delete','campaign'), c.remove);

// Safety net: handle _method=DELETE from HTML forms (method-override fallback)
router.post('/:id', (req, res, next) => {
  const method = (req.body._method || '').toUpperCase();
  if (method === 'DELETE') {
    req.method = 'DELETE';
    return router.handle(req, res, next);
  }
  next();
});

router.get('/:id/contact/:campaignContactId/email', requirePermission('campaigns.view'), c.contactEmailPreview);

// AI Campaign Analysis (cached 1h)
router.get('/:id/ai-analysis', requirePermission('analytics.view'), async (req, res) => {
  try {
    const orgId  = req.org?.id || DEFAULT_ORG;
    const result = await ai.analyzeCampaignPerformance(req.params.id, orgId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// AI A/B variant generator
router.post('/:id/generate-ab', requirePermission('campaigns.edit'), async (req, res) => {
  try {
    const orgId = req.org?.id || DEFAULT_ORG;
    // Get template_id from campaign
    const { rows } = await require('../config/db').query(
      'SELECT template_id FROM campaigns WHERE id=$1', [req.params.id],
    );
    if (!rows.length || !rows[0].template_id) {
      return res.status(400).json({ error: 'Campaign has no template' });
    }
    await aiQueue.add('ai-ab', {
      type: 'generate_ab',
      templateId: rows[0].template_id,
      objective: req.body.objective || 'improve open rate',
    });
    res.json({ queued: true, message: 'A/B variants being generated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', requirePermission('campaigns.view'), c.detail);

module.exports = router;
