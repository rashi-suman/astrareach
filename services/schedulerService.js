'use strict';
const cron  = require('node-cron');
const db    = require('../config/db');
const { connection: redis } = require('../config/redis');
const { flushAuditBuffer } = require('../middleware/rbac');
const { clockHHMMInZone } = require('../utils/scheduleHelpers');

const DEFAULT_ORG = '00000000-0000-0000-0000-000000000001';

// Lazy import to avoid circular deps at startup
function queues() { return require('./queueService'); }

// ---------------------------------------------------------------------------
// Enqueue pending campaign contacts (research → personalize → send pipeline)
// Fixes prior bug: loads real template from DB instead of empty object
// ---------------------------------------------------------------------------
async function enqueuePendingContacts(campaignId, batchSize) {

  const result = await db.query(
    `SELECT
       cc.id AS cc_id, cc.org_id,
       c.id AS contact_id, c.email, c.first_name, c.last_name, c.company, c.job_title,
       cam.id AS campaign_id,
       COALESCE(t.subject, '') AS subject,
       COALESCE(t.body_html, '') AS body_html,
       COALESCE(t.booking_url, '') AS booking_url
     FROM campaign_contacts cc
     JOIN contacts  c   ON c.id   = cc.contact_id
     JOIN campaigns cam ON cam.id = cc.campaign_id
     LEFT JOIN templates t ON t.id = cam.template_id
     WHERE cc.campaign_id=? AND cc.status='pending'
     ORDER BY cc.created_at
     LIMIT ?`,
    [campaignId, batchSize],
  );

  for (const row of result.rows) {
    // Simple variable substitution — no AI research/personalization
    const vars = {
      first_name: row.first_name || '',
      last_name:  row.last_name  || '',
      company:    row.company    || '',
      job_title:  row.job_title  || '',
      email:      row.email      || '',
      booking_url: row.booking_url || '',
    };

    const personalizedSubject = (row.subject || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] || '');
    const personalizedBody    = (row.body_html || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] || '');

    const { sendQueue } = queues();
    await sendQueue.add('send', {
      campaignContactId: row.cc_id,
      contact:   { id: row.contact_id, email: row.email, first_name: row.first_name, last_name: row.last_name, company: row.company },
      email:     { subject: personalizedSubject, body_html: personalizedBody },
      campaignId: row.campaign_id,
    });

    await db.query(
      `UPDATE campaign_contacts SET status='queued' WHERE id=? AND status='pending'`,
      [row.cc_id],
    );
  }
}

// ---------------------------------------------------------------------------
// Refresh segment contact count
// ---------------------------------------------------------------------------
async function refreshSegmentCount(segmentId) {
  try {
    const { buildFilterWhere, offsetSqlParams } = require('../utils/segmentQueryBuilder');
    const seg = await db.query('SELECT filters, org_id FROM segments WHERE id=?', [segmentId]);
    if (!seg.rows.length) return;
    const { where, params } = buildFilterWhere(seg.rows[0].filters);
    const whereFrag = offsetSqlParams(where, 1);
    const cnt = await db.query(
      `SELECT COUNT(*) AS count FROM contacts WHERE org_id=? AND (${whereFrag})`,
      [seg.rows[0].org_id, ...params],
    );
    await db.query(
      `UPDATE segments SET contact_count=?, last_count_at=NOW() WHERE id=?`,
      [parseInt(cnt.rows[0].count, 10), segmentId],
    );
  } catch (err) {
    console.error('[scheduler] refreshSegmentCount', segmentId, err.message);
  }
}

