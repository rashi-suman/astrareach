require('dotenv').config();

async function run() {
  const { connection: redis } = require('../config/redis');
  
  console.log('\n=== BullMQ Raw State ===\n');
  
  // Check all keys related to 'send' queue
  const keys = await redis.keys('bull:send:*');
  console.log('Redis keys for bull:send:*:', keys.length);
  keys.forEach(k => console.log(' ', k));
  
  // Check waiting list
  const waiting = await redis.lrange('bull:send:wait', 0, -1);
  console.log('\nWaiting job IDs:', waiting);
  
  // Check active list
  const active = await redis.lrange('bull:send:active', 0, -1);
  console.log('Active job IDs:', active);
  
  // Check locked jobs
  const locked = keys.filter(k => k.includes(':lock'));
  console.log('Locked keys:', locked);
  if (locked.length) {
    for (const lk of locked) {
      const ttl = await redis.ttl(lk);
      console.log(`  ${lk} TTL: ${ttl}s`);
    }
  }
  
  // Check first waiting job data
  if (waiting.length) {
    const jobData = await redis.hgetall(`bull:send:${waiting[0]}`);
    console.log('\nFirst job data:', JSON.stringify(jobData, null, 2).slice(0, 500));
    
    // Check if job is in delayed set
    const inDelayed = await redis.zscore('bull:send:delayed', waiting[0]);
    console.log('In delayed set?', inDelayed);
  }
  
  // Check BullMQ meta
  const meta = await redis.hgetall('bull:send:meta');
  console.log('\nQueue meta:', meta);
  
  // Check paused state
  const paused = await redis.hexists('bull:send:meta', 'paused');
  const isPaused = await redis.hget('bull:send:meta', 'paused');
  console.log('Queue paused?', isPaused);
  
  redis.quit();
}

run().catch(e => { console.error('ERROR:', e.message, e.stack); process.exit(1); });
