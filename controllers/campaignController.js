const db = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const { getPagination } = require('../middleware/paginate');
const { sendQueue } = require('../services/queueService');
const { buildFilterWhere, offsetSqlParams } = require('../utils/segmentQueryBuilder');
const { scheduledInstantFromParts } = require('../utils/scheduleHelpers');

const DEFAULT_ORG = '00000000-0000-0000-0000-000000000001';

async function getCampaignStats(campaignId) {
  return (await db.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(CASE WHEN status IN ('sent','delivered','opened','clicked','booked','bounced') THEN 1 END) AS sent,
      COUNT(CASE WHEN status IN ('delivered','opened','clicked','booked') THEN 1 END) AS delivered,
      COUNT(CASE WHEN status IN ('opened','clicked','booked') THEN 1 END) AS opened,
      COUNT(CASE WHEN status IN ('clicked','booked') THEN 1 END) AS clicked,
      COUNT(CASE WHEN status='booked' THEN 1 END) AS booked,
      COUNT(CASE WHEN status='bounced' THEN 1 END) AS bounced
    FROM campaign_contacts WHERE campaign_id=?
  `, [campaignId])).rows[0];
}

// Simple {{variable}} substitution — no AI needed
function substituteVars(template, data) {
  return (template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => data[key] || '');
}

async function enqueuePending(campaign, limit) {
  const pending = (await db.query(`
    SELECT cc.id AS campaign_contact_id, c.*,
           COALESCE(t.subject, '') AS subject,
           COALESCE(t.body_html, '') AS body_html,
           COALESCE(t.booking_url, cam.booking_url, '') AS booking_url
    FROM campaign_contacts cc
    JOIN contacts c ON c.id = cc.contact_id
    JOIN campaigns cam ON cam.id = cc.campaign_id
    LEFT JOIN templates t ON t.id = cam.template_id
    WHERE cc.campaign_id = ? AND cc.status = 'pending'
    ORDER BY cc.created_at ASC
    LIMIT ?
  `, [campaign.id, limit])).rows;

  for (const p of pending) {
    const vars = { ...p, booking_url: p.booking_url || '' };
    const personalizedSubject = substituteVars(p.subject, vars);
    const personalizedBody    = substituteVars(p.body_html, vars);

    await sendQueue.add('send', {
      campaignContactId: p.campaign_contact_id,
      contact:   { id: p.id, email: p.email, first_name: p.first_name, last_name: p.last_name, company: p.company },
      email:     { subject: personalizedSubject, body_html: personalizedBody },
      campaignId: campaign.id,
    });
    await db.query("UPDATE campaign_contacts SET status='queued' WHERE id=?", [p.campaign_contact_id]);
  }
}

module.exports = {
  index: async (req, res) => {
    try {
      const { page, limit, offset } = getPagination(req, 20);
      const params = [];
      const where = ['1=1'];
      if (req.query.search) {
        params.push(`%${req.query.search}%`);
        params.push(`%${req.query.search}%`);
        where.push(`(name LIKE ? OR description LIKE ?)`);
      }
      if (req.query.status) {
        params.push(req.query.status);
        where.push(`status = ?`);
      }
      const wClause = where.join(' AND ');
      const rows = (await db.query(
        `SELECT * FROM campaigns WHERE ${wClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      )).rows;
      const total = (await db.query(`SELECT COUNT(*) AS count FROM campaigns WHERE ${wClause}`, params)).rows[0].count;
      const summary = (await db.query(`SELECT status, COUNT(*) AS count FROM campaigns GROUP BY status`)).rows;
      // Support JSON response for campaign picker modal
      if (req.query.format === 'json' || (req.headers.accept && req.headers.accept.includes('application/json') && !req.headers['x-requested-with']?.includes('html'))) {
        return res.json({ campaigns: rows });
      }
      res.render('campaigns/index', {
        title: 'Campaigns', page: 'campaigns', breadcrumbs: ['Campaigns'],
        campaigns: rows, total, pageNo: page, limit, query: req.query, summary,
      });
    } catch (e) { res.status(500).send(e.message); }
  },

  newRedirect: async (req, res) => res.redirect('/campaigns/new/step/1'),

  stepPage: async (req, res) => {
    try {
      const n = Number(req.params.n);
      if (![1, 2, 3, 4].includes(n)) return res.status(404).send('Invalid step');
      const [segmentsRes, templatesRes] = await Promise.all([
        db.query('SELECT id, name, contact_count FROM segments ORDER BY name ASC'),
        db.query('SELECT id, name, subject FROM templates ORDER BY name ASC'),
      ]);
      res.render(`campaigns/new/step${n}`, {
        title: `New Campaign - Step ${n}`,
        page: 'campaigns',
        breadcrumbs: ['Campaigns', 'New', `Step ${n}`],
        draft: req.session.campaignDraft || {},
        segments: segmentsRes.rows,
        templates: templatesRes.rows,
      });
    } catch (e) { res.status(500).send(e.message); }
  },

  step1: async (req, res) => {
    req.session.campaignDraft = { ...(req.session.campaignDraft || {}), name: req.body.name, description: req.body.description };
    res.redirect('/campaigns/new/step/2');
  },

  step2: async (req, res) => {
    const contactIds = Array.isArray(req.body.contact_ids)
      ? req.body.contact_ids
      : (req.body.contact_ids
        ? String(req.body.contact_ids).split(',').map((x) => x.trim()).filter(Boolean)
        : []);
    req.session.campaignDraft = { ...(req.session.campaignDraft || {}), segment_id: req.body.segment_id || null, contact_ids: contactIds };
    res.redirect('/campaigns/new/step/3');
  },

  step3: async (req, res) => {
    req.session.campaignDraft = { ...(req.session.campaignDraft || {}), template_id: req.body.template_id, variable_overrides: req.body.variable_overrides || {} };
    res.redirect('/campaigns/new/step/4');
  },

  step4: async (req, res) => {
    try {
      const d = req.session.campaignDraft || {};
      const org = req.user?.org_id || req.org?.id || DEFAULT_ORG;
      const tz = req.body.timezone || 'Asia/Kolkata';
      const dateStr = (req.body.schedule_date || '').trim() || new Date().toISOString().slice(0, 10);
      const timeStr = (req.body.send_time || '09:00').toString().slice(0, 5);
      const scheduledAt = scheduledInstantFromParts(dateStr, timeStr, tz);
      const startNow = !!req.body.start_now;

      let status;
      let scheduledStartAt = null;
      let shouldEnqueue = false;

      if (startNow) {
        status = 'active';
        shouldEnqueue = true;
      } else if (scheduledAt && scheduledAt.getTime() > Date.now() + 60 * 1000) {
        status = 'scheduled';
        scheduledStartAt = scheduledAt;
      } else if (scheduledAt && scheduledAt.getTime() <= Date.now()) {
        req.flash('warning', 'The chosen date and time are in the past — starting the campaign immediately.');
        status = 'active';
        shouldEnqueue = true;
      } else {
        status = 'draft';
      }

      const newCampaignId = uuidv4();
      await db.query(
        `INSERT INTO campaigns(id, name, description, template_id, segment_id, daily_limit, send_time, timezone, status, created_by, scheduled_start_at, org_id)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          newCampaignId,
          d.name,
          d.description || null,
          d.template_id || null,
          d.segment_id || null,
          Number(req.body.daily_limit || 50),
          timeStr,
          tz,
          status,
          req.user.id,
          scheduledStartAt,
          org,
        ],
      );
      const campaign = (await db.query('SELECT * FROM campaigns WHERE id=?', [newCampaignId])).rows[0];

      let contactIds = d.contact_ids || [];
      if (!contactIds.length && d.segment_id) {
        const seg = (await db.query('SELECT filters, org_id FROM segments WHERE id=?', [d.segment_id])).rows[0];
        if (seg) {
          const built = buildFilterWhere(seg.filters);
          const whereSql = seg.org_id ? `org_id=? AND (${offsetSqlParams(built.where, 1)})` : `(${built.where})`;
          const qParams = seg.org_id ? [seg.org_id, ...built.params] : built.params;
          contactIds = (await db.query(`SELECT id FROM contacts WHERE ${whereSql}`, qParams)).rows.map((r) => r.id);
        }
      }

      for (const cid of contactIds) {
        await db.query(
          'INSERT IGNORE INTO campaign_contacts(campaign_id, contact_id, status, org_id) VALUES(?,?,?,?)',
          [campaign.id, cid, 'pending', org],
        );
      }

      await db.query('UPDATE campaigns SET total_contacts=(SELECT COUNT(*) FROM campaign_contacts WHERE campaign_id=?) WHERE id=?', [campaign.id, campaign.id]);

      if (shouldEnqueue) {
        await enqueuePending(campaign, campaign.daily_limit);
      }

      req.session.campaignDraft = null;
      if (status === 'scheduled') {
        req.flash('success', `Campaign "${campaign.name}" is scheduled. Sending will begin automatically at the chosen date and time (${tz}).`);
      } else {
        req.flash('success', `Campaign "${campaign.name}" created successfully`);
      }
      res.redirect(`/campaigns/${campaign.id}`);
    } catch (e) {
      req.flash('error', e.message);
      const d = req.session.campaignDraft || {};
      req.session.campaignDraft = {
        ...d,
        schedule_date: req.body.schedule_date,
        send_time: req.body.send_time,
        timezone: req.body.timezone,
        daily_limit: req.body.daily_limit,
      };
      res.redirect('/campaigns/new/step/4');
    }
  },

  detail: async (req, res) => {
    try {
      const { page, limit, offset } = getPagination(req, 50);
      const campaign = (await db.query('SELECT * FROM campaigns WHERE id=?', [req.params.id])).rows[0];
      if (!campaign) return res.status(404).send('Campaign not found');

      const contacts = (await db.query('SELECT cc.*, c.first_name, c.last_name, c.email, c.company FROM campaign_contacts cc JOIN contacts c ON c.id=cc.contact_id WHERE cc.campaign_id=? ORDER BY cc.created_at DESC LIMIT ? OFFSET ?', [req.params.id, limit, offset])).rows;
      const events = (await db.query('SELECT e.*, c.first_name, c.last_name FROM email_events e LEFT JOIN contacts c ON c.id=e.contact_id WHERE e.campaign_id=? ORDER BY e.created_at DESC LIMIT 20', [req.params.id])).rows;
      const stats = await getCampaignStats(req.params.id);

      // Fetch linked template (if any)
      const template = campaign.template_id
        ? (await db.query('SELECT id, name, subject, body_html, booking_url, include_unsubscribe FROM templates WHERE id=?', [campaign.template_id])).rows[0] || null
        : null;

      res.render('campaigns/detail', {
        title: campaign.name,
        page: 'campaigns',
        breadcrumbs: ['Campaigns', campaign.name],
        campaign,
        stats,
        contacts,
        events,
        template,
        pageNo: page,
        limit,
      });
    } catch (e) { res.status(500).send(e.message); }
  },

  contactEmailPreview: async (req, res) => {
    try {
      const row = (await db.query(`
        SELECT cc.*, c.first_name, c.last_name, c.email, c.company
        FROM campaign_contacts cc
        JOIN contacts c ON c.id = cc.contact_id
        WHERE cc.campaign_id=? AND cc.id=?
      `, [req.params.id, req.params.campaignContactId])).rows[0];
      if (!row) return res.status(404).send('Contact email not found');
      res.send(`
        <div class="card" style="margin:16px">
          <div class="card-body">
            <h3 style="margin-bottom:8px">${(row.first_name || '')} ${(row.last_name || '')}</h3>
            <p class="text-secondary" style="margin-bottom:8px">${row.email} • ${row.company || '-'}</p>
            <div style="margin-bottom:8px"><strong>Subject:</strong> ${row.personalized_subject || '-'}</div>
            <iframe style="width:100%;min-height:280px;border:1px solid var(--border);border-radius:8px;background:#fff" srcdoc="${String(row.personalized_body_html || '').replace(/"/g, '&quot;')}"></iframe>
          </div>
        </div>
      `);
    } catch (e) { res.status(500).send(e.message); }
  },

  stats: async (req, res) => {
    try { res.json(await getCampaignStats(req.params.id)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  },

  eventsChart: async (req, res) => {
    try {
      const rows = (await db.query(`
        SELECT
          DATE_FORMAT(created_at, '%Y-%m-%d %H:00:00') AS hour,
          event_type,
          COUNT(*) AS cnt
        FROM email_events
        WHERE campaign_id=?
          AND created_at >= NOW() - INTERVAL 48 HOUR
        GROUP BY 1, 2
        ORDER BY 1
      `, [req.params.id])).rows;

      const hourMap = {};
      rows.forEach(r => {
        const label = new Date(r.hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (!hourMap[label]) hourMap[label] = { sent: 0, opened: 0, clicked: 0 };
        if (r.event_type === 'sent' || r.event_type === 'delivered') hourMap[label].sent += r.cnt;
        if (r.event_type === 'opened') hourMap[label].opened += r.cnt;
        if (r.event_type === 'clicked') hourMap[label].clicked += r.cnt;
      });

      const labels = Object.keys(hourMap);
      res.json({
        labels,
        sent: labels.map(l => hourMap[l].sent),
        opened: labels.map(l => hourMap[l].opened),
        clicked: labels.map(l => hourMap[l].clicked),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  },

  start: async (req, res) => {
    try {
      await db.query(
        "UPDATE campaigns SET status='active', started_at=COALESCE(started_at, NOW()), scheduled_start_at=NULL WHERE id=? AND status IN ('draft','scheduled')",
        [req.params.id],
      );
      const campaign = (await db.query('SELECT * FROM campaigns WHERE id=?', [req.params.id])).rows[0];
      if (campaign) await enqueuePending(campaign, campaign.daily_limit);
      req.flash('success', 'Campaign started — emails are being queued');
      res.redirect(`/campaigns/${req.params.id}`);
    } catch (e) {
      req.flash('error', e.message);
      res.redirect(`/campaigns/${req.params.id}`);
    }
  },

  pause: async (req, res) => {
    try {
      await db.query("UPDATE campaigns SET status='paused' WHERE id=?", [req.params.id]);
      req.flash('info', 'Campaign paused');
      res.redirect(`/campaigns/${req.params.id}`);
    } catch (e) {
      req.flash('error', e.message);
      res.redirect(`/campaigns/${req.params.id}`);
    }
  },

  resume: async (req, res) => {
    try {
      await db.query("UPDATE campaigns SET status='active' WHERE id=?", [req.params.id]);
      const campaign = (await db.query('SELECT * FROM campaigns WHERE id=?', [req.params.id])).rows[0];
      if (campaign) await enqueuePending(campaign, Math.max(1, campaign.daily_limit - (campaign.emails_sent_today || 0)));
      req.flash('success', 'Campaign resumed');
      res.redirect(`/campaigns/${req.params.id}`);
    } catch (e) {
      req.flash('error', e.message);
      res.redirect(`/campaigns/${req.params.id}`);
    }
  },

  stop: async (req, res) => {
    try {
      await db.query("UPDATE campaigns SET status='stopped' WHERE id=?", [req.params.id]);
      await db.query("UPDATE campaign_contacts SET status='failed', error_message='Campaign stopped' WHERE campaign_id=? AND status IN ('pending','researching','ready','queued')", [req.params.id]);
      req.flash('warning', 'Campaign stopped — pending emails have been cancelled');
      res.redirect(`/campaigns/${req.params.id}`);
    } catch (e) {
      req.flash('error', e.message);
      res.redirect(`/campaigns/${req.params.id}`);
    }
  },

  remove: async (req, res) => {
    try {
      const c = (await db.query('SELECT status, name FROM campaigns WHERE id=?', [req.params.id])).rows[0];
      if (!c) { req.flash('error', 'Campaign not found'); return res.redirect('/campaigns'); }
      if (!['draft', 'completed', 'scheduled'].includes(c.status)) { req.flash('error', 'Only draft, scheduled, or completed campaigns can be deleted'); return res.redirect(`/campaigns/${req.params.id}`); }
      await db.query('DELETE FROM campaigns WHERE id=?', [req.params.id]);
      req.flash('success', `Campaign "${c.name}" deleted`);
      res.redirect('/campaigns');
    } catch (e) {
      req.flash('error', e.message);
      res.redirect('/campaigns');
    }
  },
};
