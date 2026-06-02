const db = require('./_base');
module.exports = {
  findByEmail: async (email) => (await db.query('SELECT * FROM users WHERE email = $1', [email])).rows[0],
  findById: async (id) => (await db.query('SELECT * FROM users WHERE id = $1', [id])).rows[0],
};
