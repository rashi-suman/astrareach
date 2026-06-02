const crypto = require('crypto');
const db = require('../config/db');

const STATUS_WEIGHT = {
  pending: 1, researching: 2, ready: 3, queued: 4, sent: 5, delivered: 6,
  opened: 7, clicked: 8, booked: 9, bounced: 10, failed: 10, unsubscribed: 10,
};

async function insertEvent(campaignContactId, eventType, metadata = {}, req = null) {
  const cc = (await db.query('SELECT * FROM campaign_contacts WHERE id=$1', [campaignContactId])).rows[0];
  if (!cc) return null;

  await db.query('INSERT INTO email_events(campaign_contact_id, campaign_id, contact_id, event_type, metadata, ip_address, user_agent) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)', [
    campaignContactId,
    cc.campaign_id,
    cc.contact_id,
    eventType,
    JSON.stringify(metadata || {}),
    req?.ip || null,
    req?.headers?.['user-agent'] || null,
  ]);

  const curr = cc.status || 'pending';
  if ((STATUS_WEIGHT[eventType] || 0) >= (STATUS_WEIGHT[curr] || 0)) {
    await db.query('UPDATE campaign_contacts SET status=$1, last_event_at=NOW() WHERE id=$2', [eventType, campaignContactId]);
  }
  return cc;
}

function transparentGif() {
  return Buffer.from('R0lGODlhAQABAAAAACwAAAAAAQABAAA=', 'base64');
}

function verifySignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (signature.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

module.exports = {
  open: async (req, res) => {
    try {
      await insertEvent(req.params.campaignContactId, 'opened', {}, req);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Content-Type', 'image/gif');
      res.send(transparentGif());
    } catch (e) { res.status(500).send(e.message); }
  },

  click: async (req, res) => {
    try {
      const type = req.query.type || 'clicked';
      const decoded = decodeURIComponent(req.query.url || process.env.APP_URL || '/');
      await insertEvent(req.params.campaignContactId, type, { url: decoded }, req);
      res.redirect(decoded);
    } catch (e) { res.status(500).send(e.message); }
  },

  unsubscribe: async (req, res) => {
    try {
      const cc = await insertEvent(req.params.campaignContactId, 'unsubscribed', {}, req);
      if (cc) {
        await db.query("UPDATE contacts SET status='unsubscribed', updated_at=NOW() WHERE id=$1", [cc.contact_id]);
        await db.query("UPDATE campaign_contacts SET status='unsubscribed', last_event_at=NOW() WHERE id=$1", [cc.id]);
      }
      res.send(`<!doctype html><html><body style="font-family:Inter,sans-serif;background:#0f1117;color:#e8eaf2"><div style="max-width:560px;margin:80px auto"><h2>You've been unsubscribed</h2><p>Your email has been removed from this campaign list.</p></div></body></html>`);
    } catch (e) { res.status(500).send(e.message); }
  },

  resend: async (req, res) => {
    try {
      const signature = req.headers['x-resend-signature'];
      const rawBody = JSON.stringify(req.body || {});
      if (!verifySignature(rawBody, signature, process.env.RESEND_WEBHOOK_SECRET)) return res.status(401).json({ error: 'Invalid signature' });

      const event = req.body?.type;
      const tags = req.body?.data?.tags || [];
      const ccId = tags.find((t) => t.name === 'campaign_contact_id')?.value;
      if (!ccId) return res.json({ ok: true });

      if (event === 'email.delivered') {
        await insertEvent(ccId, 'delivered', req.body, req);
      } else if (event === 'email.bounced') {
        const cc = await insertEvent(ccId, 'bounced', req.body, req);
        if (cc) await db.query("UPDATE contacts SET status='bounced', updated_at=NOW() WHERE id=$1", [cc.contact_id]);
      } else if (event === 'email.complained') {
        const cc = await insertEvent(ccId, 'unsubscribed', req.body, req);
        if (cc) await db.query("UPDATE contacts SET status='unsubscribed', updated_at=NOW() WHERE id=$1", [cc.contact_id]);
      }

      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  },
};
