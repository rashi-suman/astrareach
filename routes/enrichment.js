'use strict';

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/enrichmentController');

// All routes require auth (applied via protect middleware in app.js)

// Single contact enrichment
router.post('/contacts/:id/enrich',    ctrl.enrichSingle);
router.delete('/contacts/:id/enrichment', ctrl.deleteEnrichment);
router.get('/contacts/:id/enrichment', ctrl.getEnrichment);

// Bulk enrichment
router.post('/bulk-enrich', ctrl.enrichBulk);

// SSE progress stream
router.get('/job/:jobId/progress', ctrl.jobProgress);

// Progress HTML page
router.get('/job/:jobId', ctrl.progressPage);

// Admin stats
router.get('/stats', ctrl.stats);

module.exports = router;
