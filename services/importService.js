'use strict';
const fs          = require('fs');
const xlsx        = require('xlsx');
const csvParser   = require('csv-parser');
const Anthropic   = require('@anthropic-ai/sdk');
const db          = require('../config/db');
const { connection } = require('../config/redis');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BASE_FIELDS = [
  'email','first_name','last_name','company','job_title','phone',
  'website','industry','city','country','linkedin_url','revenue_range','employee_count',
];

// ─── helpers ────────────────────────────────────────────────────────────────

/** Clean a raw cell value: strip null bytes, collapse whitespace, cap at 2000 chars. */
function normalizeCell(v) {
  if (v === undefined || v === null) return '';
  return String(v)
    .replace(/\0/g, '')          // null bytes → DB would reject
    .replace(/\r/g, '')          // carriage returns
    .trim()
    .slice(0, 2000);             // hard cap so no column overflows
}

/** From a cell that may contain multiple emails ("a@b.com; c@d.com"), return the first valid one. */
function extractFirstEmail(raw) {
  if (!raw) return '';
  // Split on common delimiters: comma, semicolon, pipe, newline, space
  const parts = String(raw).split(/[,;\|\n\r\s]+/);
  for (const p of parts) {
    const candidate = p.trim().toLowerCase().replace(/\0/g, '');
    if (candidate.includes('@') && candidate.includes('.') && candidate.length <= 320) {
      return candidate;
    }
  }
  return '';
}

/** Safely convert any value to a short text value (≤500 chars). Keeps multi-values as-is. */
function safeText(v, maxLen = 500) {
  if (v === undefined || v === null || v === '') return null;
  return String(v).replace(/\0/g, '').trim().slice(0, maxLen) || null;
}

function parseSpreadsheet(filePath) {
  const workbook = xlsx.readFile(filePath, { cellDates: true });
  const firstSheetName = workbook.SheetNames?.[0];
  if (!firstSheetName) return { headers: [], rows: [] };
  const sheet = workbook.Sheets[firstSheetName];
  const aoa   = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  if (!aoa.length) return { headers: [], rows: [] };

  let headerRowIdx = 0, bestScore = -1;
  const searchLimit = Math.min(25, aoa.length);
  for (let i = 0; i < searchLimit; i++) {
    const score = (aoa[i] || []).filter((c) => normalizeCell(c)).length;
    if (score > bestScore) { bestScore = score; headerRowIdx = i; }
  }

  const rawHeaders  = (aoa[headerRowIdx] || []).map((h, idx) => normalizeCell(h) || `Column_${idx + 1}`);
  const uniqueHeaders = [];
  const seen = new Map();
  rawHeaders.forEach((h) => {
    const count = (seen.get(h) || 0) + 1;
    seen.set(h, count);
    uniqueHeaders.push(count === 1 ? h : `${h}_${count}`);
  });

  const rows = [];
  for (let r = headerRowIdx + 1; r < aoa.length; r++) {
    const line = aoa[r] || [];
    const obj  = {};
    let hasData = false;
    uniqueHeaders.forEach((header, cIdx) => {
      const val = normalizeCell(line[cIdx]);
      obj[header] = val;
      if (val) hasData = true;
    });
    if (hasData) rows.push(obj);
  }
  return { headers: uniqueHeaders, rows };
}

function parseHeaders(filePath, fileType) {
  if (['xlsx', 'xls'].includes(fileType)) {
    const parsed = parseSpreadsheet(filePath);
    return { headers: parsed.headers, sampleRows: parsed.rows.slice(0, 5), totalRows: parsed.rows.length };
  }
  return new Promise((resolve, reject) => {
    const sampleRows = [];
    let headers = [], totalRows = 0;
    fs.createReadStream(filePath)
      .pipe(csvParser())
      .on('headers', (h) => { headers = h; })
      .on('data', (row) => { totalRows++; if (sampleRows.length < 5) sampleRows.push(row); })
      .on('end', () => resolve({ headers, sampleRows, totalRows }))
      .on('error', reject);
  });
}

function parseJsonObject(rawText) {
  const text = String(rawText || '').trim();
  try { return JSON.parse(text); } catch (_) {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) { try { return JSON.parse(fenced[1]); } catch (_) {} }
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start !== -1 && end > start) return JSON.parse(text.slice(start, end + 1));
  throw new Error('AI returned non-JSON mapping response');
}

