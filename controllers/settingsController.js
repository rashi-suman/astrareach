'use strict';
const db    = require('../config/db');
const bcrypt = require('bcryptjs');
const cache  = require('../config/cache');

const DEFAULT_ORG = '00000000-0000-0000-0000-000000000001';

// All contact columns available for field-permission management
const CONTACT_COLUMNS = [
  'email','first_name','last_name','company','job_title','phone','website',
  'industry','city','country','linkedin_url','revenue_range','employee_count',
  'tags','custom_fields','research_summary','ai_score','ai_score_reason',
  'intent_signals','status','source','created_at',
];

const ALL_ROLES = ['superadmin','admin','lead_manager','campaign_manager'];

module.exports = {
  index: async (req, res) => {
    try {
      res.render('settings/index', {
        title: 'Settings',
        page: 'settings',
        breadcrumbs: ['Settings'],
        messages: req.flash ? { success: req.flash('success'), error: req.flash('error') } : {},
      });
    } catch (e) { res.status(500).send(e.message); }
  },

  save: async (req, res) => {
    try {
      const { name, current_password, new_password, confirm_password } = req.body;

      if (name) {
        await db.query('UPDATE users SET name=? WHERE id=?', [name, req.user.id]);
      }

      if (new_password) {
        if (new_password !== confirm_password) {
          req.flash && req.flash('error', 'New passwords do not match');
          return res.redirect('/settings');
        }
        const user = (await db.query('SELECT password_hash FROM users WHERE id=?', [req.user.id])).rows[0];
        const valid = await bcrypt.compare(current_password || '', user.password_hash);
        if (!valid) {
          req.flash && req.flash('error', 'Current password is incorrect');
          return res.redirect('/settings');
        }
        const hash = await bcrypt.hash(new_password, 10);
        await db.query('UPDATE users SET password_hash=? WHERE id=?', [hash, req.user.id]);
      }

      req.flash && req.flash('success', 'Settings saved successfully');
      res.redirect('/settings');
    } catch (e) { res.status(500).send(e.message); }
  },

  // GET /settings/field-permissions
  fieldPermissionsIndex: async (req, res) => {
    try {
      const orgId = req.org?.id || DEFAULT_ORG;
      const existing = await db.query(
        `SELECT role, field_name, can_view, can_edit FROM field_permissions
         WHERE org_id=? AND table_name='contacts'`,
        [orgId],
      );
      // Build lookup: role → { fieldName → { can_view, can_edit } }
      const perms = {};
      for (const row of existing.rows) {
        if (!perms[row.role]) perms[row.role] = {};
        perms[row.role][row.field_name] = { can_view: row.can_view, can_edit: row.can_edit };
      }
      res.render('settings/field-permissions', {
        title: 'Field Permissions',
        columns: CONTACT_COLUMNS,
        roles:   ALL_ROLES,
        perms,
        page: 'settings',
      });
    } catch (e) { res.status(500).send(e.message); }
  },

  // POST /settings/field-permissions
  saveFieldPermissions: async (req, res) => {
    try {
      const orgId = req.org?.id || DEFAULT_ORG;
      const { role, table_name = 'contacts', fields } = req.body;
      if (!role || !fields) {
        req.flash('error', 'Role and fields are required');
        return res.redirect('/settings/field-permissions');
      }
      const fieldsArr = Array.isArray(fields) ? fields : [fields];
      for (const fieldObj of fieldsArr) {
        const { name, can_view, can_edit } = fieldObj;
        if (!name) continue;
        await db.query(
          `INSERT INTO field_permissions (org_id, role, table_name, field_name, can_view, can_edit)
           VALUES (?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE can_view=VALUES(can_view), can_edit=VALUES(can_edit), updated_at=NOW()`,
          [orgId, role, table_name, name,
           can_view === 'true' || can_view === true,
           can_edit === 'true' || can_edit === true],
        );
      }
      // Invalidate cache for this role
      await cache.delPattern(`field_perms:${orgId}:${role}:*`);
      req.flash('success', 'Field permissions saved');
      res.redirect('/settings/field-permissions');
    } catch (e) { res.status(500).send(e.message); }
  },

  // GET /settings/user-scopes
  userScopesIndex: async (req, res) => {
    try {
      const orgId = req.org?.id || DEFAULT_ORG;
      const users = await db.query(
        `SELECT u.id, u.name, u.email, u.role,
                uds.scope_type, uds.segment_id, uds.filter_json
         FROM users u
         LEFT JOIN user_data_scopes uds ON uds.user_id = u.id
         WHERE u.org_id=? AND u.is_active=TRUE
         ORDER BY u.name`,
        [orgId],
      );
      const segments = await db.query(
        'SELECT id, name FROM segments WHERE org_id=? OR org_id IS NULL ORDER BY name',
        [orgId],
      );
      res.render('settings/user-scopes', {
        title: 'User Data Scopes',
        members: users.rows,
        segments: segments.rows,
        page: 'settings',
      });
    } catch (e) { res.status(500).send(e.message); }
  },

  // POST /settings/user-scopes/:userId
  saveUserScope: async (req, res) => {
    try {
      const orgId      = req.org?.id || DEFAULT_ORG;
      const { userId } = req.params;
      const { scope_type, segment_id, filter_json } = req.body;

      // Verify target user belongs to same org
      const check = await db.query('SELECT id FROM users WHERE id=? AND org_id=?', [userId, orgId]);
      if (!check.rows.length) {
        req.flash('error', 'User not found');
        return res.redirect('/settings/user-scopes');
      }

      await db.query(
        `INSERT INTO user_data_scopes (user_id, scope_type, segment_id, filter_json, created_by)
         VALUES (?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           scope_type  = VALUES(scope_type),
           segment_id  = VALUES(segment_id),
           filter_json = VALUES(filter_json)`,
        [userId, scope_type || 'all',
         segment_id || null,
         filter_json ? JSON.stringify(filter_json) : null,
         req.user.id],
      ).catch(() => {
        // No UNIQUE constraint — use DELETE+INSERT
        return db.query('DELETE FROM user_data_scopes WHERE user_id=?', [userId]).then(() =>
          db.query(
            `INSERT INTO user_data_scopes (user_id, scope_type, segment_id, filter_json, created_by)
             VALUES (?,?,?,?,?)`,
            [userId, scope_type || 'all', segment_id || null,
             filter_json ? JSON.stringify(filter_json) : null, req.user.id],
          ),
        );
      });

      // Invalidate user cache
      await cache.del(cache.keys(orgId).user(userId));
      req.flash('success', 'Data scope updated');
      res.redirect('/settings/user-scopes');
    } catch (e) { res.status(500).send(e.message); }
  },
};
