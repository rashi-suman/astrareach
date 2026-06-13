const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const min = LEVELS[process.env.LOG_LEVEL || 'info'] || 20;

function log(level, msg, meta) {
  if (LEVELS[level] < min) return;
  const line = { level, msg, time: new Date().toISOString(), ...(meta || {}) };
  console.log(JSON.stringify(line));
}

module.exports = {
  debug: (m, x) => log('debug', m, x),
  info:  (m, x) => log('info',  m, x),
  warn:  (m, x) => log('warn',  m, x),
  error: (m, x) => log('error', m, x),
};