async function detectColumnMapping(headers, sampleRows) {
  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 700,
    messages: [{
      role: 'user',
      content: `Map these headers to CRM fields. Headers: ${JSON.stringify(headers)}. Sample: ${JSON.stringify(sampleRows)}. Fields: email (REQUIRED), first_name, last_name, company, job_title, phone, website, industry, city, country, linkedin_url, revenue_range, employee_count. Unmapped → custom_field. Return ONLY valid JSON: { email: 'col', first_name: 'col', ... }`,
    }],
  });
  const mapping = parseJsonObject(resp.content?.[0]?.text || '{}');
  if (!mapping.email) throw new Error('AI mapping missing required email field');
  return mapping;
}

function buildMappedRow(raw, mapping, allowedCustomFields) {
  const mapped = {}, custom = {};
  // allowedCustomFields: array of file column names the user checked for custom import
  // If empty array passed → no custom fields; if undefined → allow all (backward compat)
  const customWhitelist = Array.isArray(allowedCustomFields) ? new Set(allowedCustomFields) : null;

  Object.entries(raw).forEach(([col, value]) => {
    const key = Object.keys(mapping).find(
      (f) => typeof mapping[f] === 'string' && mapping[f] === col,
    );
    const cleanVal = normalizeCell(value);
    if (key && BASE_FIELDS.includes(key)) {
      mapped[key] = cleanVal;
    } else if (cleanVal) {
      // Only include as custom field if user checked it (or no whitelist = import all)
      if (customWhitelist === null || customWhitelist.has(col)) {
        custom[col] = cleanVal;
      }
    }
  });

  const email = extractFirstEmail(mapped.email || '');

  return {
    email,
    first_name:     safeText(mapped.first_name,     100),
    last_name:      safeText(mapped.last_name,      100),
    company:        safeText(mapped.company,        255),
    job_title:      safeText(mapped.job_title,      255),
    phone:          safeText(mapped.phone,          500),
    website:        safeText(mapped.website,        500),
    industry:       safeText(mapped.industry,       255),
    city:           safeText(mapped.city,           255),
    country:        safeText(mapped.country,        255),
    linkedin_url:   safeText(mapped.linkedin_url,   500),
    revenue_range:  safeText(mapped.revenue_range,  255),
    employee_count: safeText(mapped.employee_count, 100),
    custom_fields:  custom,
  };
}

// ─── atomic import ───────────────────────────────────────────────────────────

/**
 * Read ALL rows from the file into memory first, validate & map them, then
 * write everything inside a single MySQL transaction.
 *
 * If the process crashes at any point before the COMMIT the transaction is
 * automatically rolled back by MySQL — zero rows land in the DB.
 */
