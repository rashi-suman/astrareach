'use strict';
const { Worker } = require('bullmq');
const { connection } = require('../config/redis');
const db        = require('../config/db');
const aiService = require('../services/aiService');

const DEFAULT_ORG = '00000000-0000-0000-0000-000000000001';

new Worker('ai-jobs', async (job) => {
  const { type } = job.data;

  switch (type) {

    case 'score': {
      const { contactId, orgId = DEFAULT_ORG } = job.data;
      const contactRow = await db.query('SELECT * FROM contacts WHERE id=$1', [contactId]);
      if (!contactRow.rows.length) return;
      const orgRow = await db.query('SELECT * FROM organisations WHERE id=$1', [orgId]);
      await aiService.scoreContact(contactRow.rows[0], orgRow.rows[0]);
      break;
    }

    case 'score_batch': {
      const { orgId = DEFAULT_ORG, limit = 100 } = job.data;
      const contacts = await db.query(
        `SELECT * FROM contacts
         WHERE org_id=$1 AND status='active' AND ai_score IS NULL
         LIMIT $2`,
        [orgId, limit],
      );
      const orgRow = await db.query('SELECT * FROM organisations WHERE id=$1', [orgId]);
      for (const c of contacts.rows) {
        try {
          await aiService.scoreContact(c, orgRow.rows[0]);
          await new Promise(r => setTimeout(r, 300)); // Claude rate limiting
        } catch (err) {
          console.error(`[aiWorker] score_batch contact ${c.id}:`, err.message);
        }
      }
      break;
    }

    case 'generate_icp': {
      const { orgId = DEFAULT_ORG } = job.data;
      await aiService.generateICPFromTopContacts(orgId);
      break;
    }

    case 'generate_template': {
      const { brief, orgId = DEFAULT_ORG, userId } = job.data;
      await aiService.generateTemplate(brief, orgId, userId);
      break;
    }

    case 'generate_ab': {
      const { templateId, objective } = job.data;
      await aiService.generateABVariants(templateId, objective);
      break;
    }

    case 'analyze_campaign': {
      const { campaignId, orgId = DEFAULT_ORG } = job.data;
      await aiService.analyzeCampaignPerformance(campaignId, orgId);
      break;
    }

    case 'ai_segment': {
      const { query, orgId = DEFAULT_ORG } = job.data;
      await aiService.buildSegmentFromQuery(query, orgId);
      break;
    }

    default:
      console.warn('[aiWorker] Unknown job type:', type);
  }

}, { connection, concurrency: 3 });

process.on('SIGTERM', () => process.exit(0));
