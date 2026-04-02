const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

function getPoolConfig() {
  const useConnectionString = Boolean(process.env.DATABASE_URL);
  const sslEnabled = process.env.DB_SSL === 'true';

  return useConnectionString
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: sslEnabled ? { rejectUnauthorized: false } : false,
      }
    : {
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT || 5432),
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || 'postgres',
        database: process.env.DB_NAME || 'curevie',
        ssl: sslEnabled ? { rejectUnauthorized: false } : false,
      };
}

async function withRangeTable(t, run) {
  const pool = new Pool(getPoolConfig());
  let client;

  try {
    client = await pool.connect();
  } catch (error) {
    await pool.end().catch(() => {});
    t.skip(`PostgreSQL not available for exclusion test: ${error.message}`);
    return;
  }

  try {
    await client.query('BEGIN');
    await client.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
    await client.query(`
      CREATE TEMP TABLE temp_lab_test_reference_ranges (
        id UUID PRIMARY KEY,
        lab_test_id UUID NOT NULL,
        gender VARCHAR(10) NOT NULL,
        condition VARCHAR(50),
        age_min INTEGER NOT NULL,
        age_max INTEGER NOT NULL
      ) ON COMMIT DROP
    `);
    await client.query(`
      ALTER TABLE temp_lab_test_reference_ranges
      ADD CONSTRAINT temp_no_overlapping_ranges
      EXCLUDE USING gist (
        lab_test_id WITH =,
        gender WITH =,
        COALESCE(condition, '<NULL>') WITH =,
        int4range(age_min, age_max, '[]') WITH &&
      )
    `);

    await run(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
}

test('PostgreSQL exclusion constraint rejects overlapping ranges in the same bucket', async (t) => {
  await withRangeTable(t, async (client) => {
    await client.query(
      `
      INSERT INTO temp_lab_test_reference_ranges
        (id, lab_test_id, gender, condition, age_min, age_max)
      VALUES
        ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'female', 'fasting', 18, 40)
      `
    );

    await assert.rejects(
      () => client.query(
        `
        INSERT INTO temp_lab_test_reference_ranges
          (id, lab_test_id, gender, condition, age_min, age_max)
        VALUES
          ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'female', 'fasting', 30, 50)
        `
      ),
      (error) => error && error.code === '23P01'
    );
  });
});

test('PostgreSQL exclusion constraint allows non-overlapping ranges in the same bucket', async (t) => {
  await withRangeTable(t, async (client) => {
    await client.query(
      `
      INSERT INTO temp_lab_test_reference_ranges
        (id, lab_test_id, gender, condition, age_min, age_max)
      VALUES
        ('33333333-3333-3333-3333-333333333333', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'female', 'fasting', 18, 40),
        ('44444444-4444-4444-4444-444444444444', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'female', 'fasting', 41, 60)
      `
    );

    const result = await client.query('SELECT COUNT(*)::int AS count FROM temp_lab_test_reference_ranges');
    assert.equal(result.rows[0].count, 2);
  });
});

test('PostgreSQL exclusion constraint allows overlaps when condition or gender differ', async (t) => {
  await withRangeTable(t, async (client) => {
    await client.query(
      `
      INSERT INTO temp_lab_test_reference_ranges
        (id, lab_test_id, gender, condition, age_min, age_max)
      VALUES
        ('55555555-5555-5555-5555-555555555555', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'female', 'fasting', 18, 40),
        ('66666666-6666-6666-6666-666666666666', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'male',   'fasting', 20, 35),
        ('77777777-7777-7777-7777-777777777777', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'female', 'pregnant', 20, 35),
        ('88888888-8888-8888-8888-888888888888', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'female', NULL,       20, 35)
      `
    );

    const result = await client.query('SELECT COUNT(*)::int AS count FROM temp_lab_test_reference_ranges');
    assert.equal(result.rows[0].count, 4);
  });
});
