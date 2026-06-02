require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Must delete in dependency order
    const cc  = await client.query('DELETE FROM campaign_contacts');
    const ee  = await client.query('DELETE FROM email_events');
    const et  = await client.query('DELETE FROM email_tracking');
    const con = await client.query('DELETE FROM contacts');
    const imp = await client.query('DELETE FROM import_batches');

    await client.query('COMMIT');

    console.log(`Cleared:`);
    console.log(`  ${con.rowCount}  contacts`);
    console.log(`  ${cc.rowCount}   campaign_contacts`);
    console.log(`  ${ee.rowCount}   email_events`);
    console.log(`  ${et.rowCount}   email_tracking rows`);
    console.log(`  ${imp.rowCount}  import_batches`);
    console.log('Database is clean. Ready to re-upload.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error — rolled back:', err.message);
  } finally {
    client.release();
    process.exit(0);
  }
}

run();
