require('dotenv').config();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const { buildFilterWhere } = require('../utils/segmentQueryBuilder');

async function run() {
  console.log('\n========== SEGMENT + CAMPAIGN TEST ==========\n');

  // 1. Check contacts with tag "new"
  const { where, params } = buildFilterWhere({ rules: [{ field: 'tags', op: 'contains_any', value: ['new'] }] });
  const tagQuery = `SELECT id, email, first_name, last_name, company, tags FROM contacts WHERE ${where} LIMIT 10`;
  const tagResult = await db.query(tagQuery, params);
  console.log(`Contacts with tag "new": ${tagResult.rowCount}`);
  tagResult.rows.forEach(r => console.log(` - ${r.email} | ${r.first_name} ${r.last_name} | ${r.company} | tags: ${JSON.stringify(r.tags)}`));

  if (!tagResult.rowCount) {
    // Tag contacts as "new" for a few existing contacts for testing
    console.log('\nNo contacts with tag "new" found. Tagging 3 contacts...');
    const sample = (await db.query("SELECT id FROM contacts WHERE status='active' LIMIT 3")).rows;
    if (!sample.length) { console.log('ERROR: No active contacts in DB'); db.end(); return; }
    for (const c of sample) {
      await db.query("UPDATE contacts SET tags = array_append(COALESCE(tags,'{}'), 'new') WHERE id=$1 AND NOT ('new'=ANY(COALESCE(tags,'{}')))", [c.id]);
    }
    const recheck = await db.query(`SELECT id, email, first_name, tags FROM contacts WHERE ${where} LIMIT 10`, params);
    console.log(`After tagging: ${recheck.rowCount} contacts with tag "new"`);
    recheck.rows.forEach(r => console.log(` - ${r.email} | tags: ${JSON.stringify(r.tags)}`));
  }

  // 2. Create segment
  const segName = 'Test - Tag New [auto]';
  const existing = await db.query("SELECT id FROM segments WHERE name=$1", [segName]);
  let segId;
  if (existing.rowCount) {
    segId = existing.rows[0].id;
    console.log(`\nSegment already exists: ${segId}`);
  } else {
    const filters = { rules: [{ field: 'tags', op: 'contains_any', value: ['new'] }] };
    const seg = (await db.query(
      "INSERT INTO segments(name, description, filters, created_by) VALUES($1,$2,$3::jsonb,$4) RETURNING id",
      [segName, 'Auto-test: contacts tagged "new"', JSON.stringify(filters), (await db.query("SELECT id FROM users LIMIT 1")).rows[0].id]
    )).rows[0];
    segId = seg.id;
    console.log(`\nCreated segment: ${segId}`);
  }

  // Update segment count
  const countResult = await db.query(`SELECT COUNT(*)::int AS count FROM contacts WHERE ${where}`, params);
  const contactCount = countResult.rows[0].count;
  await db.query("UPDATE segments SET contact_count=$1 WHERE id=$2", [contactCount, segId]);
  console.log(`Segment contact count: ${contactCount}`);

  // 3. Check / create template
  const templates = (await db.query("SELECT id, name, subject, booking_url FROM templates LIMIT 5")).rows;
  console.log('\nAvailable templates:', templates.map(t => `${t.id} | ${t.name} | ${t.subject}`).join('\n  '));
  
  let templateId;
  const testTemplate = templates.find(t => t.name.includes('Test') || t.name.includes('auto'));
  if (testTemplate) {
    templateId = testTemplate.id;
  } else if (templates.length) {
    templateId = templates[0].id;
  } else {
    const userId = (await db.query("SELECT id FROM users LIMIT 1")).rows[0].id;
    const tmpl = (await db.query(
      "INSERT INTO templates(name, subject, body_html, variables, created_by) VALUES($1,$2,$3,$4,$5) RETURNING id",
      ['Auto Test Template', 'Hello {{first_name}} from AstraReach', 
       '<p>Hi {{first_name}},</p><p>This is a test email from AstraReach. We noticed your interest.</p><p>Book a call: <a href="{{booking_url}}">Click here</a></p>',
       ['first_name', 'booking_url'], userId]
    )).rows[0];
    templateId = tmpl.id;
    console.log(`Created test template: ${templateId}`);
  }
  console.log(`Using template: ${templateId}`);

  // 4. Create campaign
  const campName = 'Test Campaign - Tag New [auto]';
  const existingCamp = await db.query("SELECT id FROM campaigns WHERE name=$1", [campName]);
  let campId;
  if (existingCamp.rowCount) {
    campId = existingCamp.rows[0].id;
    await db.query("UPDATE campaigns SET status='draft', segment_id=$1, template_id=$2 WHERE id=$3", [segId, templateId, campId]);
    console.log(`\nUpdated existing campaign: ${campId}`);
  } else {
    const userId = (await db.query("SELECT id FROM users LIMIT 1")).rows[0].id;
    const camp = (await db.query(
      "INSERT INTO campaigns(name, description, template_id, segment_id, daily_limit, send_time, timezone, status, created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
      [campName, 'Auto-test campaign', templateId, segId, 100, '09:00', 'Asia/Kolkata', 'draft', userId]
    )).rows[0];
    campId = camp.id;
    console.log(`\nCreated campaign: ${campId}`);
  }

  // 5. Add segment contacts to campaign_contacts
  const allContacts = await db.query(`SELECT id FROM contacts WHERE ${where}`, params);
  let inserted = 0;
  for (const c of allContacts.rows) {
    const r = await db.query(
      "INSERT INTO campaign_contacts(campaign_id, contact_id, status) VALUES($1,$2,'pending') ON CONFLICT (campaign_id, contact_id) DO NOTHING RETURNING id",
      [campId, c.id]
    );
    if (r.rowCount) inserted++;
  }
  await db.query("UPDATE campaigns SET total_contacts=(SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id=$1) WHERE id=$1", [campId]);
  console.log(`Added ${inserted} contacts to campaign (${allContacts.rowCount} total)`);

  // 6. Enqueue using new direct-send path (bypass AI)
  const { sendQueue } = require('../services/queueService');
  
  const pendingContacts = await db.query(`
    SELECT cc.id AS cc_id, c.id, c.email, c.first_name, c.last_name, c.company,
           COALESCE(t.subject,'') AS subject, COALESCE(t.body_html,'') AS body_html,
           COALESCE(t.booking_url,'') AS booking_url
    FROM campaign_contacts cc
    JOIN contacts c ON c.id=cc.contact_id
    JOIN campaigns cam ON cam.id=cc.campaign_id
    LEFT JOIN templates t ON t.id=cam.template_id
    WHERE cc.campaign_id=$1 AND cc.status='pending'
  `, [campId]);

  console.log(`\nPending contacts to send: ${pendingContacts.rowCount}`);

  let queued = 0;
  for (const p of pendingContacts.rows) {
    const vars = { first_name: p.first_name||'', last_name: p.last_name||'', company: p.company||'', booking_url: p.booking_url||'' };
    const subject = (p.subject||'').replace(/\{\{(\w+)\}\}/g, (_,k)=>vars[k]||'');
    const body    = (p.body_html||'').replace(/\{\{(\w+)\}\}/g, (_,k)=>vars[k]||'');
    await sendQueue.add('send', {
      campaignContactId: p.cc_id,
      contact: { id: p.id, email: p.email, first_name: p.first_name, last_name: p.last_name, company: p.company },
      email:   { subject, body_html: body },
      campaignId: campId,
    });
    await db.query("UPDATE campaign_contacts SET status='queued' WHERE id=$1", [p.cc_id]);
    queued++;
    console.log(`  Queued: ${p.email} | subject: "${subject.slice(0,50)}"`);
  }

  // Set campaign to active
  await db.query("UPDATE campaigns SET status='active', started_at=COALESCE(started_at, NOW()) WHERE id=$1", [campId]);

  console.log(`\n✅ ${queued} emails queued for sending`);
  console.log(`Campaign ID: ${campId}`);
  console.log(`Segment ID: ${segId}`);
  console.log(`\nMonitor status:`);
  console.log(`  node scripts/check-campaign.js ${campId}`);

  // 7. Wait 5s then check status
  await new Promise(r => setTimeout(r, 5000));
  const statusCheck = await db.query(
    "SELECT status, COUNT(*)::int FROM campaign_contacts WHERE campaign_id=$1 GROUP BY status",
    [campId]
  );
  console.log('\n--- Campaign contact statuses (after 5s) ---');
  statusCheck.rows.forEach(r => console.log(`  ${r.status}: ${r.count}`));

  const events = await db.query(
    "SELECT event_type, COUNT(*)::int FROM email_events WHERE campaign_id=$1 GROUP BY event_type",
    [campId]
  );
  console.log('--- Email events ---');
  if (events.rowCount) events.rows.forEach(r => console.log(`  ${r.event_type}: ${r.count}`));
  else console.log('  (none yet — worker may still be processing)');

  db.end();
}

run().catch(e => { console.error('FATAL:', e.message, e.stack); db.end(); });
