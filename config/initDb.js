require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('./db');
const { runMigrations } = require('./runMigrations');

async function initDb() {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');

    const tableCheck = await client.query("SELECT to_regclass('public.admins') AS admins_table");
    if (!tableCheck.rows[0].admins_table) {
      const schemaPath = path.join(__dirname, 'schema.sql');
      const schemaSql = await fs.readFile(schemaPath, 'utf8');
      await client.query(schemaSql);
      console.log('Schema initialized from config/schema.sql');
    } else {
      console.log('Schema already exists. Skipping schema.sql execution.');
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        role VARCHAR(20) NOT NULL CHECK (role IN ('ADMIN', 'PROVIDER', 'PATIENT')),
        token TEXT NOT NULL UNIQUE,
        expires_at TIMESTAMP NOT NULL,
        revoked_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id, role)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_refresh_tokens_token ON refresh_tokens(token)');

    const adminEmail = process.env.DEFAULT_ADMIN_EMAIL || 'admin@medical.com';
    const adminPassword = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';
    const providerName = process.env.DEFAULT_PROVIDER_NAME || 'Default Provider';
    const providerEmail = process.env.DEFAULT_PROVIDER_EMAIL || 'provider@medical.com';
    const providerPassword = process.env.DEFAULT_PROVIDER_PASSWORD || 'Provider123!';
    const providerPhone = process.env.DEFAULT_PROVIDER_PHONE || null;
    const providerType = process.env.DEFAULT_PROVIDER_TYPE || 'DOCTOR';

    const existingAdmin = await client.query('SELECT id FROM admins WHERE email = $1', [adminEmail]);
    if (!existingAdmin.rows[0]) {
      const hashedPassword = await bcrypt.hash(adminPassword, 12);
      await client.query(
        'INSERT INTO admins (full_name, email, password) VALUES ($1, $2, $3)',
        ['System Admin', adminEmail, hashedPassword]
      );
      console.log(`Default admin created: ${adminEmail}`);
    } else {
      console.log(`Default admin already exists: ${adminEmail}`);
    }

    const existingProvider = await client.query(
      'SELECT id FROM service_providers WHERE email = $1',
      [providerEmail]
    );

    if (!existingProvider.rows[0]) {
      const hashedProviderPassword = await bcrypt.hash(providerPassword, 12);
      await client.query(
        `
        INSERT INTO service_providers (full_name, email, password, phone, type, is_available)
        VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [providerName, providerEmail, hashedProviderPassword, providerPhone, providerType, true]
      );
      console.log(`Default provider created: ${providerEmail}`);
    } else {
      console.log(`Default provider already exists: ${providerEmail}`);
    }

    await client.query('COMMIT');
    client.release();
    client = null;

    await runMigrations();

    console.log('Database initialization completed successfully.');
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error('Database initialization failed:', err.message);
    throw err;
  } finally {
    if (client) {
      client.release();
    }
    await pool.end();
  }
}

initDb().catch((err) => {
  console.error('Initialization error:', err.message);
  process.exit(1);
});
