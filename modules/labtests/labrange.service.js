const pool = require('../../config/db');
const LabRangeRepository = require('../../repositories/LabRangeRepository');
const { AppError } = require('../../middlewares/errorHandler');
const { logger } = require('../../utils/logger');

let labRangeRepo = new LabRangeRepository(pool);

const VALID_GENDERS = new Set(['male', 'female', 'any']);
const VALID_FASTING_STATES = new Set(['fasting', 'non_fasting']);
const VALID_CYCLE_PHASES = new Set(['follicular', 'ovulatory', 'luteal', 'postmenopausal']);
const VALID_FLAGS = new Set([
  'NORMAL',
  'LOW',
  'HIGH',
  'ABNORMAL',
  'NO_RANGE',
  'PARSE_ERROR',
  'EVALUATION_ERROR',
]);

const CATEGORICAL_ALIASES = new Map([
  ['negative', 'negative'],
  ['neg', 'negative'],
  ['non reactive', 'negative'],
  ['not detected', 'negative'],
  ['positive', 'positive'],
  ['pos', 'positive'],
  ['reactive', 'positive'],
  ['detected', 'positive'],
  ['indeterminate', 'indeterminate'],
  ['no growth', 'no_growth'],
  ['growth', 'growth'],
  ['سلبي', 'negative'],
  ['ايجابي', 'positive'],
  ['غير معقم', 'positive'],
  ['معقم', 'negative'],
  ['غير محدد', 'indeterminate'],
  ['لا نمو', 'no_growth'],
  ['نمو', 'growth'],
]);

function getLabRangeRepo() {
  if (!labRangeRepo) {
    throw new Error('Lab range service has not been configured. Configure it at the composition root first.');
  }
  return labRangeRepo;
}

function getLabRangeDb() {
  return getLabRangeRepo().pool;
}

