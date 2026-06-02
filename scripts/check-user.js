require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const r = await pool.query("SELECT email, password, role FROM users WHERE email='rohit@astrabytesolutions.com'");
  if (!r.rows.length) { console.log('User not found'); process.exit(1); }
  const u = r.rows[0];
  console.log('Email:', u.email, '| Role:', u.role);
  console.log('Hash prefix:', u.password ? u.password.substring(0, 10) : 'NULL');

  // Test common passwords
  for (const pw of ['admin123', 'password', 'Admin@123', 'admin', 'rohit123', '123456']) {
    if (u.password) {
      const ok = await bcrypt.compare(pw, u.password);
      if (ok) { console.log('PASSWORD MATCH:', pw); }
    }
  }
  process.exit(0);
}
run().catch(e => { console.error(e.message); process.exit(1); });
