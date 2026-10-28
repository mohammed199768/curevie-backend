require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const pool = require('./db');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATION_FILE_PATTERN = /^(\d{3})_[a-z0-9_]+\.sql$/i;
// Arbitrary constant shared by every process that runs migrations.
const MIGRATION_LOCK_KEY = 482_917_301;

function checksum(sql) {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

async function ensureMigrationsLog(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS migrations_log (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) UNIQUE NOT NULL,
      checksum CHAR(64),
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await client.query('ALTER TABLE migrations_log ADD COLUMN IF NOT EXISTS checksum CHAR(64)');
}

async function getMigrationFiles() {
  const entries = await fs.readdir(MIGRATIONS_DIR, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.sql'))
    .map((entry) => entry.name);

  const invalid = files.filter((name) => !MIGRATION_FILE_PATTERN.test(name));
  if (invalid.length) {
    throw new Error(`Invalid migration file names (expected NNN_name.sql): ${invalid.join(', ')}`);
  }

  return files.sort((left, right) => {
    const diff = Number(left.slice(0, 3)) - Number(right.slice(0, 3));
    return diff !== 0 ? diff : left.localeCompare(right, 'en');
  });
}

/**
 * Applies pending migrations in order, one transaction per file.
 * Stops at the first failure and rethrows it, so nothing runs on a half-migrated schema.
 */
async function runMigrations({ log = console.log } = {}) {
  const client = await pool.connect();
  let applied = 0;
  let skipped = 0;

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await ensureMigrationsLog(client);

    const { rows } = await client.query('SELECT filename, checksum FROM migrations_log');
    const appliedMigrations = new Map(rows.map((row) => [row.filename, row.checksum]));

    for (const filename of await getMigrationFiles()) {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
      const sum = checksum(sql);

      if (appliedMigrations.has(filename)) {
        const storedSum = appliedMigrations.get(filename);
        if (storedSum && storedSum.trim() !== sum) {
          log(`[migrate] WARNING ${filename} changed after it was applied (checksum mismatch)`);
        }
        skipped += 1;
        continue;
      }

      if (/^\s*(BEGIN|COMMIT)\s*;/im.test(sql)) {
        throw new Error(`${filename} must not contain BEGIN/COMMIT; the runner owns the transaction`);
      }

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO migrations_log (filename, checksum) VALUES ($1, $2)',
          [filename, sum]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        err.message = `[migrate] ${filename} failed: ${err.message}`;
        throw err;
      }

      applied += 1;
      log(`[migrate] applied ${filename}`);
    }

    log(`[migrate] done: applied ${applied}, already applied ${skipped}`);
    return { applied, skipped };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => pool.end())
    .catch(async (err) => {
      console.error(err.message);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}

module.exports = { runMigrations };
