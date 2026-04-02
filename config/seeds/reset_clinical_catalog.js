require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const pool = require('../db');

const ROOT_TABLES_TO_TRUNCATE = [
  'service_requests',
  'packages',
  'services',
  'lab_tests',
  'service_categories',
];

const CATEGORY_DEFINITIONS = [
  {
    key: 'radiology',
    name: 'اشعة',
    description: 'خدمات التصوير الطبي والفحوصات الشعاعية.',
  },
  {
    key: 'doctor',
    name: 'طبيب',
    description: 'الاستشارات الطبية والمتابعة السريرية والتمريض.',
  },
  {
    key: 'lab',
    name: 'مختبر',
    description: 'فحوصات المختبر والتحاليل الأساسية والمتقدمة.',
  },
];

const SERVICE_DEFINITIONS = [
  {
    key: 'chest_xray',
    categoryKey: 'radiology',
    name: 'أشعة صدر رقمية (Chest X-Ray)',
    description: 'تصوير أشعة للصدر لتقييم الرئتين والقلب والحالات التنفسية الشائعة.',
    price: 35,
  },
  {
    key: 'abdomen_ultrasound',
    categoryKey: 'radiology',
    name: 'ألتراساوند البطن والحوض (Abdominal Ultrasound)',
    description: 'تصوير بالموجات فوق الصوتية للبطن والحوض لتقييم الأعضاء الداخلية.',
    price: 45,
  },
  {
    key: 'knee_xray',
    categoryKey: 'radiology',
    name: 'أشعة ركبة رقمية (Knee X-Ray)',
    description: 'تصوير شعاعي لتقييم الإصابات والالتهابات وتغيرات المفاصل في الركبة.',
    price: 30,
  },
  {
    key: 'general_doctor_visit',
    categoryKey: 'doctor',
    name: 'استشارة طبيب عام',
    description: 'فحص سريري أولي وتقييم الأعراض ووضع الخطة العلاجية أو التحويل اللازم.',
    price: 25,
  },
  {
    key: 'internal_medicine_visit',
    categoryKey: 'doctor',
    name: 'استشارة طب باطني',
    description: 'متابعة الحالات الباطنية المزمنة والحادة مع مراجعة الفحوصات والخطة العلاجية.',
    price: 30,
  },
  {
    key: 'nursing_session',
    categoryKey: 'doctor',
    name: 'جلسة تمريض ومتابعة العلامات الحيوية',
    description: 'جلسة تمريض تشمل قياس العلامات الحيوية، متابعة الحالة، وتنفيذ تعليمات الرعاية.',
    price: 18,
  },
];

