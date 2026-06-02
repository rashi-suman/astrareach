require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(
  "UPDATE users SET role='superadmin', org_id='00000000-0000-0000-0000-000000000001' WHERE email='rohit@astrabytesolutions.com' RETURNING id, name, email, role"
).then(r => {
  if (r.rows.length) {
    console.log('Updated:', r.rows[0]);
  } else {
    console.log('No user found with that email');
  }
  process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
