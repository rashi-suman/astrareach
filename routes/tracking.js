'use strict';
/**
 * High-performance tracking routes — no auth, must respond < 50ms.
 * All DB work is fire-and-forget via the events queue.
 */
const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const db       = require('../config/db');
const { eventsQueue } = require('../services/queueService');
const { ONE_PX_GIF }  = require('../services/trackingService');

const DEFAULT_ORG = '00000000-0000-0000-0000-000000000001';

// Pre-cache the 1x1 GIF for zero-allocation responses
const GIF_HEADERS = {
  'Content-Type':  'image/gif',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma':        'no-cache',
  'Expires':       '0',
};

// Known prefetch / security scanners — skip recording opens from these only
const BOT_UA_PATTERNS = [
  /Googlebot/i,
  /bingbot/i,
  /Yahoo.*Slurp/i,
  /MailScanner/i,
  /mimecast/i,
  /barracuda/i,
  /proofpoint/i,
  /spamhaus/i,
  /symantec/i,
  /messagelabs/i,
  /postini/i,
  /cloudmark/i,
  /Microsoft.*Safety/i,
  /outlook.*safety/i,
  /SafeLinks/i,
  /EmailPrivacyTester/i,
  /Litmus/i,
  /Mail Tester/i,
  /preview\.ms/i,
  /MailTrack/i,
  /HeadlessChrome/i,
  /PhantomJS/i,
  /Slackbot/i,
  /Twitterbot/i,
  /facebookexternalhit/i,
  /LinkedInBot/i,
  /spider/i,
  /crawler/i,
  /scanner/i,
];

function isBot(userAgent) {
  if (!userAgent || !String(userAgent).trim()) return false;
  return BOT_UA_PATTERNS.some((p) => p.test(userAgent));
}

// Resolve ccId → campaign_contact row
async function resolveCC(ccId) {
  const { rows } = await db.query(
    'SELECT campaign_id, contact_id, org_id FROM campaign_contacts WHERE id=$1',
    [ccId],
  );
  return rows[0] || null;
}

// GET /t/o/:ccId — open pixel
router.get('/o/:ccId', (req, res) => {
  // Always return the pixel immediately (fast response)
  res.writeHead(200, GIF_HEADERS);
  res.end(ONE_PX_GIF);

  const ua = req.get('User-Agent') || '';

  // Layer 1: Skip known email scanner / proxy bot User-Agents
  if (isBot(ua)) return;

  // Fire-and-forget after response sent
  setImmediate(async () => {
    try {
      const cc = await resolveCC(req.params.ccId);
      if (!cc) return;

      await eventsQueue.add('track', {
        ccId:       req.params.ccId,
        eventType:  'opened',
        orgId:      cc.org_id || DEFAULT_ORG,
        campaignId: cc.campaign_id,
        contactId:  cc.contact_id,
        metadata: {
          ip:          req.ip,
          user_agent:  ua,
          country:     req.get('CF-IPCountry') || null,
        },
      }).catch((err) => console.error('[tracking] open queue', err.message));
    } catch { /* never throw on tracking */ }
  });
});

// GET /t/c/:ccId?u=<encoded-url>&type=clicked|booked — click redirect
router.get('/c/:ccId', (req, res) => {
  const decoded = decodeURIComponent(req.query.u || '/');
  res.redirect(302, decoded);

  setImmediate(async () => {
    try {
      const cc = await resolveCC(req.params.ccId);
      if (!cc) return;
      await eventsQueue.add('track', {
        ccId:       req.params.ccId,
        eventType:  req.query.type === 'booked' ? 'booked' : 'clicked',
        orgId:      cc.org_id || DEFAULT_ORG,
        campaignId: cc.campaign_id,
        contactId:  cc.contact_id,
        metadata:   { url: decoded, ip: req.ip, user_agent: req.get('User-Agent') },
      }).catch((err) => console.error('[tracking] click queue', err.message));
    } catch { /* never throw */ }
  });
});

// GET /t/u/:ccId — unsubscribe (synchronous — user is waiting for confirmation)
router.get('/u/:ccId', async (req, res) => {
  try {
    const cc = await resolveCC(req.params.ccId);
    if (cc) {
      await Promise.all([
        db.query(`UPDATE contacts SET status='unsubscribed' WHERE id=$1`, [cc.contact_id]),
        db.query(`UPDATE campaign_contacts SET status='unsubscribed', last_event_at=NOW() WHERE id=$1`, [req.params.ccId]),
        db.query(
          `INSERT INTO email_events (id, campaign_contact_id, campaign_id, contact_id, org_id, event_type, created_at)
           VALUES (gen_random_uuid(),$1,$2,$3,$4,'unsubscribed',NOW())`,
          [req.params.ccId, cc.campaign_id, cc.contact_id, cc.org_id || DEFAULT_ORG],
        ),
      ]);
    }
    const pause = req.query.pause ? ` for ${req.query.pause} days` : '';
    res.send(`<!doctype html><html lang="en">
<head><meta charset="utf-8"><title>Unsubscribed</title>
<style>*{box-sizing:border-box}body{background:#0f1117;color:#e8eaf2;font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#1a1d2e;border:1px solid #2d3151;border-radius:12px;padding:40px 48px;max-width:480px;text-align:center}
h2{margin:0 0 12px;font-size:20px}p{color:#8b92a5;line-height:1.6}</style></head>
<body><div class="card">
  <h2>You've been unsubscribed${pause}</h2>
  <p>Your email has been removed from our outreach list. You won't receive any further emails from this campaign.</p>
</div></body></html>`);
  } catch (e) {
    res.status(500).send('Unsubscribe failed. Please try again.');
  }
});

// ---- Webhook endpoints ---- //

// POST /t/webhooks/resend
router.post('/webhooks/resend', express.raw({ type: '*/*' }), async (req, res) => {
  res.json({ ok: true }); // respond immediately

  setImmediate(async () => {
    try {
      const rawBody  = req.body;
      const signature = req.headers['svix-signature'] || req.headers['x-resend-signature'] || '';
      const secret   = process.env.RESEND_WEBHOOK_SECRET;
      if (secret && signature) {
        const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
        const parts    = signature.split(',');
        const v1       = parts.find(p => p.startsWith('v1,')).replace('v1,', '');
        if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1 || ''))) return;
      }
      const body  = JSON.parse(rawBody.toString());
      const event = body?.type;
      const tags  = body?.data?.tags || [];
      const ccId  = tags.find(t => t.name === 'campaign_contact_id')?.value;
      if (!ccId) return;

      const cc = await resolveCC(ccId);
      if (!cc) return;

      const typeMap = {
        'email.delivered':  'delivered',
        'email.bounced':    'bounced',
        'email.complained': 'unsubscribed',
      };
      const eventType = typeMap[event];
      if (!eventType) return;

      await eventsQueue.add('webhook', {
        ccId, eventType,
        orgId: cc.org_id || DEFAULT_ORG,
        campaignId: cc.campaign_id,
        contactId:  cc.contact_id,
        metadata:   { bounceType: body?.data?.bounce?.type, provider: 'resend' },
      });
    } catch (e) { console.error('[webhook/resend]', e.message); }
  });
});

module.exports = router;
