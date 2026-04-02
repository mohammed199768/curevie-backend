const BaseRepository = require('./BaseRepository');
const { AppError } = require('../middlewares/errorHandler');

const ALLOWED_UPDATE_FIELDS = new Set([
  'gender', 'age_min', 'age_max',
  'fasting_state', 'cycle_phase', 'is_pregnant',
  'range_low', 'range_high', 'range_text',
  'unit', 'notes', 'priority',
]);

class LabRangeRepository extends BaseRepository {
  constructor(db) {
    super(db, 'lab_test_reference_ranges');
  }

  async findByTestId(labTestId, client = null) {
    const result = await this._query(
      `
      SELECT *
      FROM lab_test_reference_ranges
      WHERE lab_test_id = $1
      ORDER BY priority DESC, updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
      `,
      [labTestId],
      client
    );
    return result.rows;
  }

  async findResolvableRanges(labTestId, {
    age,
    gender,
    fasting_state,
    cycle_phase,
    is_pregnant,
  }, client = null) {
    const result = await this._query(
      `
      SELECT *
      FROM lab_test_reference_ranges lrr
      WHERE lrr.lab_test_id = $1
        AND ($2::numeric IS NULL OR ($2 BETWEEN lrr.age_min AND lrr.age_max))
        AND (
          $3::text IS NULL AND lrr.gender = 'any'
          OR $3::text IS NOT NULL AND (lrr.gender = $3 OR lrr.gender = 'any')
        )
        AND (
          $4::text IS NULL AND lrr.fasting_state IS NULL
          OR $4::text IS NOT NULL AND (lrr.fasting_state IS NULL OR lrr.fasting_state = $4)
        )
        AND (
          $5::text IS NULL AND lrr.cycle_phase IS NULL
          OR $5::text IS NOT NULL AND (lrr.cycle_phase IS NULL OR lrr.cycle_phase = $5)
        )
        AND (
          $6::boolean IS NULL AND lrr.is_pregnant IS NULL
          OR $6::boolean IS NOT NULL AND (lrr.is_pregnant IS NULL OR lrr.is_pregnant = $6)
        )
      `,
      [labTestId, age, gender, fasting_state, cycle_phase, is_pregnant],
      client
    );
    return result.rows;
  }

  async findByTestIds(labTestIds, client = null) {
    const result = await this._query(
      `
      SELECT *
      FROM lab_test_reference_ranges
      WHERE lab_test_id = ANY($1::uuid[])
      ORDER BY priority DESC, updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
      `,
      [labTestIds],
      client
    );
    return result.rows;
  }