async function importContacts(filePath, fileType, mapping, batchId, userId, opts = {}) {
  const source            = opts.source || 'import';
  const duplicateStrategy = opts.duplicateStrategy || 'update';
  const allowedCustomFields = opts.allowedCustomFields; // undefined = all, [] = none

  // ── Step 1: Signal "reading file" immediately ──────────────────────────────
  await connection.set(`import:${batchId}`, JSON.stringify({
    total: 0, imported: 0, duplicates: 0, skipped_invalid_email: 0,
    errors: 0, status: 'reading', phase: 'Reading file…',
  }), 'EX', 3600);

  // ── Step 2: load every row from the file into memory ──────────────────────
  let rawRows = [];
  if (['xlsx', 'xls'].includes(fileType)) {
    rawRows = parseSpreadsheet(filePath).rows;
  } else {
    rawRows = await new Promise((resolve, reject) => {
      const rows = [];
      fs.createReadStream(filePath)
        .pipe(csvParser())
        .on('data', (r) => rows.push(r))
        .on('end',  () => resolve(rows))
        .on('error', reject);
    });
  }

  const stats = {
    total:                rawRows.length,
    imported:             0,
    duplicates:           0,
    skipped_invalid_email: 0,
    errors:               0,
    status:               'processing',
    last_error:           null,
    phase:                'Validating rows…',
  };

  // Immediately broadcast the total row count so the UI shows the real number
  await connection.set(`import:${batchId}`, JSON.stringify({ ...stats }), 'EX', 3600);

  // ── Step 3: map & validate all rows — only skip rows with NO valid email ───
  // All other missing columns are imported as null/empty — never fail a row
  // just because phone/company/address etc. is blank.
  const validRows = [];
  for (const raw of rawRows) {
    const r = buildMappedRow(raw, mapping, allowedCustomFields);
    if (!r.email) { stats.skipped_invalid_email++; continue; }   // blank email → skip
    validRows.push(r);
  }

  if (!validRows.length) {
    stats.status     = 'failed';
    stats.last_error = `No valid email addresses found in ${stats.total.toLocaleString()} rows. Check the email column mapping.`;
    await connection.set(`import:${batchId}`, JSON.stringify(stats), 'EX', 3600);
    await _finaliseBatch(batchId, stats);
    return stats;
  }

  stats.phase = 'Saving contacts…';
  await connection.set(`import:${batchId}`, JSON.stringify(stats), 'EX', 3600);

  // ── Step 3: write EVERYTHING inside one transaction ────────────────────────
  const client = await db.pool.connect();            // grab a dedicated connection
  try {
    await client.query('START TRANSACTION');

    // Mark batch as processing inside the same transaction so a rollback also
    // undoes the batch row (if we created it outside we leave it orphaned).
    await client.query(
      'UPDATE import_batches SET status=?, total_rows=? WHERE id=?',
      ['processing', stats.total, batchId],
    );

    const CHUNK = 500;
    for (let i = 0; i < validRows.length; i += CHUNK) {
      const chunk = validRows.slice(i, i + CHUNK);
      await _insertChunk(client, chunk, mapping, batchId, source, stats, duplicateStrategy);

      // Stream progress to Redis so the progress bar updates while we process —
      // even though the DB transaction isn't committed yet the Redis key is visible.
      await connection.set(`import:${batchId}`, JSON.stringify({ ...stats, status: 'processing' }), 'EX', 3600);
    }

    // Accurate duplicate count = valid rows that were neither inserted nor errored
    // (i.e. silently skipped by INSERT IGNORE for intra-file or pre-existing dupes)
    stats.duplicates = validRows.length - stats.imported - stats.errors;
    if (stats.duplicates < 0) stats.duplicates = 0;

    // "done" if at least some rows were imported; "failed" only if NOTHING was saved
    stats.status = stats.imported > 0 ? 'done' : 'failed';
    if (stats.imported === 0 && !stats.last_error) {
      stats.last_error = 'No rows were inserted. All valid rows may already exist (duplicates).';
    }

    await client.query(
      `UPDATE import_batches
         SET status=?, total_rows=?, imported_rows=?,
             duplicate_rows=?, error_rows=?, skipped_rows=?, completed_at=NOW()
       WHERE id=?`,
      [stats.status, stats.total, stats.imported, stats.duplicates, stats.errors, stats.skipped_invalid_email, batchId],
    );

    await client.query('COMMIT');      // ← single atomic commit; crash before here = 0 rows saved
  } catch (err) {
    await client.query('ROLLBACK');
    stats.status     = 'failed';
    stats.last_error = err.message;
    // Persist failure status via a fresh connection (the transactional one was rolled back)
    await _finaliseBatch(batchId, stats);
    console.error('[importContacts] transaction rolled back:', err.message);
  } finally {
    client.release();
  }

  // Update Redis with final state
  await connection.set(`import:${batchId}`, JSON.stringify(stats), 'EX', 3600);
  return stats;
}

const COLS = 'email,first_name,last_name,company,job_title,phone,website,industry,city,country,linkedin_url,revenue_range,employee_count,custom_fields,source,import_batch_id,status,created_at,updated_at';

function buildOnConflict(strategy) {
  if (strategy === 'skip') return '';   // handled via INSERT IGNORE at call site
  return `ON DUPLICATE KEY UPDATE
    first_name=VALUES(first_name), last_name=VALUES(last_name),
    company=VALUES(company), job_title=VALUES(job_title),
    phone=VALUES(phone), website=VALUES(website),
    industry=VALUES(industry), city=VALUES(city),
    country=VALUES(country), linkedin_url=VALUES(linkedin_url),
    revenue_range=VALUES(revenue_range), employee_count=VALUES(employee_count),
    custom_fields=VALUES(custom_fields),
    source=VALUES(source), import_batch_id=VALUES(import_batch_id),
    updated_at=NOW()`;
}

