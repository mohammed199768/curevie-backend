/**
 * Local development data: providers, catalog items (incl. lab services and a package) and provider areas.
 *   npm run db:seed:dev
 * Refuses to run when NODE_ENV=production. Safe to run more than once.
 *
 * Accounts created (local only):
 *   PROVIDER  dev.doctor@example.com / DevPass123!   (DOCTOR, covers Abdoun + Khalda)
 *   PROVIDER  dev.nurse@example.com  / DevPass123!   (NURSE, covers Abdoun)
 *   PROVIDER  dev.lab@example.com    / DevPass123!   (LAB_TECH, covers Khalda)
 *   PATIENT   dev.patient@example.com / DevPatient123!  (registered through the patient site, not by this script)
 * The admin comes from INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD (npm run db:init).
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../db');

const DEV_PASSWORD = 'DevPass123!';

const PROVIDERS = [
  { email: 'dev.doctor@example.com', full_name: 'د. سامر الخطيب', type: 'DOCTOR', phone: '0790000101', areas: ['abdoun', 'khalda'] },
  { email: 'dev.nurse@example.com', full_name: 'الممرضة لينا حداد', type: 'NURSE', phone: '0790000102', areas: ['abdoun'] },
  { email: 'dev.lab@example.com', full_name: 'فني المختبر عمر', type: 'LAB_TECH', phone: '0790000103', areas: ['khalda'] },
];

const SERVICES = [
  { name: 'زيارة طبيب منزلية', name_en: 'Home doctor visit', price: 25, kind: 'MEDICAL', category: 'زيارات طبية' },
  { name: 'تمريض منزلي - تغيير جرح', name_en: 'Home nursing - wound care', price: 15, kind: 'NURSING', category: 'تمريض منزلي' },
  { name: 'أشعة منزلية', name_en: 'Home X-ray', price: 40, kind: 'RADIOLOGY', category: 'أشعة' },
  { name: 'CBC - تعداد دم كامل', name_en: 'CBC - Complete blood count', price: 7.5, kind: 'LAB', category: 'فحوصات مخبرية' },
  { name: 'فحص السكر التراكمي HbA1c', name_en: 'HbA1c', price: 10, kind: 'LAB', category: 'فحوصات مخبرية' },
];

async function seed() {
  if (process.env.NODE_ENV === 'production') throw new Error('dev seed must not run in production');
  const hash = await bcrypt.hash(DEV_PASSWORD, 12);

  for (const provider of PROVIDERS) {
    const { rows } = await pool.query(
      `INSERT INTO service_providers (full_name, email, password, phone, type)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
       RETURNING id`,
      [provider.full_name, provider.email, hash, provider.phone, provider.type]
    );
    await pool.query(
      `INSERT INTO provider_areas (provider_id, area_id)
       SELECT $1, id FROM areas WHERE slug = ANY($2::text[])
       ON CONFLICT DO NOTHING`,
      [rows[0].id, provider.areas]
    );
  }

  for (const service of SERVICES) {
    let category = await pool.query('SELECT id FROM service_categories WHERE name = $1', [service.category]);
    if (!category.rows[0]) {
      category = await pool.query('INSERT INTO service_categories (name) VALUES ($1) RETURNING id', [service.category]);
    }
    const exists = await pool.query('SELECT 1 FROM services WHERE name = $1', [service.name]);
    if (!exists.rows[0]) {
      await pool.query(
        `INSERT INTO services (name, name_ar, name_en, price, service_kind, category_id)
         VALUES ($1, $1, $2, $3, $4, $5)`,
        [service.name, service.name_en, service.price, service.kind, category.rows[0].id]
      );
    }
  }

  const pkg = await pool.query("SELECT 1 FROM packages WHERE name = 'باقة الفحص الدوري'");
  if (!pkg.rows[0]) {
    const created = await pool.query(
      `INSERT INTO packages (name, name_ar, name_en, total_cost) VALUES ('باقة الفحص الدوري', 'باقة الفحص الدوري', 'Check-up bundle', 35)
       RETURNING id`
    );
    await pool.query(
      `INSERT INTO package_services (package_id, service_id, display_order)
       SELECT $1, s.id, ROW_NUMBER() OVER (ORDER BY s.name)
       FROM services s WHERE s.name IN ('زيارة طبيب منزلية', 'CBC - تعداد دم كامل', 'فحص السكر التراكمي HbA1c')`,
      [created.rows[0].id]
    );
  }

  console.log('[seed:dev] providers, services (incl. lab) and a package ready');
}

seed()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('[seed:dev] failed:', err.message);
    await pool.end().catch(() => {});
    process.exit(1);
  });
