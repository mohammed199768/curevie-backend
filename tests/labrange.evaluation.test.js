const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { loadWithMocks } = require('./helpers/loadWithMocks');

const ROOT = path.resolve(__dirname, '..');
const SERVICE_PATH = path.join(ROOT, 'modules', 'labtests', 'labrange.service.js');

class AppError extends Error {
  constructor(message, statusCode = 500, code = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
  }
}

function createMockLogger() {
  return {
    error() {},
    warn() {},
  };
}

function createMockRepository(rows = [], overrides = {}) {
  return {
    async findResolvableRanges(labTestId, { age, gender, condition }) {
      return rows.filter((row) => {
        if (row.lab_test_id !== labTestId) return false;
        if (age !== null && age !== undefined) {
          if (age < Number(row.age_min) || age > Number(row.age_max)) return false;
        }
        if (gender === null) {
          if (row.gender !== 'any') return false;
        } else if (row.gender !== gender && row.gender !== 'any') {
          return false;
        }
        if (condition === null) {
          if (row.condition !== null) return false;
        } else if (row.condition !== null && row.condition !== condition) {
          return false;
        }
        return true;
      });
    },
    ...overrides,
  };
}

function createRange({
  id,
  lab_test_id = 'lab-1',
  gender = 'any',
  age_min = 0,
  age_max = 999,
  condition = null,
  range_low = null,
  range_high = null,
  range_text = null,
  priority = 0,
  created_at = '2026-01-01T00:00:00.000Z',
  updated_at = '2026-01-01T00:00:00.000Z',
}) {
  return {
    id,
    lab_test_id,
    gender,
    age_min,
    age_max,
    condition,
    range_low,
    range_high,
    range_text,
    priority,
    created_at,
    updated_at,
  };
}

function loadService(rows = [], repoOverrides = {}) {
  const logger = createMockLogger();
  const repository = createMockRepository(rows, repoOverrides);

  class MockLabRangeRepository {
    constructor() {
      return repository;
    }
  }

  const service = loadWithMocks(SERVICE_PATH, {
    '../../config/db': {},
    '../../repositories/LabRangeRepository': MockLabRangeRepository,
    '../../middlewares/errorHandler': { AppError },
    '../../utils/logger': { logger },
  });

  return { service, repository, logger };
}

