require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const pool = require('./db');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureMigrationsLog() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migrations_log (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations() {
  const result = await pool.query('SELECT filename FROM migrations_log');
  return new Set(result.rows.map((row) => row.filename));
}

async function getMigrationFiles() {
  const entries = await fs.readdir(MIGRATIONS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.sql'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function runMigrations() {
  await ensureMigrationsLog();

  const appliedMigrations = await getAppliedMigrations();
  const migrationFiles = await getMigrationFiles();

  let applied = 0;
  let skipped = 0;
  let failed = 0;

  for (const filename of migrationFiles) {
    if (appliedMigrations.has(filename)) {
      skipped += 1;
      console.log(`[migrate] skipped ${filename}`);
      continue;
    }

    const filePath = path.join(MIGRATIONS_DIR, filename);
    const sql = await fs.readFile(filePath, 'utf8');
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO migrations_log (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING',
        [filename]
      );
      await client.query('COMMIT');
      applied += 1;
      console.log(`[migrate] applied ${filename}`);
    } catch (err) {
      failed += 1;
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[migrate] failed ${filename}: ${err.message}`);
    } finally {
      client.release();
    }
  }

  console.log(`[migrate] summary: applied ${applied}, skipped ${skipped}, failed ${failed}`);
  return { applied, skipped, failed };
}

if (require.main === module) {
  runMigrations()
    .catch((err) => {
      console.error('[migrate] fatal error:', err.message);
      process.exit(1);
    })
    .finally(async () => {
      await pool.end();
    });
}

module.exports = { runMigrations };
