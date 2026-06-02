'use strict';
const express = require('express');
const router  = express.Router();
const wc      = require('../controllers/whatsappController');

// Phone numbers
router.get('/phones',            wc.phonesIndex);
router.post('/phones',           wc.phoneCreate);
router.put('/phones/:id',        wc.phoneUpdate);
router.delete('/phones/:id',     wc.phoneDelete);
router.get('/phones/:id/quality',wc.phoneQuality);

// Templates
router.get('/templates',         wc.templatesIndex);
router.get('/templates/new',     wc.templateNewPage);
router.post('/templates/ai-generate', wc.templateAiGenerate);
router.post('/templates',        wc.templateCreate);
router.post('/templates/sync',   wc.templatesSyncFromMeta);
router.delete('/templates/:id',  wc.templateDelete);

// Opt-ins
router.get('/optins',                        wc.optInsIndex);
router.post('/optins/import-segment',       wc.optInsImportSegment);
router.post('/optins/:contactId/optin',      wc.optInRecord);
router.post('/optins/:contactId/optout',     wc.optOutRecord);

// Campaigns
router.get('/campaigns',                     wc.campaignsIndex);
router.get('/campaigns/new/step/:step',      wc.campaignWizardStep);
router.post('/campaigns/new/step/:step',     wc.campaignWizardStepPost);
router.get('/campaigns/:id',                 wc.campaignDetail);
router.get('/campaigns/:id/stats',           wc.campaignStats);
router.post('/campaigns/:id/start',          wc.campaignStart);
router.post('/campaigns/:id/pause',          wc.campaignPause);
router.post('/campaigns/:id/resume',         wc.campaignResume);
router.post('/campaigns/:id/stop',           wc.campaignStop);

// Analytics
router.get('/analytics',                     wc.analyticsIndex);

// Inbox
router.get('/inbox',                         wc.inboxIndex);
router.get('/inbox/:contactId',              wc.inboxContact);

module.exports = router;
