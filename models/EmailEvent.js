const db = require('./_base');
module.exports = { recent: async () => (await db.query('SELECT * FROM email_events ORDER BY created_at DESC LIMIT 20')).rows };
