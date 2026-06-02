'use strict';
const { Queue }     = require('bullmq');
const { connection } = require('../config/redis');

const waQueue = new Queue('whatsapp', {
  connection,
  defaultJobOptions: {
    attempts:         5,
    backoff:          { type: 'exponential', delay: 30000 },
    removeOnComplete: 500,
    removeOnFail:     2000,
  },
});

const waEventsQueue = new Queue('whatsapp-events', {
  connection,
  defaultJobOptions: {
    attempts:         3,
    removeOnComplete: 100,
    removeOnFail:     500,
  },
});

function getTodayStr() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Add a campaign contact to the WhatsApp send queue.
 * Calculates per-phone-number send delay based on tier to avoid per-second limit errors.
 * @param {string} campaignContactId - wa_campaign_contacts.id
 * @param {string} phoneNumberId     - wa_phone_numbers.phone_number_id (Meta's ID)
 * @param {number} tier              - phone tier: 1|2|3|4
 * @param {number} scheduledDelay    - ms to wait before even considering rate limiting (scheduled start)
 */
async function addToWaQueue(campaignContactId, phoneNumberId, tier = 1, scheduledDelay = 0) {
  const msgsPerSec = { 1: 1, 2: 3, 3: 10, 4: 20 }[tier] || 1;

  // Atomic counter for position in today's queue for this phone number
  const posKey  = `waqpos:${phoneNumberId}:${getTodayStr()}`;
  const position = await connection.incr(posKey);
  await connection.expire(posKey, 86400);

  // Space out messages: position 1 → 0ms delay, position 2 → 1000/msgsPerSec ms, etc.
  const rateDelayMs = Math.floor((position - 1) / msgsPerSec) * 1000;
  const totalDelay  = scheduledDelay + rateDelayMs;

  return waQueue.add(
    'send',
    { campaignContactId, phoneNumberId },
    { delay: totalDelay, priority: 5 },
  );
}

module.exports = { waQueue, waEventsQueue, addToWaQueue };
