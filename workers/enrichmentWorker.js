'use strict';

const { Worker } = require('bullmq');
const { connection } = require('../config/redis');
const { connection: redis } = require('../config/redis');
const { enrichContact } = require('../services/enrichmentService');

// Re-export the queue from queueService for controller use
const { enrichmentQueue } = require('../services/queueService');

// Worker — max 5 concurrent Claude calls, rate-limited to 50/min
const enrichmentWorker = new Worker('enrichment', async (job) => {
  const { contactId, orgId, enrichmentJobId } = job.data;
  if (!contactId) return;

  // Update Redis progress hash
  const redisKey = enrichmentJobId ? `enrichjob:${enrichmentJobId}` : null;
  if (redisKey) {
    await redis.hset(redisKey, 'current_contact', contactId, 'status', 'running');
    await redis.expire(redisKey, 86400); // 24h TTL
  }

  try {
    const result = await enrichContact(contactId, orgId, enrichmentJobId);

    if (redisKey) {
      await redis.hincrby(redisKey, 'completed', 1);
      // Check if job is fully done
      const hash = await redis.hgetall(redisKey);
      if (hash && parseInt(hash.completed || 0) + parseInt(hash.failed || 0) >= parseInt(hash.total || 0)) {
        await redis.hset(redisKey, 'status', 'completed');
        // Mark DB job completed
        if (enrichmentJobId) {
          await require('../config/db').query(
            "UPDATE enrichment_jobs SET status='completed', completed_at=NOW() WHERE id=?",
            [enrichmentJobId]
          );
        }
      }
    }

    return result;
  } catch (err) {
    if (redisKey) await redis.hincrby(redisKey, 'failed', 1);
    throw err; // BullMQ handles retry
  }
}, {
  connection,
  concurrency: parseInt(process.env.ENRICHMENT_CONCURRENCY || '5', 10),
  limiter: {
    max:      parseInt(process.env.ENRICHMENT_RATE_PER_MINUTE || '50', 10),
    duration: 60000,
  },
});

enrichmentWorker.on('completed', (job) => {
  console.log(`[enrichmentWorker] Job ${job.id} completed for contact ${job.data.contactId}`);
});

enrichmentWorker.on('failed', (job, err) => {
  if (!err.message?.includes('not in the active state') && !err.message?.includes('Missing lock')) {
    console.error(`[enrichmentWorker] Job ${job?.id} failed: ${err.message}`);
  }
});

enrichmentWorker.on('error', (err) => {
  if (err.code === -3 || err.code === -2 || err.message?.includes('not in the active state') || err.message?.includes('Missing lock')) return;
  console.error('[enrichmentWorker] worker error:', err.message);
});

module.exports = { enrichmentQueue };
