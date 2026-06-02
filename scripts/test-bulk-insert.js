require('dotenv').config();
const { Pool } = require('pg');
const xlsx = require('xlsx');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const filePath = 'C:\\Users\\rohit\\Downloads\\HNI Data\\HNI Data\\Banglore High Income\\BANGALORE COMMERCIAL DATABASE.xls';

function normalizeCell(v) { return v === undefined || v === null ? '' : String(v).trim().replace(/\0/g, ''); }

const workbook = xlsx.readFile(filePath, { cellDates: true });
const sheet    = workbook.Sheets[workbook.SheetNames[0]];
const aoa      = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
const headers  = aoa[0].map((h, i) => normalizeCell(h) || `Col_${i}`);

// Build 500 valid-email rows (exactly one chunk)
const mapping = { email: 'Email', company: 'Company', city: 'City', phone: 'Phone', industry: 'Category' };
const validRows = [];
for (let r = 1; r < aoa.length && validRows.length < 500; r++) {
  const raw = {};
  headers.forEach((h, ci) => { raw[h] = normalizeCell(aoa[r][ci]); });
  const email = (raw.Email || '').toLowerCase().replace(/\0/g, '').trim();
  if (!email.includes('@')) continue;
  const custom = {};
  Object.entries(raw).forEach(([col, val]) => {
    if (!Object.values(mapping).includes(col)) custom[col] = val;
  });
  validRows.push({ email, company: raw.Company || null, city: raw.City || null, phone: raw.Phone || null, industry: raw.Category || null, custom_fields: custom, first_name: null, last_name: null, job_title: null, website: null, country: null, linkedin_url: null, revenue_range: null, employee_count: null });
}
console.log(`Testing chunk of ${validRows.length} rows...`);

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const values = [], placeholders = [];
    validRows.forEach((r, i) => {
      const b = i * 17;
      values.push(r.email, r.first_name, r.last_name, r.company, r.job_title, r.phone, r.website,
        r.industry, r.city, r.country, r.linkedin_url, r.revenue_range, r.employee_count,
        JSON.stringify(r.custom_fields), 'BANGALORE TEST', '00000000-0000-0000-0000-000000000099', 'active');
      placeholders.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12},$${b+13},$${b+14}::jsonb,$${b+15},$${b+16},$${b+17},NOW(),NOW())`);
    });
    const cols = 'email,first_name,last_name,company,job_title,phone,website,industry,city,country,linkedin_url,revenue_range,employee_count,custom_fields,source,import_batch_id,status,created_at,updated_at';
    await client.query(`INSERT INTO contacts (${cols}) VALUES ${placeholders.join(',')} ON CONFLICT (email) DO NOTHING`, values);
    await client.query('ROLLBACK');
    console.log(`✓ Bulk INSERT of ${validRows.length} rows succeeded!`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('✗ Bulk INSERT FAILED:', err.message);
    console.error('Code:', err.code, '| Detail:', err.detail);
  } finally {
    client.release();
    process.exit(0);
  }
}
run();