// ---------------------------------------------------------------------------
// Check provider bounce rates — penalise health if > 5% in last hour
// ---------------------------------------------------------------------------
async function checkProviderHealth() {
  const providers = ['resend', 'ses', 'sendgrid'];
  for (const provider of providers) {
    try {
      const res = await db.query(
        `SELECT
           SUM(CASE WHEN event_type='bounced' THEN 1 ELSE 0 END) AS bounces,
           SUM(CASE WHEN event_type='sent'    THEN 1 ELSE 0 END) AS sent
         FROM email_events
         WHERE JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.provider')) = ?
           AND created_at >= NOW() - INTERVAL 1 HOUR`,
        [provider],
      );
      const { bounces, sent } = res.rows[0];
      const rate = parseInt(sent || '0', 10) > 0
        ? (parseInt(bounces || '0', 10) / parseInt(sent, 10)) * 100
        : 0;
      if (rate > 5) {
        const healthKey = `provider_health:${provider}`;
        const current = parseInt(await redis.get(healthKey) || '100', 10);
        await redis.setex(healthKey, 3600, Math.max(0, current - 20));
        console.warn(`[scheduler] Provider ${provider} bounce rate ${rate.toFixed(1)}% — health penalised`);
      }
    } catch (err) {
      console.error('[scheduler] checkProviderHealth', provider, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Start all cron jobs
// ---------------------------------------------------------------------------
function startScheduler() {

  // Every minute: activate scheduled email campaigns + enqueue at send window
  cron.schedule('* * * * *', async () => {
    try {
      await db.query(
        `UPDATE campaigns SET status = 'active', started_at = COALESCE(started_at, NOW())
         WHERE status = 'scheduled' AND scheduled_start_at IS NOT NULL AND scheduled_start_at <= NOW()`,
      );
      const activated = await db.query(
        `SELECT id, daily_limit FROM campaigns
         WHERE status = 'active' AND started_at >= NOW() - INTERVAL 1 MINUTE`,
      );
      for (const row of activated.rows) {
        await enqueuePendingContacts(row.id, Math.max(1, row.daily_limit || 50));
      }

      const campaigns = await db.query(
        `SELECT id, timezone, send_time, daily_limit, emails_sent_today, scheduled_start_at
         FROM campaigns WHERE status = 'active'`,
      );
      const now = new Date();
      for (const c of campaigns.rows) {
        if (c.scheduled_start_at && new Date(c.scheduled_start_at) > now) continue;
        const tz = c.timezone || 'UTC';
        const localHM = clockHHMMInZone(now, tz);
        const localSend = (c.send_time || '09:00').toString().slice(0, 5);
        if (localHM === localSend) {
          const remaining = Math.max(0, (c.daily_limit || 50) - (c.emails_sent_today || 0));
          if (remaining > 0) {
            await enqueuePendingContacts(c.id, remaining);
          }
        }
      }
    } catch (err) { console.error('[scheduler] campaign enqueue', err.message); }
  });

  // Midnight IST (18:30 UTC): reset daily counters + purge old provider quota keys
  cron.schedule('30 18 * * *', async () => {
    try {
      await db.query(
        `UPDATE campaigns SET emails_sent_today=0, last_reset_date=CURRENT_DATE
         WHERE status IN ('active','paused')`,
      );
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const old = await redis.keys(`provider_quota:*:${yesterday}`);
      if (old.length) await redis.del(...old);
      console.log('[scheduler] Daily reset complete');
    } catch (err) { console.error('[scheduler] daily reset', err.message); }
  }, { timezone: 'UTC' });

  // Every 10 minutes: refresh dynamic segment counts
  cron.schedule('*/10 * * * *', async () => {
    try {
      const segs = await db.query(
        `SELECT id FROM segments WHERE is_dynamic=TRUE
         AND (last_count_at IS NULL OR last_count_at < NOW() - INTERVAL 10 MINUTE)`,
      );
      for (const s of segs.rows) {
        await refreshSegmentCount(s.id);
        await redis.del(`segment_count:${s.id}`);
      }
    } catch (err) { console.error('[scheduler] segment refresh', err.message); }
  });

  // Daily 3am IST (21:30 UTC): AI score unscored contacts in batches
  cron.schedule('30 21 * * *', async () => {
    try {
      const { aiQueue } = queues();
      const orgs = await db.query('SELECT id FROM organisations');
      for (const org of orgs.rows) {
        await aiQueue.add('ai-batch', {
          type: 'score_batch',
          orgId: org.id,
          limit: 500,
        }, { priority: 10 });
      }
    } catch (err) { console.error('[scheduler] AI score batch', err.message); }
  }, { timezone: 'UTC' });

  // Daily 4am IST (22:30 UTC): generate ICP from top performers
  cron.schedule('30 22 * * *', async () => {
    try {
      const { aiQueue } = queues();
      const orgs = await db.query(`SELECT id FROM organisations WHERE plan='enterprise'`);
      for (const org of orgs.rows) {
        await aiQueue.add('ai-icp', { type: 'generate_icp', orgId: org.id }, { priority: 5 });
      }
    } catch (err) { console.error('[scheduler] ICP generation', err.message); }
  }, { timezone: 'UTC' });

  // Every hour: check provider bounce rates
  cron.schedule('0 * * * *', async () => {
    await checkProviderHealth();
  });

  // Every 500ms: flush audit buffer from Redis → MySQL
  setInterval(flushAuditBuffer, 500);

  console.log('[scheduler] All cron jobs started');
}

module.exports = { startScheduler, enqueuePendingContacts, refreshSegmentCount };
