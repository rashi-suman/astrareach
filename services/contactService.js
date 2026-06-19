'use strict';
const db    = require('../config/db');
const cache = require('../config/cache');
const crypto = require('crypto');
const { applyRowScope } = require('../middleware/rbac');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT     = 200;

/**
 * Full-featured contact search with:
 *  - full-text search via MATCH...AGAINST
 *  - facet filters (industry, country, status, tags, score range)
 *  - row-scope awareness (RBAC)
 *  - keyset pagination for pages > 100 (avoids deep OFFSET)
 *  - parallel count + data queries
 *  - result caching (TTL 2 min)
 */
async function searchContacts(orgId, params, allowedFields, userId) {
  const {
    search        = '',
    industry      = '',
    country       = '',
    status        = '',
    tags          = '',
    ai_score_min  = '',
    ai_score_max  = '',
    sort          = 'created_at',
    order         = 'DESC',
    page          = 1,
    limit: rawLim = DEFAULT_LIMIT,
    cursor_created_at = null,
    cursor_id         = null,
  } = params;

  const limit   = Math.min(parseInt(rawLim, 10) || DEFAULT_LIMIT, MAX_LIMIT);
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);

  // Safe sort column whitelist
  const SAFE_SORT = new Set([
    'created_at','updated_at','email','company','first_name','last_name',
    'ai_score','industry','country',
  ]);
  const safeSortCol = SAFE_SORT.has(sort) ? sort : 'created_at';
  const safeOrder   = order === 'ASC' ? 'ASC' : 'DESC';

  // Build cache key from all params
  const paramHash = crypto
    .createHash('md5')
    .update(JSON.stringify({ orgId, ...params, userId }))
    .digest('hex');
  const cKey = cache.keys(orgId).contactSearch(paramHash);
  const cached = await cache.getJSON(cKey);
  if (cached) return cached;

  // ---- Build WHERE clause ----
  const conditions = ['c.org_id = ?'];
  const values     = [orgId];

  if (search) {
    conditions.push(
      `(MATCH(c.email, c.first_name, c.last_name, c.company) AGAINST(? IN BOOLEAN MODE)
       OR c.email LIKE ?
       OR c.first_name LIKE ?
       OR c.last_name  LIKE ?
       OR c.company    LIKE ?)`,
    );
    values.push(search, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (industry) { conditions.push(`c.industry = ?`); values.push(industry); }
  if (country)  { conditions.push(`c.country  = ?`); values.push(country);  }
  if (status)   { conditions.push(`c.status   = ?`); values.push(status);   }
  if (tags) {
    const tagArr = tags.split(',').map(t => t.trim()).filter(Boolean);
    if (tagArr.length) {
      const tagConditions = tagArr.map(() => `JSON_CONTAINS(c.tags, JSON_QUOTE(?))`);
      conditions.push(`(${tagConditions.join(' OR ')})`);
      values.push(...tagArr);
    }
  }
  if (ai_score_min !== '') { conditions.push(`c.ai_score >= ?`); values.push(parseFloat(ai_score_min)); }
  if (ai_score_max !== '') { conditions.push(`c.ai_score <= ?`); values.push(parseFloat(ai_score_max)); }

  // Apply row scope
  const scope = await applyRowScope(userId, orgId, values.length + 1);
  const whereStr = conditions.join(' AND ') + scope.extraWhere;
  const allValues = [...values, ...scope.extraParams];

  // Keyset pagination for deep pages (page > 100)
  let paginationWhere = '';
  const paginationValues = [];
  const useKeyset = pageNum > 100 && cursor_created_at && cursor_id;
  if (useKeyset) {
    paginationWhere = ` AND (c.${safeSortCol}, c.id) ${safeOrder === 'DESC' ? '<' : '>'} (?, ?)`;
    paginationValues.push(cursor_created_at, cursor_id);
  }

  const finalWhere  = whereStr + paginationWhere;
  const finalValues = [...allValues, ...paginationValues];

  // Allowed fields for SELECT
  const selFields = (allowedFields && allowedFields.length)
    ? allowedFields.map(f => `c.${f}`).join(', ')
    : 'c.*';

  const offset = useKeyset ? 0 : (pageNum - 1) * limit;

  const [countRes, dataRes] = await Promise.all([
    db.query(
      `SELECT COUNT(*) FROM contacts c WHERE ${whereStr}`,
      allValues,
    ),
    db.query(
      `SELECT ${selFields}
       FROM contacts c
       WHERE ${finalWhere}
       ORDER BY c.${safeSortCol} ${safeOrder}, c.id ${safeOrder}
       LIMIT ? OFFSET ?`,
      [...finalValues, limit, offset],
    ),
  ]);

  const total = parseInt(countRes.rows[0].count, 10);
  const result = {
    contacts:   dataRes.rows,
    total,
    page:       pageNum,
    limit,
    totalPages: Math.ceil(total / limit),
  };

  await cache.setJSON(cKey, result, cache.TTL.CONTACT_SEARCH);
  return result;
}

/**
 * Stream contacts as CSV directly to res without loading into memory.
 */
async function exportContactsStream(orgId, filters, allowedFields, res) {
  const fields = (allowedFields && allowedFields.length)
    ? allowedFields.filter(f => !f.startsWith('custom_fields.'))
    : ['id','email','first_name','last_name','company','job_title',
       'phone','industry','country','status','created_at'];

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="contacts-${Date.now()}.csv"`);

  // Header row
  res.write(fields.join(',') + '\n');

  const conditions = ['org_id = ?'];
  const values     = [orgId];

  if (filters?.status)   { conditions.push(`status = ?`);   values.push(filters.status);   }
  if (filters?.industry) { conditions.push(`industry = ?`); values.push(filters.industry); }

  const BATCH = 5000;
  let   offset = 0;

  const client = await db.getClient();
  try {
    while (true) {
      const rows = await client.query(
        `SELECT ${fields.join(',')}
         FROM contacts
         WHERE ${conditions.join(' AND ')}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
        [...values, BATCH, offset],
      );
      if (!rows.rows.length) break;
      for (const row of rows.rows) {
        const line = fields.map(f => {
          const v = row[f];
          if (v === null || v === undefined) return '';
          if (Array.isArray(v)) return `"${v.join(';').replace(/"/g, '""')}"`;
          return `"${String(v).replace(/"/g, '""')}"`;
        }).join(',');
        res.write(line + '\n');
      }
      offset += BATCH;
    }
  } finally {
    client.release();
  }
  res.end();
}

module.exports = { searchContacts, exportContactsStream };
