require('dotenv').config();
const app  = require('./app');
const { startScheduler } = require('./services/schedulerService');
const { cleanupOrphanedImports } = require('./services/importService');

// Load workers (registers BullMQ Worker instances)
require('./workers/campaignWorker');   // research + personalize (legacy AI path)
require('./workers/sendWorker');       // main send worker
require('./workers/eventsWorker');     // high-priority event processing
require('./workers/aiWorker');         // AI batch jobs
require('./workers/enrichmentWorker'); // AI contact enrichment
require('./workers/waWorker');        // WhatsApp send worker
require('./workers/waEventsWorker');  // WhatsApp events processor

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, async () => {
  // Clean up any half-imported batches left by a previous crash
  await cleanupOrphanedImports();

  // Ensure BullMQ queues are not paused (can get stuck paused if crashed mid-operation)
  try {
    const { sendQueue, personalizeQueue } = require('./services/queueService');
    const { waQueue } = require('./services/waQueueService');
    await Promise.all([sendQueue.resume(), personalizeQueue.resume(), waQueue.resume()]).catch(() => {});
    console.log('[server] Queues resumed');
  } catch (_) {}

  startScheduler();
  // Start WhatsApp health cron (quality score checks + daily resets)
  try { require('./services/waHealthService').startWaHealthCron(); } catch (e) { console.error('[waHealth]', e.message); }
  console.log(`AstraReach running on :${PORT}`);
});

// Graceful shutdown
async function shutdown(signal) {
  console.log(`[server] ${signal} received — shutting down gracefully`);
  server.close(async () => {
    try {
      await require('./config/db').pool.end();
      await require('./config/redis').connection.quit();
    } catch (e) { console.error(e.message); }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 15000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