/** Build the VALUES array for a single row (17 params). */
function rowValues(r, source, batchId) {
  return [
    r.email, r.first_name, r.last_name, r.company, r.job_title,
    r.phone, r.website, r.industry, r.city, r.country,
    r.linkedin_url, r.revenue_range, r.employee_count,
    JSON.stringify(r.custom_fields || {}),
    source, batchId, 'active',
  ];
}

async function _insertChunk(client, rows, mapping, batchId, source, stats, duplicateStrategy) {
  if (!rows.length) return;

  const onConflict = buildOnConflict(duplicateStrategy);
  const insertKeyword = duplicateStrategy === 'skip' ? 'INSERT IGNORE' : 'INSERT';

  // ── Try the whole chunk as a single INSERT first (fast path) ──────────────
  const values = [], placeholders = [];
  rows.forEach((r) => {
    values.push(...rowValues(r, source, batchId));
    placeholders.push('(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())');
  });

  try {
    await client.query(`SAVEPOINT sp_chunk`);
    const result = await client.query(
      `${insertKeyword} INTO contacts (${COLS}) VALUES ${placeholders.join(',')} ${onConflict}`,
      values,
    );
    await client.query(`RELEASE SAVEPOINT sp_chunk`);
    // rowCount = actual rows inserted (excludes INSERT IGNORE skips for intra-file dupes)
    stats.imported += result.rowCount;
    return;
  } catch (_) {
    // Chunk failed — roll back only this chunk and fall through to row-by-row
    await client.query(`ROLLBACK TO SAVEPOINT sp_chunk`);
    await client.query(`RELEASE SAVEPOINT sp_chunk`);
  }

  // ── Slow path: insert one row at a time so bad rows don't block good ones ─
  for (const r of rows) {
    try {
      await client.query(`SAVEPOINT sp_row`);
      const res = await client.query(
        `${insertKeyword} INTO contacts (${COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW()) ${onConflict}`,
        rowValues(r, source, batchId),
      );
      await client.query(`RELEASE SAVEPOINT sp_row`);
      stats.imported += res.rowCount; // 1 if inserted, 0 if INSERT IGNORE skipped
    } catch (rowErr) {
      await client.query(`ROLLBACK TO SAVEPOINT sp_row`);
      await client.query(`RELEASE SAVEPOINT sp_row`);
      stats.errors += 1;
    }
  }
}

async function _finaliseBatch(batchId, stats) {
  try {
    const errJson = stats.last_error ? JSON.stringify({ error: stats.last_error }) : null;
    await db.query(
      `UPDATE import_batches
         SET status=?, total_rows=?, imported_rows=?,
             duplicate_rows=?, error_rows=?, skipped_rows=?, completed_at=NOW(),
             error_log=?
       WHERE id=?`,
      [stats.status, stats.total, stats.imported, stats.duplicates, stats.errors, stats.skipped_invalid_email || 0, errJson, batchId],
    );
  } catch (_) {}
}

// ─── startup cleanup ──────────────────────────────────────────────────────────
/**
 * Called once at server startup.  Finds import batches that were left in
 * 'processing' state (because of a crash) and deletes their contacts, then
 * marks the batch as 'failed'.  This guarantees the DB is never left in a
 * half-imported state across restarts.
 */
async function cleanupOrphanedImports() {
  try {
    const orphans = await db.query(
      `SELECT id FROM import_batches
        WHERE status = 'processing'
          AND created_at < NOW() - INTERVAL 10 MINUTE`,
    );
    for (const { id } of orphans.rows) {
      await db.query('DELETE FROM contacts WHERE import_batch_id = ?', [id]);
      await db.query(
        `UPDATE import_batches SET status='failed', error_log='{"error":"Server restarted during import — rolled back"}' WHERE id=?`,
        [id],
      );
      console.log(`[importService] cleaned up orphaned batch ${id}`);
    }
  } catch (err) {
    console.error('[importService] orphan cleanup error:', err.message);
  }
}

module.exports = { parseHeaders, detectColumnMapping, importContacts, cleanupOrphanedImports };
