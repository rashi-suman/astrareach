const db = require('../config/db');

const DEFAULT_ORG = '00000000-0000-0000-0000-000000000001';

function orgId(req) {
  return req.user?.org_id || DEFAULT_ORG;
}

module.exports = {
  index: async (req, res) => {
    try {
      const oid = orgId(req);

      const daily = (await db.query(`
        WITH RECURSIVE date_series AS (
          SELECT DATE(NOW() - INTERVAL 29 DAY) AS d
          UNION ALL
          SELECT DATE(d + INTERVAL 1 DAY)
          FROM date_series
          WHERE d < DATE(NOW())
        )
        SELECT DATE_FORMAT(ds.d, '%Y-%m-%d') AS day,
               SUM(CASE WHEN e.event_type='delivered' THEN 1 ELSE 0 END) AS delivered,
               SUM(CASE WHEN e.event_type='opened' THEN 1 ELSE 0 END) AS opened,
               SUM(CASE WHEN e.event_type='clicked' THEN 1 ELSE 0 END) AS clicked,
               SUM(CASE WHEN e.event_type='booked' THEN 1 ELSE 0 END) AS booked
        FROM date_series ds
        LEFT JOIN email_events e ON DATE(e.created_at) = ds.d
        GROUP BY ds.d
        ORDER BY ds.d
      `)).rows;

      const topCampaigns = (await db.query(`
        SELECT c.id, c.name,
          COUNT(cc.id) AS total,
          SUM(CASE WHEN cc.status IN ('opened','clicked','booked') THEN 1 ELSE 0 END) AS opened,
          SUM(CASE WHEN cc.status IN ('clicked','booked') THEN 1 ELSE 0 END) AS clicked,
          SUM(CASE WHEN cc.status='booked' THEN 1 ELSE 0 END) AS booked
        FROM campaigns c
        LEFT JOIN campaign_contacts cc ON cc.campaign_id=c.id
        GROUP BY c.id
        ORDER BY booked DESC, clicked DESC
        LIMIT 10
      `)).rows;

      const topTemplates = (await db.query(`
        SELECT t.id, t.name,
          COUNT(cc.id) AS total,
          SUM(CASE WHEN cc.status IN ('opened','clicked','booked') THEN 1 ELSE 0 END) AS opened
        FROM templates t
        LEFT JOIN campaigns c ON c.template_id=t.id
        LEFT JOIN campaign_contacts cc ON cc.campaign_id=c.id
        GROUP BY t.id
        ORDER BY opened DESC
        LIMIT 10
      `)).rows;

      const [waDailyRes, waOverviewRes, waTopRes] = await Promise.all([
        db.query(`
          WITH RECURSIVE date_series AS (
            SELECT DATE(NOW() - INTERVAL 29 DAY) AS d
            UNION ALL
            SELECT DATE(d + INTERVAL 1 DAY)
            FROM date_series
            WHERE d < DATE(NOW())
          )
          SELECT DATE_FORMAT(ds.d, '%Y-%m-%d') AS day,
                 SUM(CASE WHEN e.event_type='sent' THEN 1 ELSE 0 END) AS sent,
                 SUM(CASE WHEN e.event_type='delivered' THEN 1 ELSE 0 END) AS delivered,
                 SUM(CASE WHEN e.event_type='read' THEN 1 ELSE 0 END) AS \`read\`,
                 SUM(CASE WHEN e.event_type='replied' THEN 1 ELSE 0 END) AS replied
          FROM date_series ds
          LEFT JOIN wa_events e ON DATE(e.created_at) = ds.d AND e.org_id = ?
          GROUP BY ds.d
          ORDER BY ds.d
        `, [oid]),
        db.query(`
          SELECT event_type, COUNT(*) AS cnt
          FROM wa_events
          WHERE org_id = ? AND created_at >= NOW() - INTERVAL 30 DAY
          GROUP BY event_type
        `, [oid]),
        db.query(`
          SELECT c.id, c.name, c.status, c.messages_sent,
                 SUM(CASE WHEN we.event_type='delivered' THEN 1 ELSE 0 END) AS delivered,
                 SUM(CASE WHEN we.event_type='read' THEN 1 ELSE 0 END) AS read_count,
                 SUM(CASE WHEN we.event_type='replied' THEN 1 ELSE 0 END) AS replied
          FROM wa_campaigns c
          LEFT JOIN wa_events we ON we.campaign_id=c.id AND we.created_at >= NOW() - INTERVAL 30 DAY
          WHERE c.org_id = ?
          GROUP BY c.id
          ORDER BY c.messages_sent IS NULL ASC, c.messages_sent DESC, c.created_at DESC
          LIMIT 8
        `, [oid]),
      ]);

      const waDaily    = waDailyRes.rows;
      const waOverview = Object.fromEntries(waOverviewRes.rows.map((r) => [r.event_type, parseInt(r.cnt, 10)]));
      const waTop      = waTopRes.rows;

      res.render('analytics/index', {
        title: 'Analytics', page: 'analytics', breadcrumbs: ['Analytics'],
        chartData: {
          labels: daily.map((d) => d.day),
          sent: daily.map((d) => d.delivered),
          openRate: daily.map((d) => (d.delivered ? Number((d.opened / d.delivered * 100).toFixed(2)) : 0)),
          clickRate: daily.map((d) => (d.opened ? Number((d.clicked / d.opened * 100).toFixed(2)) : 0)),
          booked: daily.map((d) => d.booked || 0),
          deliveryPie: {
            delivered: daily.reduce((a, b) => a + Number(b.delivered || 0), 0),
            bounced: (await db.query("SELECT COUNT(*) AS count FROM email_events WHERE event_type='bounced' AND created_at >= NOW() - INTERVAL 30 DAY")).rows[0].count,
          },
        },
        waChart: {
          labels: waDaily.map((d) => d.day),
          sent:     waDaily.map((d) => parseInt(d.sent, 10) || 0),
          delivered: waDaily.map((d) => parseInt(d.delivered, 10) || 0),
          read:     waDaily.map((d) => parseInt(d.read, 10) || 0),
          replied:  waDaily.map((d) => parseInt(d.replied, 10) || 0),
        },
        waOverview,
        waTopCampaigns: waTop,
        topCampaigns,
        topTemplates,
        user: req.user,
      });
    } catch (e) { res.status(500).send(e.message); }
  },
};
