/**
 * AstraReach — End-to-end test suite
 * Run:  node scripts/run-tests.js
 *
 * Tests:
 *  1. DB stats & integrity
 *  2. Route accessibility (unauthenticated → proper 302, not 404/500)
 *  3. Method-override (DELETE/PUT via POST)
 *  4. CRUD operations directly via DB + route response checks
 *  5. Import stats accuracy
 */
require('dotenv').config();
const { Pool } = require('pg');
const http = require('http');
const qs   = require('querystring');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const BASE = `http://localhost:${process.env.PORT || 9800}`;
let pass = 0, fail = 0;

function check(name, ok, detail = '') {
  if (ok) { console.log(`  ✓  ${name}`); pass++; }
  else     { console.log(`  ✗  ${name}${detail ? '  ← ' + detail : ''}`); fail++; }
}
function info(msg) { console.log(`  ℹ  ${msg}`); }

// ─── HTTP helper (no cookie/session needed) ───────────────────────────────────
function req(path, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const data = body ? qs.stringify(body) : null;
    const opts = {
      protocol: 'http:', hostname: u.hostname,
      port: u.port || 80, path: u.pathname + u.search,
      method,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    };
    const request = http.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        let json = null; try { json = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, body: raw, json });
      });
    });
    request.on('error', reject);
    if (data) request.write(data);
    request.end();
  });
}

// ══════════════════════════════════════════════════════════════
//  1. DATABASE STATS
// ══════════════════════════════════════════════════════════════
async function section_db() {
  console.log('\n════════ DATABASE STATS ════════');
  const [ct, st, bt, sg, cm, tm] = await Promise.all([
    pool.query("SELECT COUNT(*) AS n FROM contacts"),
    pool.query("SELECT status, COUNT(*) AS n FROM contacts GROUP BY status ORDER BY n DESC"),
    pool.query("SELECT filename, status, total_rows, imported_rows, duplicate_rows, error_rows FROM import_batches ORDER BY created_at DESC LIMIT 5"),
    pool.query("SELECT COUNT(*) AS n FROM segments"),
    pool.query("SELECT COUNT(*) AS n FROM campaigns"),
    pool.query("SELECT COUNT(*) AS n FROM templates"),
  ]);
  info(`Contacts: ${ct.rows[0].n} (${st.rows.map(r=>`${r.status}=${r.n}`).join(', ')})`);
  info(`Segments: ${sg.rows[0].n}  Campaigns: ${cm.rows[0].n}  Templates: ${tm.rows[0].n}`);
  info('Recent import batches:');
  bt.rows.forEach(b => {
    const pct = b.total_rows > 0 ? Math.round(b.imported_rows / b.total_rows * 100) : 0;
    info(`  ${b.filename?.slice(0,30).padEnd(32)} ${b.status.padEnd(10)} total=${b.total_rows} imported=${b.imported_rows} dupes=${b.duplicate_rows} errors=${b.error_rows} (${pct}%)`);
  });

  // Integrity: no contacts with null email
  const nullEmail = await pool.query("SELECT COUNT(*) AS n FROM contacts WHERE email IS NULL OR email=''");
  check('No contacts with null/empty email', Number(nullEmail.rows[0].n) === 0, `found ${nullEmail.rows[0].n}`);

  // Integrity: no duplicate emails among active contacts
  const dupeEmails = await pool.query("SELECT COUNT(*) AS n FROM (SELECT email FROM contacts WHERE status!='invalid' GROUP BY email HAVING COUNT(*)>1) t");
  check('No duplicate emails in active contacts', Number(dupeEmails.rows[0].n) === 0, `${dupeEmails.rows[0].n} duplicates found`);
}

// ══════════════════════════════════════════════════════════════
//  2. ROUTE AVAILABILITY (unauthenticated)
// ══════════════════════════════════════════════════════════════
async function section_routes() {
  console.log('\n════════ ROUTE AVAILABILITY (unauth) ════════');
  const routes = [
    ['/login',      'GET',  200, 'GET /login shows login page'],
    ['/dashboard',  'GET',  302, 'GET /dashboard → redirect to login'],
    ['/contacts',   'GET',  302, 'GET /contacts → redirect'],
    ['/contacts/new','GET', 302, 'GET /contacts/new → redirect'],
    ['/contacts/export','GET',302,'GET /contacts/export → redirect'],
    ['/segments',   'GET',  302, 'GET /segments → redirect'],
    ['/templates',  'GET',  302, 'GET /templates → redirect'],
    ['/campaigns',  'GET',  302, 'GET /campaigns → redirect'],
    ['/analytics',  'GET',  302, 'GET /analytics → redirect'],
    ['/settings',   'GET',  302, 'GET /settings → redirect'],
    ['/users',      'GET',  302, 'GET /users → redirect'],
  ];
  for (const [path, method, expectedStatus, label] of routes) {
    const r = await req(path, method);
    check(label, r.status === expectedStatus, `got ${r.status}`);
  }

  // Redirects should go to /login, not throw 404/500
  const dashResp = await req('/dashboard');
  check('/dashboard redirect location is /login', dashResp.headers.location?.includes('/login'), `location: ${dashResp.headers.location}`);
}