function configureLabRangeService(repository) {
  labRangeRepo = repository;
  return module.exports;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeNullableString(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function normalizeGender(value, { defaultValue, required = false } = {}) {
  const normalized = (value ?? '').toString().trim().toLowerCase();
  if (!normalized || normalized === 'null') {
    if (defaultValue !== undefined) return defaultValue;
    if (required) throw new AppError('gender is required', 400);
    return null;
  }
  if (!VALID_GENDERS.has(normalized)) {
    throw new AppError(`Invalid gender: ${value}`, 400);
  }
  return normalized;
}

function normalizeFastingState(value) {
  if (value == null || value === '') return null;
  const normalized = value.toString().trim().toLowerCase();
  if (!VALID_FASTING_STATES.has(normalized)) {
    throw new AppError(`Invalid fasting_state: ${value}`, 400);
  }
  return normalized;
}

function normalizeCyclePhase(value) {
  if (value == null || value === '') return null;
  const normalized = value.toString().trim().toLowerCase();
  if (!VALID_CYCLE_PHASES.has(normalized)) {
    throw new AppError(`Invalid cycle_phase: ${value}`, 400);
  }
  return normalized;
}

function normalizeIsPregnant(value) {
  if (value == null || value === '') return null;
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : value;
  if (normalized === true || normalized === 'true' || normalized === '1') return true;
  if (normalized === false || normalized === 'false' || normalized === '0') return false;
  throw new AppError(`Invalid is_pregnant: ${value}`, 400);
}

function normalizeIntegerField(value, fieldName, { defaultValue, allowUndefined = false } = {}) {
  if (value === undefined) {
    if (allowUndefined) return undefined;
    return defaultValue;
  }

  if (value === null || value === '') {
    throw new AppError(`${fieldName} must be an integer`, 400, 'INVALID_RANGE_INPUT');
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new AppError(`${fieldName} must be an integer`, 400, 'INVALID_RANGE_INPUT');
  }

  return parsed;
}

function normalizeNumberField(value, fieldName, { defaultValue = null, allowUndefined = false } = {}) {
  if (value === undefined) {
    if (allowUndefined) return undefined;
    return defaultValue;
  }

  if (value === null || value === '') {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AppError(`${fieldName} must be a number`, 400, 'INVALID_RANGE_INPUT');
  }

  return parsed;
}

function normalizePriority(value, { defaultValue = 0, allowUndefined = false } = {}) {
  return normalizeIntegerField(value, 'priority', { defaultValue, allowUndefined });
}

function buildCreatePayload(data = {}) {
  return {
    gender: normalizeGender(data.gender, { defaultValue: 'any' }),
    age_min: normalizeIntegerField(data.age_min, 'age_min', { defaultValue: 0 }),
    age_max: normalizeIntegerField(data.age_max, 'age_max', { defaultValue: 999 }),
    fasting_state: normalizeFastingState(data.fasting_state),
    cycle_phase: normalizeCyclePhase(data.cycle_phase),
    is_pregnant: normalizeIsPregnant(data.is_pregnant),
    range_low: normalizeNumberField(data.range_low, 'range_low'),
    range_high: normalizeNumberField(data.range_high, 'range_high'),
    range_text: normalizeNullableString(data.range_text) ?? null,
    unit: normalizeNullableString(data.unit) ?? null,
    notes: normalizeNullableString(data.notes) ?? null,
    priority: normalizePriority(data.priority, { defaultValue: 0 }),
  };
}

function buildUpdatePayload(data = {}) {
  const payload = {};

  if (hasOwn(data, 'gender')) {
    payload.gender = normalizeGender(data.gender, { required: true });
  }
  if (hasOwn(data, 'age_min')) {
    payload.age_min = normalizeIntegerField(data.age_min, 'age_min', { allowUndefined: true });
  }
  if (hasOwn(data, 'age_max')) {
    payload.age_max = normalizeIntegerField(data.age_max, 'age_max', { allowUndefined: true });
  }
  if (hasOwn(data, 'fasting_state')) {
    payload.fasting_state = normalizeFastingState(data.fasting_state);
  }
  if (hasOwn(data, 'cycle_phase')) {
    payload.cycle_phase = normalizeCyclePhase(data.cycle_phase);
  }
  if (hasOwn(data, 'is_pregnant')) {
    payload.is_pregnant = normalizeIsPregnant(data.is_pregnant);
  }
  if (hasOwn(data, 'range_low')) {
    payload.range_low = normalizeNumberField(data.range_low, 'range_low', { allowUndefined: true });
  }
  if (hasOwn(data, 'range_high')) {
    payload.range_high = normalizeNumberField(data.range_high, 'range_high', { allowUndefined: true });
  }
  if (hasOwn(data, 'range_text')) {
    payload.range_text = normalizeNullableString(data.range_text) ?? null;
  }
  if (hasOwn(data, 'unit')) {
    payload.unit = normalizeNullableString(data.unit) ?? null;
  }
  if (hasOwn(data, 'notes')) {
    payload.notes = normalizeNullableString(data.notes) ?? null;
  }
  if (hasOwn(data, 'priority')) {
    payload.priority = normalizePriority(data.priority, { allowUndefined: true });
  }

  return payload;
}

function validateRangePayload(payload) {
  if (payload.age_min > payload.age_max) {
    throw new AppError('age_min must be less than or equal to age_max', 400, 'INVALID_RANGE_INPUT');
  }

  if (payload.range_low !== null && payload.range_high !== null && payload.range_low > payload.range_high) {
    throw new AppError('range_low must be less than or equal to range_high', 400, 'INVALID_RANGE_INPUT');
  }

  const hasNumericRange = payload.range_low !== null || payload.range_high !== null;
  const hasTextRange = payload.range_text !== null;
  if (!hasNumericRange && !hasTextRange) {
    throw new AppError('A range must include numeric bounds or range_text', 400, 'INVALID_RANGE_INPUT');
  }
}

function normalizeCategoricalText(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value)
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
  return normalized || null;
}

function toCategoricalCanonical(value) {
  const normalized = normalizeCategoricalText(value);
  if (!normalized) return null;
  return CATEGORICAL_ALIASES.get(normalized) || normalized;
}

function tryParseNumericResult(resultValue) {
  if (typeof resultValue === 'number' && Number.isFinite(resultValue)) {
    return { ok: true, value: resultValue };
  }

  if (resultValue === undefined || resultValue === null) {
    return { ok: false, reason: 'EMPTY' };
  }

  const raw = String(resultValue).trim();
  if (!raw) {
    return { ok: false, reason: 'EMPTY' };
  }

  if (/^[<>]=?/.test(raw) || /trace/i.test(raw) || /\+\s*$/.test(raw)) {
    return { ok: false, reason: 'UNSAFE_SPECIAL_VALUE' };
  }

  const directNumeric = /^[+-]?\d+(?:\.\d+)?$/;
  if (directNumeric.test(raw)) {
    return { ok: true, value: Number(raw) };
  }

  const numericWithUnits = /^([+-]?\d+(?:\.\d+)?)(?:\s*[A-Za-z%/._ÂµÎ¼-]+(?:\s*[A-Za-z%/._ÂµÎ¼-]+)*)$/;
  const match = raw.match(numericWithUnits);
  if (match) {
    return { ok: true, value: Number(match[1]) };
  }

  return { ok: false, reason: 'NOT_SAFELY_NUMERIC' };
}

function toTimestampValue(value) {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getAgeSpan(range) {
  const min = Number.isFinite(Number(range.age_min)) ? Number(range.age_min) : 0;
  const max = Number.isFinite(Number(range.age_max)) ? Number(range.age_max) : 999;
  return max - min;
}

function compareSpecificity(value, emptyValue = null) {
  return value === emptyValue || value == null ? 0 : 1;
}

function compareCandidateRanges(left, right) {
  const leftPriority = Number(left.priority || 0);
  const rightPriority = Number(right.priority || 0);
  if (rightPriority !== leftPriority) {
    return rightPriority - leftPriority;
  }

  const leftFastingScore = compareSpecificity(left.fasting_state);
  const rightFastingScore = compareSpecificity(right.fasting_state);
  if (rightFastingScore !== leftFastingScore) {
    return rightFastingScore - leftFastingScore;
  }

  const leftCycleScore = compareSpecificity(left.cycle_phase);
  const rightCycleScore = compareSpecificity(right.cycle_phase);
  if (rightCycleScore !== leftCycleScore) {
    return rightCycleScore - leftCycleScore;
  }

  const leftPregnancyScore = compareSpecificity(left.is_pregnant);
  const rightPregnancyScore = compareSpecificity(right.is_pregnant);
  if (rightPregnancyScore !== leftPregnancyScore) {
    return rightPregnancyScore - leftPregnancyScore;
  }

  const leftGenderScore = left.gender === 'any' ? 0 : 1;
  const rightGenderScore = right.gender === 'any' ? 0 : 1;
  if (rightGenderScore !== leftGenderScore) {
    return rightGenderScore - leftGenderScore;
  }

  const leftAgeSpan = getAgeSpan(left);
  const rightAgeSpan = getAgeSpan(right);
  if (leftAgeSpan !== rightAgeSpan) {
    return leftAgeSpan - rightAgeSpan;
  }

  const updatedDelta = toTimestampValue(right.updated_at) - toTimestampValue(left.updated_at);
  if (updatedDelta !== 0) {
    return updatedDelta;
  }

  const createdDelta = toTimestampValue(right.created_at) - toTimestampValue(left.created_at);
  if (createdDelta !== 0) {
    return createdDelta;
  }

  return String(right.id || '').localeCompare(String(left.id || ''));
}

async function findOverlappingRange(db, {
  labTestId,
  gender,
  fasting_state,
  cycle_phase,
  is_pregnant,
  ageMin,
  ageMax,
  excludeRangeId = null,
}) {
  return getLabRangeRepo().findOverlappingRange({
    labTestId,
    gender,
    fasting_state,
    cycle_phase,
    is_pregnant,
    ageMin,
    ageMax,
    excludeRangeId,
  }, db);
}

async function assertNoRangeConflict(db, payload, { labTestId, excludeRangeId = null } = {}) {
  const overlappingRange = await findOverlappingRange(db, {
    labTestId,
    gender: payload.gender,
    fasting_state: payload.fasting_state,
    cycle_phase: payload.cycle_phase,
    is_pregnant: payload.is_pregnant,
    ageMin: payload.age_min,
    ageMax: payload.age_max,
    excludeRangeId,
  });

  if (overlappingRange) {
    throw new AppError(
      'Overlapping reference range exists for the same test context',
      409,
      'RANGE_CONFLICT'
    );
  }
}

function mapEvaluationFlag(flag) {
  return VALID_FLAGS.has(flag) ? flag : 'EVALUATION_ERROR';
}

async function getRangesForTest(labTestId) {
  return getLabRangeRepo().findByTestId(labTestId);
}

async function getRangeById(rangeId) {
  return getLabRangeRepo().findById(rangeId);
}

async function createRange(labTestId, data) {
  const payload = buildCreatePayload(data);
  validateRangePayload(payload);
  await assertNoRangeConflict(getLabRangeDb(), payload, { labTestId });
  return getLabRangeRepo().createRange(labTestId, payload);
}

async function createManyRanges(labTestId, rangesArray) {
  return getLabRangeRepo().withTransaction(async (client) => {
    const createdRows = [];
    const errors = [];

    for (let index = 0; index < rangesArray.length; index += 1) {
      const rawRange = rangesArray[index];

      try {
        const payload = buildCreatePayload(rawRange);
        validateRangePayload(payload);
        await assertNoRangeConflict(client, payload, { labTestId });
        createdRows.push(await getLabRangeRepo().createRange(labTestId, payload, client));
      } catch (err) {
        if (err.isOperational) {
          errors.push({
            index,
            code: err.code || 'INVALID_RANGE_INPUT',
            message: err.message,
            input: rawRange,
          });
          continue;
        }

        if (err.code === '23505') {
          errors.push({
            index,
            code: 'DUPLICATE_RANGE',
            message: 'Duplicate range detected',
            input: rawRange,
          });
          continue;
        }

        throw err;
      }
    }

    return {
      created: createdRows.length,
      skipped: errors.length,
      data: createdRows,
      errors,
    };
  });
}

async function updateRange(rangeId, data) {
  const existing = await getRangeById(rangeId);
  if (!existing) {
    return { noUpdates: false, row: null };
  }

  const payload = buildUpdatePayload(data);
  if (!Object.keys(payload).length) {
    return { noUpdates: true, row: null };
  }

  const merged = {
    gender: hasOwn(payload, 'gender') ? payload.gender : existing.gender,
    age_min: hasOwn(payload, 'age_min') ? payload.age_min : Number(existing.age_min),
    age_max: hasOwn(payload, 'age_max') ? payload.age_max : Number(existing.age_max),
    fasting_state: hasOwn(payload, 'fasting_state') ? payload.fasting_state : existing.fasting_state,
    cycle_phase: hasOwn(payload, 'cycle_phase') ? payload.cycle_phase : existing.cycle_phase,
    is_pregnant: hasOwn(payload, 'is_pregnant') ? payload.is_pregnant : existing.is_pregnant,
    range_low: hasOwn(payload, 'range_low') ? payload.range_low : (existing.range_low === null ? null : Number(existing.range_low)),
    range_high: hasOwn(payload, 'range_high') ? payload.range_high : (existing.range_high === null ? null : Number(existing.range_high)),
    range_text: hasOwn(payload, 'range_text') ? payload.range_text : existing.range_text,
    unit: hasOwn(payload, 'unit') ? payload.unit : existing.unit,
    notes: hasOwn(payload, 'notes') ? payload.notes : existing.notes,
    priority: hasOwn(payload, 'priority') ? payload.priority : Number(existing.priority || 0),
  };

  validateRangePayload(merged);
  await assertNoRangeConflict(getLabRangeDb(), merged, {
    labTestId: existing.lab_test_id,
    excludeRangeId: rangeId,
  });

  const result = await getLabRangeRepo().updateRange(rangeId, payload);
  if (result?.noUpdates) {
    return { noUpdates: true, row: null };
  }

  return { noUpdates: false, row: result?.row ?? null };
}

async function deleteRange(rangeId) {
  return getLabRangeRepo().deleteRange(rangeId);
}

async function deleteAllRangesForTest(labTestId) {
  return getLabRangeRepo().deleteAllForTest(labTestId);
}

function filterPreloadedRanges(ranges, context) {
  return ranges.filter((range) => {
    const rowGender = normalizeGender(range.gender, { defaultValue: 'any' });
    const rowAgeMin = Number.isFinite(Number(range.age_min)) ? Number(range.age_min) : 0;
    const rowAgeMax = Number.isFinite(Number(range.age_max)) ? Number(range.age_max) : 999;
    const rowFastingState = range.fasting_state ?? null;
    const rowCyclePhase = range.cycle_phase ?? null;
    const rowIsPregnant = range.is_pregnant ?? null;

    if (context.gender === null) {
      if (rowGender !== 'any') return false;
    } else if (rowGender !== context.gender && rowGender !== 'any') {
      return false;
    }

    if (context.age !== null && (context.age < rowAgeMin || context.age > rowAgeMax)) {
      return false;
    }

    if (context.fasting_state === null) {
      if (rowFastingState !== null) return false;
    } else if (rowFastingState !== null && rowFastingState !== context.fasting_state) {
      return false;
    }

    if (context.cycle_phase === null) {
      if (rowCyclePhase !== null) return false;
    } else if (rowCyclePhase !== null && rowCyclePhase !== context.cycle_phase) {
      return false;
    }

    if (context.is_pregnant === null) {
      if (rowIsPregnant !== null) return false;
    } else if (rowIsPregnant !== null && rowIsPregnant !== context.is_pregnant) {
      return false;
    }

    return true;
  });
}

async function resolveRange(labTestId, context = {}, preloadedRanges = null) {
  const gender = normalizeGender(context.gender);
  const age = context.age === undefined || context.age === null || context.age === ''
    ? null
    : normalizeNumberField(context.age, 'age', { allowUndefined: true });
  const fasting_state = normalizeFastingState(context.fasting_state);
  const cycle_phase = normalizeCyclePhase(context.cycle_phase);
  const is_pregnant = normalizeIsPregnant(context.is_pregnant);

  const normalizedContext = { gender, age, fasting_state, cycle_phase, is_pregnant };
  const rows = Array.isArray(preloadedRanges)
    ? filterPreloadedRanges(preloadedRanges, normalizedContext)
    : await getLabRangeRepo().findResolvableRanges(labTestId, normalizedContext);

  if (!rows.length) {
    return null;
  }

  const candidates = [...rows].sort(compareCandidateRanges);
  return candidates[0] || null;
}

async function evaluateOrdinalResult(labTestId, resultValue) {
  const scale = await getLabRangeRepo().getOrdinalScale(labTestId);
  if (!scale || scale.length === 0) {
    return { is_normal: null, range: null, flag: 'NO_RANGE' };
  }

  const normalizedInput = resultValue.toString().trim().toLowerCase();
  const matched = scale.find(
    (item) => item.value_text.trim().toLowerCase() === normalizedInput
  );
  if (!matched) {
    return { is_normal: null, range: null, flag: 'PARSE_ERROR' };
  }

  const normalMaxItem = scale.find((item) => item.is_normal_max);
  if (!normalMaxItem) {
    return { is_normal: null, range: null, flag: 'NO_RANGE' };
  }

  const resultRank = Number(matched.numeric_rank);
  const normalRank = Number(normalMaxItem.numeric_rank);

  if (resultRank < normalRank) {
    return { is_normal: false, range: null, flag: 'LOW', matched, normalMaxItem };
  }
  if (resultRank === normalRank) {
    return { is_normal: true, range: null, flag: 'NORMAL', matched, normalMaxItem };
  }
  return { is_normal: false, range: null, flag: 'HIGH', matched, normalMaxItem };
}

async function evaluateResult(labTestId, resultValue, context = {}, preloadedRanges = null) {
  try {
    const { rows } = await getLabRangeRepo().pool.query(
      'SELECT result_type FROM lab_tests WHERE id = $1',
      [labTestId]
    );
    const resultType = rows[0]?.result_type ?? 'NUMERIC';

    if (resultType === 'ORDINAL') {
      return await evaluateOrdinalResult(labTestId, resultValue);
    }

    if (resultType === 'CATEGORICAL') {
      const range = await resolveRange(labTestId, context, preloadedRanges);
      if (!range) return { is_normal: null, range: null, flag: 'NO_RANGE' };
      if (!range.range_text) return { is_normal: null, range, flag: 'NO_RANGE' };
      const expected = toCategoricalCanonical(range.range_text);
      const actual = toCategoricalCanonical(resultValue);
      if (!actual) return { is_normal: null, range, flag: 'PARSE_ERROR' };
      const isNormal = expected === actual;
      return { is_normal: isNormal, range, flag: isNormal ? 'NORMAL' : 'ABNORMAL' };
    }

    const range = await resolveRange(labTestId, context, preloadedRanges);
    if (!range) {
      return { is_normal: null, range: null, flag: 'NO_RANGE' };
    }

    if (range.range_text) {
      const expected = toCategoricalCanonical(range.range_text);
      const actual = toCategoricalCanonical(resultValue);

      if (!actual) {
        return { is_normal: null, range, flag: 'PARSE_ERROR' };
      }

      const isNormal = expected === actual;
      return {
        is_normal: isNormal,
        range,
        flag: isNormal ? 'NORMAL' : 'ABNORMAL',
      };
    }

    const parsedResult = tryParseNumericResult(resultValue);
    if (!parsedResult.ok) {
      return { is_normal: null, range, flag: 'PARSE_ERROR' };
    }

    const numericValue = parsedResult.value;
    const rangeLow = range.range_low === null || range.range_low === undefined ? null : Number(range.range_low);
    const rangeHigh = range.range_high === null || range.range_high === undefined ? null : Number(range.range_high);

    const below = rangeLow !== null && numericValue < rangeLow;
    const above = rangeHigh !== null && numericValue > rangeHigh;
    const isNormal = !below && !above;

    return {
      is_normal: isNormal,
      range,
      flag: mapEvaluationFlag(below ? 'LOW' : above ? 'HIGH' : 'NORMAL'),
    };
  } catch (err) {
    logger.error('Failed to evaluate lab result', {
      labTestId,
      resultValue,
      context,
      error: err.message,
    });

    return { is_normal: null, range: null, flag: 'EVALUATION_ERROR' };
  }
}

module.exports = {
  getRangesForTest,
  getRangeById,
  buildDisplayRange: (labTestId) => getLabRangeRepo().buildDisplayRange(labTestId),
  getOrdinalScale: (labTestId) => getLabRangeRepo().getOrdinalScale(labTestId),
  replaceOrdinalScale: (labTestId, items) => getLabRangeRepo().withTransaction(async (client) =>
    getLabRangeRepo().replaceOrdinalScale(labTestId, items, client)
  ),
  deleteOrdinalScale: (labTestId) => getLabRangeRepo().deleteOrdinalScale(labTestId),
  createRange,
  createManyRanges,
  updateRange,
  deleteRange,
  deleteAllRangesForTest,
  resolveRange,
  evaluateResult,
  configureLabRangeService,
};