describe('resolveRange — reference range selection', () => {
  describe('gender-specific ranges', () => {
    it('returns the male-specific range when both male and female ranges exist for the same test', async () => {
      const { service } = loadService([
        createRange({ id: 'male-range', gender: 'male', range_low: 4, range_high: 8 }),
        createRange({ id: 'female-range', gender: 'female', range_low: 3, range_high: 7 }),
      ]);

      const result = await service.resolveRange('lab-1', { gender: 'male', age: 30 });

      assert.equal(result.id, 'male-range');
    });

    it('returns the female-specific range when both female and general ranges match', async () => {
      const { service } = loadService([
        createRange({ id: 'general-range', gender: 'any', range_low: 2, range_high: 6 }),
        createRange({ id: 'female-range', gender: 'female', range_low: 3, range_high: 7 }),
      ]);

      const result = await service.resolveRange('lab-1', { gender: 'female', age: 28 });

      assert.equal(result.id, 'female-range');
    });

    it('falls back to the general range when no gender-specific range matches the patient context', async () => {
      const { service } = loadService([
        createRange({ id: 'general-range', gender: 'any', range_low: 2, range_high: 6 }),
        createRange({ id: 'female-range', gender: 'female', range_low: 3, range_high: 7 }),
      ]);

      const result = await service.resolveRange('lab-1', { gender: 'male', age: 34 });

      assert.equal(result.id, 'general-range');
    });
  });

  describe('age-specific ranges', () => {
    it('returns the pediatric range for a patient under eighteen years old', async () => {
      const { service } = loadService([
        createRange({ id: 'pediatric-range', age_min: 0, age_max: 17, range_low: 1, range_high: 4 }),
        createRange({ id: 'adult-range', age_min: 18, age_max: 65, range_low: 3, range_high: 7 }),
      ]);

      const result = await service.resolveRange('lab-1', { gender: 'male', age: 12 });

      assert.equal(result.id, 'pediatric-range');
    });

    it('returns the adult range for a patient between eighteen and sixty-five', async () => {
      const { service } = loadService([
        createRange({ id: 'pediatric-range', age_min: 0, age_max: 17 }),
        createRange({ id: 'adult-range', age_min: 18, age_max: 65 }),
        createRange({ id: 'geriatric-range', age_min: 66, age_max: 120 }),
      ]);

      const result = await service.resolveRange('lab-1', { gender: 'female', age: 44 });

      assert.equal(result.id, 'adult-range');
    });

    it('returns the geriatric range for a patient older than sixty-five', async () => {
      const { service } = loadService([
        createRange({ id: 'adult-range', age_min: 18, age_max: 65 }),
        createRange({ id: 'geriatric-range', age_min: 66, age_max: 120 }),
      ]);

      const result = await service.resolveRange('lab-1', { gender: 'female', age: 72 });

      assert.equal(result.id, 'geriatric-range');
    });

    it('falls back to the most general range when age is unavailable and the D3 demographic guard triggers', async () => {
      const { service } = loadService([
        createRange({ id: 'general-range', gender: 'any', age_min: 0, age_max: 999 }),
        createRange({ id: 'male-adult-range', gender: 'male', age_min: 18, age_max: 65 }),
      ]);

      const result = await service.resolveRange('lab-1', { gender: null, age: null });

      assert.equal(result.id, 'general-range');
    });
  });

  describe('condition-specific ranges', () => {
    it('prefers the pregnancy-specific range over a same-priority gender-only range', async () => {
      const { service } = loadService([
        createRange({ id: 'female-range', gender: 'female', condition: null, priority: 5 }),
        createRange({ id: 'pregnant-range', gender: 'female', condition: 'pregnant', priority: 5 }),
      ]);

      const result = await service.resolveRange('lab-1', { gender: 'female', age: 31, condition: 'pregnant' });

      assert.equal(result.id, 'pregnant-range');
    });

    it('applies the fasting-specific range when fasting context is supplied', async () => {
      const { service } = loadService([
        createRange({ id: 'general-range', condition: null, range_low: 70, range_high: 99 }),
        createRange({ id: 'fasting-range', condition: 'fasting', range_low: 65, range_high: 95 }),
      ]);

      const result = await service.resolveRange('lab-1', { gender: 'male', age: 40, condition: 'fasting' });

      assert.equal(result.id, 'fasting-range');
    });

    it('returns null when the database has no range for the requested test identifier', async () => {
      const { service } = loadService([
        createRange({ id: 'other-test', lab_test_id: 'lab-2' }),
      ]);

      const result = await service.resolveRange('lab-1', { gender: 'female', age: 29 });

      assert.equal(result, null);
    });
  });

  describe('priority ordering', () => {
    it('picks the higher-priority range when multiple ranges match the same patient context', async () => {
      const { service } = loadService([
        createRange({ id: 'low-priority', priority: 1 }),
        createRange({ id: 'high-priority', priority: 10 }),
      ]);

      const result = await service.resolveRange('lab-1', { gender: 'female', age: 35 });

      assert.equal(result.id, 'high-priority');
    });

    it('picks the more specific age band when priority and condition scores are tied', async () => {
      const { service } = loadService([
        createRange({ id: 'wide-range', age_min: 0, age_max: 99, priority: 4 }),
        createRange({ id: 'narrow-range', age_min: 25, age_max: 35, priority: 4 }),
      ]);

      const result = await service.resolveRange('lab-1', { gender: 'male', age: 30 });

      assert.equal(result.id, 'narrow-range');
    });
  });
});

