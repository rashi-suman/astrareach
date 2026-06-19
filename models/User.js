const db = require('./_base');
module.exports = {
  findByEmail: async (email) => (await db.query('SELECT * FROM users WHERE email = ?', [email])).rows[0],
  findById: async (id) => (await db.query('SELECT * FROM users WHERE id = ?', [id])).rows[0],
};
