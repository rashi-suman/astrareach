'use strict';
const { Worker } = require('bullmq');
const { connection } = require('../config/redis');
const db = require('../config/db');

const STATUS_RANK = {
  pending: 0, queued: 1, sent: 2, delivered: 3,
  read: 4, replied: 5, failed: -1, invalid_number: -1, opted_out: -1,
};

new Worker('whatsapp-events', async (job) => {
  const { orgId, campaignId, waccId, contactId, phoneNumber, eventType, failureCode, buttonPayload, metadata = {} } = job.data;
  if (!waccId || !eventType) return;

  // 1. Upgrade status (never downgrade)
  const { rows: [cur] } = await db.query('SELECT status FROM wa_campaign_contacts WHERE id=$1', [waccId]);
  if (cur && (STATUS_RANK[eventType] ?? 0) > (STATUS_RANK[cur.status] ?? 0)) {
    const colMap = {
      delivered: 'delivered_at', read: 'read_at', replied: 'replied_at',
      failed: 'failed_at', opted_out: null,
    };
    const col = colMap[eventType];
    const setCols = col ? `status=$1, ${col}=NOW()` : 'status=$1';
    const failClause = (eventType === 'failed' && failureCode)
      ? `, failure_code='${failureCode}'` : '';
    await db.query(
      `UPDATE wa_campaign_contacts SET ${setCols}${failClause} WHERE id=$2`,
      [eventType, waccId],
    );
  }

  // 2. On opted_out — mark contact
  if (eventType === 'opted_out' && contactId) {
    await db.query(`UPDATE contacts SET whatsapp_opted_in=false WHERE id=$1`, [contactId]);
    await db.query(
      `INSERT INTO wa_opt_ins (org_id,contact_id,phone_number,status,opted_out_at,opted_out_reason)
       VALUES ((SELECT org_id FROM contacts WHERE id=$1),$1,$2,'opted_out',NOW(),'user_reply')
       ON CONFLICT (org_id,phone_number) DO UPDATE SET status='opted_out',opted_out_at=NOW()`,
      [contactId, phoneNumber],
    );
  }

  // 3. Write wa_events analytics row
  await db.query(
    `INSERT INTO wa_events (org_id,campaign_id,wacc_id,contact_id,phone_number,event_type,failure_code,button_payload,metadata,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
    [orgId, campaignId, waccId, contactId, phoneNumber, eventType,
     failureCode || null, buttonPayload || null, JSON.stringify(metadata)],
  );

  // 4. Auto-complete campaign check
  if (['delivered','read','replied','failed','opted_out','invalid_number'].includes(eventType) && campaignId) {
    const { rows: [r] } = await db.query(
      `SELECT COUNT(*)::int AS pending FROM wa_campaign_contacts
       WHERE campaign_id=$1 AND status NOT IN ('sent','delivered','read','replied','failed','opted_out','invalid_number')`,
      [campaignId],
    );
    if (r.pending === 0) {
      await db.query(
        `UPDATE wa_campaigns SET status='completed', completed_at=COALESCE(completed_at,NOW())
         WHERE id=$1 AND status IN ('active','paused')`,
        [campaignId],
      );
    }
  }

}, { connection, concurrency: 50 });

process.on('SIGTERM', () => process.exit(0));
