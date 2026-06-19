const db = require('../config/db');

function getGreeting() {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffset - (now.getTimezoneOffset() * 60 * 1000));
  const hour = istDate.getUTCHours();
  if (hour >= 5  && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  if (hour >= 17 && hour < 21) return 'Good evening';
  return 'Hi';
}

module.exports = {
  index: async (req, res) => {
    try {
      const [
        contactsRes,
        campaignsActiveRes,
        campaignsPausedRes,
        emailsTodayRes,
        openRateRes,
        clickRateRes,
        bookedRes,
        recentEventsRes,
        campaignPerfRes,
      ] = await Promise.all([
        db.query('SELECT COUNT(*) AS count FROM contacts'),

        // Active + paused campaigns (anything that's not draft/completed/stopped)
        db.query("SELECT COUNT(*) AS count FROM campaigns WHERE status IN ('active','paused','queued')"),
        db.query("SELECT COUNT(*) AS count FROM campaigns WHERE status='paused'"),

        // Emails sent today — count directly from email_events (accurate regardless of campaign status)
        db.query(`SELECT COUNT(*) AS count FROM email_events
                  WHERE event_type='sent'
                    AND created_at >= CURRENT_DATE`),

        // Open rate — use 'sent' as denominator (we reliably emit sent events)
        db.query(`SELECT
          CASE WHEN COUNT(CASE WHEN event_type='sent' THEN 1 END) > 0
          THEN ROUND(COUNT(CASE WHEN event_type='opened' THEN 1 END)
               / COUNT(CASE WHEN event_type='sent' THEN 1 END) * 100, 1)
          ELSE 0 END AS rate
          FROM email_events WHERE created_at > NOW() - INTERVAL 30 DAY`),

        // Click rate — use 'sent' as denominator
        db.query(`SELECT
          CASE WHEN COUNT(CASE WHEN event_type='sent' THEN 1 END) > 0
          THEN ROUND(COUNT(CASE WHEN event_type IN ('clicked','booked') THEN 1 END)
               / COUNT(CASE WHEN event_type='sent' THEN 1 END) * 100, 1)
          ELSE 0 END AS rate
          FROM email_events WHERE created_at > NOW() - INTERVAL 30 DAY`),

        db.query(`SELECT COUNT(*) AS count FROM email_events
                  WHERE event_type='booked' AND created_at > NOW() - INTERVAL 7 DAY`),

        db.query(`SELECT e.event_type, e.created_at,
          c.first_name, c.last_name, c.email AS contact_email,
          UPPER(COALESCE(LEFT(c.first_name,1),'') || COALESCE(LEFT(c.last_name,1),'')) AS avatar_initials,
          cam.name AS campaign_name
          FROM email_events e
          JOIN contacts c ON c.id = e.contact_id
          LEFT JOIN campaigns cam ON cam.id = e.campaign_id
          ORDER BY e.created_at DESC LIMIT 15`),

        db.query(`SELECT cam.id, cam.name, cam.status, cam.emails_sent,
          COUNT(CASE WHEN cc.status IN ('opened','clicked','booked') THEN 1 END) AS opened,
          COUNT(CASE WHEN cc.status IN ('clicked','booked') THEN 1 END) AS clicked,
          COUNT(CASE WHEN cc.status='booked' THEN 1 END) AS booked,
          COUNT(cc.id) AS total_contacts
          FROM campaigns cam
          LEFT JOIN campaign_contacts cc ON cc.campaign_id = cam.id
          GROUP BY cam.id ORDER BY cam.created_at DESC LIMIT 8`),
      ]);

      // Total emails sent (all time) for display
      const totalSentRes = await db.query(
        `SELECT COUNT(*) AS count FROM email_events WHERE event_type='sent'`
      );

      const totalContacts    = contactsRes.rows[0].count;
      const activeCampaigns  = campaignsActiveRes.rows[0].count;

      res.render('dashboard/index', {
        title: 'Dashboard',
        page: 'dashboard',
        breadcrumbs: ['Dashboard'],
        greeting: getGreeting(),
        totalContacts,
        activeCampaigns,
        stats: {
          totalContacts,
          activeCampaigns,
          pausedCampaigns:  campaignsPausedRes.rows[0].count,
          emailsSentToday:  emailsTodayRes.rows[0].count,
          totalEmailsSent:  totalSentRes.rows[0].count,
          openRate:         parseFloat(openRateRes.rows[0].rate  || 0),
          clickRate:        parseFloat(clickRateRes.rows[0].rate || 0),
          bookedThisWeek:   bookedRes.rows[0].count,
        },
        recentEvents:  recentEventsRes.rows,
        campaignPerf:  campaignPerfRes.rows,
      });
    } catch (e) {
      res.status(500).send(e.message);
    }
  },
};
