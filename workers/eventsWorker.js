'use strict';
const { Worker } = require('bullmq');
const { connection } = require('../config/redis');
const db = require('../config/db');
const { v4: uuidv4 } = require('uuid');

const STATUS_RANK = {
  pending: 0, queued: 1, sent: 2, delivered: 3,
  opened: 4, clicked: 5, booked: 6, bounced: -1, unsubscribed: -2,
};

new Worker('events', async (job) => {
  const { ccId, eventType, metadata = {}, orgId, campaignId, contactId } = job.data;
  if (!ccId || !eventType) return;

  // 1. Upsert email_tracking (latest-state per campaign_contact)
  const trackingSQL = (() => {
    switch (eventType) {
      case 'delivered':
        return `INSERT INTO email_tracking (campaign_contact_id, campaign_id, contact_id, org_id, delivered_at)
                VALUES (?,?,?,?,NOW())
                ON DUPLICATE KEY UPDATE delivered_at = COALESCE(email_tracking.delivered_at, NOW())`;
      case 'opened':
        return `INSERT INTO email_tracking (campaign_contact_id, campaign_id, contact_id, org_id,
                  first_opened_at, last_opened_at, open_count)
                VALUES (?,?,?,?,NOW(),NOW(),1)
                ON DUPLICATE KEY UPDATE
                  first_opened_at = COALESCE(email_tracking.first_opened_at, NOW()),
                  last_opened_at  = NOW(),
                  open_count      = email_tracking.open_count + 1`;
      case 'clicked':
        return `INSERT INTO email_tracking (campaign_contact_id, campaign_id, contact_id, org_id,
                  first_clicked_at, click_count)
                VALUES (?,?,?,?,NOW(),1)
                ON DUPLICATE KEY UPDATE
                  first_clicked_at = COALESCE(email_tracking.first_clicked_at, NOW()),
                  click_count      = email_tracking.click_count + 1`;
      case 'booked':
        return `INSERT INTO email_tracking (campaign_contact_id, campaign_id, contact_id, org_id, booked_at)
                VALUES (?,?,?,?,NOW())
                ON DUPLICATE KEY UPDATE
                  booked_at = COALESCE(email_tracking.booked_at, NOW())`;
      case 'bounced':
        return `INSERT INTO email_tracking (campaign_contact_id, campaign_id, contact_id, org_id,
                  bounced_at, bounce_type)
                VALUES (?,?,?,?,NOW(),?)
                ON DUPLICATE KEY UPDATE
                  bounced_at  = COALESCE(email_tracking.bounced_at, NOW()),
                  bounce_type = VALUES(bounce_type)`;
      case 'unsubscribed':
        return `INSERT INTO email_tracking (campaign_contact_id, campaign_id, contact_id, org_id, unsubscribed_at)
                VALUES (?,?,?,?,NOW())
                ON DUPLICATE KEY UPDATE
                  unsubscribed_at = COALESCE(email_tracking.unsubscribed_at, NOW())`;
      case 'spam':
        return `INSERT INTO email_tracking (campaign_contact_id, campaign_id, contact_id, org_id, spam_at)
                VALUES (?,?,?,?,NOW())
                ON DUPLICATE KEY UPDATE
                  spam_at = COALESCE(email_tracking.spam_at, NOW())`;
      default:
        return null;
    }
  })();

  if (trackingSQL) {
    const trackingParams = eventType === 'bounced'
      ? [ccId, campaignId, contactId, orgId, metadata.bounceType || 'soft']
      : [ccId, campaignId, contactId, orgId];
    try { await db.query(trackingSQL, trackingParams); } catch (e) {
      console.error('[eventsWorker] tracking upsert', e.message);
    }
  }

  // 2. Upgrade campaign_contacts.status (never downgrade)
  try {
    const cur = await db.query('SELECT status FROM campaign_contacts WHERE id=?', [ccId]);
    const currentStatus = cur.rows[0]?.status || 'sent';
    const curRank = STATUS_RANK[currentStatus] ?? 0;
    const newRank = STATUS_RANK[eventType]    ?? 0;
    if (newRank > curRank) {
      await db.query(
        `UPDATE campaign_contacts SET status=?, last_event_at=NOW(), last_event_type=? WHERE id=?`,
        [eventType, eventType, ccId],
      );
    }
  } catch (e) { console.error('[eventsWorker] status update', e.message); }

  // 3. Write to email_events (full history)
  try {
    const newEventId = uuidv4();
    await db.query(
      `INSERT INTO email_events
         (id, campaign_contact_id, campaign_id, contact_id, org_id,
          event_type, url, ip_address, user_agent, country, device_type, email_client, metadata, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
      [
        newEventId,
        ccId, campaignId, contactId, orgId,
        eventType,
        metadata.url        || null,
        metadata.ip         || null,
        metadata.user_agent || null,
        metadata.country    || null,
        metadata.device_type || null,
        metadata.email_client || null,
        JSON.stringify(metadata),
      ],
    );
  } catch (e) { console.error('[eventsWorker] event insert', e.message); }

  // 4. On hard bounce: mark contact as bounced
  if (eventType === 'bounced' && metadata.bounceType === 'hard' && contactId) {
    try {
      await db.query(`UPDATE contacts SET status='bounced' WHERE id=?`, [contactId]);
    } catch (e) { console.error('[eventsWorker] contact bounce', e.message); }
  }

  // 5. On unsubscribe: mark contact + update campaign_contacts
  if (eventType === 'unsubscribed' && contactId) {
    try {
      await db.query(`UPDATE contacts SET status='unsubscribed' WHERE id=?`, [contactId]);
    } catch (e) { console.error('[eventsWorker] contact unsub', e.message); }
  }

  // 6. After any terminal event, check if campaign should be marked completed
  if (['bounced','unsubscribed','sent','delivered'].includes(eventType) && campaignId) {
    try {
      const r = await db.query(
        `SELECT COUNT(*) AS pending
         FROM campaign_contacts
         WHERE campaign_id=?
           AND status NOT IN ('sent','delivered','opened','clicked','booked','bounced','unsubscribed','failed')`,
        [campaignId],
      );
      if (r.rows[0].pending === 0) {
        await db.query(
          `UPDATE campaigns SET status='completed', completed_at=COALESCE(completed_at, NOW())
           WHERE id=? AND status IN ('active','paused')`,
          [campaignId],
        );
      }
    } catch (e) { console.error('[eventsWorker] auto-complete', e.message); }
  }

}, { connection, concurrency: 30 });

process.on('SIGTERM', async () => process.exit(0));
