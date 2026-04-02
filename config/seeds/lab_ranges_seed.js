require('dotenv').config();
const pool = require('../db');

const TEST_RANGE_DEFINITIONS = [
  // CBC
  {
    name: 'Hemoglobin',
    patterns: ['%hemoglobin%', '%haemoglobin%'],
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 13.5, range_high: 17.5, unit: 'g/dL',      priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, range_low: 12.0, range_high: 15.5, unit: 'g/dL',      priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, condition: 'pregnant', range_low: 11.0, range_high: 14.0, unit: 'g/dL', priority: 20 },
    ],
  },
  {
    name: 'WBC',
    patterns: ['%wbc%', '%white blood cell%'],
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 4.5,  range_high: 11.0, unit: 'x10^3/uL', priority: 10 }],
  },
  {
    name: 'Platelets',
    patterns: ['%platelet%'],
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 150,  range_high: 400,  unit: 'x10^3/uL', priority: 10 }],
  },
  {
    name: 'RBC',
    patterns: ['%rbc%', '%red blood cell%'],
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 4.5, range_high: 5.9, unit: 'x10^6/uL', priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, range_low: 3.8, range_high: 5.2, unit: 'x10^6/uL', priority: 10 },
    ],
  },
  {
    name: 'Hematocrit',
    patterns: ['%hematocrit%', '%haematocrit%', '%hct%'],
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 41, range_high: 53, unit: '%', priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, range_low: 36, range_high: 46, unit: '%', priority: 10 },
    ],
  },
  {
    name: 'MCV',
    patterns: ['%mcv%'],
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 80, range_high: 100, unit: 'fL', priority: 10 }],
  },
  {
    name: 'MCH',
    patterns: ['%mch%'],
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 27, range_high: 33, unit: 'pg', priority: 10 }],
  },
  {
    name: 'MCHC',
    patterns: ['%mchc%'],
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 32, range_high: 36, unit: 'g/dL', priority: 10 }],
  },

  // LFT
  {
    name: 'ALT',
    patterns: ['%alt%', '%alanine aminotransferase%', '%sgpt%'],
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 7, range_high: 56, unit: 'U/L', priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, range_low: 7, range_high: 45, unit: 'U/L', priority: 10 },
    ],
  },
  {
    name: 'AST',
    patterns: ['%ast%', '%aspartate aminotransferase%'],
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 10, range_high: 40, unit: 'U/L', priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, range_low: 10, range_high: 35, unit: 'U/L', priority: 10 },
    ],
  },
  {
    name: 'Total Bilirubin',
    patterns: ['%total bilirubin%'],
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 0.2, range_high: 1.2, unit: 'mg/dL', priority: 10 }],
  },
  {
    name: 'Direct Bilirubin',
    patterns: ['%direct bilirubin%'],
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 0.0, range_high: 0.3, unit: 'mg/dL', priority: 10 }],
  },
  {
    name: 'Albumin',
    patterns: ['%albumin%'],
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 3.5, range_high: 5.0, unit: 'g/dL', priority: 10 }],
  },
  {
    name: 'Total Protein',
    patterns: ['%total protein%'],
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 6.0, range_high: 8.3, unit: 'g/dL', priority: 10 }],
  },
  {
    name: 'ALP',
    patterns: ['%alp%', '%alkaline phosphatase%'],
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 44, range_high: 147, unit: 'U/L', priority: 10 }],
  },

  // RFT
  {
    name: 'Creatinine',
    patterns: ['%creatinine%'],
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 0.74, range_high: 1.35, unit: 'mg/dL', priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, range_low: 0.59, range_high: 1.04, unit: 'mg/dL', priority: 10 },
    ],
  },
  {
    name: 'BUN',
    patterns: ['%bun%', '%blood urea nitrogen%'],
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 7, range_high: 20, unit: 'mg/dL', priority: 10 }],
  },
  {
    name: 'Uric Acid',
    patterns: ['%uric acid%'],
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 3.4, range_high: 7.0, unit: 'mg/dL', priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, range_low: 2.4, range_high: 6.0, unit: 'mg/dL', priority: 10 },
    ],
  },
  {
    name: 'eGFR',
    patterns: ['%egfr%', '%estimated glomerular filtration%'],
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 90, range_high: 120, unit: 'mL/min/1.73m2', priority: 10 }],
  },

  // Lipid
  {
    name: 'Total Cholesterol',
    patterns: ['%total cholesterol%', '%cholesterol total%'],
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_high: 200, unit: 'mg/dL', priority: 10 }],
  },
  {
    name: 'LDL',
    patterns: ['%ldl%'],
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_high: 130, unit: 'mg/dL', priority: 10 }],
  },
  {
    name: 'HDL',
    patterns: ['%hdl%'],
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 40, unit: 'mg/dL', priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, range_low: 50, unit: 'mg/dL', priority: 10 },
    ],
  },
  {
    name: 'Triglycerides',
    patterns: ['%triglyceride%'],
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_high: 150, unit: 'mg/dL', priority: 10 }],
  },

  // Thyroid
  {
    name: 'TSH',
    patterns: ['%tsh%'],
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 0.4, range_high: 4.0, unit: 'mIU/L', priority: 10 }],
  },
  {
    name: 'T3',
    patterns: ['% t3%', 't3 %', '%triiodothyronine%'],
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 0.8, range_high: 2.0, unit: 'ng/mL', priority: 10 }],
  },
  {
    name: 'T4',
    patterns: ['% t4%', 't4 %', '%thyroxine%'],
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 5.0, range_high: 12.0, unit: 'ug/dL', priority: 10 }],
  },
  {
    name: 'Free T4',
    patterns: ['%free t4%'],
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 0.8, range_high: 1.8, unit: 'ng/dL', priority: 10 }],
  },

  // Diabetes
  {
    name: 'Fasting Glucose',
    patterns: ['%fasting glucose%', '%fasting blood sugar%', '%fasting blood glucose%'],
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, condition: 'fasting', range_low: 70, range_high: 100, unit: 'mg/dL', priority: 20 }],
  },
  {
    name: 'Random Glucose',
    patterns: ['%random glucose%', '%random blood sugar%'],
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_high: 140, unit: 'mg/dL', priority: 10 }],
  },
  {
    name: 'HbA1c',
    patterns: ['%hba1c%', '%hemoglobin a1c%'],
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_high: 5.7, unit: '%', priority: 10 }],
  },

  // Hormones
  {
    name: 'FSH',
    patterns: ['%fsh%', '%follicle stimulating hormone%'],
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 1.5,  range_high: 12.4,  unit: 'mIU/mL', priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, condition: 'follicular',    range_low: 3.5,  range_high: 12.5,  unit: 'mIU/mL', priority: 20 },
      { gender: 'female', age_min: 18, age_max: 999, condition: 'luteal',        range_low: 1.7,  range_high: 7.7,   unit: 'mIU/mL', priority: 20 },
      { gender: 'female', age_min: 18, age_max: 999, condition: 'postmenopausal',range_low: 25.8, range_high: 134.8, unit: 'mIU/mL', priority: 20 },
    ],
  },
  {
    name: 'LH',
    patterns: ['% lh%', 'lh %', '%luteinizing hormone%'],
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 1.7,  range_high: 8.6,  unit: 'mIU/mL', priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, condition: 'follicular',    range_low: 2.4,  range_high: 12.6, unit: 'mIU/mL', priority: 20 },
      { gender: 'female', age_min: 18, age_max: 999, condition: 'luteal',        range_low: 1.0,  range_high: 11.4, unit: 'mIU/mL', priority: 20 },
      { gender: 'female', age_min: 18, age_max: 999, condition: 'postmenopausal',range_low: 7.7,  range_high: 58.5, unit: 'mIU/mL', priority: 20 },
    ],
  },
  {
    name: 'Prolactin',
    patterns: ['%prolactin%'],
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 2, range_high: 18, unit: 'ng/mL', priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, range_low: 2, range_high: 29, unit: 'ng/mL', priority: 10 },
    ],
  },
  {
    name: 'Testosterone',
    patterns: ['%testosterone%'],
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 300, range_high: 1000, unit: 'ng/dL', priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, range_low: 15,  range_high: 70,   unit: 'ng/dL', priority: 10 },
    ],
  },
  {
    name: 'Estradiol',
    patterns: ['%estradiol%'],
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 10, range_high: 40,  unit: 'pg/mL', priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, condition: 'follicular', range_low: 12, range_high: 166, unit: 'pg/mL', priority: 20 },
      { gender: 'female', age_min: 18, age_max: 999, condition: 'luteal',     range_low: 43, range_high: 211, unit: 'pg/mL', priority: 20 },
    ],
  },

  // Vitamins & Minerals
  {
    name: 'Vitamin D (25-OH)',
    patterns: ['%vitamin d%', '%25-oh%'],
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 30,  range_high: 100, unit: 'ng/mL', priority: 10 }],
  },
  {
    name: 'Vitamin B12',
    patterns: ['%vitamin b12%', '%b12%'],
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 200, range_high: 900, unit: 'pg/mL', priority: 10 }],
  },
  {
    name: 'Ferritin',
    patterns: ['%ferritin%'],
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 12, range_high: 300, unit: 'ng/mL', priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, range_low: 12, range_high: 150, unit: 'ng/mL', priority: 10 },
    ],
  },
  {
    name: 'Iron',
    patterns: ['%iron%'],
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 65, range_high: 175, unit: 'ug/dL', priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, range_low: 50, range_high: 170, unit: 'ug/dL', priority: 10 },
    ],
  },
  {
    name: 'Calcium',
    patterns: ['%calcium%'],
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 8.5, range_high: 10.5, unit: 'mg/dL', priority: 10 }],
  },
  {
    name: 'Magnesium',
    patterns: ['%magnesium%'],
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 1.7, range_high: 2.2, unit: 'mg/dL', priority: 10 }],
  },
];