describe('evaluateResult — flag assignment', () => {
  it('flags a numeric result as NORMAL when it falls strictly inside the configured range', async () => {
    const { service } = loadService([
      createRange({ id: 'range-1', range_low: 4, range_high: 10 }),
    ]);

    const result = await service.evaluateResult('lab-1', 7.5, { gender: 'male', age: 30 });

    assert.equal(result.flag, 'NORMAL');
    assert.equal(result.is_normal, true);
  });

  it('flags a numeric result as LOW when it falls below the configured minimum', async () => {
    const { service } = loadService([
      createRange({ id: 'range-1', range_low: 4, range_high: 10 }),
    ]);

    const result = await service.evaluateResult('lab-1', 3.9, { gender: 'male', age: 30 });

    assert.equal(result.flag, 'LOW');
    assert.equal(result.is_normal, false);
  });

  it('flags a numeric result as HIGH when it rises above the configured maximum', async () => {
    const { service } = loadService([
      createRange({ id: 'range-1', range_low: 4, range_high: 10 }),
    ]);

    const result = await service.evaluateResult('lab-1', 10.1, { gender: 'male', age: 30 });

    assert.equal(result.flag, 'HIGH');
    assert.equal(result.is_normal, false);
  });

  it('treats a result equal to the lower boundary as NORMAL because the lower bound is inclusive', async () => {
    const { service } = loadService([
      createRange({ id: 'range-1', range_low: 4, range_high: 10 }),
    ]);

    const result = await service.evaluateResult('lab-1', 4, { gender: 'male', age: 30 });

    assert.equal(result.flag, 'NORMAL');
    assert.equal(result.is_normal, true);
  });

  it('treats a result equal to the upper boundary as NORMAL because the upper bound is inclusive', async () => {
    const { service } = loadService([
      createRange({ id: 'range-1', range_low: 4, range_high: 10 }),
    ]);

    const result = await service.evaluateResult('lab-1', 10, { gender: 'male', age: 30 });

    assert.equal(result.flag, 'NORMAL');
    assert.equal(result.is_normal, true);
  });

  it('accepts a numeric result passed as the string "7.5" and evaluates it correctly', async () => {
    const { service } = loadService([
      createRange({ id: 'range-1', range_low: 4, range_high: 10 }),
    ]);

    const result = await service.evaluateResult('lab-1', '7.5', { gender: 'male', age: 30 });

    assert.equal(result.flag, 'NORMAL');
    assert.equal(result.is_normal, true);
  });

  it('treats a categorical POSITIVE result as NORMAL when the configured text range expects POSITIVE', async () => {
    const { service } = loadService([
      createRange({ id: 'cat-range', range_text: 'positive' }),
    ]);

    const result = await service.evaluateResult('lab-1', 'reactive', { gender: 'female', age: 30 });

    assert.equal(result.flag, 'NORMAL');
    assert.equal(result.is_normal, true);
  });

  it('treats a categorical NEGATIVE result as NORMAL when the configured text range expects NEGATIVE', async () => {
    const { service } = loadService([
      createRange({ id: 'cat-range', range_text: 'negative' }),
    ]);

    const result = await service.evaluateResult('lab-1', 'not detected', { gender: 'female', age: 30 });

    assert.equal(result.flag, 'NORMAL');
    assert.equal(result.is_normal, true);
  });

  it('returns the NO_RANGE flag when resolveRange cannot find any applicable reference range', async () => {
    const { service } = loadService([]);

    const result = await service.evaluateResult('lab-1', 6.2, { gender: 'male', age: 30 });

    assert.equal(result.flag, 'NO_RANGE');
    assert.equal(result.range, null);
    assert.equal(result.is_normal, null);
  });

  it('does not throw when preloadedRanges is an empty array and instead reports NO_RANGE', async () => {
    const { service } = loadService([]);

    const result = await service.evaluateResult('lab-1', 6.2, { gender: 'male', age: 30 }, []);

    assert.equal(result.flag, 'NO_RANGE');
    assert.equal(result.range, null);
  });
});
