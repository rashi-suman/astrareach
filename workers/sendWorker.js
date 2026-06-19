'use strict';
const { Worker } = require('bullmq');
const { connection } = require('../config/redis');
const db = require('../config/db');
const { providerRouter } = require('../services/emailProviders');
const { injectTracking } = require('../services/trackingService');
const { eventsQueue }    = require('../services/queueService');
const { convert }        = require('html-to-text');

// Terminal states — a contact in any of these needs no further action
const TERMINAL = new Set(['sent','delivered','opened','clicked','booked','bounced','unsubscribed','failed']);

function getNextSendWindow(sendTime) {
  try {
    const [hh, mm] = (sendTime || '09:00').split(':').map(Number);
    const now  = new Date();
    const tmrw = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hh, mm, 0, 0);
    return tmrw.getTime();
  } catch {
    return Date.now() + 24 * 60 * 60 * 1000;
  }
}

// Convert HTML to clean plain text for multi-part MIME (critical for inbox placement)
function htmlToPlainText(html) {
  try {
    return convert(html, {
      wordwrap:       80,
      selectors: [
        { selector: 'a',   options: { hideLinkHrefIfSameAsText: true, ignoreHref: false } },
        { selector: 'img', format: 'skip' },   // skip tracking pixel
        { selector: 'table', options: { uppercaseHeaderCells: false } },
      ],
    }).trim();
  } catch {
    // Fallback: strip all tags
    return html.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }
}

// Check if every contact in the campaign is in a terminal state; if so mark completed
async function tryCompleteCampaign(campaignId) {
  try {
    const r = await db.query(
      `SELECT COUNT(*) AS pending
       FROM campaign_contacts
       WHERE campaign_id = ?
         AND status NOT IN ('sent','delivered','opened','clicked','booked','bounced','unsubscribed','failed')`,
      [campaignId],
    );
    if (r.rows[0].pending === 0) {
      await db.query(
        `UPDATE campaigns SET status='completed', completed_at=COALESCE(completed_at, NOW())
         WHERE id = ? AND status IN ('active','paused')`,
        [campaignId],
      );
      console.log(`[sendWorker] Campaign ${campaignId} marked completed`);
    }
  } catch (e) {
    console.error('[sendWorker] tryCompleteCampaign', e.message);
  }
}

