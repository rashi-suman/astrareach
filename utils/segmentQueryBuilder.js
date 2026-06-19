'use strict';

const ALLOWED_FIELDS = new Set([
  'email','first_name','last_name','company','industry','country','city',
  'job_title','tags','status','source','revenue_range','employee_count',
  'research_done','created_at','custom_fields',
  'whatsapp_phone','whatsapp_opted_in',
]);

function pushParam(params, value) {
  params.push(value);
  return `?`;
}

function toTagArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string') return value.split(',').map(t => t.trim()).filter(Boolean);
  return [];
}

function parseCondition(condition, params) {
  const { field, op, value } = condition || {};
  if (!ALLOWED_FIELDS.has(field)) return '1=1';

  // ── tags ──────────────────────────────────────────────────────────────────
  if (field === 'tags') {
    const arr = toTagArray(value);
    if (op === 'contains_any' || op === 'contains') {
      if (!arr.length) return '1=1';
      // JSON array column: match if any tag in arr exists in tags
      const clauses = arr.map(t => { params.push(t); return `JSON_CONTAINS(tags, JSON_QUOTE(?))`; });
      return clauses.join(' OR ');
    }
    if (op === 'contains_all') {
      if (!arr.length) return '1=1';
      // JSON array column: all tags in arr must exist in tags
      const clauses = arr.map(t => { params.push(t); return `JSON_CONTAINS(tags, JSON_QUOTE(?))`; });
      return clauses.join(' AND ');
    }
    if (op === 'not_contains') {
      if (!arr.length) return '1=1';
      // JSON array column: none of the tags in arr should exist in tags
      const clauses = arr.map(t => { params.push(t); return `NOT JSON_CONTAINS(tags, JSON_QUOTE(?))`; });
      return clauses.join(' AND ');
    }
    if (op === 'is_empty') return `(tags IS NULL OR JSON_LENGTH(tags) = 0)`;
    return '1=1';
  }

  // ── custom_fields ──────────────────────────────────────────────────────────
  if (field === 'custom_fields' && op === 'key_exists') {
    const p = pushParam(params, `$.${String(value)}`);
    return `JSON_CONTAINS_PATH(custom_fields, 'one', ${p})`;
  }

  // ── created_at ─────────────────────────────────────────────────────────────
  if (field === 'created_at') {
    if (op === 'after')  { const p = pushParam(params, value); return `created_at >= ${p}`; }
    if (op === 'before') { const p = pushParam(params, value); return `created_at <= ${p}`; }
    if (op === 'between' && Array.isArray(value) && value.length === 2) {
      const p1 = pushParam(params, value[0]);
      const p2 = pushParam(params, value[1]);
      return `created_at BETWEEN ${p1} AND ${p2}`;
    }
  }

  // ── boolean ────────────────────────────────────────────────────────────────
  if (field === 'research_done') {
    const p = pushParam(params, value === 'true' || value === true);
    return `research_done = ${p}`;
  }
  if (field === 'whatsapp_opted_in') {
    const on = value === 'true' || value === true;
    if (on) return '(whatsapp_opted_in IS TRUE)';
    return '(whatsapp_opted_in IS NOT TRUE)';
  }

  // whatsapp_phone: treat general `phone` as fallback (same as WhatsApp opt-in / campaigns)
  if (field === 'whatsapp_phone') {
    const eff = `COALESCE(NULLIF(TRIM(whatsapp_phone), ''), NULLIF(TRIM(phone), ''))`;
    if (op === 'is_empty') return `(${eff} IS NULL)`;
    if (op === 'is_filled') return `(${eff} IS NOT NULL)`;
    if (op === 'equals' || op === 'is') {
      const p = pushParam(params, value); return `(${eff} = ${p})`;
    }
    if (op === 'not_equals') {
      const p = pushParam(params, value); return `((${eff} != ${p}) OR (${eff} IS NULL))`;
    }
    if (op === 'contains') {
      const p = pushParam(params, `%${value}%`); return `(whatsapp_phone LIKE ${p} OR phone LIKE ${p})`;
    }
    if (op === 'not_contains') {
      const p = pushParam(params, `%${value}%`);
      return `((whatsapp_phone IS NULL OR whatsapp_phone NOT LIKE ${p}) AND (phone IS NULL OR phone NOT LIKE ${p}))`;
    }
    if (op === 'starts_with') {
      const p = pushParam(params, `${value}%`); return `(whatsapp_phone LIKE ${p} OR phone LIKE ${p})`;
    }
    if (op === 'in' || op === 'is_one_of') {
      const arr = Array.isArray(value) ? value : String(value).split(',').map(s => s.trim()).filter(Boolean);
      if (!arr.length) return '1=1';
      const p = pushParam(params, arr); return `(${eff} IN (${p}))`;
    }
    return '1=1';
  }

  // ── generic string ops ────────────────────────────────────────────────────
  if (op === 'equals' || op === 'is') {
    const p = pushParam(params, value); return `${field} = ${p}`;
  }
  if (op === 'not_equals') {
    const p = pushParam(params, value); return `(${field} != ${p} OR ${field} IS NULL)`;
  }
  if (op === 'contains') {
    const p = pushParam(params, `%${value}%`); return `${field} LIKE ${p}`;
  }
  if (op === 'not_contains') {
    const p = pushParam(params, `%${value}%`); return `(${field} NOT LIKE ${p} OR ${field} IS NULL)`;
  }
  if (op === 'starts_with') {
    const p = pushParam(params, `${value}%`); return `${field} LIKE ${p}`;
  }
  if (op === 'in' || op === 'is_one_of') {
    const arr = Array.isArray(value) ? value : String(value).split(',').map(s=>s.trim()).filter(Boolean);
    if (!arr.length) return '1=1';
    const p = pushParam(params, arr); return `${field} IN (${p})`;
  }
  if (op === 'is_empty')  return `(${field} IS NULL OR ${field} = '')`;
  if (op === 'is_filled') return `(${field} IS NOT NULL AND ${field} != '')`;

  return '1=1';
}

function buildFilterWhere(filters, _startIdx) {
  const params = [];
  if (!filters || (!Array.isArray(filters.rules) && !Array.isArray(filters))) {
    return { where: '1=1', params };
  }

  const rules = Array.isArray(filters) ? filters : (filters.rules || []);
  const logic = (filters.logic || 'AND').toUpperCase() === 'OR' ? 'OR' : 'AND';

  if (!rules.length) return { where: '1=1', params };

  const clauses = rules.map(rule => {
    if (rule && Array.isArray(rule.rules)) {
      // Recursively build nested group; params are accumulated by reference via spread
      const nestedResult = buildFilterWhere(rule);
      params.push(...nestedResult.params);
      return `(${nestedResult.where})`;
    }
    return `(${parseCondition(rule, params)})`;
  });

  return { where: clauses.join(` ${logic} `), params };
}

/**
 * No-op in MySQL: placeholders are positional `?` and do not carry numeric
 * indices, so there is nothing to offset. Kept for API compatibility with any
 * callers that still reference this helper; it simply returns the where string
 * unchanged.
 */
function offsetSqlParams(where, offset) {
  return String(where);
}

module.exports = { buildFilterWhere, offsetSqlParams };
