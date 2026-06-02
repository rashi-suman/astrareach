const db = require('../config/db');
const { getPagination } = require('../middleware/paginate');
const { buildFilterWhere, offsetSqlParams } = require('../utils/segmentQueryBuilder');
console.log("rashi is dilligent woman");

const DEFAULT_ORG = '00000000-0000-0000-0000-000000000001';

function sessionOrgId(req) {
  return req.user?.org_id || req.org?.id || DEFAULT_ORG;
}

/** WHERE clause + params for contacts matching a segment (same rules as detail / refresh). */
function segmentContactsWhere(seg) {
  const built = buildFilterWhere(seg.filters);
  const orgId = seg.org_id;
  const whereSql = orgId ? `org_id=$1 AND (${offsetSqlParams(built.where, 1)})` : `(${built.where})`;
  const qParams = orgId ? [orgId, ...built.params] : built.params;
  return { whereSql, qParams };
}

async function liveSegmentContactCount(seg) {
  const { whereSql, qParams } = segmentContactsWhere(seg);
  const r = await db.query(`SELECT COUNT(*)::int AS count FROM contacts WHERE ${whereSql}`, qParams);
  return r.rows[0].count;
}

module.exports = {
  index: async (req, res) => {
    try {
      const { page, limit, offset } = getPagination(req, 20);
      const org = sessionOrgId(req);
      const params = [org];
      const where = ['(org_id = $1 OR org_id IS NULL)'];
      if (req.query.search) {
        params.push(`%${req.query.search}%`);
        where.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length})`);
      }
      const wClause = where.join(' AND ');
      const segments = (await db.query(
        `SELECT * FROM segments WHERE ${wClause} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      )).rows;
      const total = (await db.query(`SELECT COUNT(*)::int AS count FROM segments WHERE ${wClause}`, params)).rows[0].count;

      await Promise.all(
        segments.map(async (seg) => {
          const live = await liveSegmentContactCount(seg);
          if (seg.contact_count !== live) {
            await db.query(
              'UPDATE segments SET contact_count=$1, last_count_at=NOW(), updated_at=NOW() WHERE id=$2',
              [live, seg.id],
            );
          }
          seg.contact_count = live;
        }),
      );

      res.render('segments/index', {
        title: 'Segments', page: 'segments', breadcrumbs: ['Segments'],
        segments, total, pageNo: page, limit, query: req.query,
      });
    } catch (e) { res.status(500).send(e.message); }
  },

  newPage: async (req, res) => {
    try {
      res.render('segments/new', { title: 'New Segment', page: 'segments', breadcrumbs: ['Segments', 'New'] });
    } catch (e) { res.status(500).send(e.message); }
  },

  create: async (req, res) => {
    try {
      const { name, description, filters } = req.body;
      if (!name) { req.flash('error', 'Segment name is required'); return res.redirect('/segments/new'); }
      const normalizedFilters = typeof filters === 'string' ? JSON.parse(filters || '{}') : (filters || { rules: [] });
      const org = sessionOrgId(req);
      await db.query(
        'INSERT INTO segments(name, description, filters, created_by, org_id) VALUES($1, $2, $3::jsonb, $4, $5)',
        [name, description || null, JSON.stringify(normalizedFilters), req.user.id, org],
      );
      req.flash('success', `Segment "${name}" created`);
      res.redirect('/segments');
    } catch (e) {
      req.flash('error', e.message);
      res.redirect('/segments/new');
    }
  },

  detail: async (req, res) => {
    try {
      const seg = (await db.query('SELECT * FROM segments WHERE id=$1', [req.params.id])).rows[0];
      if (!seg) return res.status(404).send('Segment not found');
      const { whereSql, qParams } = segmentContactsWhere(seg);
      // Always fetch live count and contacts together
      const [contactsResult, countResult] = await Promise.all([
        db.query(`SELECT * FROM contacts WHERE ${whereSql} ORDER BY created_at DESC LIMIT 50`, qParams),
        db.query(`SELECT COUNT(*)::int AS count FROM contacts WHERE ${whereSql}`, qParams),
      ]);
      const liveCount = countResult.rows[0].count;
      // Persist live count so list cards and campaign pickers stay accurate
      if (seg.contact_count !== liveCount) {
        await db.query(
          'UPDATE segments SET contact_count=$1, last_count_at=NOW(), updated_at=NOW() WHERE id=$2',
          [liveCount, seg.id],
        );
        seg.contact_count = liveCount;
      }
      res.render('segments/detail', { title: seg.name, page: 'segments', breadcrumbs: ['Segments', seg.name], segment: seg, contacts: contactsResult.rows });
    } catch (e) { res.status(500).send(e.message); }
  },

  update: async (req, res) => {
    try {
      const { name, description, filters } = req.body;
      const normalizedFilters = typeof filters === 'string' ? JSON.parse(filters || '{}') : (filters || { rules: [] });
      await db.query('UPDATE segments SET name=$1, description=$2, filters=$3::jsonb, updated_at=NOW() WHERE id=$4', [name, description || null, JSON.stringify(normalizedFilters), req.params.id]);
      req.flash('success', 'Segment updated successfully');
      res.redirect(`/segments/${req.params.id}`);
    } catch (e) {
      req.flash('error', e.message);
      res.redirect(`/segments/${req.params.id}`);
    }
  },

  remove: async (req, res) => {
    try {
      // Check if any campaigns are using this segment
      const inUse = (await db.query(
        `SELECT COUNT(*)::int AS count, string_agg(name, ', ') AS names
         FROM campaigns WHERE segment_id=$1`,
        [req.params.id]
      )).rows[0];

      if (inUse.count > 0) {
        req.flash('error', `Cannot delete — this segment is used by ${inUse.count} campaign(s): ${inUse.names}. Remove the segment from those campaigns first.`);
        return res.redirect(`/segments/${req.params.id}`);
      }

      await db.query('DELETE FROM segments WHERE id=$1', [req.params.id]);
      req.flash('success', 'Segment deleted');
      res.redirect('/segments');
    } catch (e) {
      req.flash('error', e.message);
      res.redirect('/segments');
    }
  },

  refresh: async (req, res) => {
    try {
      const seg = (await db.query('SELECT filters, org_id FROM segments WHERE id=$1', [req.params.id])).rows[0];
      if (!seg) return res.status(404).json({ error: 'Segment not found' });
      const count = await liveSegmentContactCount(seg);
      await db.query(
        'UPDATE segments SET contact_count=$1, last_count_at=NOW(), updated_at=NOW() WHERE id=$2',
        [count, req.params.id],
      );
      // If called via AJAX return JSON, otherwise redirect
      if (req.headers.accept && req.headers.accept.includes('application/json')) {
        return res.json({ contact_count: count });
      }
      req.flash('success', `Count refreshed: ${count} contacts`);
      res.redirect(`/segments/${req.params.id}`);
    } catch (e) { res.status(500).json({ error: e.message }); }
  },

  preview: async (req, res) => {
    try {
      const filters = typeof req.body.filters === 'string' ? JSON.parse(req.body.filters || '{}') : (req.body.filters || { rules: [] });
      const built = buildFilterWhere(filters);
      const orgId = req.user?.org_id;
      const whereSql = orgId ? `org_id=$1 AND (${offsetSqlParams(built.where, 1)})` : `(${built.where})`;
      const qParams = orgId ? [orgId, ...built.params] : built.params;
      const count = (await db.query(`SELECT COUNT(*)::int AS count FROM contacts WHERE ${whereSql}`, qParams)).rows[0].count;
      res.json({ count });
    } catch (e) { res.status(500).json({ error: e.message }); }
  },

  contacts: async (req, res) => {
    try {
      const { page, limit, offset } = getPagination(req, 50);
      const seg = (await db.query('SELECT filters, org_id FROM segments WHERE id=$1', [req.params.id])).rows[0];
      if (!seg) return res.status(404).json({ error: 'Segment not found' });
      const built = buildFilterWhere(seg.filters);
      const whereSql = seg.org_id ? `org_id=$1 AND (${offsetSqlParams(built.where, 1)})` : `(${built.where})`;
      const qParams = seg.org_id ? [seg.org_id, ...built.params] : built.params;
      const n = qParams.length;
      const rows = (await db.query(`SELECT * FROM contacts WHERE ${whereSql} ORDER BY created_at DESC LIMIT $${n + 1} OFFSET $${n + 2}`, [...qParams, limit, offset])).rows;
      const total = (await db.query(`SELECT COUNT(*)::int AS count FROM contacts WHERE ${whereSql}`, qParams)).rows[0].count;
      res.json({ page, limit, total, rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  },

  exportCSV: async (req, res) => {
    try {
      const seg = (await db.query('SELECT filters, name, org_id FROM segments WHERE id=$1', [req.params.id])).rows[0];
      if (!seg) return res.status(404).send('Segment not found');
      const built = buildFilterWhere(seg.filters);
      const whereSql = seg.org_id ? `org_id=$1 AND (${offsetSqlParams(built.where, 1)})` : `(${built.where})`;
      const qParams = seg.org_id ? [seg.org_id, ...built.params] : built.params;
      const rows = (await db.query(`SELECT email, first_name, last_name, company, industry, country, status, created_at FROM contacts WHERE ${whereSql} ORDER BY created_at DESC`, qParams)).rows;
      const filename = `${(seg.name || 'segment').replace(/[^a-zA-Z0-9-_]/g, '_')}.csv`;
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.write('email,first_name,last_name,company,industry,country,status,created_at\n');
      rows.forEach((r) => {
        const line = [r.email, r.first_name, r.last_name, r.company, r.industry, r.country, r.status, r.created_at]
          .map((v) => `"${String(v || '').replace(/"/g, '""')}"`).join(',');
        res.write(`${line}\n`);
      });
      res.end();
    } catch (e) { res.status(500).send(e.message); }
  },
};
