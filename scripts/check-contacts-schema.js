require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name='contacts' AND table_schema='public' ORDER BY ordinal_position`)
  .then(r => {
    console.log('contacts columns:');
    r.rows.forEach(c => console.log(` ${c.column_name.padEnd(25)} ${c.data_type.padEnd(20)} nullable:${c.is_nullable}`));
    process.exit(0);
  }).catch(e => { console.error(e.message); process.exit(1); });