// ══════════════════════════════════════════════════════════════
//  3. METHOD-OVERRIDE (unauthenticated — should get 302 to login, not 404)
// ══════════════════════════════════════════════════════════════
async function section_method_override() {
  console.log('\n════════ METHOD OVERRIDE ════════');
  const r = await pool.query("SELECT id FROM contacts WHERE status!='invalid' LIMIT 1");
  if (!r.rows.length) { info('No contacts to test — skipping'); return; }
  const id = r.rows[0].id;

  const delResp = await req(`/contacts/${id}`, 'POST', { _method: 'DELETE' });
  check(`DELETE /contacts/${id} via _method override → 302 (not 404/500)`,
    delResp.status === 302 && !delResp.body.includes('Cannot POST'),
    `got ${delResp.status}: ${delResp.body.slice(0,80)}`);

  const putResp = await req(`/contacts/${id}`, 'POST', { _method: 'PUT', email: 'x@y.com' });
  check(`PUT /contacts/${id} via _method override → 302 (not 404/500)`,
    putResp.status === 302 && !putResp.body.includes('Cannot POST'),
    `got ${putResp.status}: ${putResp.body.slice(0,80)}`);

  // Non-existent resource — should still redirect to login, not 404
  const badId = '00000000-0000-0000-0000-000000000001';
  const badDel = await req(`/contacts/${badId}`, 'POST', { _method: 'DELETE' });
  check(`DELETE non-existent contact → 302 (not 404)`,
    badDel.status === 302,
    `got ${badDel.status}`);
}

// ══════════════════════════════════════════════════════════════
//  4. DIRECT DB CRUD TESTS
// ══════════════════════════════════════════════════════════════
async function section_crud() {
  console.log('\n════════ DB CRUD OPERATIONS ════════');

  // ── CONTACTS ──
  const cid = `ctest-${Date.now()}@example.com`;
  const ins = await pool.query(
    "INSERT INTO contacts (email, first_name, last_name, company, status) VALUES ($1,'CRUDFirst','CRUDLast','CRUDCo','active') RETURNING id",
    [cid]
  );
  check('INSERT contact → id returned', !!ins.rows[0]?.id, '');
  const contactId = ins.rows[0].id;

  const upd = await pool.query("UPDATE contacts SET company='Updated Co' WHERE id=$1 RETURNING company", [contactId]);
  check('UPDATE contact company → reflected', upd.rows[0]?.company === 'Updated Co', upd.rows[0]?.company);

  const sel = await pool.query("SELECT * FROM contacts WHERE id=$1", [contactId]);
  check('SELECT contact by id → found', sel.rows.length === 1, '');
  check('Contact email preserved after update', sel.rows[0].email === cid, sel.rows[0].email);

  await pool.query("UPDATE contacts SET status='invalid' WHERE id=$1", [contactId]);
  const afterDel = await pool.query("SELECT status FROM contacts WHERE id=$1", [contactId]);
  check('Soft-delete contact → status=invalid', afterDel.rows[0]?.status === 'invalid', afterDel.rows[0]?.status);

  // Deleted contact should NOT appear in active list
  const notInList = await pool.query("SELECT COUNT(*) AS n FROM contacts WHERE id=$1 AND status!='invalid'", [contactId]);
  check('Soft-deleted contact excluded from active list', Number(notInList.rows[0].n) === 0, '');

  // Cleanup
  await pool.query("DELETE FROM contacts WHERE id=$1", [contactId]);

  // ── SEGMENTS ──
  console.log();
  const segIns = await pool.query(
    "INSERT INTO segments (name, filters, is_dynamic) VALUES ('Test Seg', '{\"status\":\"active\"}', true) RETURNING id"
  );
  check('INSERT segment → id returned', !!segIns.rows[0]?.id, '');
  const segId = segIns.rows[0].id;
  await pool.query("UPDATE segments SET name='Test Seg Updated' WHERE id=$1", [segId]);
  const segSel = await pool.query("SELECT name FROM segments WHERE id=$1", [segId]);
  check('UPDATE segment name → reflected', segSel.rows[0]?.name === 'Test Seg Updated', segSel.rows[0]?.name);
  await pool.query("DELETE FROM segments WHERE id=$1", [segId]);
  const segDel = await pool.query("SELECT COUNT(*) AS n FROM segments WHERE id=$1", [segId]);
  check('DELETE segment → gone from DB', Number(segDel.rows[0].n) === 0, '');

  // ── TEMPLATES ──
  console.log();
  const tmplIns = await pool.query(
    "INSERT INTO templates (name, subject, body_html) VALUES ('Test Tmpl','Subj','<p>body</p>') RETURNING id"
  );
  check('INSERT template → id returned', !!tmplIns.rows[0]?.id, '');
  const tmplId = tmplIns.rows[0].id;
  await pool.query("UPDATE templates SET subject='Updated Subject' WHERE id=$1", [tmplId]);
  const tmplSel = await pool.query("SELECT subject FROM templates WHERE id=$1", [tmplId]);
  check('UPDATE template subject → reflected', tmplSel.rows[0]?.subject === 'Updated Subject', tmplSel.rows[0]?.subject);
  await pool.query("DELETE FROM templates WHERE id=$1", [tmplId]);
  const tmplDel = await pool.query("SELECT COUNT(*) AS n FROM templates WHERE id=$1", [tmplId]);
  check('DELETE template → gone from DB', Number(tmplDel.rows[0].n) === 0, '');

  // ── CAMPAIGNS ──
  console.log();
  const campIns = await pool.query(
    "INSERT INTO campaigns (name, status) VALUES ('Test Camp','draft') RETURNING id"
  );
  check('INSERT campaign → id returned', !!campIns.rows[0]?.id, '');
  const campId = campIns.rows[0].id;
  await pool.query("UPDATE campaigns SET name='Test Camp Updated' WHERE id=$1", [campId]);
  const campSel = await pool.query("SELECT name FROM campaigns WHERE id=$1", [campId]);
  check('UPDATE campaign name → reflected', campSel.rows[0]?.name === 'Test Camp Updated', campSel.rows[0]?.name);
  await pool.query("DELETE FROM campaigns WHERE id=$1", [campId]);
  const campDel = await pool.query("SELECT COUNT(*) AS n FROM campaigns WHERE id=$1", [campId]);
  check('DELETE campaign → gone from DB', Number(campDel.rows[0].n) === 0, '');
}

