require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name")
  .then(r => {
    console.log('Tables:', r.rows.map(x => x.table_name).join(', '));
    process.exit(0);
  })
  .catch(e => { console.error(e.message); process.exit(1); });
