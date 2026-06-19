const db = require('../config/db');
const { getPagination } = require('../middleware/paginate');

function extractVariables(text = '') {
  return [...new Set((text.match(/{{\s*([a-zA-Z0-9_]+)\s*}}/g) || []).map((x) => x.replace(/[{}\s]/g, '')))];
}

function fillTemplate(input, data) {
  return input.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => data[key] || '');
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
        where.push(`(name LIKE ? OR subject LIKE ?)`);
      }
      const wClause = where.join(' AND ');
      const templates = (await db.query(
        `SELECT * FROM templates WHERE ${wClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      )).rows;
      const total = (await db.query(`SELECT COUNT(*) AS count FROM templates WHERE ${wClause}`, params)).rows[0].count;
      res.render('templates/index', {
        title: 'Templates', page: 'templates', breadcrumbs: ['Templates'],
        templates, total, pageNo: page, limit, query: req.query,
      });
    } catch (e) { res.status(500).send(e.message); }
  },

  newPage: async (req, res) => {
    try { res.render('templates/new', { title: 'New Template', page: 'templates', breadcrumbs: ['Templates', 'New'] }); }
    catch (e) { res.status(500).send(e.message); }
  },

  create: async (req, res) => {
    try {
      if (!req.body.name || !req.body.subject) { req.flash('error', 'Template name and subject are required'); return res.redirect('/templates/new'); }
      const vars = extractVariables((req.body.subject || '') + ' ' + (req.body.body_html || ''));
      const includeUnsub = req.body.include_unsubscribe === 'on' || req.body.include_unsubscribe === 'true' || req.body.include_unsubscribe === '1';
      await db.query(
        'INSERT INTO templates(name, subject, body_html, variables, preview_text, booking_url, include_unsubscribe, created_by) VALUES(?,?,?,?,?,?,?,?)',
        [req.body.name, req.body.subject, req.body.body_html, vars, req.body.preview_text || null, req.body.booking_url || null, includeUnsub, req.user.id]
      );
      req.flash('success', `Template "${req.body.name}" created`);
      res.redirect('/templates');
    } catch (e) {
      req.flash('error', e.message);
      res.redirect('/templates/new');
    }
  },

  detail: async (req, res) => {
    try {
      const template = (await db.query('SELECT * FROM templates WHERE id=?', [req.params.id])).rows[0];
      if (!template) return res.status(404).send('Template not found');
      res.render('templates/detail', { title: template.name, page: 'templates', breadcrumbs: ['Templates', template.name], template });
    } catch (e) { res.status(500).send(e.message); }
  },

  editPage: async (req, res) => {
    try {
      const template = (await db.query('SELECT * FROM templates WHERE id=?', [req.params.id])).rows[0];
      if (!template) return res.status(404).send('Template not found');
      res.render('templates/edit', { title: `Edit ${template.name}`, page: 'templates', breadcrumbs: ['Templates', 'Edit'], template });
    } catch (e) { res.status(500).send(e.message); }
  },

  update: async (req, res) => {
    try {
      const vars = extractVariables((req.body.subject || '') + ' ' + (req.body.body_html || ''));
      const includeUnsub = req.body.include_unsubscribe === 'on' || req.body.include_unsubscribe === 'true' || req.body.include_unsubscribe === '1';
      await db.query(
        'UPDATE templates SET name=?, subject=?, body_html=?, variables=?, preview_text=?, booking_url=?, include_unsubscribe=?, updated_at=NOW() WHERE id=?',
        [req.body.name, req.body.subject, req.body.body_html, vars, req.body.preview_text || null, req.body.booking_url || null, includeUnsub, req.params.id]
      );
      req.flash('success', 'Template updated successfully');
      res.redirect(`/templates/${req.params.id}`);
    } catch (e) {
      req.flash('error', e.message);
      res.redirect(`/templates/${req.params.id}`);
    }
  },

  remove: async (req, res) => {
    try {
      const inUse = (await db.query("SELECT COUNT(*) AS count FROM campaigns WHERE template_id=? AND status IN ('active','queued')", [req.params.id])).rows[0].count;
      if (inUse > 0) { req.flash('error', 'Cannot delete — template is used by an active or queued campaign'); return res.redirect(`/templates/${req.params.id}`); }
      await db.query('DELETE FROM templates WHERE id=?', [req.params.id]);
      req.flash('success', 'Template deleted');
      res.redirect('/templates');
    } catch (e) {
      req.flash('error', e.message);
      res.redirect('/templates');
    }
  },

  preview: async (req, res) => {
    try {
      const sample = { first_name: 'John', last_name: 'Doe', company: 'Acme Inc', job_title: 'CTO', industry: 'SaaS', custom_field_name: 'Value' };
      const html = fillTemplate(req.body.body_html || '', sample);
      res.json({ html });
    } catch (e) { res.status(500).json({ error: e.message }); }
  },
};
