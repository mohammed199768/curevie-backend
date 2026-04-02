require('dotenv').config();
const pool = require('../db');
const { createRange } = require('../../modules/labtests/labrange.service');

const LAB_TESTS = [
  // CBC
  {
    name: 'Hemoglobin',
    description: 'Measures the amount of hemoglobin in the blood.',
    unit: 'g/dL',
    cost: 5.0,
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 13.5, range_high: 17.5, priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, range_low: 12.0, range_high: 15.5, priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, condition: 'pregnant', range_low: 11.0, range_high: 14.0, priority: 20 },
    ],
  },
  {
    name: 'WBC',
    description: 'White Blood Cell Count',
    unit: 'x10^3/uL',
    cost: 5.0,
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 4.5,  range_high: 11.0, priority: 10 }],
  },
  {
    name: 'Platelets',
    description: 'Platelet Count',
    unit: 'x10^3/uL',
    cost: 5.0,
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 150,  range_high: 400, priority: 10 }],
  },
  {
    name: 'RBC',
    description: 'Red Blood Cell Count',
    unit: 'x10^6/uL',
    cost: 5.0,
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 4.5, range_high: 5.9, priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, range_low: 3.8, range_high: 5.2, priority: 10 },
    ],
  },
  {
    name: 'Hematocrit',
    description: 'Volume of red blood cells',
    unit: '%',
    cost: 5.0,
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 41, range_high: 53, priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, range_low: 36, range_high: 46, priority: 10 },
    ],
  },
  {
    name: 'MCV',
    description: 'Mean Corpuscular Volume',
    unit: 'fL',
    cost: 5.0,
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 80, range_high: 100, priority: 10 }],
  },
  {
    name: 'MCH',
    description: 'Mean Corpuscular Hemoglobin',
    unit: 'pg',
    cost: 5.0,
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 27, range_high: 33, priority: 10 }],
  },
  {
    name: 'MCHC',
    description: 'Mean Corpuscular Hemoglobin Concentration',
    unit: 'g/dL',
    cost: 5.0,
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 32, range_high: 36, priority: 10 }],
  },

  // LFT
  {
    name: 'ALT (SGPT)',
    description: 'Alanine Aminotransferase',
    unit: 'U/L',
    cost: 10.0,
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 7, range_high: 56, priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, range_low: 7, range_high: 45, priority: 10 },
    ],
  },
  {
    name: 'AST (SGOT)',
    description: 'Aspartate Aminotransferase',
    unit: 'U/L',
    cost: 10.0,
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 10, range_high: 40, priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, range_low: 10, range_high: 35, priority: 10 },
    ],
  },
  {
    name: 'Total Bilirubin',
    description: 'Total Bilirubin',
    unit: 'mg/dL',
    cost: 10.0,
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 0.2, range_high: 1.2, priority: 10 }],
  },
  {
    name: 'Direct Bilirubin',
    description: 'Direct Bilirubin',
    unit: 'mg/dL',
    cost: 10.0,
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 0.0, range_high: 0.3, priority: 10 }],
  },
  {
    name: 'Albumin',
    description: 'Albumin',
    unit: 'g/dL',
    cost: 10.0,
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 3.5, range_high: 5.0, priority: 10 }],
  },
  {
    name: 'Total Protein',
    description: 'Total Protein',
    unit: 'g/dL',
    cost: 10.0,
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 6.0, range_high: 8.3, priority: 10 }],
  },
  {
    name: 'ALP',
    description: 'Alkaline Phosphatase',
    unit: 'U/L',
    cost: 10.0,
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 44, range_high: 147, priority: 10 }],
  },

  // RFT
  {
    name: 'Creatinine',
    description: 'Creatinine',
    unit: 'mg/dL',
    cost: 8.0,
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 0.74, range_high: 1.35, priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, range_low: 0.59, range_high: 1.04, priority: 10 },
    ],
  },
  {
    name: 'BUN',
    description: 'Blood Urea Nitrogen',
    unit: 'mg/dL',
    cost: 8.0,
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 7, range_high: 20, priority: 10 }],
  },
  {
    name: 'Uric Acid',
    description: 'Uric Acid',
    unit: 'mg/dL',
    cost: 8.0,
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 3.4, range_high: 7.0, priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, range_low: 2.4, range_high: 6.0, priority: 10 },
    ],
  },
  {
    name: 'eGFR',
    description: 'Estimated Glomerular Filtration Rate',
    unit: 'mL/min/1.73m2',
    cost: 8.0,
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 90, range_high: 120, priority: 10 }],
  },

  // Lipid
  {
    name: 'Total Cholesterol',
    description: 'Total Cholesterol',
    unit: 'mg/dL',
    cost: 15.0,
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_high: 200, priority: 10 }],
  },
  {
    name: 'LDL',
    description: 'Low-Density Lipoprotein',
    unit: 'mg/dL',
    cost: 15.0,
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_high: 130, priority: 10 }],
  },
  {
    name: 'HDL',
    description: 'High-Density Lipoprotein',
    unit: 'mg/dL',
    cost: 15.0,
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 40, priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, range_low: 50, priority: 10 },
    ],
  },
  {
    name: 'Triglycerides',
    description: 'Triglycerides',
    unit: 'mg/dL',
    cost: 15.0,
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_high: 150, priority: 10 }],
  },

  // Thyroid
  {
    name: 'TSH',
    description: 'Thyroid Stimulating Hormone',
    unit: 'mIU/L',
    cost: 20.0,
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 0.4, range_high: 4.0, priority: 10 }],
  },
  {
    name: 'Free T3',
    description: 'Free Triiodothyronine',
    unit: 'pg/mL',
    cost: 20.0,
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 2.3, range_high: 4.1, priority: 10 }],
  },
  {
    name: 'Free T4',
    description: 'Free Thyroxine',
    unit: 'ng/dL',
    cost: 20.0,
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 0.8, range_high: 1.8, priority: 10 }],
  },

  // Diabetes
  {
    name: 'Fasting Glucose',
    description: 'Fasting Blood Sugar',
    unit: 'mg/dL',
    cost: 5.0,
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, condition: 'fasting', range_low: 70, range_high: 100, priority: 20 }],
  },
  {
    name: 'Random Glucose',
    description: 'Random Blood Sugar',
    unit: 'mg/dL',
    cost: 5.0,
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_high: 140, priority: 10 }],
  },
  {
    name: 'HbA1c',
    description: 'Hemoglobin A1c',
    unit: '%',
    cost: 15.0,
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_high: 5.7, priority: 10 }],
  },

  // Hormones
  {
    name: 'FSH',
    description: 'Follicle Stimulating Hormone',
    unit: 'mIU/mL',
    cost: 25.0,
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 1.5,  range_high: 12.4, priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, condition: 'follicular',     range_low: 3.5,  range_high: 12.5, priority: 20 },
      { gender: 'female', age_min: 18, age_max: 999, condition: 'luteal',         range_low: 1.7,  range_high: 7.7,  priority: 20 },
      { gender: 'female', age_min: 18, age_max: 999, condition: 'postmenopausal', range_low: 25.8, range_high: 134.8, priority: 20 },
    ],
  },
  {
    name: 'LH',
    description: 'Luteinizing Hormone',
    unit: 'mIU/mL',
    cost: 25.0,
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 1.7,  range_high: 8.6, priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, condition: 'follicular',     range_low: 2.4,  range_high: 12.6, priority: 20 },
      { gender: 'female', age_min: 18, age_max: 999, condition: 'luteal',         range_low: 1.0,  range_high: 11.4, priority: 20 },
      { gender: 'female', age_min: 18, age_max: 999, condition: 'postmenopausal', range_low: 7.7,  range_high: 58.5, priority: 20 },
    ],
  },
  {
    name: 'Prolactin',
    description: 'Prolactin',
    unit: 'ng/mL',
    cost: 25.0,
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 2, range_high: 18, priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, range_low: 2, range_high: 29, priority: 10 },
    ],
  },

  // Vitamins & Minerals
  {
    name: 'Vitamin D (25-OH)',
    description: 'Vitamin D',
    unit: 'ng/mL',
    cost: 30.0,
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 30,  range_high: 100, priority: 10 }],
  },
  {
    name: 'Vitamin B12',
    description: 'Vitamin B12',
    unit: 'pg/mL',
    cost: 25.0,
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 200, range_high: 900, priority: 10 }],
  },
  {
    name: 'Ferritin',
    description: 'Ferritin',
    unit: 'ng/mL',
    cost: 15.0,
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 12, range_high: 300, priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, range_low: 12, range_high: 150, priority: 10 },
    ],
  },
  {
    name: 'Calcium',
    description: 'Total Calcium',
    unit: 'mg/dL',
    cost: 8.0,
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 8.5, range_high: 10.5, priority: 10 }],
  },
  {
    name: 'Magnesium',
    description: 'Magnesium',
    unit: 'mg/dL',
    cost: 8.0,
    ranges: [{ gender: 'any', age_min: 18, age_max: 999, range_low: 1.7, range_high: 2.2, priority: 10 }],
  },
  {
    name: 'Iron',
    description: 'Serum Iron',
    unit: 'ug/dL',
    cost: 10.0,
    ranges: [
      { gender: 'male',   age_min: 18, age_max: 999, range_low: 65, range_high: 175, priority: 10 },
      { gender: 'female', age_min: 18, age_max: 999, range_low: 50, range_high: 170, priority: 10 },
    ],
  },
];

