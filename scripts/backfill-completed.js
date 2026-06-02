require('dotenv').config();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

const sql = `
  UPDATE campaigns SET status='completed', completed_at=NOW()
  WHERE status IN ('active','paused')
    AND total_contacts > 0
    AND id IN (
      SELECT campaign_id FROM campaign_contacts
      GROUP BY campaign_id
      HAVING COUNT(*) FILTER (
        WHERE status NOT IN ('sent','delivered','opened','clicked','booked','bounced','unsubscribed','failed')
      ) = 0
    )
`;

db.query(sql)
  .then(r => { console.log('Backfilled:', r.rowCount, 'campaigns marked completed'); db.end(); })
  .catch(e => { console.error(e.message); db.end(); });
