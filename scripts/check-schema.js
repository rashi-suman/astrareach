require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function main() {
  for (const t of ['segments', 'templates', 'campaigns', 'contacts']) {
    const r = await pool.query('SELECT column_name, data_type FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position', [t]);
    console.log(`\n${t}: ${r.rows.map(c => c.column_name).join(', ')}`);
  }
  await pool.end();
}
main().catch(e => console.error(e.message));
