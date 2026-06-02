require('dotenv').config();
const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  // Check error_log column type
  const col = await p.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name='import_batches' AND column_name='error_log'`);
  console.log('error_log type:', col.rows[0]);

  // Fix using correct type
  const type = col.rows[0]?.data_type;
  let r;
  if (type === 'jsonb' || type === 'json') {
    r = await p.query(`UPDATE import_batches SET status='failed', error_log=$1::jsonb WHERE status='processing'`, [JSON.stringify({msg:'Server crash during import'})]);
  } else {
    r = await p.query(`UPDATE import_batches SET status='failed' WHERE status='processing'`);
  }
  console.log('Fixed', r.rowCount, 'stuck batches');
  p.end();
}
run().catch(e => { console.error(e.message); process.exit(1); });
