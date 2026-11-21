/**
 * Partner lab catalog: 18 groups and ~600 tests from config/seeds/data/lab_catalog.json
 * (built from the partner's price list by curevie-docs/tools/build-lab-catalog.js).
 *
 *   npm run db:seed:lab          (or SEED_LAB=1 ./deploy.sh)
 *
 * Safe to run again:
 *  - groups are matched by slug and tests by source_name (the name in the partner's list);
 *  - existing rows are never overwritten: prices, provider share, order, active flag and any text
 *    the admin changed stay as they are; only empty texts are filled in;
 *  - on the first run only, the older generic LAB services (no source_name) are deactivated so the
 *    catalog shows the partner's tests; they stay in the database for past orders.
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const pool = require('../db');

const DATA_FILE = path.join(__dirname, 'data', 'lab_catalog.json');
const FIRST_RUN_MARKER = 'seed.lab_catalog_v1';

async function seedGroups(client, groups) {
  const ids = {};
  for (const group of groups) {
    const { rows } = await client.query(
      `INSERT INTO service_categories
         (name, description, name_ar, name_en, description_ar, description_en, slug, service_kind, sort_order, is_specialized)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'LAB', $8, $9)
       ON CONFLICT (slug) WHERE slug IS NOT NULL DO UPDATE SET
         name_ar = COALESCE(service_categories.name_ar, EXCLUDED.name_ar),
         name_en = COALESCE(service_categories.name_en, EXCLUDED.name_en),
         description_ar = COALESCE(service_categories.description_ar, EXCLUDED.description_ar),
         description_en = COALESCE(service_categories.description_en, EXCLUDED.description_en)
       RETURNING id`,
      [`lab-${group.key}`, group.description_en, group.name_ar, group.name_en, group.description_ar,
        group.description_en, `lab-${group.key}`, group.sort, Boolean(group.specialized)]
    );
    ids[group.key] = rows[0].id;
  }
  return ids;
}

async function seedTests(client, tests, groupIds) {
  let inserted = 0;
  let filled = 0;
  for (const test of tests) {
    const existing = await client.query('SELECT id FROM services WHERE source_name = $1', [test.source_name]);
    if (existing.rows[0]) {
      const result = await client.query(
        `UPDATE services SET
           name_ar = COALESCE(NULLIF(name_ar, ''), $2),
           name_en = COALESCE(NULLIF(name_en, ''), $3),
           description_ar = COALESCE(NULLIF(description_ar, ''), $4),
           description_en = COALESCE(NULLIF(description_en, ''), $5)
         WHERE id = $1
           AND (NULLIF(name_ar, '') IS NULL OR NULLIF(name_en, '') IS NULL
                OR NULLIF(description_ar, '') IS NULL OR NULLIF(description_en, '') IS NULL)`,
        [existing.rows[0].id, test.name_ar, test.name_en, test.description_ar, test.description_en]
      );
      filled += result.rowCount;
      continue;
    }

    // The lab's price is its fixed share; a test without a lab price falls back to the default share.
    const hasLabPrice = test.lab_price != null;
    await client.query(
      `INSERT INTO services
         (name, name_ar, name_en, description, description_ar, description_en, price, service_kind, category_id,
          is_active, is_vip_exclusive, provider_share_type, provider_share_value,
          is_popular, requires_fasting, sort_order, source_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'LAB', $8, $9, FALSE, $10, $11, $12, $13, $14, $15)`,
      [
        test.name_ar,
        test.name_ar,
        test.name_en,
        test.description_en,
        test.description_ar,
        test.description_en,
        test.patient_price || 0,
        groupIds[test.group],
        test.active,
        hasLabPrice ? 'FIXED' : null,
        hasLabPrice ? test.lab_price : null,
        test.popularity === 1,
        test.fasting,
        test.sort_order,
        test.source_name,
      ]
    );
    inserted += 1;
  }
  return { inserted, filled };
}

async function retireOldLabServices(client) {
  const marker = await client.query('SELECT 1 FROM app_settings WHERE key = $1', [FIRST_RUN_MARKER]);
  if (marker.rows[0]) return 0;
  const result = await client.query(
    `UPDATE services SET is_active = FALSE, updated_at = NOW()
     WHERE service_kind = 'LAB' AND source_name IS NULL AND system_key IS NULL AND is_active = TRUE`
  );
  await client.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING`,
    [FIRST_RUN_MARKER, JSON.stringify({ ran_at: new Date().toISOString(), retired: result.rowCount })]
  );
  return result.rowCount;
}

async function seedLabCatalog() {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const groupIds = await seedGroups(client, data.groups);
    const { inserted, filled } = await seedTests(client, data.tests, groupIds);
    const retired = await retireOldLabServices(client);
    await client.query('COMMIT');
    return { groups: data.groups.length, tests: data.tests.length, inserted, filled, retired };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  seedLabCatalog()
    .then(async (summary) => {
      // The API caches catalog reads; drop them so the new tests show at once.
      await require('../../utils/cache').del('services:*').catch(() => {});
      console.log(`[seed:lab] ${summary.groups} groups; ${summary.inserted} new tests, ${summary.filled} filled in `
        + `(list has ${summary.tests}); ${summary.retired} older lab services deactivated`);
      await pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('[seed:lab] failed:', err.message);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}

module.exports = { seedLabCatalog };
