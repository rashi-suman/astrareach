const db = require('./_base');
module.exports = { all: async () => (await db.query('SELECT * FROM campaigns ORDER BY created_at DESC')).rows };