async function run() {
  const client = await pool.connect();
  let createdTestsCount = 0;
  let createdRangesCount = 0;

  try {
    console.log('Starting seed process to recreate all lab tests & ranges from scratch...');
    await client.query('BEGIN');

    // Remove foreign key dependencies first
    console.log('1. Clearing existing lab test data...');
    await client.query('UPDATE service_requests SET lab_test_id = NULL;');
    await client.query('DELETE FROM lab_test_results;');
    await client.query('DELETE FROM package_tests;');
    
    // Clear ranges and tests
    await client.query('DELETE FROM lab_test_reference_ranges;');
    await client.query('DELETE FROM lab_tests;');
    console.log('Data cleared successfully.');

    // Insert new lab tests
    console.log('2. Inserting new lab tests & ranges...');
    for (const testDef of LAB_TESTS) {
      // First, create the lab test
      const insertTestRes = await client.query(
        `
        INSERT INTO lab_tests (name, description, unit, reference_range, sample_type, cost, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id
        `,
        [
          testDef.name,
          testDef.description,
          testDef.unit,
          '', // No legacy reference_range text representation, relying solely on smart ranges
          'Blood',
          testDef.cost,
          true
        ]
      );
      const testId = insertTestRes.rows[0].id;
      createdTestsCount++;

      // Create proper ranges for this test
      if (testDef.ranges && testDef.ranges.length > 0) {
        for (const r of testDef.ranges) {
          try {
            // Using the service directly so validation constraints are respected
            // (Assumes `createRange` is using pool not client transaction strictly, 
            // but `createRange` from labrange.service.js does indeed use `pool.query` which can cause concurrency issues if inside a client transaction...
            // Let's insert via raw client to remain in the transaction)
            
            await client.query(
              `
              INSERT INTO lab_test_reference_ranges (
                lab_test_id, gender, age_min, age_max, condition,
                range_low, range_high, range_text, unit, notes, priority
              )
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
              `,
              [
                testId,
                r.gender || 'any',
                r.age_min || 0,
                r.age_max || 999,
                r.condition || null,
                r.range_low !== undefined ? r.range_low : null,
                r.range_high !== undefined ? r.range_high : null,
                r.range_text || null,
                r.unit || testDef.unit,
                r.notes || null,
                r.priority || 0
              ]
            );
            createdRangesCount++;
          } catch (rangeErr) {
            console.error(`Failed to insert range for ${testDef.name}:`, rangeErr.message);
            throw rangeErr;
          }
        }
      }
    }

    await client.query('COMMIT');
    console.log('\n--- SEED COMPLETE ---');
    console.log(`Created Tests: ${createdTestsCount}`);
    console.log(`Created Ranges: ${createdRangesCount}`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('SEED FAILED:', err);
    process.exit(1);
  } finally {
    client.release();
    pool.end();
  }
}

run();
