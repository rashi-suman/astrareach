'use strict';
const { Worker } = require('bullmq');
const { connection } = require('../config/redis');
const db = require('../config/db');
const { WaBspService, WaApiError } = require('../services/waBspService');
const { waEventsQueue } = require('../services/waQueueService');

const FATAL_CODES   = new Set(['132000', '132001']);
const INVALID_CODES = new Set(['131026']);

// Status upgrade ranking — never downgrade
const STATUS_RANK = {
  pending: 0, queued: 1, sent: 2, delivered: 3,
  read: 4, replied: 5, failed: -1, invalid_number: -1, opted_out: -1,
};

async function tryCompleteWaCampaign(campaignId) {
  try {
    const r = await db.query(
      `SELECT COUNT(*) AS pending FROM wa_campaign_contacts
       WHERE campaign_id=?
         AND status NOT IN ('sent','delivered','read','replied','failed','opted_out','invalid_number')`,
      [campaignId],
    );
    if (parseInt(r.rows[0].pending) === 0) {
      await db.query(
        `UPDATE wa_campaigns SET status='completed', completed_at=COALESCE(completed_at,NOW())
         WHERE id=? AND status IN ('active','paused')`,
        [campaignId],
      );
      console.log(`[waWorker] Campaign ${campaignId} completed`);
    }
  } catch (e) {
    console.error('[waWorker] tryComplete', e.message);
  }
}

async function logWaEvent(data) {
  try {
    await waEventsQueue.add('event', data);
  } catch { /* non-fatal */ }
}

