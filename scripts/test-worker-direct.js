require('dotenv').config();

async function run() {
  console.log('Testing sendWorker registration...');
  
  // Attach error handler to catch Worker-level errors
  process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err.message));
  process.on('uncaughtException', (err) => console.error('[uncaughtException]', err.message));
  
  const { Worker } = require('bullmq');
  const { connection } = require('../config/redis');
  const { sendQueue }  = require('../services/queueService');
  
  console.log('Creating test Worker on "send" queue...');
  
  const testWorker = new Worker('send', async (job) => {
    console.log(`[TEST WORKER] Processing job ${job.id}:`, JSON.stringify(job.data).slice(0, 100));
    // Just log — don't actually send
    const { Pool } = require('pg');
    const db = new Pool({ connectionString: process.env.DATABASE_URL });
    const ccId = job.data.campaignContactId;
    
    // Save personalized content
    if (job.data.email) {
      await db.query(
        "UPDATE campaign_contacts SET personalized_subject=$1, personalized_body_html=$2, status='ready' WHERE id=$3",
        [job.data.email.subject, job.data.email.body_html, ccId]
      );
    }
    
    // Do real send
    const { providerRouter } = require('../services/emailProviders');
    const { injectTracking } = require('../services/trackingService');
    const { Pool: Pool2 } = require('pg');
    const db2 = new Pool2({ connectionString: process.env.DATABASE_URL });
    
    const row = (await db2.query(`
      SELECT cc.*, c.email, c.first_name, cam.id AS campaign_id, cam.status AS campaign_status,
             cam.daily_limit, cam.emails_sent_today, cam.last_reset_date,
             COALESCE(t.booking_url,'') AS booking_url
      FROM campaign_contacts cc
      JOIN contacts c ON c.id=cc.contact_id
      JOIN campaigns cam ON cam.id=cc.campaign_id
      LEFT JOIN templates t ON t.id=cam.template_id
      WHERE cc.id=$1
    `, [ccId])).rows[0];
    
    if (!row) { console.log('[TEST WORKER] No row found for', ccId); db.end(); db2.end(); return; }
    if (['paused','stopped','completed'].includes(row.campaign_status)) { db.end(); db2.end(); return; }
    
    const subject = row.personalized_subject || '(no subject)';
    const html    = injectTracking(row.personalized_body_html || '', ccId, row.booking_url);
    
    console.log(`[TEST WORKER] Sending to ${row.email} | subject: ${subject.slice(0,50)}`);
    
    const provider = await providerRouter.selectProvider();
    const result   = await providerRouter.send(provider, {
      from: `${process.env.FROM_NAME || 'AstraReach'} <${process.env.FROM_EMAIL}>`,
      to:   row.email,
      subject,
      html,
    });
    
    console.log(`[TEST WORKER] SENT ✅ messageId: ${result.messageId}`);
    
    await db2.query(
      "UPDATE campaign_contacts SET status='sent', sent_at=NOW(), provider_used=$1, provider_message_id=$2 WHERE id=$3",
      [provider, result.messageId, ccId]
    );
    await db2.query(
      "UPDATE campaigns SET emails_sent=emails_sent+1, emails_sent_today=emails_sent_today+1 WHERE id=$1",
      [row.campaign_id]
    );
    
    // Log email event
    await db2.query(
      "INSERT INTO email_events(campaign_id, contact_id, campaign_contact_id, event_type) VALUES($1,$2,$3,'sent') ON CONFLICT DO NOTHING",
      [row.campaign_id, row.contact_id || null, ccId]
    );
    
    db.end();
    db2.end();
  }, { connection, concurrency: 5 });
  
  testWorker.on('completed', (job) => console.log(`[TEST WORKER] Job ${job.id} completed`));
  testWorker.on('failed',    (job, err) => console.error(`[TEST WORKER] Job ${job?.id} FAILED:`, err.message));
  testWorker.on('error',     (err) => console.error('[TEST WORKER] Worker error:', err.message));
  
  console.log('Worker registered. Waiting 30s for jobs...');
  console.log('Queue waiting count:', await sendQueue.getWaitingCount());
  
  await new Promise(r => setTimeout(r, 30000));
  
  console.log('\nFinal queue state:');
  console.log('  Waiting:', await sendQueue.getWaitingCount());
  console.log('  Completed:', await sendQueue.getCompletedCount());
  console.log('  Failed:', await sendQueue.getFailedCount());
  
  await testWorker.close();
  process.exit(0);
}

run().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
