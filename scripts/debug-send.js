require('dotenv').config();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  console.log('\n========== SEND DEBUG TEST ==========\n');
  
  // 1. Test provider router
  console.log('1. Testing provider selection...');
  try {
    const { providerRouter } = require('../services/emailProviders');
    const provider = await providerRouter.selectProvider();
    console.log('   Provider selected:', provider, '✅');
  } catch (e) {
    console.log('   Provider ERROR:', e.message, '❌');
    console.log('   This is why emails are not sending!');
  }

  // 2. Check BullMQ queue state directly
  console.log('\n2. Checking BullMQ queue state...');
  const { sendQueue } = require('../services/queueService');
  const [waiting, active, delayed, failed, completed] = await Promise.all([
    sendQueue.getWaitingCount(),
    sendQueue.getActiveCount(),
    sendQueue.getDelayedCount(),
    sendQueue.getFailedCount(),
    sendQueue.getCompletedCount(),
  ]);
  console.log(`   Waiting: ${waiting} | Active: ${active} | Delayed: ${delayed} | Failed: ${failed} | Completed: ${completed}`);
  
  // Check failed jobs details
  if (failed > 0) {
    const failedJobs = await sendQueue.getFailed(0, 5);
    failedJobs.forEach(j => console.log(`   Failed job ${j.id}: ${j.failedReason}`));
  }

  // Check delayed jobs
  if (delayed > 0) {
    console.log(`   ⚠️  ${delayed} jobs are DELAYED (moved to future send time due to error)`);
    const delayedJobs = await sendQueue.getDelayed(0, 5);
    delayedJobs.forEach(j => console.log(`   Delayed job ${j.id}: delay until ${new Date(j.processedOn || j.timestamp + (j.opts?.delay||0)).toISOString()}`));
  }

  // 3. Test Resend API directly
  console.log('\n3. Testing Resend API directly...');
  if (!process.env.RESEND_API_KEY) {
    console.log('   RESEND_API_KEY not set ❌');
  } else {
    try {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      // Just verify the key is valid by listing domains
      const result = await resend.emails.send({
        from: process.env.FROM_EMAIL || 'test@astrabytesolutions.com',
        to:   [process.env.TEST_EMAIL || 'rohit@astrabytesolutions.com'],
        subject: 'AstraReach Test Email',
        html: '<p>Test from AstraReach. If you see this, Resend is working! 🎉</p><p>Click tracking: <a href="https://astrabytesolutions.com">Visit our website</a></p>',
      });
      console.log('   Resend API result:', JSON.stringify(result));
      if (result.error) {
        console.log('   Resend ERROR:', result.error.message, '❌');
      } else {
        console.log('   Email sent! Message ID:', result.data?.id, '✅');
      }
    } catch (e) {
      console.log('   Resend EXCEPTION:', e.message, '❌');
    }
  }

  // 4. Check .env settings
  console.log('\n4. Environment check:');
  console.log('   RESEND_API_KEY:', process.env.RESEND_API_KEY ? process.env.RESEND_API_KEY.slice(0,12) + '...' : 'NOT SET ❌');
  console.log('   FROM_EMAIL:', process.env.FROM_EMAIL || 'NOT SET ❌');
  console.log('   APP_URL:', process.env.APP_URL || 'NOT SET ⚠️');

  db.end();
  process.exit(0);
}

run().catch(e => { console.error('FATAL:', e.message); db.end(); process.exit(1); });
