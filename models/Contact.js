const db = require('./_base');
module.exports = {
  list: async ({ where, params, limit, offset, sort = 'created_at', order = 'desc' }) => {
    const safeSort = ['email','company','industry','country','created_at'].includes(sort) ? sort : 'created_at';
    const safeOrder = order.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const rows = await db.query(`SELECT * FROM contacts ${where} ORDER BY ${safeSort} ${safeOrder} LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const total = await db.query(`SELECT COUNT(*) AS count FROM contacts ${where}`, params);
    return { rows: rows.rows, total: total.rows[0].count };
  },
};
