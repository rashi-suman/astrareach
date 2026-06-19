'use strict';
const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const db      = require('../config/db');
const { connection: redis } = require('../config/redis');
const { waEventsQueue } = require('../services/waQueueService');
const { WaBspService } = require('../services/waBspService');

const OPT_OUT_KEYWORDS = (process.env.WA_OPT_OUT_KEYWORDS || 'STOP,UNSUBSCRIBE,QUIT,END,CANCEL,OPTOUT,REMOVE,ROKNA HAI,BAND KARO').split(',');
const DEFAULT_ORG = '00000000-0000-0000-0000-000000000001';

// ── Shared status processor ────────────────────────────────────────────────

async function processWaStatus(wamid, status, timestamp, errorCode) {
  const { rows: [cc] } = await db.query(
    `SELECT id, contact_id, campaign_id, org_id, phone_number FROM wa_campaign_contacts WHERE wa_message_id=?`,
    [wamid],
  );
  if (!cc) return;

  await waEventsQueue.add('event', {
    waccId: cc.id, contactId: cc.contact_id,
    campaignId: cc.campaign_id, orgId: cc.org_id,
    phoneNumber: cc.phone_number,
    eventType: status, failureCode: errorCode || null,
  });
}

// ── Inbound message processor ──────────────────────────────────────────────

async function processInboundMessage(msg, phoneNumberId, orgId) {
  const fromPhone = WaBspService.normalizePhone(msg.from);

  const { rows: [contact] } = await db.query(
    `SELECT id, org_id FROM contacts WHERE whatsapp_phone=? LIMIT 1`,
    [fromPhone],
  );

  const isOptOut = OPT_OUT_KEYWORDS.some(k =>
    (msg.text?.body || msg.interactive?.button_reply?.title || '').toUpperCase().includes(k.toUpperCase()),
  );

  if (isOptOut) {
    await waEventsQueue.add('event', {
      waccId: null, contactId: contact?.id || null,
      orgId: contact?.org_id || orgId,
      phoneNumber: fromPhone, eventType: 'opted_out',
    });
    return;
  }

  // Record inbound message (opens 24h session window)
  await db.query(`
    INSERT IGNORE INTO wa_inbound_messages
      (org_id, phone_number_id, from_phone, contact_id, wa_message_id,
       message_type, message_body, button_payload, session_expires_at)
    VALUES (?,?,?,?,?,?,?,?, NOW() + INTERVAL 24 HOUR)
  `, [
    contact?.org_id || orgId, phoneNumberId, fromPhone, contact?.id || null,
    msg.id, msg.type || 'text',
    msg.text?.body || null,
    msg.interactive?.button_reply?.payload || null,
  ]);

  if (contact) {
    await db.query(
      `UPDATE contacts SET whatsapp_session_active=true, whatsapp_last_reply_at=NOW() WHERE id=?`,
      [contact.id],
    );
    await db.query(`
      UPDATE wa_campaign_contacts SET status='replied', replied_at=NOW()
      WHERE contact_id=? AND status IN ('sent','delivered','read')
      ORDER BY sent_at DESC LIMIT 1
    `, [contact.id]);

    // Log reply event
    const { rows: [wacc] } = await db.query(
      `SELECT id, campaign_id, org_id FROM wa_campaign_contacts WHERE contact_id=? AND status='replied' ORDER BY replied_at DESC LIMIT 1`,
      [contact.id],
    );
    if (wacc) {
      await waEventsQueue.add('event', {
        waccId: wacc.id, contactId: contact.id,
        campaignId: wacc.campaign_id, orgId: wacc.org_id,
        phoneNumber: fromPhone, eventType: 'replied',
        buttonPayload: msg.interactive?.button_reply?.payload,
      });
    }
  }

  // 24h session key in Redis
  await redis.setex(`wasession:${fromPhone}`, 86400, '1');
}

// ══════════════════════════════════════════════════════════════════════════════
// Meta Cloud API / 360dialog webhook
// ══════════════════════════════════════════════════════════════════════════════

// GET — Meta webhook verification challenge
router.get('/meta', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === (process.env.META_WEBHOOK_VERIFY_TOKEN || 'astrareach-verify')) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// POST — Meta events
router.post('/meta', express.raw({ type: '*/*' }), async (req, res) => {
  res.json({ ok: true }); // Respond immediately (Meta retries if no 200 within 20s)

  setImmediate(async () => {
    try {
      // Verify signature
      const appSecret = process.env.META_APP_SECRET;
      const sig       = req.headers['x-hub-signature-256'];
      if (appSecret && sig) {
        const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(req.body).digest('hex')}`;
        if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return;
      }

      const body = JSON.parse(req.body.toString());
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          const value = change.value;
          const phoneNumberId = value.metadata?.phone_number_id;

          // Delivery status updates
          for (const status of value.statuses || []) {
            const statusMap = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' };
            const mapped = statusMap[status.status];
            if (mapped) {
              await processWaStatus(status.id, mapped, status.timestamp, status.errors?.[0]?.code);
            }
          }

          // Inbound messages
          for (const msg of value.messages || []) {
            await processInboundMessage(msg, phoneNumberId, DEFAULT_ORG);
          }
        }
      }
    } catch (e) { console.error('[waWebhook/meta]', e.message); }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Twilio status webhook
// ══════════════════════════════════════════════════════════════════════════════

router.post('/twilio', express.urlencoded({ extended: false }), async (req, res) => {
  res.sendStatus(204);

  setImmediate(async () => {
    try {
      const { MessageStatus, MessageSid } = req.body;
      const statusMap = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed', undelivered: 'failed' };
      const mapped = statusMap[MessageStatus];
      if (mapped) await processWaStatus(MessageSid, mapped, Math.floor(Date.now() / 1000), null);
    } catch (e) { console.error('[waWebhook/twilio]', e.message); }
  });
});

module.exports = router;
