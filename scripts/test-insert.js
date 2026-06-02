require('dotenv').config();
const { Pool } = require('pg');
const xlsx = require('xlsx');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const filePath = 'C:\\Users\\rohit\\Downloads\\HNI Data\\HNI Data\\Banglore High Income\\BANGALORE COMMERCIAL DATABASE.xls';
const mapping  = { email: 'Email', company: 'Company', city: 'City', phone: 'Phone', industry: 'Category' };

const workbook = xlsx.readFile(filePath, { cellDates: true });
const sheet    = workbook.Sheets[workbook.SheetNames[0]];
const aoa      = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });

const headers = aoa[0].map((h, i) => String(h).trim() || `Col_${i}`);

// Grab first 10 rows with a valid email
const testRows = [];
for (let r = 1; r < aoa.length && testRows.length < 10; r++) {
  const obj = {};
  headers.forEach((h, ci) => { obj[h] = String(aoa[r][ci] || '').trim(); });
  if (obj.Email && obj.Email.includes('@')) testRows.push(obj);
}

console.log('Test rows:', JSON.stringify(testRows, null, 2));

async function tryInsert() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of testRows) {
      const custom = {};
      Object.entries(row).forEach(([col, val]) => {
        if (!Object.values(mapping).includes(col)) custom[col] = val;
      });
      const email = (row.Email || '').trim().toLowerCase().replace(/\0/g, '');
      await client.query(
        `INSERT INTO contacts (email, company, city, phone, industry, custom_fields, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'active', NOW(), NOW())
         ON CONFLICT (email) DO NOTHING`,
        [email, row.Company || null, row.City || null, row.Phone || null, row.Category || null, JSON.stringify(custom)]
      );
      console.log('✓ inserted:', email);
    }
    await client.query('ROLLBACK'); // don't actually save
    console.log('\nTest passed — INSERT works fine.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n✗ INSERT FAILED:', err.message);
    console.error('Error code:', err.code);
    console.error('Detail:', err.detail);
  } finally {
    client.release();
    process.exit(0);
  }
}
tryInsert();
