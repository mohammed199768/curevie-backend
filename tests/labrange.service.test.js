const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { loadWithMocks } = require('./helpers/loadWithMocks');

const ROOT = path.resolve(__dirname, '..');
const SERVICE_PATH = path.join(ROOT, 'modules', 'labtests', 'labrange.service.js');
const DB_PATH = path.join(ROOT, 'config', 'db.js');
const ERROR_HANDLER_PATH = path.join(ROOT, 'middlewares', 'errorHandler.js');
const LOGGER_PATH = path.join(ROOT, 'utils', 'logger.js');

class AppError extends Error {
  constructor(message, statusCode = 500, code = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
  }
}

function createRangeStore(initialRows = []) {
  let sequence = 0;
  const rows = initialRows.map((row) => ({
    priority: 0,
    age_min: 0,
    age_max: 999,
    gender: 'any',
    condition: null,
    range_low: null,
    range_high: null,
    range_text: null,
    unit: null,
    notes: null,
    created_at: row.created_at || new Date(`2026-01-01T00:00:0${sequence += 1}.000Z`).toISOString(),
    updated_at: row.updated_at || new Date(`2026-01-01T00:00:1${sequence}.000Z`).toISOString(),
    ...row,
  }));

  async function query(sql, params = []) {
    const normalizedSql = String(sql).replace(/\s+/g, ' ').trim();

    if (normalizedSql === 'BEGIN' || normalizedSql === 'COMMIT' || normalizedSql === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }

    if (normalizedSql.includes('FROM lab_test_reference_ranges WHERE lab_test_id = $1')
      && normalizedSql.includes('AND gender = $2')
      && normalizedSql.includes('AND condition IS NOT DISTINCT FROM $3')) {
      const [labTestId, gender, condition, ageMin, ageMax, excludeRangeId] = params;
      const found = rows.find((row) => row.lab_test_id === labTestId
        && row.gender === gender
        && row.condition === condition
        && row.age_min <= ageMax
        && row.age_max >= ageMin
        && (!excludeRangeId || row.id !== excludeRangeId));
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    if (normalizedSql.startsWith('INSERT INTO lab_test_reference_ranges')) {
      const row = {
        id: `range-${rows.length + 1}`,
        lab_test_id: params[0],
        gender: params[1],
        age_min: params[2],
        age_max: params[3],
        condition: params[4],
        range_low: params[5],
        range_high: params[6],
        range_text: params[7],
        unit: params[8],
        notes: params[9],
        priority: params[10],
        created_at: new Date(`2026-01-02T00:00:${String(rows.length + 1).padStart(2, '0')}.000Z`).toISOString(),
        updated_at: new Date(`2026-01-02T00:00:${String(rows.length + 1).padStart(2, '0')}.500Z`).toISOString(),
      };
      rows.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (normalizedSql.startsWith('SELECT * FROM lab_test_reference_ranges WHERE lab_test_id = $1')
      && normalizedSql.includes('($2::numeric IS NULL OR $2 BETWEEN age_min AND age_max)')) {
      const [labTestId, age, gender, condition] = params;
      const filtered = rows.filter((row) => row.lab_test_id === labTestId
        && (age === null || (age >= row.age_min && age <= row.age_max))
        && (
          (gender === null && row.gender === 'any')
          || (gender !== null && (row.gender === gender || row.gender === 'any'))
        )
        && (
          (condition === null && row.condition === null)
          || (condition !== null && (row.condition === condition || row.condition === null))
        ));
      return { rows: filtered, rowCount: filtered.length };
    }

    if (normalizedSql === 'SELECT * FROM lab_test_reference_ranges WHERE id = $1 LIMIT 1') {
      const found = rows.find((row) => row.id === params[0]) || null;
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    if (normalizedSql.startsWith('UPDATE lab_test_reference_ranges SET')) {
      const rangeId = params[params.length - 1];
      const row = rows.find((item) => item.id === rangeId);
      if (!row) {
        return { rows: [], rowCount: 0 };
      }

      const setClause = normalizedSql
        .replace('UPDATE lab_test_reference_ranges SET ', '')
        .replace(/, updated_at = NOW\(\) WHERE id = \$\d+ RETURNING \*$/, '');

      setClause.split(', ').forEach((assignment) => {
        const [field, placeholder] = assignment.split(' = ');
        const index = Number(placeholder.slice(1)) - 1;
        row[field] = params[index];
      });
      row.updated_at = new Date('2026-01-03T00:00:00.000Z').toISOString();

      return { rows: [row], rowCount: 1 };
    }

    throw new Error(`Unexpected SQL in test double: ${normalizedSql}`);
  }

  return {
    rows,
    pool: {
      query,
      connect: async () => ({
        query,
        release() {},
      }),
    },
  };
}

function loadService(poolOverrides = {}) {
  const pool = {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => ({
      query: async () => ({ rows: [], rowCount: 0 }),
      release() {},
    }),
    ...poolOverrides,
  };

  const logger = {
    error() {},
    warn() {},
  };

  const service = loadWithMocks(SERVICE_PATH, {
    [DB_PATH]: pool,
    [ERROR_HANDLER_PATH]: { AppError },
    [LOGGER_PATH]: { logger },
  });

  return { service, pool, logger };
}

test('resolveRange prefers exact condition over null condition', async () => {
  const store = createRangeStore([
    { id: 'generic', lab_test_id: 'lab-1', gender: 'any', condition: null, age_min: 0, age_max: 120, range_low: 1, range_high: 5, priority: 5 },
    { id: 'fasting', lab_test_id: 'lab-1', gender: 'any', condition: 'fasting', age_min: 0, age_max: 120, range_low: 2, range_high: 6, priority: 5 },
  ]);
  const { service } = loadService(store.pool);

  const result = await service.resolveRange('lab-1', { gender: 'female', age: 30, condition: 'fasting' });

  assert.equal(result.id, 'fasting');
});

test('resolveRange prefers specific gender over any', async () => {
  const store = createRangeStore([
    { id: 'any-range', lab_test_id: 'lab-1', gender: 'any', condition: null, age_min: 0, age_max: 120, range_low: 1, range_high: 5, priority: 3 },
    { id: 'female-range', lab_test_id: 'lab-1', gender: 'female', condition: null, age_min: 0, age_max: 120, range_low: 2, range_high: 6, priority: 3 },
  ]);
  const { service } = loadService(store.pool);

  const result = await service.resolveRange('lab-1', { gender: 'female', age: 25, condition: null });

  assert.equal(result.id, 'female-range');
});

test('resolveRange prefers narrower age band when candidates still tie', async () => {
  const store = createRangeStore([
    { id: 'wide', lab_test_id: 'lab-1', gender: 'any', condition: null, age_min: 0, age_max: 120, range_low: 1, range_high: 5, priority: 2 },
    { id: 'narrow', lab_test_id: 'lab-1', gender: 'any', condition: null, age_min: 20, age_max: 40, range_low: 1, range_high: 5, priority: 2 },
  ]);
  const { service } = loadService(store.pool);

  const result = await service.resolveRange('lab-1', { gender: null, age: 30, condition: null });

  assert.equal(result.id, 'narrow');
});

test('createRange rejects overlapping ranges for the same test, gender, and condition', async () => {
  const store = createRangeStore([
    { id: 'existing', lab_test_id: 'lab-1', gender: 'female', condition: 'fasting', age_min: 18, age_max: 40, range_low: 1, range_high: 5 },
  ]);
  const { service } = loadService(store.pool);

  await assert.rejects(
    () => service.createRange('lab-1', {
      gender: 'female',
      condition: 'fasting',
      age_min: 30,
      age_max: 50,
      range_low: 2,
      range_high: 6,
    }),
    (error) => error instanceof AppError && error.code === 'RANGE_CONFLICT'
  );
});

test('createManyRanges reports created rows and skips conflicts safely', async () => {
  const store = createRangeStore([
    { id: 'existing', lab_test_id: 'lab-1', gender: 'female', condition: 'fasting', age_min: 0, age_max: 10, range_low: 1, range_high: 5 },
  ]);
  const { service } = loadService(store.pool);

  const result = await service.createManyRanges('lab-1', [
    {
      gender: 'female',
      condition: 'fasting',
      age_min: 11,
      age_max: 20,
      range_low: 2,
      range_high: 6,
    },
    {
      gender: 'female',
      condition: 'fasting',
      age_min: 5,
      age_max: 15,
      range_low: 2,
      range_high: 6,
    },
    {
      gender: 'female',
      condition: 'fasting',
      age_min: 21,
      age_max: 30,
      range_text: 'negative',
    },
  ]);

  assert.equal(result.created, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.data.length, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'RANGE_CONFLICT');
});

test('evaluateResult returns numeric and categorical statuses conservatively', async (t) => {
  await t.test('NORMAL for in-range numeric values', async () => {
    const store = createRangeStore([
      { id: 'r1', lab_test_id: 'lab-1', range_low: 1, range_high: 5 },
    ]);
    const { service } = loadService(store.pool);
    const result = await service.evaluateResult('lab-1', '3', {});
    assert.equal(result.flag, 'NORMAL');
    assert.equal(result.is_normal, true);
  });

  await t.test('LOW for values below the lower bound', async () => {
    const store = createRangeStore([
      { id: 'r1', lab_test_id: 'lab-1', range_low: 1, range_high: 5 },
    ]);
    const { service } = loadService(store.pool);
    const result = await service.evaluateResult('lab-1', '0.5', {});
    assert.equal(result.flag, 'LOW');
    assert.equal(result.is_normal, false);
  });

  await t.test('HIGH for values above the upper bound', async () => {
    const store = createRangeStore([
      { id: 'r1', lab_test_id: 'lab-1', range_low: 1, range_high: 5 },
    ]);
    const { service } = loadService(store.pool);
    const result = await service.evaluateResult('lab-1', '5.5', {});
    assert.equal(result.flag, 'HIGH');
    assert.equal(result.is_normal, false);
  });

  await t.test('ABNORMAL for categorical mismatches', async () => {
    const store = createRangeStore([
      { id: 'r1', lab_test_id: 'lab-2', range_text: 'negative' },
    ]);
    const { service } = loadService(store.pool);
    const result = await service.evaluateResult('lab-2', 'detected', {});
    assert.equal(result.flag, 'ABNORMAL');
    assert.equal(result.is_normal, false);
  });

  await t.test('NO_RANGE when no matching range exists', async () => {
    const { service } = loadService();
    const result = await service.evaluateResult('lab-3', '3', {});
    assert.equal(result.flag, 'NO_RANGE');
    assert.equal(result.range, null);
  });

  await t.test('PARSE_ERROR when numeric extraction is not safe', async () => {
    const store = createRangeStore([
      { id: 'r1', lab_test_id: 'lab-4', range_low: 1, range_high: 5 },
    ]);
    const { service } = loadService(store.pool);
    const result = await service.evaluateResult('lab-4', '<0.5', {});
    assert.equal(result.flag, 'PARSE_ERROR');
    assert.equal(result.is_normal, null);
  });

  await t.test('EVALUATION_ERROR when resolution fails unexpectedly', async () => {
    const { service } = loadService({
      query: async () => {
        throw new Error('db exploded');
      },
      connect: async () => {
        throw new Error('unused');
      },
    });
    const result = await service.evaluateResult('lab-5', '3', {});
    assert.equal(result.flag, 'EVALUATION_ERROR');
    assert.equal(result.range, null);
  });
});

test('categorical aliases normalize common negative synonyms', async () => {
  const store = createRangeStore([
    { id: 'r1', lab_test_id: 'lab-6', range_text: 'non-reactive' },
  ]);
  const { service } = loadService(store.pool);

  const result = await service.evaluateResult('lab-6', ' NEG ', {});

  assert.equal(result.flag, 'NORMAL');
  assert.equal(result.is_normal, true);
});
