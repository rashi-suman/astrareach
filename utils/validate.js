const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isEmail(s)    { return typeof s === 'string' && EMAIL_RE.test(s); }
function isNonEmpty(s) { return typeof s === 'string' && s.trim().length > 0; }
function isUUID(s)     { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s); }

function required(obj, fields) {
  const missing = fields.filter(f => obj[f] === undefined || obj[f] === null || obj[f] === '');
  if (missing.length) {
    const e = new Error('Missing required fields: ' + missing.join(', '));
    e.status = 400;
    throw e;
  }
}

module.exports = { isEmail, isNonEmpty, isUUID, required };
