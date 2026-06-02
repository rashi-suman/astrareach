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
        SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
               COUNT(*) FILTER (WHERE e.event_type='delivered')::int AS delivered,
               COUNT(*) FILTER (WHERE e.event_type='opened')::int AS opened,
               COUNT(*) FILTER (WHERE e.event_type='clicked')::int AS clicked,
               COUNT(*) FILTER (WHERE e.event_type='booked')::int AS booked
        FROM generate_series(now() - interval '29 days', now(), interval '1 day') d
        LEFT JOIN email_events e ON date(e.created_at)=date(d)
        GROUP BY d
        ORDER BY d
      `)).rows;

      const topCampaigns = (await db.query(`
        SELECT c.id, c.name,
          COUNT(cc.*)::int AS total,
          COUNT(cc.*) FILTER (WHERE cc.status IN ('opened','clicked','booked'))::int AS opened,
          COUNT(cc.*) FILTER (WHERE cc.status IN ('clicked','booked'))::int AS clicked,
          COUNT(cc.*) FILTER (WHERE cc.status='booked')::int AS booked
        FROM campaigns c
        LEFT JOIN campaign_contacts cc ON cc.campaign_id=c.id
        GROUP BY c.id
        ORDER BY booked DESC, clicked DESC
        LIMIT 10
      `)).rows;

      const topTemplates = (await db.query(`
        SELECT t.id, t.name,
          COUNT(cc.*)::int AS total,
          COUNT(cc.*) FILTER (WHERE cc.status IN ('opened','clicked','booked'))::int AS opened
        FROM templates t
        LEFT JOIN campaigns c ON c.template_id=t.id
        LEFT JOIN campaign_contacts cc ON cc.campaign_id=c.id
        GROUP BY t.id
        ORDER BY opened DESC
        LIMIT 10
      `)).rows;

      const [waDailyRes, waOverviewRes, waTopRes] = await Promise.all([
        db.query(`
          SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
                 COUNT(*) FILTER (WHERE e.event_type='sent')::int AS sent,
                 COUNT(*) FILTER (WHERE e.event_type='delivered')::int AS delivered,
                 COUNT(*) FILTER (WHERE e.event_type='read')::int AS read,
                 COUNT(*) FILTER (WHERE e.event_type='replied')::int AS replied
          FROM generate_series(now() - interval '29 days', now(), interval '1 day') d
          LEFT JOIN wa_events e ON date(e.created_at)=date(d) AND e.org_id=$1::uuid
          GROUP BY d
          ORDER BY d
        `, [oid]),
        db.query(`
          SELECT event_type, COUNT(*)::int AS cnt
          FROM wa_events
          WHERE org_id=$1::uuid AND created_at >= now() - interval '30 days'
          GROUP BY event_type
        `, [oid]),
        db.query(`
          SELECT c.id, c.name, c.status, c.messages_sent,
                 COUNT(we.id) FILTER (WHERE we.event_type='delivered')::int AS delivered,
                 COUNT(we.id) FILTER (WHERE we.event_type='read')::int AS read_count,
                 COUNT(we.id) FILTER (WHERE we.event_type='replied')::int AS replied
          FROM wa_campaigns c
          LEFT JOIN wa_events we ON we.campaign_id=c.id AND we.created_at >= now() - interval '30 days'
          WHERE c.org_id=$1::uuid
          GROUP BY c.id
          ORDER BY c.messages_sent DESC NULLS LAST, c.created_at DESC
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
            bounced: (await db.query("SELECT COUNT(*)::int AS count FROM email_events WHERE event_type='bounced' AND created_at >= now() - interval '30 days'")).rows[0].count,
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
