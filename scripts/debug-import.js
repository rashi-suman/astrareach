require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  // Check last few import batches
  const batches = await pool.query(
    `SELECT id, filename, status, total_rows, imported_rows, duplicate_rows, error_rows,
            column_mapping, created_at, completed_at
     FROM import_batches ORDER BY created_at DESC LIMIT 5`
  );
  console.log('\n=== RECENT IMPORT BATCHES ===');
  batches.rows.forEach(b => {
    console.log(`ID:       ${b.id}`);
    console.log(`File:     ${b.filename}`);
    console.log(`Status:   ${b.status}`);
    console.log(`Rows:     total=${b.total_rows} imported=${b.imported_rows} dupes=${b.duplicate_rows} errors=${b.error_rows}`);
    console.log(`Mapping:  ${JSON.stringify(b.column_mapping)}`);
    console.log('---');
  });

  // Check if last_error column exists
  const cols = await pool.query(
    `SELECT column_name FROM information_schema.columns 
     WHERE table_name='import_batches' AND table_schema='public'`
  );
  console.log('\n=== import_batches COLUMNS ===');
  console.log(cols.rows.map(r => r.column_name).join(', '));

  process.exit(0);
}
run().catch(e => { console.error(e.message); process.exit(1); });
