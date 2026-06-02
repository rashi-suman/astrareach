'use strict';
const db     = require('../config/db');
const bcrypt = require('bcryptjs');
const cache  = require('../config/cache');
const { logAction } = require('../middleware/audit');

const DEFAULT_ORG = '00000000-0000-0000-0000-000000000001';

module.exports = {
  // GET /users
  async index(req, res) {
    const orgId = req.org?.id || DEFAULT_ORG;
    const users = await db.query(
      `SELECT u.id, u.name, u.email, u.role, u.is_active, u.last_login_at, u.created_at,
              creator.name AS created_by_name
       FROM users u
       LEFT JOIN users creator ON creator.id = u.created_by
       WHERE u.org_id = $1
       ORDER BY u.created_at DESC`,
      [orgId],
    );
    res.render('users/index', { users: users.rows, title: 'Team Members' });
  },

  // GET /users/new
  newForm(req, res) {
    res.render('users/new', { title: 'Invite User' });
  },

  // POST /users
  async create(req, res) {
    const { name, email, role, password } = req.body;
    const orgId = req.org?.id || DEFAULT_ORG;

    if (!name || !email || !password) {
      req.flash('error', 'Name, email and password are required');
      return res.redirect('/users/new');
    }
    const validRoles = ['superadmin','admin','editor','lead_manager','campaign_manager'];
    if (!validRoles.includes(role)) {
      req.flash('error', 'Invalid role');
      return res.redirect('/users/new');
    }

    const existing = await db.query('SELECT id FROM users WHERE email=$1 AND org_id=$2', [email, orgId]);
    if (existing.rows.length) {
      req.flash('error', 'A user with that email already exists');
      return res.redirect('/users/new');
    }

    const hash = await bcrypt.hash(password, 12);
    await db.query(
      `INSERT INTO users (name, email, password_hash, role, org_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [name, email, hash, role, orgId, req.user.id],
    );
    req.flash('success', `User ${email} created`);
    res.redirect('/users');
  },

  // GET /users/:id
  async show(req, res) {
    const orgId = req.org?.id || DEFAULT_ORG;
    const user = await db.query(
      `SELECT u.*, (SELECT COUNT(*) FROM audit_log al WHERE al.user_id=u.id) AS audit_count
       FROM users u WHERE u.id=$1 AND u.org_id=$2`,
      [req.params.id, orgId],
    );
    if (!user.rows.length) { req.flash('error', 'User not found'); return res.redirect('/users'); }
    res.render('users/show', { member: user.rows[0], title: user.rows[0].name });
  },

  // GET /users/:id/edit
  async editForm(req, res) {
    const orgId = req.org?.id || DEFAULT_ORG;
    const user = await db.query(
      'SELECT id,name,email,role,is_active FROM users WHERE id=$1 AND org_id=$2',
      [req.params.id, orgId],
    );
    if (!user.rows.length) { req.flash('error', 'User not found'); return res.redirect('/users'); }
    res.render('users/edit', { member: user.rows[0], title: `Edit ${user.rows[0].name}` });
  },

  // PUT /users/:id
  async update(req, res) {
    const { name, role, is_active } = req.body;
    const orgId  = req.org?.id || DEFAULT_ORG;
    const userId = req.params.id;

    // Capture old values for audit
    const old = await db.query('SELECT name, role, is_active FROM users WHERE id=$1', [userId]);
    req.auditBefore = old.rows[0];

    const validRoles = ['superadmin','admin','editor','lead_manager','campaign_manager'];
    if (role && !validRoles.includes(role)) {
      req.flash('error', 'Invalid role'); return res.redirect(`/users/${userId}/edit`);
    }

    await db.query(
      `UPDATE users SET name=$1, role=$2, is_active=$3 WHERE id=$4 AND org_id=$5`,
      [name, role, is_active === 'true' || is_active === true, userId, orgId],
    );

    req.auditAfter = { name, role, is_active };

    // Invalidate user cache
    const cKey = cache.keys(orgId).user(userId);
    await cache.del(cKey);

    req.flash('success', 'User updated');
    res.redirect(`/users/${userId}`);
  },

  // DELETE /users/:id (superadmin only)
  async destroy(req, res) {
    const orgId = req.org?.id || DEFAULT_ORG;
    if (req.params.id === req.user.id) {
      req.flash('error', 'Cannot delete your own account');
      return res.redirect('/users');
    }
    await db.query('UPDATE users SET is_active=FALSE WHERE id=$1 AND org_id=$2', [req.params.id, orgId]);
    await cache.del(cache.keys(orgId).user(req.params.id));
    req.flash('success', 'User deactivated');
    res.redirect('/users');
  },

  // POST /users/:id/reset-password
  async resetPassword(req, res) {
    const { new_password } = req.body;
    if (!new_password || new_password.length < 8) {
      req.flash('error', 'Password must be at least 8 characters');
      return res.redirect(`/users/${req.params.id}`);
    }
    const hash = await bcrypt.hash(new_password, 12);
    const orgId = req.org?.id || DEFAULT_ORG;
    await db.query(
      'UPDATE users SET password_hash=$1 WHERE id=$2 AND org_id=$3',
      [hash, req.params.id, orgId],
    );
    await cache.del(cache.keys(orgId).user(req.params.id));
    req.flash('success', 'Password reset');
    res.redirect(`/users/${req.params.id}`);
  },

  // GET /users/:id/audit-log
  async auditLogView(req, res) {
    const orgId = req.org?.id || DEFAULT_ORG;
    const logs  = await db.query(
      `SELECT al.*, u.name AS user_name
       FROM audit_log al
       LEFT JOIN users u ON u.id = al.user_id
       WHERE al.user_id=$1 AND al.org_id=$2
       ORDER BY al.created_at DESC LIMIT 200`,
      [req.params.id, orgId],
    );
    res.render('users/audit', { logs: logs.rows, memberId: req.params.id, title: 'Audit Log' });
  },
};
