'use strict';

const ONE_PX_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

/**
 * Inject open pixel and click redirects into HTML.
 * Unsubscribe footer is only added when includeUnsubscribe = true.
 * @param {string}  html               - Original email HTML
 * @param {string}  ccId               - campaign_contact UUID
 * @param {string}  bookingUrl         - e.g. https://example.com/book-call
 * @param {boolean} includeUnsubscribe - Whether to append unsubscribe footer
 * @returns {string}                   - Tracked HTML
 */
function wrapHref(url, ccId, base, bookingUrl) {
  if (!url) return null;
  const u = String(url).trim();
  if (u.startsWith('mailto:') || u.startsWith('#') || u.startsWith('javascript:')) return null;
  if (u.includes('/t/c/') || u.includes('/t/o/')) return null;
  const type = bookingUrl && u.includes(bookingUrl) ? 'booked' : 'clicked';
  const encoded = encodeURIComponent(u);
  return `href="${base}/t/c/${ccId}?u=${encoded}&type=${type}"`;
}

function injectTracking(html, ccId, bookingUrl, includeUnsubscribe = false) {
  if (!html) return '';
  const base = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');

  const replaceQuoted = (s, quote) => {
    const re = quote === '"'
      ? /href\s*=\s*"([^"]*)"/gi
      : /href\s*=\s*'([^']*)'/gi;
    return s.replace(re, (match, url) => {
      const wrapped = wrapHref(url, ccId, base, bookingUrl);
      return wrapped || match;
    });
  };

  let tracked = replaceQuoted(html, '"');
  tracked = replaceQuoted(tracked, "'");

  // Append 1×1 open-tracking pixel before </body> (or at end)
  // Use display:none and no alt text to keep it invisible and non-promotional
  const pixel = `<img src="${base}/t/o/${ccId}" `
    + `width="1" height="1" border="0" style="height:1px!important;width:1px!important;`
    + `border-width:0!important;margin:0!important;padding:0!important;`
    + `display:block!important;overflow:hidden!important;" alt="">`;
  if (tracked.toLowerCase().includes('</body>')) {
    tracked = tracked.replace(/<\/body>/i, `${pixel}</body>`);
  } else {
    tracked += pixel;
  }

  // Only append unsubscribe footer when the template author opted in
  if (includeUnsubscribe) {
    const footer = `
<br>
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;">
  <tr>
    <td align="center" style="padding:16px 0;font-family:Arial,sans-serif;font-size:11px;color:#999999;">
      You received this because you're on our outreach list.<br>
      <a href="${base}/t/u/${ccId}" style="color:#999999;text-decoration:underline;">Unsubscribe</a> &nbsp;·&nbsp;
      <a href="${base}/t/u/${ccId}?pause=30" style="color:#999999;text-decoration:underline;">Pause 30 days</a>
    </td>
  </tr>
</table>`;
    tracked += footer;
  }

  return tracked;
}

module.exports = { injectTracking, ONE_PX_GIF };
