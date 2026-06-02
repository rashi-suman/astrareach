require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Find the batch
    const batch = await client.query(
      "SELECT id, filename, imported_rows, status FROM import_batches WHERE filename ILIKE '%BANGALORE%' ORDER BY created_at DESC LIMIT 5"
    );
    if (!batch.rows.length) {
      console.log('No matching import batch found.');
      await client.query('ROLLBACK');
      return;
    }

    for (const b of batch.rows) {
      console.log(`Found batch: ${b.id} | ${b.filename} | ${b.imported_rows} rows | status: ${b.status}`);

      // Delete contacts imported in this batch
      const deleted = await client.query(
        "DELETE FROM contacts WHERE import_batch_id = $1 RETURNING id", [b.id]
      );
      console.log(`  → Deleted ${deleted.rowCount} contacts`);

      // Delete the batch record
      await client.query("DELETE FROM import_batches WHERE id = $1", [b.id]);
      console.log(`  → Deleted import batch ${b.id}`);
    }

    await client.query('COMMIT');
    console.log('Done. All rolled back cleanly.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error:', err.message);
  } finally {
    client.release();
    process.exit(0);
  }
}

run();
