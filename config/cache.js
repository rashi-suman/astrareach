'use strict';
const { connection: redis } = require('./redis');

// TTL constants (seconds)
const TTL = {
  USER:           5  * 60,   // 5 min   — session user + role
  FIELD_PERMS:    30 * 60,   // 30 min  — field visibility per role
  SEGMENT_COUNT:  10 * 60,   // 10 min  — segment contact count
  CAMPAIGN_STATS: 30,        // 30 sec  — live campaign stats
  PROVIDER_QUOTA: 24 * 3600, // 24 h    — email provider daily quota
  IMPORT:         2  * 3600, // 2 h     — import progress
  AI_ANALYSIS:    1  * 3600, // 1 h     — Claude analysis result
  CONTACT_SEARCH: 2  * 60,   // 2 min   — search result cache
};

function keys(orgId) {
  return {
    user:           (userId)              => `user:${userId}`,
    fieldPerms:     (role, table)         => `field_perms:${orgId}:${role}:${table}`,
    segmentCount:   (segId)               => `segment_count:${segId}`,
    campaignStats:  (campaignId)          => `campaign_stats:${campaignId}`,
    providerQuota:  (provider, dateStr)   => `provider_quota:${provider}:${dateStr}`,
    providerRate:   (provider)            => `provider_rate:${provider}`,
    import:         (batchId)             => `import:${batchId}`,
    aiAnalysis:     (campaignId)          => `ai_analysis:${campaignId}`,
    contactSearch:  (hash)                => `contact_search:${hash}`,
    providerHealth: (provider)            => `provider_health:${provider}`,
  };
}

async function getJSON(key) {
  const raw = await redis.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function setJSON(key, value, ttlSeconds) {
  await redis.setex(key, ttlSeconds, JSON.stringify(value));
}

async function del(key) {
  await redis.del(key);
}

async function delPattern(pattern) {
  const found = await redis.keys(pattern);
  if (found.length > 0) await redis.del(...found);
}

module.exports = { TTL, keys, getJSON, setJSON, del, delPattern };
