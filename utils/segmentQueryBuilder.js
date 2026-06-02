'use strict';

const ALLOWED_FIELDS = new Set([
  'email','first_name','last_name','company','industry','country','city',
  'job_title','tags','status','source','revenue_range','employee_count',
  'research_done','created_at','custom_fields',
  'whatsapp_phone','whatsapp_opted_in',
]);

function pushParam(params, value) {
  params.push(value);
  return `$${params.length}`;
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
      const p = pushParam(params, arr);
      return `tags && ${p}::text[]`;
    }
    if (op === 'contains_all') {
      if (!arr.length) return '1=1';
      const p = pushParam(params, arr);
      return `tags @> ${p}::text[]`;
    }
    if (op === 'not_contains') {
      if (!arr.length) return '1=1';
      const p = pushParam(params, arr);
      return `NOT (tags && ${p}::text[])`;
    }
    if (op === 'is_empty') return `(tags IS NULL OR tags = '{}')`;
    return '1=1';
  }

  // ── custom_fields ──────────────────────────────────────────────────────────
  if (field === 'custom_fields' && op === 'key_exists') {
    const p = pushParam(params, String(value));
    return `custom_fields ? ${p}`;
  }

  // ── created_at ─────────────────────────────────────────────────────────────
  if (field === 'created_at') {
    if (op === 'after')  { const p = pushParam(params, value); return `created_at >= ${p}::timestamptz`; }
    if (op === 'before') { const p = pushParam(params, value); return `created_at <= ${p}::timestamptz`; }
    if (op === 'between' && Array.isArray(value) && value.length === 2) {
      const p1 = pushParam(params, value[0]);
      const p2 = pushParam(params, value[1]);
      return `created_at BETWEEN ${p1}::timestamptz AND ${p2}::timestamptz`;
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
      const p = pushParam(params, `%${value}%`); return `(whatsapp_phone ILIKE ${p} OR phone ILIKE ${p})`;
    }
    if (op === 'not_contains') {
      const p = pushParam(params, `%${value}%`);
      return `((whatsapp_phone IS NULL OR whatsapp_phone NOT ILIKE ${p}) AND (phone IS NULL OR phone NOT ILIKE ${p}))`;
    }
    if (op === 'starts_with') {
      const p = pushParam(params, `${value}%`); return `(whatsapp_phone ILIKE ${p} OR phone ILIKE ${p})`;
    }
    if (op === 'in' || op === 'is_one_of') {
      const arr = Array.isArray(value) ? value : String(value).split(',').map(s => s.trim()).filter(Boolean);
      if (!arr.length) return '1=1';
      const p = pushParam(params, arr); return `(${eff} = ANY(${p}::text[]))`;
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
    const p = pushParam(params, `%${value}%`); return `${field} ILIKE ${p}`;
  }
  if (op === 'not_contains') {
    const p = pushParam(params, `%${value}%`); return `(${field} NOT ILIKE ${p} OR ${field} IS NULL)`;
  }
  if (op === 'starts_with') {
    const p = pushParam(params, `${value}%`); return `${field} ILIKE ${p}`;
  }
  if (op === 'in' || op === 'is_one_of') {
    const arr = Array.isArray(value) ? value : String(value).split(',').map(s=>s.trim()).filter(Boolean);
    if (!arr.length) return '1=1';
    const p = pushParam(params, arr); return `${field} = ANY(${p}::text[])`;
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
      // Flatten nested group: pass a fresh params reference so indices match
      const nestedParams = [...params]; // snapshot current length
      const savedLen = params.length;
      const nestedResult = buildFilterWhere(rule);
      // Re-offset the nested where clause so param indices start from savedLen+1
      const offset = savedLen;
      const reindexed = nestedResult.where.replace(/\$(\d+)/g, (_, n) => `$${parseInt(n, 10) + offset}`);
      params.push(...nestedResult.params);
      return `(${reindexed})`;
    }
    return `(${parseCondition(rule, params)})`;
  });

  return { where: clauses.join(` ${logic} `), params };
}

/**
 * Renumber placeholders in a WHERE fragment: $1 → $(1+offset), $2 → $(2+offset), …
 * Use when AND-ing this fragment after conditions that already consume $1…$offset
 * (e.g. `org_id=$1 AND (` + offsetSqlParams(where, 1) + `)` with params [orgId, ...params]).
 */
function offsetSqlParams(where, offset) {
  if (!offset) return where;
  return String(where).replace(/\$(\d+)/g, (_, n) => `$${parseInt(n, 10) + offset}`);
}

module.exports = { buildFilterWhere, offsetSqlParams };