const sendWorker = new Worker('send', async (job) => {
  const { campaignContactId, orgId, email: jobEmail } = job.data;
  if (!campaignContactId) return;

  // If inline email data was provided (direct-send path), persist it before querying
  if (jobEmail?.subject || jobEmail?.body_html) {
    await db.query(
      `UPDATE campaign_contacts
       SET personalized_subject = ?, personalized_body_html = ?, status = 'ready'
       WHERE id = ?`,
      [jobEmail.subject || '', jobEmail.body_html || '', campaignContactId],
    );
  }

  // Load full record
  const result = await db.query(
    `SELECT
       cc.id AS cc_id, cc.status AS cc_status, cc.personalized_subject,
       cc.personalized_body_html, cc.retry_count, cc.org_id, cc.contact_id,
       c.email, c.first_name, c.last_name,
       cam.id AS campaign_id, cam.status AS campaign_status, cam.daily_limit,
       cam.emails_sent_today, cam.last_reset_date, cam.send_time,
       COALESCE(t.booking_url, '') AS booking_url,
       COALESCE(t.include_unsubscribe, FALSE) AS include_unsubscribe,
       t.subject AS template_subject, t.body_html AS template_body
     FROM campaign_contacts cc
     JOIN contacts   c   ON c.id   = cc.contact_id
     JOIN campaigns  cam ON cam.id = cc.campaign_id
     LEFT JOIN templates t ON t.id = cam.template_id
     WHERE cc.id = ?`,
    [campaignContactId],
  );

  if (!result.rows.length) return;
  const row = result.rows[0];

  // Skip if already in terminal state (duplicate job)
  if (TERMINAL.has(row.cc_status)) return;

  // Campaign gating — reschedule if paused/stopped/completed/draft/scheduled
  if (['paused', 'stopped', 'completed', 'draft', 'scheduled'].includes(row.campaign_status)) {
    return job.moveToDelayed(Date.now() + 30 * 60 * 1000);
  }

  // Daily limit reset
  const today = new Date().toISOString().slice(0, 10);
  if (row.last_reset_date?.toISOString?.().slice(0, 10) !== today) {
    await db.query(
      `UPDATE campaigns SET emails_sent_today = 0, last_reset_date = CURRENT_DATE WHERE id = ?`,
      [row.campaign_id],
    );
    row.emails_sent_today = 0;
  }

  if (parseInt(row.emails_sent_today || '0', 10) >= parseInt(row.daily_limit || '50', 10)) {
    return job.moveToDelayed(getNextSendWindow(row.send_time));
  }

  // Select provider
  let provider;
  try {
    provider = await providerRouter.selectProvider();
  } catch (err) {
    // Mark as failed and still check campaign completion
    await db.query(
      `UPDATE campaign_contacts SET status = 'failed', error_message = ? WHERE id = ?`,
      [err.message, campaignContactId],
    );
    await tryCompleteCampaign(row.campaign_id);
    throw err; // BullMQ will retry
  }

  // Build tracked HTML + plain text (multi-part MIME = inbox, not promotions)
  const htmlBody  = row.personalized_body_html || row.template_body || '';
  const subject   = row.personalized_subject   || row.template_subject || '(no subject)';
  const tracked   = injectTracking(htmlBody, campaignContactId, row.booking_url, row.include_unsubscribe);

  // Generate plain text from the ORIGINAL html (before tracking links injected)
  // so the plain text version has real URLs, not redirect wrappers
  const plainText = htmlToPlainText(htmlBody);

  const fromEmail = process.env.FROM_EMAIL || 'outreach@astrabytesolutions.com';
  const fromName  = process.env.FROM_NAME  || 'AstraReach';
  const appUrl    = (process.env.APP_URL   || '').replace(/\/$/, '');

  // Build headers — keep minimal and personal-looking to avoid Promotions tab.
  // Do NOT add X-Campaign-ID, X-CC-ID or bulk-mail identifiers; Gmail reads those as marketing signals.
  const emailHeaders = {};
  // Only add List-Unsubscribe when the template explicitly opts in — it's a newsletter/bulk signal.
  if (row.include_unsubscribe && appUrl) {
    emailHeaders['List-Unsubscribe']      = `<${appUrl}/t/u/${campaignContactId}>`;
    emailHeaders['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  let sendResult;
  try {
    sendResult = await providerRouter.send(provider, {
      from:    `${fromName} <${fromEmail}>`,
      to:      row.email,
      subject,
      html:    tracked,
      text:    plainText,   // multi-part MIME — critical for inbox placement
      headers: emailHeaders,
    });
  } catch (err) {
    // Mark contact as failed
    await db.query(
      `UPDATE campaign_contacts SET status = 'failed', error_message = ? WHERE id = ?`,
      [err.message.slice(0, 500), campaignContactId],
    );
    await tryCompleteCampaign(row.campaign_id);
    throw err; // BullMQ retry
  }

  // Success — update DB
  await db.query(
    `UPDATE campaign_contacts
     SET status = 'sent', sent_at = NOW(), provider_used = ?, provider_message_id = ?
     WHERE id = ?`,
    [provider, sendResult.messageId, campaignContactId],
  );
  await db.query(
    `UPDATE campaigns SET emails_sent = emails_sent + 1, emails_sent_today = emails_sent_today + 1 WHERE id = ?`,
    [row.campaign_id],
  );

  // Fire-and-forget event
  eventsQueue.add('event', {
    ccId:       campaignContactId,
    eventType:  'sent',
    orgId:      row.org_id || orgId || '00000000-0000-0000-0000-000000000001',
    campaignId: row.campaign_id,
    contactId:  row.contact_id,
    metadata:   { provider, messageId: sendResult.messageId },
  }).catch(() => {});

  // Check if this was the last pending contact
  await tryCompleteCampaign(row.campaign_id);

}, { connection, concurrency: 20 });

// Suppress non-fatal BullMQ lock-race errors (happen when multiple workers competed for same job)
sendWorker.on('error', (err) => {
  if (err.code === -3 || err.code === -2 || err.message?.includes('not in the active state') || err.message?.includes('Missing lock')) {
    // These are harmless race-condition artifacts — ignore
    return;
  }
  console.error('[sendWorker] worker error:', err.message);
});

process.on('SIGTERM', () => process.exit(0));