const LAB_TEST_DEFINITIONS = [
  {
    key: 'hemoglobin',
    categoryKey: 'lab',
    name: 'Hemoglobin',
    description: 'قياس مستوى الهيموغلوبين لتقييم فقر الدم والحالة الدموية العامة.',
    unit: 'g/dL',
    referenceRange: 'Male 13.5-17.5 / Female 12.0-15.5',
    sampleType: 'Blood',
    cost: 6,
    ranges: [
      { gender: 'male', ageMin: 18, ageMax: 999, rangeLow: 13.5, rangeHigh: 17.5, priority: 10 },
      { gender: 'female', ageMin: 18, ageMax: 999, rangeLow: 12.0, rangeHigh: 15.5, priority: 10 },
    ],
  },
  {
    key: 'wbc',
    categoryKey: 'lab',
    name: 'WBC',
    description: 'تعداد كريات الدم البيضاء لتقييم الالتهابات والاستجابة المناعية.',
    unit: 'x10^3/uL',
    referenceRange: '4.5-11.0',
    sampleType: 'Blood',
    cost: 6,
    ranges: [
      { gender: 'any', ageMin: 18, ageMax: 999, rangeLow: 4.5, rangeHigh: 11.0, priority: 10 },
    ],
  },
  {
    key: 'platelets',
    categoryKey: 'lab',
    name: 'Platelets',
    description: 'تعداد الصفائح الدموية لتقييم النزف والتجلط.',
    unit: 'x10^3/uL',
    referenceRange: '150-400',
    sampleType: 'Blood',
    cost: 6,
    ranges: [
      { gender: 'any', ageMin: 18, ageMax: 999, rangeLow: 150, rangeHigh: 400, priority: 10 },
    ],
  },
  {
    key: 'fasting_glucose',
    categoryKey: 'lab',
    name: 'Fasting Glucose',
    description: 'سكر صائم لتقييم اضطرابات السكر والاستقلاب.',
    unit: 'mg/dL',
    referenceRange: '70-100 fasting',
    sampleType: 'Blood',
    cost: 7,
    ranges: [
      { gender: 'any', ageMin: 18, ageMax: 999, condition: 'fasting', rangeLow: 70, rangeHigh: 100, priority: 20 },
    ],
  },
  {
    key: 'creatinine',
    categoryKey: 'lab',
    name: 'Creatinine',
    description: 'فحص وظائف الكلى لتقدير الكرياتينين ومراقبة الأداء الكلوي.',
    unit: 'mg/dL',
    referenceRange: 'Male 0.74-1.35 / Female 0.59-1.04',
    sampleType: 'Blood',
    cost: 8,
    ranges: [
      { gender: 'male', ageMin: 18, ageMax: 999, rangeLow: 0.74, rangeHigh: 1.35, priority: 10 },
      { gender: 'female', ageMin: 18, ageMax: 999, rangeLow: 0.59, rangeHigh: 1.04, priority: 10 },
    ],
  },
  {
    key: 'vitamin_d',
    categoryKey: 'lab',
    name: 'Vitamin D (25-OH)',
    description: 'قياس مستوى فيتامين د لتقييم النقص واضطرابات العظام والتمثيل الغذائي.',
    unit: 'ng/mL',
    referenceRange: '30-100',
    sampleType: 'Blood',
    cost: 22,
    ranges: [
      { gender: 'any', ageMin: 18, ageMax: 999, rangeLow: 30, rangeHigh: 100, priority: 10 },
    ],
  },
];

const MIXED_PACKAGE_DEFINITION = {
  name: 'باقة تقييم شامل متعددة التخصصات',
  description: 'تشمل استشارة طبيب عام، جلسة تمريض، أشعة صدر رقمية، وتحاليل مخبرية أساسية في طلب واحد.',
  categoryKey: 'doctor',
  includedServiceKeys: ['general_doctor_visit', 'nursing_session', 'chest_xray'],
  includedLabTestKeys: ['hemoglobin', 'wbc', 'fasting_glucose', 'creatinine'],
  totalCost: 89,
};

// AUDIT-FIX: PATH — use __dirname so uploads resolve inside backend/
// __dirname = backend/config/seeds → BACKEND_ROOT = backend/
const BACKEND_ROOT = path.join(__dirname, '..', '..');
const PROVIDER_REPORTS_DIR = path.join(BACKEND_ROOT, 'uploads', 'provider-reports');

async function truncateClinicalCatalog(client) {
  await client.query(`
    TRUNCATE TABLE ${ROOT_TABLES_TO_TRUNCATE.join(', ')}
    RESTART IDENTITY
    CASCADE
  `);
}

async function insertCategory(client, definition) {
  const result = await client.query(
    `
    INSERT INTO service_categories (name, description)
    VALUES ($1, $2)
    RETURNING id, name
    `,
    [definition.name, definition.description]
  );

  return result.rows[0];
}

async function insertService(client, definition, categoryId) {
  const result = await client.query(
    `
    INSERT INTO services (
      name,
      description,
      price,
      category_id,
      is_vip_exclusive,
      is_active
    )
    VALUES ($1, $2, $3, $4, FALSE, TRUE)
    RETURNING id, name, price
    `,
    [definition.name, definition.description, definition.price, categoryId]
  );

  return result.rows[0];
}

