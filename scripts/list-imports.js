require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query("SELECT id, filename, imported_rows, duplicate_rows, status, created_at FROM import_batches ORDER BY created_at DESC LIMIT 20")
  .then(r => {
    if (!r.rows.length) { console.log('No import batches found.'); process.exit(0); }
    r.rows.forEach(b => console.log(`${b.id} | "${b.filename}" | imported:${b.imported_rows} dupes:${b.duplicate_rows} | ${b.status} | ${b.created_at}`));
    process.exit(0);
  }).catch(e => { console.error(e.message); process.exit(1); });
