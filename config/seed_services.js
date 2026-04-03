const pool = require('./db');

async function seedServices() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const medicalCat = await client.query(`
      INSERT INTO service_categories (name, description)
      VALUES ('خدمات طبية منزلية', 'Medical home visits')
      ON CONFLICT DO NOTHING RETURNING id
    `);

    const radiologyCat = await client.query(`
      INSERT INTO service_categories (name, description)
      VALUES ('أشعة منزلية', 'Radiology home services')
      ON CONFLICT DO NOTHING RETURNING id
    `);

    const medicalId = medicalCat.rows[0]?.id || (
      await client.query(`SELECT id FROM service_categories WHERE name = 'خدمات طبية منزلية'`)
    ).rows[0].id;

    const radiologyId = radiologyCat.rows[0]?.id || (
      await client.query(`SELECT id FROM service_categories WHERE name = 'أشعة منزلية'`)
    ).rows[0].id;

    const medicalServices = [
      { name: 'زيارة طبيب عام', description: 'General Doctor Visit', price: 15.000 },
      { name: 'زيارة طبيب أطفال', description: 'Pediatrician Visit', price: 20.000 },
      { name: 'زيارة طبيب باطنية', description: 'Internal Medicine Visit', price: 25.000 },
      { name: 'قياس ضغط وسكر', description: 'Blood Pressure & Sugar Check', price: 8.000 },
      { name: 'حقنة منزلية', description: 'Home Injection', price: 10.000 },
    ];

    const radiologyServices = [
      { name: 'أشعة صدر', description: 'Chest X-Ray', price: 25.000 },
      { name: 'أشعة عظام', description: 'Bone X-Ray', price: 20.000 },
      { name: 'سونار بطن', description: 'Abdominal Ultrasound', price: 35.000 },
      { name: 'سونار قلب', description: 'Echocardiogram', price: 50.000 },
    ];

    for (const s of medicalServices) {
      await client.query(`
        INSERT INTO services (name, description, price, category_id, is_active)
        VALUES ($1, $2, $3, $4, true) ON CONFLICT DO NOTHING
      `, [s.name, s.description, s.price, medicalId]);
    }

    for (const s of radiologyServices) {
      await client.query(`
        INSERT INTO services (name, description, price, category_id, is_active)
        VALUES ($1, $2, $3, $4, true) ON CONFLICT DO NOTHING
      `, [s.name, s.description, s.price, radiologyId]);
    }

    await client.query('COMMIT');
    console.log('Services seeded successfully');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', e.message);
  } finally {
    client.release();
    process.exit(0);
  }
}

seedServices();
