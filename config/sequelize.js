require('dotenv').config();

function parseDbUrl(url) {
  if (!url || !url.startsWith('mysql')) return null;
  try {
    const u = new URL(url);
    return {
      host:     u.hostname || 'localhost',
      port:     parseInt(u.port) || 3306,
      username: u.username || 'root',
      password: u.password || '',
      database: u.pathname.replace(/^\//, '') || 'astrareach',
    };
  } catch { return null; }
}

const cfg = parseDbUrl(process.env.DATABASE_URL) || {
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 3306,
  username: process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'astrareach',
};

const base = {
  ...cfg,
  dialect:  'mysql',
  dialectOptions: { charset: 'utf8mb4' },
  logging:  false,
};

module.exports = {
  development: base,
  test:        base,
  production:  base,
};
