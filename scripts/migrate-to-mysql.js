#!/usr/bin/env node
/**
 * Postgres → MySQL data migration for AstraReach.
 *
 * Prereqs:
 *   1. MySQL 8 running with the converted schema loaded:
 *        mysql -u root < db/mysql/schema.mysql.sql
 *   2. npm install mysql2   (pg is already a dependency)
 *
 * Usage:
 *   DATABASE_URL=postgres://rashisuman@localhost:5432/astrareach \
 *   MYSQL_URL=mysql://root:password@localhost:3306/astrareach \
 *   node scripts/migrate-to-mysql.js
 *
 * Reads DATABASE_URL from .env automatically if present.
 * Idempotent-ish: uses INSERT ... ON DUPLICATE KEY UPDATE id=id (skips existing rows).
 */

require('dotenv').config();
const { Pool } = require('pg');
const mysql = require('mysql2/promise');

const PG_URL = process.env.DATABASE_URL;
const MYSQL_URL = process.env.MYSQL_URL || 'mysql://root@localhost:3306/astrareach';
const BATCH = 500;

// Parent tables first (FK order); FK checks are disabled during load anyway.
const TABLES = [
  'session',
  'organisations',
  'users',
  'contacts',
  'import_batches',
  'segments',
  'templates',
  'campaigns',
  'campaign_contacts',
  'email_events',
  'email_tracking',
  'activity_log',
  'field_permissions',
  'user_data_scopes',
  'permission_grants',
  'audit_log',
  'wa_phone_numbers',
  'wa_templates',
  'wa_campaigns',
  'wa_campaign_contacts',
  'wa_opt_ins',
  'wa_inbound_messages',
  'wa_events',
];

function convertValue(v, mysqlType) {
  if (v === null || v === undefined) return null;
  if (mysqlType === 'json') {
    // pg returns jsonb as object, text[] as JS array — both stringify cleanly
    return JSON.stringify(v);
  }
  if (v instanceof Date) return v; // mysql2 formats Date in session TZ (set to UTC below)
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

async function main() {
  if (!PG_URL) {
    console.error('DATABASE_URL is not set (check your .env)');
    process.exit(1);
  }

  const pg = new Pool({ connectionString: PG_URL });
  const my = await mysql.createConnection({
    uri: MYSQL_URL,
    timezone: 'Z', // store DATETIME values as UTC
    supportBigNumbers: true,
    bigNumberStrings: true,
  });

  console.log('Connected to Postgres and MySQL.');
  await my.query('SET FOREIGN_KEY_CHECKS = 0');
  await my.query("SET time_zone = '+00:00'");

  let grandTotal = 0;

  for (const table of TABLES) {
    // Does the table exist on both sides?
    const pgExists = await pg.query(
      'SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1',
      [table]
    );
    if (pgExists.rowCount === 0) {
      console.log(`-- ${table}: not in Postgres, skipping`);
      continue;
    }

    const [myCols] = await my.query(
      'SELECT COLUMN_NAME name, DATA_TYPE type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
      [table]
    );
    if (myCols.length === 0) {
      console.log(`-- ${table}: not in MySQL schema, skipping`);
      continue;
    }
    const myTypeByCol = Object.fromEntries(myCols.map((c) => [c.name, c.type]));

    const pgCols = (
      await pg.query(
        'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1',
        [table]
      )
    ).rows.map((r) => r.column_name);

    // Copy only columns that exist on both sides
    const cols = pgCols.filter((c) => c in myTypeByCol);
    const colList = cols.map((c) => `"${c}"`).join(', ');
    const myColList = cols.map((c) => `\`${c}\``).join(', ');
    const placeholders = `(${cols.map(() => '?').join(', ')})`;

    const { rows: countRows } = await pg.query(`SELECT COUNT(*)::bigint AS n FROM "${table}"`);
    const total = Number(countRows[0].n);
    if (total === 0) {
      console.log(`-- ${table}: 0 rows`);
      continue;
    }

    // Keyset-free batched copy, stable order
    const orderCol = cols.includes('id') ? 'id' : cols[0];
    let copied = 0;
    for (let offset = 0; offset < total; offset += BATCH) {
      const { rows } = await pg.query(
        `SELECT ${colList} FROM "${table}" ORDER BY "${orderCol}" LIMIT ${BATCH} OFFSET ${offset}`
      );
      if (rows.length === 0) break;

      const values = rows.map((row) => cols.map((c) => convertValue(row[c], myTypeByCol[c])));
      const flat = values.flat();
      const sql = `INSERT INTO \`${table}\` (${myColList}) VALUES ${values
        .map(() => placeholders)
        .join(', ')} ON DUPLICATE KEY UPDATE \`${cols[0]}\` = \`${cols[0]}\``;
      await my.query(sql, flat);
      copied += rows.length;
      process.stdout.write(`\r   ${table}: ${copied}/${total}`);
    }
    console.log(`\r✓ ${table}: ${copied}/${total} rows copied`);
    grandTotal += copied;
  }

  await my.query('SET FOREIGN_KEY_CHECKS = 1');

  // Row-count verification
  console.log('\nVerification (Postgres vs MySQL row counts):');
  let mismatches = 0;
  for (const table of TABLES) {
    try {
      const pgN = Number((await pg.query(`SELECT COUNT(*)::bigint AS n FROM "${table}"`)).rows[0].n);
      const [[{ n: myN }]] = await my.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
      const ok = pgN === Number(myN);
      if (!ok) mismatches++;
      console.log(`  ${ok ? '✓' : '✗'} ${table}: pg=${pgN} mysql=${myN}`);
    } catch {
      /* table missing on one side — already reported above */
    }
  }

  console.log(`\nDone. ${grandTotal} rows migrated. ${mismatches === 0 ? 'All counts match.' : `${mismatches} table(s) mismatched!`}`);
  await pg.end();
  await my.end();
  process.exit(mismatches === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nMigration failed:', err.message);
  process.exit(1);
});
