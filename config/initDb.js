require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./db');
const { runMigrations } = require('./runMigrations');

const STRONG_PASSWORD = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{12,}$/;

/**
 * Creates the first admin account, only when the database has no admin yet and
 * INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD are provided. There are no default credentials.
 */
async function bootstrapAdmin() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM admins');
  if (rows[0].count > 0) {
    console.log('[init] admin account already exists, skipping bootstrap');
    return;
  }

  const email = String(process.env.INITIAL_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.INITIAL_ADMIN_PASSWORD || '');
  const fullName = String(process.env.INITIAL_ADMIN_NAME || 'System Admin').trim();

  if (!email || !password) {
    console.warn('[init] no admin exists. Set INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD, then run db:init again.');
    return;
  }

  if (!STRONG_PASSWORD.test(password)) {
    throw new Error('INITIAL_ADMIN_PASSWORD must be at least 12 characters with upper, lower case letters and a digit');
  }

  await pool.query(
    'INSERT INTO admins (full_name, email, password) VALUES ($1, $2, $3)',
    [fullName, email, await bcrypt.hash(password, 12)]
  );
  console.log(`[init] first admin created: ${email}. Remove INITIAL_ADMIN_PASSWORD from the environment now.`);
}

async function initDb() {
  await runMigrations();
  await bootstrapAdmin();
  console.log('[init] database ready');
}

initDb()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('[init] failed:', err.message);
    await pool.end().catch(() => {});
    process.exit(1);
  });
