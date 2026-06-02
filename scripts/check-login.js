require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const r = await pool.query('SELECT email, role, password_hash FROM users WHERE email=$1', ['rohit@astrabytesolutions.com']);
  if (!r.rows.length) { console.log('User not found'); return; }
  const u = r.rows[0];
  console.log('email:', u.email, '| role:', u.role);
  const passwords = ['Astrabyte@2025', 'astrabyte@2025', 'Astrabyte2025', 'rohit', 'password', 'admin', 'Admin@123', 'Rohit@123'];
  for (const p of passwords) {
    const ok = await bcrypt.compare(p, u.password_hash);
    if (ok) { console.log('MATCH password:', p); }
  }
  console.log('hash (first 20 chars):', u.password_hash?.slice(0,20));
  await pool.end();
}
main().catch(console.error);
