const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendTrackedEmail(campaignContact, contact, personalizedEmail, options = {}) {
  const trackBase = process.env.APP_URL;
  const ccId = campaignContact.id;
  const openPixel = `<img src="${trackBase}/webhooks/open/${ccId}" width="1" height="1" style="display:none" alt=""/>`;

  let body = personalizedEmail.body_html || '';

  // Wrap all href links for click tracking
  body = body.replace(/href="([^"]+)"/g, (m, url) => {
    if (url.startsWith('mailto:') || url.startsWith('#') || url.startsWith('javascript:')) return m;
    const encoded = encodeURIComponent(url);
    const type = url.includes('book-call') ? 'booked' : 'clicked';
    return `href="${trackBase}/webhooks/click/${ccId}?url=${encoded}&type=${type}"`;
  });

  body += openPixel;

  // Only append unsubscribe footer if the template explicitly opted in
  if (options.includeUnsubscribe) {
    body += `<br><br><hr style="border:none;border-top:1px solid #eee;margin:20px 0"><p style="font-size:11px;color:#999;text-align:center;"><a href="${trackBase}/webhooks/unsubscribe/${ccId}" style="color:#999">Unsubscribe</a></p>`;
  }

  await resend.emails.send({
    from: process.env.FROM_EMAIL,
    to: contact.email,
    subject: personalizedEmail.subject,
    html: body,
    tags: [{ name: 'campaign_contact_id', value: ccId }],
  });
}
module.exports = { sendTrackedEmail };
