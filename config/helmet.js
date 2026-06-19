const helmet = require('helmet');

module.exports = helmet({
  contentSecurityPolicy: false, // EJS views inline some scripts; tighten later
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
});
