require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../db');

async function seedProvider() {
  const client = await pool.connect();

  try {
    const providerName = process.env.DEFAULT_PROVIDER_NAME || 'Default Provider';
    const providerEmail = process.env.DEFAULT_PROVIDER_EMAIL || 'provider@medical.com';
    const providerPassword = process.env.DEFAULT_PROVIDER_PASSWORD || 'Provider123!';
    const providerPhone = process.env.DEFAULT_PROVIDER_PHONE || null;
    const providerType = process.env.DEFAULT_PROVIDER_TYPE || 'DOCTOR';

    const existingProvider = await client.query(
      'SELECT id FROM service_providers WHERE email = $1',
      [providerEmail]
    );

    if (existingProvider.rows[0]) {
      console.log(`Provider already exists: ${providerEmail}`);
      return;
    }

    const hashedProviderPassword = await bcrypt.hash(providerPassword, 12);

    await client.query(
      `
      INSERT INTO service_providers (full_name, email, password, phone, type, is_available)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [providerName, providerEmail, hashedProviderPassword, providerPhone, providerType, true]
    );

    console.log(`Provider seeded successfully: ${providerEmail}`);
  } catch (err) {
    console.error('Provider seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

seedProvider();
