'use strict';
const db    = require('../config/db');
const cache = require('../config/cache');
const { connection: redis } = require('../config/redis');

// ---------------------------------------------------------------------------
// Role hierarchy and default permissions
// ---------------------------------------------------------------------------
const ROLE_LEVEL = {
  superadmin:       100,
  admin:            80,
  editor:           60,   // view + create + edit, no delete
  lead_manager:     40,
  campaign_manager: 40,
};

const DEFAULT_PERMISSIONS = {
  superadmin: ['*'],
  admin: [
    'contacts.*', 'campaigns.*', 'templates.*', 'segments.*',
    'analytics.view', 'users.view', 'settings.view',
    'import.*', 'export.*',
  ],
  // Editor: full read-write across contacts/segments/templates + analytics, but NO deletes and NO campaigns
  editor: [
    'contacts.view',   'contacts.create',   'contacts.edit',
    'segments.view',   'segments.create',   'segments.edit',
    'templates.view',  'templates.create',  'templates.edit',
    'analytics.view',
    'import.create',
  ],
  lead_manager: [
    'contacts.view', 'contacts.create', 'contacts.edit',
    'segments.view', 'segments.create',
    'import.create', 'analytics.view',
  ],
  campaign_manager: [
    'campaigns.*', 'templates.*', 'analytics.view',
    'contacts.view',
  ],
};

const DEFAULT_FIELD_VISIBILITY = {
  editor: {
    contacts: [
      'id','first_name','last_name','email','company','job_title',
      'phone','website','industry','city','country','linkedin_url',
      'revenue_range','employee_count','tags','status','source','created_at',
    ],
  },
  lead_manager: {
    contacts: [
      'id','first_name','last_name','email','company',
      'job_title','industry','country','tags','status','created_at',
    ],
  },
  campaign_manager: {
    contacts: [
      'id','first_name','last_name','email','company',
      'job_title','industry','country','status','ai_score','tags',
    ],
  },
};

