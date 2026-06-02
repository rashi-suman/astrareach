const db = require('./_base');
module.exports = {
  list: async ({ where, params, limit, offset, sort = 'created_at', order = 'desc' }) => {
    const safeSort = ['email','company','industry','country','created_at'].includes(sort) ? sort : 'created_at';
    const safeOrder = order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const rows = await db.query(`SELECT * FROM contacts ${where} ORDER BY ${safeSort} ${safeOrder} LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params, limit, offset]);
    const total = await db.query(`SELECT COUNT(*)::int AS count FROM contacts ${where}`, params);
    return { rows: rows.rows, total: total.rows[0].count };
  },
};