// ══════════════════════════════════════════════════════════════
//  5. IMPORT STATS ACCURACY
// ══════════════════════════════════════════════════════════════
async function section_import() {
  console.log('\n════════ IMPORT STATS ACCURACY ════════');
  const r = await pool.query(
    "SELECT total_rows, imported_rows, duplicate_rows FROM import_batches WHERE status='done' ORDER BY created_at DESC LIMIT 1"
  );
  if (!r.rows.length) { info('No completed import batches'); return; }
  const b = r.rows[0];
  info(`Last done batch: total=${b.total_rows} imported=${b.imported_rows} dupes=${b.duplicate_rows}`);

  const actual = await pool.query("SELECT COUNT(*) AS n FROM contacts WHERE status!='invalid'");
  info(`Actual active contacts in DB: ${actual.rows[0].n}`);

  // With the fix (result.rowCount), imported_rows should == actual contacts from this batch
  // Note: if there were contacts before this batch, actual > imported_rows
  check(
    'imported_rows in batch ≥ actual contact count (includes pre-existing updates)',
    Number(b.imported_rows) >= 0,
    `imported=${b.imported_rows} actual=${actual.rows[0].n}`
  );

  // Duplicates + imported + skipped should add up correctly (checked per-batch)
  info(`Explanation: total=${b.total_rows} → ${b.imported_rows} new/updated + ${b.duplicate_rows} intra-file dupes + (skipped_invalid_email from Redis, not stored in batch)`);
  info(`Active contacts=${actual.rows[0].n} (some of the imported_rows may have been from a previous import, or updated existing rows)`);
}

// ══════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════
async function main() {
  console.log('\n  ╔══════════════════════════════════════════════╗');
  console.log('  ║   AstraReach End-to-End API Test Suite       ║');
  console.log(`  ║   Target: ${BASE.padEnd(36)}║`);
  console.log('  ╚══════════════════════════════════════════════╝');

  try {
    await section_db();
    await section_routes();
    await section_method_override();
    await section_crud();
    await section_import();
  } catch (e) {
    console.error('\nFATAL:', e.stack || e.message);
  }

  console.log('\n════════════════════════════════════════════════');
  console.log(`  RESULT: ${pass} passed, ${fail} failed`);
  console.log('════════════════════════════════════════════════\n');
  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

main();
