const IORedis = require('ioredis');

function makeOpts() {
  const url = process.env.REDIS_URL || '';

  // If explicit host/port/pass env vars are set, use them directly
  if (process.env.REDIS_HOST) {
    const opts = {
      host:                 process.env.REDIS_HOST || '127.0.0.1',
      port:                 parseInt(process.env.REDIS_PORT || 6379, 10),
      maxRetriesPerRequest: null,
      enableReadyCheck:     false,
    };
    if (process.env.REDIS_PASSWORD) opts.password = process.env.REDIS_PASSWORD;
    return opts;
  }

  // Parse from URL
  try {
    const u = new URL(url);
    const opts = {
      host:                 u.hostname || '127.0.0.1',
      port:                 parseInt(u.port || 6379, 10),
      maxRetriesPerRequest: null,
      enableReadyCheck:     false,
    };
    if (u.password && u.password.length > 0) opts.password = decodeURIComponent(u.password);
    if (u.protocol === 'rediss:') opts.tls = { rejectUnauthorized: false };
    return opts;
  } catch (_) {
    return { host: '127.0.0.1', port: 6379, maxRetriesPerRequest: null };
  }
}

const connection = new IORedis(makeOpts());

connection.on('error', err => {
  if (process.env.NODE_ENV !== 'test') console.error('[redis] error:', err.message);
});

module.exports = { connection };