async function insertLabTest(client, definition, categoryId) {
  const result = await client.query(
    `
    INSERT INTO lab_tests (
      name,
      description,
      unit,
      reference_range,
      sample_type,
      cost,
      category_id,
      is_vip_exclusive,
      is_active
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, TRUE)
    RETURNING id, name, cost, unit
    `,
    [
      definition.name,
      definition.description,
      definition.unit,
      definition.referenceRange,
      definition.sampleType,
      definition.cost,
      categoryId,
    ]
  );

  const labTest = result.rows[0];

  for (const range of definition.ranges) {
    await client.query(
      `
      INSERT INTO lab_test_reference_ranges (
        lab_test_id,
        gender,
        age_min,
        age_max,
        condition,
        range_low,
        range_high,
        range_text,
        unit,
        priority
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        labTest.id,
        range.gender || 'any',
        range.ageMin ?? 0,
        range.ageMax ?? 999,
        range.condition || null,
        range.rangeLow ?? null,
        range.rangeHigh ?? null,
        definition.referenceRange || null,
        definition.unit || null,
        range.priority ?? 0,
      ]
    );
  }

  return labTest;
}

async function insertMixedPackage(client, definition, categoryId, serviceMap, labTestMap) {
  const packageResult = await client.query(
    `
    INSERT INTO packages (
      name,
      description,
      total_cost,
      category_id,
      is_vip_exclusive,
      is_active
    )
    VALUES ($1, $2, $3, $4, FALSE, TRUE)
    RETURNING id, name, total_cost
    `,
    [definition.name, definition.description, definition.totalCost, categoryId]
  );

  const mixedPackage = packageResult.rows[0];

  for (const serviceKey of definition.includedServiceKeys) {
    const service = serviceMap.get(serviceKey);
    if (!service) {
      throw new Error(`Missing service for key: ${serviceKey}`);
    }

    await client.query(
      `
      INSERT INTO package_services (package_id, service_id)
      VALUES ($1, $2)
      `,
      [mixedPackage.id, service.id]
    );
  }

  for (const labTestKey of definition.includedLabTestKeys) {
    const labTest = labTestMap.get(labTestKey);
    if (!labTest) {
      throw new Error(`Missing lab test for key: ${labTestKey}`);
    }

    await client.query(
      `
      INSERT INTO package_tests (package_id, lab_test_id)
      VALUES ($1, $2)
      `,
      [mixedPackage.id, labTest.id]
    );
  }

  return mixedPackage;
}

async function clearProviderReportUploads() {
  try {
    await fs.rm(PROVIDER_REPORTS_DIR, { recursive: true, force: true });
    await fs.mkdir(PROVIDER_REPORTS_DIR, { recursive: true });
  } catch (error) {
    console.warn('Provider report uploads cleanup skipped:', error.message);
  }
}

async function resetClinicalCatalog() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    console.log('Resetting service, package, lab, and request demo data...');
    await truncateClinicalCatalog(client);

    const categories = new Map();
    for (const definition of CATEGORY_DEFINITIONS) {
      const category = await insertCategory(client, definition);
      categories.set(definition.key, category);
    }

    const services = new Map();
    for (const definition of SERVICE_DEFINITIONS) {
      const category = categories.get(definition.categoryKey);
      const service = await insertService(client, definition, category.id);
      services.set(definition.key, service);
    }

    const labTests = new Map();
    for (const definition of LAB_TEST_DEFINITIONS) {
      const category = categories.get(definition.categoryKey);
      const labTest = await insertLabTest(client, definition, category.id);
      labTests.set(definition.key, labTest);
    }

    const mixedPackage = await insertMixedPackage(
      client,
      MIXED_PACKAGE_DEFINITION,
      categories.get(MIXED_PACKAGE_DEFINITION.categoryKey).id,
      services,
      labTests
    );

    await client.query('COMMIT');
    await clearProviderReportUploads();

    console.log('Clinical catalog reset complete.');
    console.log(JSON.stringify({
      categories: Array.from(categories.values()).map((category) => category.name),
      services: Array.from(services.values()).map((service) => service.name),
      lab_tests: Array.from(labTests.values()).map((labTest) => labTest.name),
      mixed_package: mixedPackage.name,
    }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Clinical catalog reset failed:', error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

resetClinicalCatalog();
