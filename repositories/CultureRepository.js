'use strict';

const { AppError } = require('../middlewares/errorHandler');

class CultureRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async getByLabResultId(labResultId, client = null) {
    const c = client || this.pool;
    const { rows } = await c.query(
      `SELECT cr.*,
              json_agg(
                json_build_object(
                  'id',              sr.id,
                  'antibiotic_name', sr.antibiotic_name,
                  'mic_value',       sr.mic_value,
                  'interpretation',  sr.interpretation
                ) ORDER BY sr.antibiotic_name
              ) FILTER (WHERE sr.id IS NOT NULL) AS sensitivity
       FROM culture_results cr
       LEFT JOIN sensitivity_results sr ON sr.culture_result_id = cr.id
       WHERE cr.lab_result_id = $1
       GROUP BY cr.id`,
      [labResultId]
    );
    return rows[0] || null;
  }

  async upsert(labResultId, data, client) {
    const c = client || this.pool;
    const { growth_status, organism_name, colony_count, notes, sensitivity = [] } = data;

    const VALID_STATUSES = new Set(['NO_GROWTH', 'GROWTH', 'CONTAMINATED', 'PENDING']);
    if (!VALID_STATUSES.has(growth_status)) {
      throw new AppError(`Invalid growth_status: ${growth_status}`, 400);
    }

    const VALID_INTERP = new Set(['S', 'I', 'R']);
    for (const s of sensitivity) {
      if (!s.antibiotic_name?.trim()) {
        throw new AppError('antibiotic_name is required for each sensitivity entry', 400);
      }
      if (!VALID_INTERP.has(s.interpretation)) {
        throw new AppError(`Invalid interpretation: ${s.interpretation}`, 400);
      }
    }

    const { rows } = await c.query(
      `INSERT INTO culture_results
         (lab_result_id, growth_status, organism_name, colony_count, notes)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (lab_result_id)
       DO UPDATE SET
         growth_status = EXCLUDED.growth_status,
         organism_name = EXCLUDED.organism_name,
         colony_count  = EXCLUDED.colony_count,
         notes         = EXCLUDED.notes
       RETURNING *`,
      [labResultId, growth_status, organism_name || null, colony_count || null, notes || null]
    );
    const cultureRow = rows[0];

    await c.query('DELETE FROM sensitivity_results WHERE culture_result_id = $1', [cultureRow.id]);
    for (const s of sensitivity) {
      await c.query(
        `INSERT INTO sensitivity_results
           (culture_result_id, antibiotic_name, mic_value, interpretation)
         VALUES ($1,$2,$3,$4)`,
        [cultureRow.id, s.antibiotic_name.trim(), s.mic_value || null, s.interpretation]
      );
    }

    return this.getByLabResultId(labResultId, c);
  }

  async delete(labResultId, client) {
    const c = client || this.pool;
    const { rowCount } = await c.query(
      'DELETE FROM culture_results WHERE lab_result_id = $1',
      [labResultId]
    );
    return { deleted: rowCount };
  }

  async withTransaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = CultureRepository;
