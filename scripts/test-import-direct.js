require('dotenv').config();
const { importContacts } = require('../services/importService');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const filePath   = 'C:\\Users\\rohit\\Downloads\\HNI Data\\HNI Data\\Banglore High Income\\BANGALORE COMMERCIAL DATABASE.xls';
const fileType   = 'xls';
const mapping    = { email: 'Email', company: 'Company', city: 'City', phone: 'Phone', industry: 'Category' };

async function run() {
  // Create a temp batch
  const b = await pool.query(
    "INSERT INTO import_batches(filename, status, uploaded_by, column_mapping) VALUES($1,'processing',(SELECT id FROM users LIMIT 1),$2::jsonb) RETURNING id",
    ['BANGALORE TEST', JSON.stringify(mapping)]
  );
  const batchId = b.rows[0].id;
  console.log('Test batch:', batchId);

  try {
    const stats = await importContacts(filePath, fileType, mapping, batchId, null, { source: 'test', duplicateStrategy: 'skip' });
    console.log('Result:', JSON.stringify(stats, null, 2));
  } catch (err) {
    console.error('THREW:', err.message);
    console.error(err.stack);
  }

  // Cleanup
  await pool.query('DELETE FROM contacts WHERE import_batch_id=$1', [batchId]);
  await pool.query('DELETE FROM import_batches WHERE id=$1', [batchId]);
  process.exit(0);
}
run().catch(e => { console.error('OUTER ERROR:', e.message); process.exit(1); });
