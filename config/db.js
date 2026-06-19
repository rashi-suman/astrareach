require('dotenv').config();
const mysql = require('mysql2/promise');

function parseDbUrl(url) {
  if (!url || !url.startsWith('mysql')) return null;
  try {
    const u = new URL(url);
    return {
      host: u.hostname || 'localhost',
      port: parseInt(u.port) || 3306,
      user: u.username || 'root',
      password: u.password || '',
      database: u.pathname.replace(/^\//, '') || 'astrareach',
    };
  } catch { return null; }
}

const cfg = parseDbUrl(process.env.DATABASE_URL) || {
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'astrareach',
};

const pool = mysql.createPool({
  ...cfg,
  waitForConnections: true,
  connectionLimit:    20,
  queueLimit:         0,
  decimalNumbers:     true,
  timezone:           'Z',
  multipleStatements: false,
});

async function query(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  if (Array.isArray(result)) {
    return { rows: result, rowCount: result.length };
  }
  return { rows: [], rowCount: result.affectedRows ?? 0, insertId: result.insertId };
}

async function getClient() {
  const conn = await pool.getConnection();
  return {
    query: async (sql, params = []) => {
      const [result] = await conn.execute(sql, params);
      if (Array.isArray(result)) {
        return { rows: result, rowCount: result.length };
      }
      return { rows: [], rowCount: result.affectedRows ?? 0, insertId: result.insertId };
    },
    release: () => conn.release(),
  };
}

module.exports = { query, getClient, pool };