  async findAll(filters = {}, client = null) {
    const where = [];
    const params = [];

    if (filters.labTestId) {
      params.push(filters.labTestId);
      where.push(`lab_test_id = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const result = await this._query(
      `
      SELECT *
      FROM lab_test_reference_ranges
      ${whereSql}
      ORDER BY priority DESC, updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
      `,
      params,
      client
    );
    return result.rows;
  }

  async findById(rangeId, client = null) {
    return this._queryOne(
      `
      SELECT *
      FROM lab_test_reference_ranges
      WHERE id = $1
      LIMIT 1
      `,
      [rangeId],
      client
    );
  }

  async buildDisplayRange(labTestId) {
    const { rows } = await this.pool.query(
      `
      SELECT
        gender,
        age_min,
        age_max,
        fasting_state,
        cycle_phase,
        is_pregnant,
        range_low,
        range_high,
        range_text,
        unit
      FROM lab_test_reference_ranges
      WHERE lab_test_id = $1
      ORDER BY priority DESC, gender DESC, age_min ASC
      LIMIT 10
      `,
      [labTestId]
    );

    if (!rows.length) return null;

    const textRanges = rows.filter((row) => row.range_text);
    if (textRanges.length && textRanges.length === rows.length) {
      const unique = [...new Set(textRanges.map((row) => row.range_text))];
      return unique.join(' / ');
    }

    const general = rows.find(
      (row) =>
        row.gender === 'any'
        && !row.fasting_state
        && !row.cycle_phase
        && row.is_pregnant === null
    );
    const target = general || rows[0];

    if (!target) return null;

    const unit = target.unit || '';
    if (target.range_low !== null && target.range_high !== null) {
      return `${target.range_low} \u2013 ${target.range_high}${unit ? ` ${unit}` : ''}`;
    }
    if (target.range_low !== null) {
      return `\u2265 ${target.range_low}${unit ? ` ${unit}` : ''}`;
    }
    if (target.range_high !== null) {
      return `\u2264 ${target.range_high}${unit ? ` ${unit}` : ''}`;
    }

    return null;
  }

  async findOverlappingRange({
    labTestId,
    gender,
    fasting_state,
    cycle_phase,
    is_pregnant,
    ageMin,
    ageMax,
    excludeRangeId = null,
  }, client = null) {
    return this._queryOne(
      `
      SELECT id, age_min, age_max, gender, fasting_state, cycle_phase, is_pregnant
      FROM lab_test_reference_ranges
      WHERE lab_test_id = $1
        AND gender = $2
        AND fasting_state IS NOT DISTINCT FROM $3
        AND cycle_phase IS NOT DISTINCT FROM $4
        AND is_pregnant IS NOT DISTINCT FROM $5
        AND COALESCE(age_min, 0) <= $7
        AND COALESCE(age_max, 999) >= $6
        AND ($8::uuid IS NULL OR id <> $8)
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
      LIMIT 1
      `,
      [labTestId, gender, fasting_state, cycle_phase, is_pregnant, ageMin, ageMax, excludeRangeId],
      client
    );
  }

  async createRange(labTestId, payload, client = null) {
    return this._queryOne(
      `
      INSERT INTO lab_test_reference_ranges (
        lab_test_id, gender, age_min, age_max, fasting_state,
        cycle_phase, is_pregnant, range_low, range_high, range_text,
        unit, notes, priority
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *
      `,
      [
        labTestId,
        payload.gender,
        payload.age_min,
        payload.age_max,
        payload.fasting_state,
        payload.cycle_phase,
        payload.is_pregnant,
        payload.range_low,
        payload.range_high,
        payload.range_text,
        payload.unit,
        payload.notes,
        payload.priority,
      ],
      client
    );
  }

  async getOrdinalScale(labTestId) {
    const { rows } = await this.pool.query(
      `SELECT id, value_text, numeric_rank, is_normal_max
       FROM ordinal_scale_items
       WHERE lab_test_id = $1
       ORDER BY numeric_rank ASC`,
      [labTestId]
    );
    return rows;
  }

  async replaceOrdinalScale(labTestId, items, client) {
    const c = client || this.pool;
    if (!items || items.length === 0) {
      throw new AppError('Ordinal scale must have at least one item', 400);
    }
    const normalMaxCount = items.filter((item) => item.is_normal_max).length;
    if (normalMaxCount !== 1) {
      throw new AppError('Exactly one item must be marked as is_normal_max', 400);
    }
    await c.query(
      'DELETE FROM ordinal_scale_items WHERE lab_test_id = $1',
      [labTestId]
    );
    for (const item of items) {
      await c.query(
        `INSERT INTO ordinal_scale_items
           (lab_test_id, value_text, numeric_rank, is_normal_max)
         VALUES ($1, $2, $3, $4)`,
        [labTestId, item.value_text.trim(), item.numeric_rank, item.is_normal_max ?? false]
      );
    }
  }

  async deleteOrdinalScale(labTestId) {
    const { rowCount } = await this.pool.query(
      'DELETE FROM ordinal_scale_items WHERE lab_test_id = $1',
      [labTestId]
    );
    return { deleted: rowCount };
  }

  async updateRange(rangeId, payload, client = null) {
    const safeKeys = Object.keys(payload).filter((key) => ALLOWED_UPDATE_FIELDS.has(key));
    if (!safeKeys.length) {
      return { noUpdates: true };
    }

    const setClause = safeKeys.map((field, index) => `${field} = $${index + 1}`).join(', ');
    const params = [...safeKeys.map((field) => payload[field]), rangeId];

    const row = await this._queryOne(
      `
      UPDATE lab_test_reference_ranges
      SET ${setClause}, updated_at = NOW()
      WHERE id = $${params.length}
      RETURNING *
      `,
      params,
      client
    );

    return { noUpdates: false, row };
  }

  async deleteRange(rangeId, client = null) {
    return this._queryOne(
      `
      DELETE FROM lab_test_reference_ranges
      WHERE id = $1
      RETURNING *
      `,
      [rangeId],
      client
    );
  }

  async deleteAllForTest(labTestId, client = null) {
    const result = await this._query(
      `
      DELETE FROM lab_test_reference_ranges
      WHERE lab_test_id = $1
      `,
      [labTestId],
      client
    );
    return { deleted: result.rowCount };
  }
}

module.exports = LabRangeRepository;
