'use strict';
const { Queue } = require('bullmq');
const { connection } = require('../config/redis');

const QUEUES = {
  research: new Queue('research', {
    connection,
    defaultJobOptions: {
      attempts:         3,
      backoff:          { type: 'exponential', delay: 60000 },
      removeOnComplete: 100,
      removeOnFail:     500,
    },
  }),

  personalize: new Queue('personalize', {
    connection,
    defaultJobOptions: {
      attempts:         3,
      backoff:          { type: 'exponential', delay: 30000 },
      removeOnComplete: 100,
      removeOnFail:     500,
    },
  }),

  send: new Queue('send', {
    connection,
    defaultJobOptions: {
      attempts:         5,
      backoff:          { type: 'exponential', delay: 10000 },
      removeOnComplete: 200,
      removeOnFail:     1000,
    },
  }),

  // High-priority webhook events — must process fast
  events: new Queue('events', {
    connection,
    defaultJobOptions: {
      attempts:         5,
      removeOnComplete: 50,
    },
  }),

  // Lower-priority AI batch jobs
  ai: new Queue('ai-jobs', {
    connection,
    defaultJobOptions: {
      attempts:         2,
      removeOnComplete: 20,
    },
  }),

  // AI Contact Enrichment
  enrichment: new Queue('enrichment', {
    connection,
    defaultJobOptions: {
      attempts:         3,
      backoff:          { type: 'exponential', delay: 120000 },
      removeOnComplete: 500,
      removeOnFail:     1000,
    },
  }),
};

module.exports = {
  researchQueue:    QUEUES.research,
  personalizeQueue: QUEUES.personalize,
  sendQueue:        QUEUES.send,
  eventsQueue:      QUEUES.events,
  aiQueue:          QUEUES.ai,
  enrichmentQueue:  QUEUES.enrichment,
};