// All contact columns exposed to admin / superadmin
const ALL_CONTACT_FIELDS = [
  'id','org_id','email','first_name','last_name','company','job_title',
  'phone','website','industry','city','country','linkedin_url',
  'revenue_range','employee_count','tags','custom_fields',
  'research_summary','research_done','ai_score','ai_score_reason',
  'ai_scored_at','intent_signals','enriched_at','status','source',
  'import_batch_id','created_at','updated_at',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function hasPermission(role, permission, grants = []) {
  // Check explicit per-user grant overrides first
  const override = grants.find(g => g.resource === permission || g.resource === `${permission.split('.')[0]}.*`);
  if (override) return override.granted;

  const allowed = DEFAULT_PERMISSIONS[role] || [];
  if (allowed.includes('*')) return true;

  // Exact match
  if (allowed.includes(permission)) return true;

  // Wildcard match: 'contacts.*' matches 'contacts.view'
  const [ns] = permission.split('.');
  if (allowed.includes(`${ns}.*`)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// 1. requireAuth — verify session; attach req.user / req.org
// ---------------------------------------------------------------------------
async function requireAuth(req, res, next) {
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    if (req.xhr || req.accepts('json') === 'json') {
      return res.status(401).json({ error: 'Unauthenticated' });
    }
    return res.redirect('/login');
  }

  // Attempt cache
  const cacheKey = cache.keys(req.user.org_id || 'default').user(req.user.id);
  const cached = await cache.getJSON(cacheKey);
  if (cached) {
    req.user = cached.user;
    req.org  = cached.org;
    return next();
  }

  try {
    const userRow = await db.query(
      `SELECT u.id, u.name, u.email, u.role, u.org_id,
              o.id AS org_db_id, o.name AS org_name, o.slug AS org_slug, o.settings AS org_settings
       FROM users u
       LEFT JOIN organisations o ON o.id = u.org_id
       WHERE u.id = $1`,
      [req.user.id],
    );
    if (!userRow.rows.length) {
      return res.redirect('/login');
    }
    const row = userRow.rows[0];
    req.user = {
      id:    row.id,
      name:  row.name,
      email: row.email,
      role:  row.role || 'admin',
      org_id: row.org_id || '00000000-0000-0000-0000-000000000001',
    };
    req.org = {
      id:       row.org_db_id || '00000000-0000-0000-0000-000000000001',
      name:     row.org_name  || 'Default',
      slug:     row.org_slug  || 'default',
      settings: row.org_settings || {},
    };

    await cache.setJSON(cacheKey, { user: req.user, org: req.org }, cache.TTL.USER);
    next();
  } catch (err) {
    console.error('[requireAuth]', err.message);
    next(err);
  }
}

// ---------------------------------------------------------------------------
// 2. requirePermission(permission) — returns middleware
// ---------------------------------------------------------------------------
function requirePermission(permission) {
  return async (req, res, next) => {
    const role    = req.user?.role || 'campaign_manager';
    const orgId   = req.user?.org_id;
    const userId  = req.user?.id;

    // Load per-user grants (with expiry check)
    let grants = [];
    try {
      const grantRows = await db.query(
        `SELECT resource, granted FROM permission_grants
         WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
        [userId],
      );
      grants = grantRows.rows;
    } catch { /* table may not exist yet on first run */ }

    if (hasPermission(role, permission, grants)) return next();

    const msg = `Permission denied: ${permission}`;
    if (req.xhr || req.accepts('json') === 'json') {
      return res.status(403).json({ error: msg });
    }
    req.flash('error', msg);
    res.redirect('back');
  };
}

// ---------------------------------------------------------------------------
// 3. applyFieldFilter(tableName) — attaches req.allowedFields
// ---------------------------------------------------------------------------
function applyFieldFilter(tableName) {
  return async (req, res, next) => {
    const role  = req.user?.role || 'campaign_manager';
    const orgId = req.user?.org_id || '00000000-0000-0000-0000-000000000001';

    if (role === 'superadmin' || role === 'admin') {
      req.allowedFields = tableName === 'contacts' ? [...ALL_CONTACT_FIELDS] : null;
      return next();
    }

    const cKey = cache.keys(orgId).fieldPerms(role, tableName);
    const cached = await cache.getJSON(cKey);
    if (cached) {
      req.allowedFields = cached;
      return next();
    }

    try {
      const rows = await db.query(
        `SELECT field_name FROM field_permissions
         WHERE org_id=$1 AND role=$2 AND table_name=$3 AND can_view=TRUE`,
        [orgId, role, tableName],
      );
      let fields = rows.rows.map(r => r.field_name);
      if (!fields.length) {
        fields = (DEFAULT_FIELD_VISIBILITY[role]?.[tableName]) || ALL_CONTACT_FIELDS;
      }
      req.allowedFields = fields;
      await cache.setJSON(cKey, fields, cache.TTL.FIELD_PERMS);
      next();
    } catch {
      req.allowedFields = ALL_CONTACT_FIELDS;
      next();
    }
  };
}

// ---------------------------------------------------------------------------
// 4. applyRowScope — builds scope-aware WHERE fragment
//    Returns { extraWhere, extraParams, nextIdx }
// ---------------------------------------------------------------------------
async function applyRowScope(userId, orgId, baseParamIdx) {
  let extraWhere = '';
  let extraParams = [];
  let idx = baseParamIdx;

  try {
    const scopeRows = await db.query(
      `SELECT scope_type, segment_id, filter_json
       FROM user_data_scopes WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    const scope = scopeRows.rows[0];
    if (!scope || scope.scope_type === 'all') return { extraWhere, extraParams, nextIdx: idx };

    if (scope.scope_type === 'imported_by_me') {
      extraWhere = ` AND c.import_batch_id IN (
        SELECT id FROM import_batches WHERE imported_by=$${idx})`;
      extraParams.push(userId);
      idx++;
    } else if (scope.scope_type === 'assigned') {
      // future: assigned_to column
    } else if (scope.scope_type === 'segment' && scope.segment_id) {
      const segRow = await db.query('SELECT filters FROM segments WHERE id=$1', [scope.segment_id]);
      if (segRow.rows.length) {
        const { buildFilterWhere, offsetSqlParams } = require('../utils/segmentQueryBuilder');
        const { where, params } = buildFilterWhere(segRow.rows[0].filters);
        const innerWhere = offsetSqlParams(where, idx - 1);
        const innerParamCount = params.length;
        extraWhere = ` AND c.id IN (SELECT id FROM contacts c2 WHERE ${innerWhere})`;
        extraParams = params;
        idx += innerParamCount;
      }
    }
  } catch { /* skip scope on error */ }

  return { extraWhere, extraParams, nextIdx: idx };
}

// ---------------------------------------------------------------------------
// 5. auditLog(action, resourceType) — middleware; fires after response
// ---------------------------------------------------------------------------
function auditLog(action, resourceType) {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);
    const originalRender = res.render.bind(res);

    const flush = async () => {
      try {
        const orgId = req.org?.id || req.user?.org_id || '00000000-0000-0000-0000-000000000001';
        const entry = {
          action,
          resource_type: resourceType,
          resource_id: req.params?.id || null,
          old_values: req.auditBefore || null,
          new_values: req.auditAfter  || null,
          ip_address: req.ip,
          user_agent: req.get('User-Agent'),
        };
        // Buffer in Redis; flushed every 500ms by schedulerService
        await redis.lpush(`audit_buffer:${orgId}:${req.user?.id || 'anon'}`,
          JSON.stringify({ ...entry, orgId, userId: req.user?.id, role: req.user?.role,
            created_at: new Date().toISOString() }));
      } catch { /* never block the response */ }
    };

    res.json = (...args) => { flush(); return originalJson(...args); };
    res.render = (...args) => { flush(); return originalRender(...args); };
    next();
  };
}

// ---------------------------------------------------------------------------
// Flush audit buffer (called by scheduler every 500ms)
// ---------------------------------------------------------------------------
async function flushAuditBuffer() {
  try {
    const keys = await redis.keys('audit_buffer:*');
    for (const key of keys) {
      const items = await redis.lrange(key, 0, 99);
      if (!items.length) continue;
      await redis.ltrim(key, items.length, -1);
      const parsed = items.map(i => { try { return JSON.parse(i); } catch { return null; } }).filter(Boolean);
      for (const p of parsed) {
        await db.query(
          `INSERT INTO audit_log
             (org_id,user_id,role,action,resource_type,resource_id,old_values,new_values,ip_address,user_agent,created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [p.orgId, p.userId, p.role, p.action, p.resource_type,
           p.resource_id, p.old_values ? JSON.stringify(p.old_values) : null,
           p.new_values  ? JSON.stringify(p.new_values)  : null,
           p.ip_address, p.user_agent, p.created_at],
        );
      }
    }
  } catch (err) {
    console.error('[flushAuditBuffer]', err.message);
  }
}

module.exports = {
  requireAuth,
  requirePermission,
  applyFieldFilter,
  applyRowScope,
  auditLog,
  flushAuditBuffer,
  hasPermission,
  ALL_CONTACT_FIELDS,
};
