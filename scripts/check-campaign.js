require('dotenv').config();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const campId = process.argv[2];
  if (!campId) {
    // Find the test campaign
    const c = (await db.query("SELECT id, name FROM campaigns WHERE name LIKE '%Tag New%' ORDER BY created_at DESC LIMIT 1")).rows[0];
    if (!c) { console.log('No test campaign found'); db.end(); return; }
    console.log(`Checking campaign: ${c.name} (${c.id})`);
    return checkCampaign(c.id);
  }
  return checkCampaign(campId);
}

async function checkCampaign(campId) {
  // Campaign info
  const camp = (await db.query("SELECT * FROM campaigns WHERE id=$1", [campId])).rows[0];
  if (!camp) { console.log('Campaign not found'); db.end(); return; }
  
  console.log('\n=== Campaign Status ===');
  console.log(`Name: ${camp.name}`);
  console.log(`Status: ${camp.status}`);
  console.log(`Total: ${camp.total_contacts} | Sent today: ${camp.emails_sent_today} | Total sent: ${camp.emails_sent}`);

  // Contact statuses
  const statuses = (await db.query(
    "SELECT status, COUNT(*)::int FROM campaign_contacts WHERE campaign_id=$1 GROUP BY status ORDER BY status",
    [campId]
  )).rows;
  console.log('\n=== Contact Statuses ===');
  statuses.forEach(s => console.log(`  ${s.status.padEnd(15)}: ${s.count}`));

  // Recent email events
  const events = (await db.query(
    "SELECT event_type, COUNT(*)::int FROM email_events WHERE campaign_id=$1 GROUP BY event_type ORDER BY event_type",
    [campId]
  )).rows;
  console.log('\n=== Email Events ===');
  if (events.length) events.forEach(e => console.log(`  ${e.event_type.padEnd(15)}: ${e.count}`));
  else console.log('  (no events yet)');

  // Show individual contacts with details
  const contacts = (await db.query(`
    SELECT cc.status, cc.sent_at, cc.error_message, cc.provider_used, cc.provider_message_id,
           cc.personalized_subject, c.email, c.first_name
    FROM campaign_contacts cc
    JOIN contacts c ON c.id=cc.contact_id
    WHERE cc.campaign_id=$1
    ORDER BY cc.created_at
  `, [campId])).rows;
  
  console.log('\n=== Individual Contacts ===');
  contacts.forEach(c => {
    const status = c.status.padEnd(10);
    const sent   = c.sent_at ? new Date(c.sent_at).toLocaleTimeString() : '-';
    const err    = c.error_message ? ` ERR: ${c.error_message}` : '';
    const prov   = c.provider_used ? ` [${c.provider_used}]` : '';
    const msgId  = c.provider_message_id ? ` msgId:${c.provider_message_id.slice(0,16)}...` : '';
    console.log(`  ${status} | ${c.email.padEnd(35)} | sent:${sent}${prov}${msgId}${err}`);
  });

  // Check BullMQ queue depth
  const { sendQueue } = require('../services/queueService');
  const [waiting, active, completed, failed] = await Promise.all([
    sendQueue.getWaitingCount(),
    sendQueue.getActiveCount(),
    sendQueue.getCompletedCount(),
    sendQueue.getFailedCount(),
  ]);
  console.log(`\n=== Send Queue Depth ===`);
  console.log(`  Waiting: ${waiting} | Active: ${active} | Completed: ${completed} | Failed: ${failed}`);

  db.end();
}

run().catch(e => { console.error('ERROR:', e.message); db.end(); });