async function ensureSmartRangesMigration(client) {
  const result = await client.query("SELECT to_regclass('public.lab_test_reference_ranges') AS table_name");
  if (!result.rows[0]?.table_name) {
    throw new Error('Table lab_test_reference_ranges not found. Run migration 008_lab_reference_ranges.sql first.');
  }
}

async function findLabTest(client, patterns) {
  const result = await client.query(
    `
    SELECT id, name
    FROM lab_tests
    WHERE name ILIKE ANY($1::text[])
    ORDER BY char_length(name) ASC
    LIMIT 1
    `,
    [patterns]
  );
  return result.rows[0] || null;
}

async function insertRangeIfMissing(client, labTestId, range) {
  const payload = {
    gender:     range.gender    || 'any',
    age_min:    Number.isInteger(range.age_min)  ? range.age_min  : 0,
    age_max:    Number.isInteger(range.age_max)  ? range.age_max  : 999,
    condition:  range.condition  ?? null,
    range_low:  range.range_low  ?? null,
    range_high: range.range_high ?? null,
    range_text: range.range_text ?? null,
    unit:       range.unit       ?? null,
    notes:      range.notes      ?? null,
    priority:   Number.isInteger(range.priority) ? range.priority : 0,
  };

  // ─── FIX: explicit casts prevent PostgreSQL "inconsistent types" error
  // when the same $N parameter appears in both SELECT list and WHERE subquery.
  const result = await client.query(
    `
    INSERT INTO lab_test_reference_ranges (
      lab_test_id, gender, age_min, age_max, condition,
      range_low, range_high, range_text, unit, notes, priority
    )
    SELECT
      $1::uuid,
      $2::varchar,
      $3::integer,
      $4::integer,
      $5::varchar,
      $6::numeric,
      $7::numeric,
      $8::text,
      $9::varchar,
      $10::text,
      $11::integer
    WHERE NOT EXISTS (
      SELECT 1
      FROM lab_test_reference_ranges
      WHERE lab_test_id  = $1::uuid
        AND gender       = $2::varchar
        AND age_min      = $3::integer
        AND age_max      = $4::integer
        AND condition    IS NOT DISTINCT FROM $5::varchar
        AND range_low    IS NOT DISTINCT FROM $6::numeric
        AND range_high   IS NOT DISTINCT FROM $7::numeric
        AND range_text   IS NOT DISTINCT FROM $8::text
        AND unit         IS NOT DISTINCT FROM $9::varchar
    )
    RETURNING id
    `,
    [
      labTestId,
      payload.gender,
      payload.age_min,
      payload.age_max,
      payload.condition,
      payload.range_low,
      payload.range_high,
      payload.range_text,
      payload.unit,
      payload.notes,
      payload.priority,
    ]
  );

  return result.rowCount > 0;
}

async function run() {
  const client = await pool.connect();
  let inserted = 0;
  let skipped  = 0;
  const missingTests = [];

  try {
    await client.query('BEGIN');
    await ensureSmartRangesMigration(client);

    for (const testDef of TEST_RANGE_DEFINITIONS) {
      const labTest = await findLabTest(client, testDef.patterns);
      if (!labTest) {
        missingTests.push(testDef.name);
        continue;
      }

      console.log(`  → Seeding ranges for: ${labTest.name}`);

      for (const range of testDef.ranges) {
        // eslint-disable-next-line no-await-in-loop
        const wasInserted = await insertRangeIfMissing(client, labTest.id, range);
        if (wasInserted) inserted += 1;
        else             skipped  += 1;
      }
    }

    await client.query('COMMIT');

    console.log('\n✅ Lab ranges seed completed.');
    console.log(`   Inserted : ${inserted}`);
    console.log(`   Skipped  : ${skipped} (already exists)`);
    if (missingTests.length) {
      console.log(`   Not found: ${missingTests.length} — ${missingTests.join(', ')}`);
      console.log('   (These tests are not in your lab_tests table yet — create them first)');
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Lab ranges seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();