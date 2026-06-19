'use strict';
const cron = require('node-cron');
const db   = require('../config/db');
const { connection: redis } = require('../config/redis');
const { WaBspService } = require('./waBspService');

async function sendAdminAlert(orgId, type, message) {
  // Log to console — extend to email/Slack as needed
  console.warn(`[waHealth][${type}] org=${orgId}: ${message}`);
}

// Check quality scores for all active WABA numbers — runs every 30 minutes
async function checkAllQualityScores() {
  let phones;
  try {
    ({ rows: phones } = await db.query(
      `SELECT * FROM wa_phone_numbers WHERE is_active=TRUE AND bsp IN ('meta_cloud','360dialog')`,
    ));
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE' || /wa_phone_numbers/.test(e.message)) return;
    throw e;
  }

  for (const phone of phones) {
    try {
      const bsp   = new WaBspService(phone);
      const score = await bsp.getQualityRating();
      const prev  = phone.quality_score;

      await db.query(
        `UPDATE wa_phone_numbers SET quality_score=?, quality_updated_at=NOW() WHERE id=?`,
        [score, phone.id],
      );

      if (score === 'YELLOW' && !phone.is_paused) {
        await db.query(
          `UPDATE wa_phone_numbers SET is_paused=TRUE, pause_reason='Quality score YELLOW' WHERE id=?`,
          [phone.id],
        );
        await db.query(
          `UPDATE wa_campaigns SET status='paused' WHERE phone_number_id=? AND status='active'`,
          [phone.id],
        );
        await sendAdminAlert(phone.org_id, 'YELLOW_QUALITY',
          `WhatsApp number ${phone.phone_number} quality dropped to YELLOW — campaigns paused.`);
      }

      if (score === 'RED') {
        await db.query(
          `UPDATE wa_phone_numbers SET is_paused=TRUE, pause_reason='Quality score RED — manual review required' WHERE id=?`,
          [phone.id],
        );
        await db.query(
          `UPDATE wa_campaigns SET status='stopped' WHERE phone_number_id=? AND status IN ('active','paused')`,
          [phone.id],
        );
        await sendAdminAlert(phone.org_id, 'RED_QUALITY',
          `URGENT: WhatsApp number ${phone.phone_number} quality is RED — all campaigns stopped.`);
      }

      if (score === 'GREEN' && prev === 'YELLOW' && phone.is_paused &&
          phone.pause_reason === 'Quality score YELLOW') {
        await db.query(
          `UPDATE wa_phone_numbers SET is_paused=FALSE, pause_reason=NULL WHERE id=?`,
          [phone.id],
        );
        await sendAdminAlert(phone.org_id, 'GREEN_QUALITY',
          `WhatsApp number ${phone.phone_number} quality recovered to GREEN.`);
      }
    } catch (err) {
      console.error(`[waHealth] quality check failed for ${phone.phone_number}:`, err.message);
    }
  }
}

// Reset daily send counters at midnight IST (18:30 UTC)
async function resetDailyCounts() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    try {
      await db.query(`UPDATE wa_phone_numbers SET messages_sent_today=0, last_reset_date=?`, [today]);
      await db.query(
        `UPDATE wa_campaigns SET messages_sent_today=0, last_reset_date=? WHERE status IN ('active','paused')`,
        [today],
      );
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE' && !/wa_phone_numbers|wa_campaigns/.test(e.message)) throw e;
    }
    // Clear per-phone queue position counters
    const keys = await redis.keys('waqpos:*');
    if (keys.length) await redis.del(...keys);
    console.log('[waHealth] Daily WA counts reset');
  } catch (e) { console.error('[waHealth] resetDailyCounts', e.message); }
}

function startWaHealthCron() {
  // Every 30 minutes: quality score check
  cron.schedule('*/30 * * * *', () => checkAllQualityScores().catch(e => console.error('[waHealth]', e.message)));
  // Midnight IST (18:30 UTC): reset daily counters
  cron.schedule('30 18 * * *', resetDailyCounts, { timezone: 'UTC' });
  console.log('[waHealth] WhatsApp health cron started');
}

module.exports = { startWaHealthCron, checkAllQualityScores, resetDailyCounts };