new Worker('whatsapp', async (job) => {
  const { campaignContactId } = job.data;

  // 1. Load all required data in one query
  const { rows } = await db.query(`
    SELECT
      wacc.id, wacc.status AS cc_status, wacc.org_id, wacc.contact_id,
      wacc.phone_number, wacc.personalized_vars, wacc.retry_count,
      wacc.campaign_id,
      c.first_name, c.last_name, c.company, c.custom_fields,
      c.whatsapp_opted_in,
      cam.status         AS campaign_status,
      cam.template_id,
      cam.variable_mapping,
      cam.daily_limit    AS campaign_daily_limit,
      cam.messages_sent_today,
      cam.last_reset_date,
      cam.send_time,
      cam.timezone,
      t.name             AS template_name,
      t.language,
      t.body_text,
      t.header_type,
      t.header_content,
      t.buttons,
      pn.id              AS phone_record_id,
      pn.bsp,
      pn.bsp_api_key,
      pn.access_token,
      pn.phone_number_id AS meta_phone_id,
      pn.waba_id,
      pn.tier,
      pn.daily_limit     AS phone_daily_limit,
      pn.messages_sent_today AS phone_sent_today,
      pn.last_reset_date AS phone_reset_date,
      pn.quality_score,
      pn.is_paused,
      pn.phone_number    AS from_number
    FROM wa_campaign_contacts wacc
    JOIN contacts c         ON c.id = wacc.contact_id
    JOIN wa_campaigns cam   ON cam.id = wacc.campaign_id
    JOIN wa_templates t     ON t.id = cam.template_id
    JOIN wa_phone_numbers pn ON pn.id = cam.phone_number_id
    WHERE wacc.id = ?
  `, [campaignContactId]);

  if (!rows.length) return; // Orphaned job — discard
  const cc = rows[0];

  // Skip if already in terminal state (duplicate job)
  if (['sent','delivered','read','replied','failed','opted_out','invalid_number'].includes(cc.cc_status)) return;

  // 2. Safety checks — NEVER skip these
  if (['paused','stopped','completed'].includes(cc.campaign_status)) {
    return job.moveToDelayed(Date.now() + 30 * 60 * 1000);
  }
  if (cc.quality_score === 'RED') {
    await db.query(
      `UPDATE wa_campaign_contacts SET status='failed', failure_reason='Phone number RED quality score', failed_at=NOW() WHERE id=?`,
      [campaignContactId],
    );
    return;
  }
  if (cc.quality_score === 'YELLOW') {
    return job.moveToDelayed(Date.now() + 60 * 60 * 1000);
  }
  if (!cc.whatsapp_opted_in) {
    await db.query(
      `UPDATE wa_campaign_contacts SET status='opted_out', failure_reason='Not opted in' WHERE id=?`,
      [campaignContactId],
    );
    return;
  }
  if (!WaBspService.isValidE164(cc.phone_number)) {
    await db.query(
      `UPDATE wa_campaign_contacts SET status='invalid_number', failure_reason='Invalid E.164 number' WHERE id=?`,
      [campaignContactId],
    );
    return;
  }

  // 3. Daily limit resets
  const today = new Date().toISOString().slice(0, 10);
  if (cc.last_reset_date?.toISOString?.().slice(0, 10) !== today) {
    await db.query(`UPDATE wa_campaigns SET messages_sent_today=0, last_reset_date=? WHERE id=?`, [today, cc.campaign_id]);
    cc.messages_sent_today = 0;
  }
  if (cc.phone_reset_date?.toISOString?.().slice(0, 10) !== today) {
    await db.query(`UPDATE wa_phone_numbers SET messages_sent_today=0, last_reset_date=? WHERE id=?`, [today, cc.phone_record_id]);
    cc.phone_sent_today = 0;
  }

  if (parseInt(cc.messages_sent_today || 0) >= parseInt(cc.campaign_daily_limit || 1000)) {
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(10, 0, 0, 0);
    return job.moveToDelayed(tomorrow.getTime());
  }
  if (parseInt(cc.phone_sent_today || 0) >= parseInt(cc.phone_daily_limit || 1000)) {
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(10, 0, 0, 0);
    return job.moveToDelayed(tomorrow.getTime());
  }

  // 4. Per-second rate limiting via Redis sliding window
  const rateKey    = `warate:${cc.meta_phone_id}`;
  const now        = Date.now();
  const windowMs   = 1000;
  const maxPerSec  = { 1: 1, 2: 3, 3: 10, 4: 20 }[cc.tier] || 1;

  await connection.zremrangebyscore(rateKey, 0, now - windowMs);
  const currentRate = await connection.zcard(rateKey);

  if (currentRate >= maxPerSec) {
    // Slow down — retry after a brief delay
    return job.moveToDelayed(now + 1100);
  }
  await connection.zadd(rateKey, now, `${campaignContactId}-${now}`);
  await connection.expire(rateKey, 5);

  // 5. Build template components
  const contact = {
    first_name:    cc.first_name,
    last_name:     cc.last_name,
    company:       cc.company,
    custom_fields: cc.custom_fields || {},
  };
  const templateData = {
    body_text:      cc.body_text,
    header_type:    cc.header_type,
    header_content: cc.header_content,
    buttons:        cc.buttons || [],
  };
  const components = WaBspService.buildComponents(
    templateData,
    contact,
    cc.variable_mapping || {},
    cc.personalized_vars || {},
  );

  // 6. Send
  const bspService = new WaBspService({
    bsp:            cc.bsp,
    bsp_api_key:    cc.bsp_api_key,
    access_token:   cc.access_token,
    phone_number_id: cc.meta_phone_id,
    phone_number:   cc.from_number,
    waba_id:        cc.waba_id,
    tier:           cc.tier,
  });

  try {
    const result = await bspService.sendTemplate(
      cc.phone_number, cc.template_name, cc.language, components,
    );

    await db.query(
      `UPDATE wa_campaign_contacts SET status='sent', wa_message_id=?, sent_at=NOW() WHERE id=?`,
      [result.wamid, campaignContactId],
    );
    await db.query(
      `UPDATE wa_campaigns SET messages_sent=messages_sent+1, messages_sent_today=messages_sent_today+1 WHERE id=?`,
      [cc.campaign_id],
    );
    await db.query(
      `UPDATE wa_phone_numbers SET messages_sent_today=messages_sent_today+1 WHERE phone_number_id=?`,
      [cc.meta_phone_id],
    );

    await logWaEvent({
      orgId: cc.org_id, campaignId: cc.campaign_id,
      waccId: campaignContactId, contactId: cc.contact_id,
      phoneNumber: cc.phone_number, eventType: 'sent',
    });

    await tryCompleteWaCampaign(cc.campaign_id);

  } catch (err) {
    if (err instanceof WaApiError) {
      if (FATAL_CODES.has(err.code)) {
        await db.query(
          `UPDATE wa_campaign_contacts SET status='failed', failure_code=?, failure_reason=?, failed_at=NOW() WHERE id=?`,
          [err.code, err.message, campaignContactId],
        );
        await tryCompleteWaCampaign(cc.campaign_id);
        return; // Do not retry
      }
      if (INVALID_CODES.has(err.code)) {
        await db.query(
          `UPDATE wa_campaign_contacts SET status='invalid_number', failure_code=? WHERE id=?`,
          [err.code, campaignContactId],
        );
        await db.query(`UPDATE contacts SET whatsapp_opted_in=false WHERE id=?`, [cc.contact_id]);
        await tryCompleteWaCampaign(cc.campaign_id);
        return;
      }
    }
    // Rate limit or transient errors — BullMQ will retry with backoff
    throw err;
  }

}, {
  connection,
  concurrency: 10,
  limiter: { max: 300, duration: 60000 },
});

console.log('[waWorker] WhatsApp send worker started');
process.on('SIGTERM', () => process.exit(0));
