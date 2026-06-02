'use strict';
const { Worker } = require('bullmq');
const { connection }      = require('../config/redis');
const db                  = require('../config/db');
const ai                  = require('../services/aiService');
const { personalizeQueue, sendQueue } = require('../services/queueService');

const DEFAULT_ORG = '00000000-0000-0000-0000-000000000001';

// ---- Research worker ----
new Worker('research', async (job) => {
  const { contact, campaignContactId, template, campaign, orgId } = job.data;
  try {
    await ai.researchContact(contact);
  } catch (err) {
    console.error('[research worker]', err.message);
  }
  await personalizeQueue.add('personalize', {
    contact, campaignContactId, template, campaign,
    orgId: orgId || DEFAULT_ORG,
  }, { attempts: 3, backoff: { type: 'exponential', delay: 60000 } });
}, { connection, concurrency: 5 });

// ---- Personalize worker ----
new Worker('personalize', async (job) => {
  const { contact, campaignContactId, template, campaign, orgId } = job.data;

  let personalized = { subject: template.subject, body_html: template.body_html };
  try {
    const result = await ai.personalizeEmail(contact, template, campaign);
    if (result?.subject) personalized = result;
  } catch (err) {
    console.error('[personalize worker]', err.message);
  }

  await db.query(
    `UPDATE campaign_contacts
     SET personalized_subject=$1, personalized_body_html=$2, status='ready'
     WHERE id=$3`,
    [personalized.subject, personalized.body_html, campaignContactId],
  );

  await sendQueue.add('send', {
    campaignContactId,
    orgId: orgId || DEFAULT_ORG,
  }, { delay: 500, attempts: 5, backoff: { type: 'exponential', delay: 10000 } });

}, { connection, concurrency: 8 });
