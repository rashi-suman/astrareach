require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../config/db');

async function seedAdmin() {
  const email = process.env.SEED_ADMIN_EMAIL || 'rohit@astrabytesolutions.com';
  const password = process.env.SEED_ADMIN_PASSWORD || 'Payal2218$';
  const name = process.env.SEED_ADMIN_NAME || 'Rohit';
  const role = 'admin';
  const avatarInitials = (name || 'A')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0].toUpperCase())
    .join('');

  const passwordHash = await bcrypt.hash(password, 12);

  await db.query(
    `INSERT INTO users (name, email, password_hash, role, avatar_initials)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email)
     DO UPDATE SET
       name = EXCLUDED.name,
       password_hash = EXCLUDED.password_hash,
       role = EXCLUDED.role,
       avatar_initials = EXCLUDED.avatar_initials`,
    [name, email, passwordHash, role, avatarInitials]
  );

  console.log('Admin user seeded successfully.');
  console.log(`Email: ${email}`);
  console.log(`Password: ${password}`);
}

seedAdmin()
  .catch((err) => {
    console.error('Failed to seed admin user:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.pool.end();
    } catch (_) {
      // no-op
    }
  });
