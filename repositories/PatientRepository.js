const BaseRepository = require('./BaseRepository');

const PATIENT_COLUMNS = `p.id, p.full_name, p.email, p.phone, p.secondary_phone, p.address, p.area_id,
  a.name_ar AS area_name_ar, a.name_en AS area_name_en,
  p.date_of_birth, p.gender, p.height, p.weight, p.allergies, p.is_vip, p.vip_discount,
  p.avatar_url, p.created_at, p.updated_at`;

class PatientRepository extends BaseRepository {
  constructor(pool) {
    super(pool, 'patients');
  }

  async getById(id, db = null) {
    return this._queryOne(
      `SELECT ${PATIENT_COLUMNS}
       FROM patients p LEFT JOIN areas a ON a.id = p.area_id
       WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [id],
      db
    );
  }

  async exists(id, db = null) {
    const row = await this._queryOne('SELECT 1 FROM patients WHERE id = $1 AND deleted_at IS NULL', [id], db);
    return Boolean(row);
  }

  async list({ search, is_vip: isVip } = {}, { limit, offset } = {}, db = null) {
    const params = [];
    const where = ['p.deleted_at IS NULL'];

    if (search) {
      params.push(`%${search}%`);
      where.push(`(p.full_name ILIKE $${params.length} OR p.email ILIKE $${params.length} OR p.phone ILIKE $${params.length})`);
    }
    if (typeof isVip === 'boolean') {
      params.push(isVip);
      where.push(`p.is_vip = $${params.length}`);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const countResult = await this._query(`SELECT COUNT(*)::int AS total FROM patients p ${whereSql}`, params, db);
    const dataResult = await this._query(
      `SELECT ${PATIENT_COLUMNS},
              (SELECT COUNT(*)::int FROM cases c WHERE c.patient_id = p.id) AS total_cases
       FROM patients p LEFT JOIN areas a ON a.id = p.area_id
       ${whereSql}
       ORDER BY p.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
      db
    );

    return { data: dataResult.rows, total: countResult.rows[0].total };
  }

  /** Patients and distinct guest contacts (guests are grouped by phone + name). */
  async listCombined({ search }, { limit, offset }, db = null) {
    const contactsCte = `
      WITH patient_rows AS (
        SELECT p.id::text AS id, p.full_name AS name, p.email, p.phone, p.gender, p.address,
               'PATIENT'::text AS record_type, p.created_at
        FROM patients p
        WHERE p.deleted_at IS NULL
      ),
      guest_rows AS (
        SELECT md5(lower(COALESCE(c.guest_phone, '')) || '|' || lower(COALESCE(c.guest_name, ''))) AS id,
               c.guest_name AS name, NULL::text AS email, c.guest_phone AS phone, NULL::text AS gender,
               (ARRAY_REMOVE(ARRAY_AGG(c.address ORDER BY c.created_at DESC), NULL))[1] AS address,
               'GUEST'::text AS record_type, MAX(c.created_at) AS created_at
        FROM cases c
        WHERE c.patient_id IS NULL AND c.guest_name IS NOT NULL AND c.guest_phone IS NOT NULL
        GROUP BY c.guest_name, c.guest_phone
      ),
      contacts AS (
        SELECT * FROM patient_rows
        UNION ALL
        SELECT g.* FROM guest_rows g
        WHERE NOT EXISTS (SELECT 1 FROM patients p WHERE p.deleted_at IS NULL AND p.phone = g.phone)
      )`;
    const searchSql = `($1::text IS NULL OR c.name ILIKE $1 OR COALESCE(c.email, '') ILIKE $1
      OR COALESCE(c.phone, '') ILIKE $1 OR COALESCE(c.address, '') ILIKE $1)`;
    const searchParam = search ? `%${search}%` : null;

    const [rows, count] = await Promise.all([
      this._query(
        `${contactsCte} SELECT * FROM contacts c WHERE ${searchSql} ORDER BY c.created_at DESC LIMIT $2 OFFSET $3`,
        [searchParam, limit, offset],
        db
      ),
      this._query(`${contactsCte} SELECT COUNT(*)::int AS total FROM contacts c WHERE ${searchSql}`, [searchParam], db),
    ]);
    return { data: rows.rows, total: count.rows[0]?.total || 0 };
  }

  async updateMedical(id, data, db = null) {
    return this.update(id, data, ['height', 'weight', 'allergies', 'gender'], db);
  }

  async updateProfile(id, data, db = null) {
    return this.update(id, data, ['full_name', 'phone', 'secondary_phone', 'address', 'area_id', 'gender', 'date_of_birth'], db);
  }

  async updateVip(id, isVip, vipDiscount, db = null) {
    return this._queryOne(
      `UPDATE patients SET is_vip = $1, vip_discount = $2, updated_at = NOW()
       WHERE id = $3 AND deleted_at IS NULL
       RETURNING id, full_name, is_vip, vip_discount, updated_at`,
      [isVip, isVip ? vipDiscount : 0, id],
      db
    );
  }

  async getAvatarInfo(id, db = null) {
    return this._queryOne('SELECT id, avatar_url FROM patients WHERE id = $1 AND deleted_at IS NULL', [id], db);
  }

  async updateAvatar(id, avatarUrl, db = null) {
    return this._queryOne(
      `UPDATE patients SET avatar_url = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, full_name, email, avatar_url, updated_at`,
      [avatarUrl, id],
      db
    );
  }

  /** Soft delete: medical history and cases must survive the account. */
  async softDelete(id, db = null) {
    return this._queryOne(
      `UPDATE patients SET deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id, full_name, email`,
      [id],
      db
    );
  }

  async getRecentCases(patientId, limit = 5, db = null) {
    const [rows, count] = await Promise.all([
      this._query(
        `SELECT c.id, c.status, c.created_at, c.scheduled_for,
                (SELECT ARRAY_AGG(cs.item_name ORDER BY cs.created_at) FROM case_services cs
                 WHERE cs.case_id = c.id AND cs.status <> 'CANCELLED') AS item_names
         FROM cases c
         WHERE c.patient_id = $1
         ORDER BY c.created_at DESC
         LIMIT $2`,
        [patientId, limit],
        db
      ),
      this._query('SELECT COUNT(*)::int AS total FROM cases WHERE patient_id = $1', [patientId], db),
    ]);
    return { data: rows.rows, total: count.rows[0]?.total || 0 };
  }

  /**
   * True when the provider works on one of the patient's cases.
   * @param {boolean} openOnly  only count cases that are not closed/cancelled
   */
  async providerServesPatient(providerId, patientId, { openOnly = false } = {}, db = null) {
    const row = await this._queryOne(
      `SELECT 1
       FROM cases c
       WHERE c.patient_id = $2
         ${openOnly ? "AND c.status NOT IN ('CLOSED', 'CANCELLED')" : "AND c.status <> 'CANCELLED'"}
         AND (c.lead_provider_id = $1 OR EXISTS (
           SELECT 1 FROM case_services cs
           WHERE cs.case_id = c.id AND cs.provider_id = $1 AND cs.status <> 'CANCELLED'
         ))
       LIMIT 1`,
      [providerId, patientId],
      db
    );
    return Boolean(row);
  }

  async getHistory(patientId, { limit, offset } = {}, db = null) {
    const [countResult, historyResult] = await Promise.all([
      this._query('SELECT COUNT(*)::int AS total FROM patient_history WHERE patient_id = $1', [patientId], db),
      this._query(
        `SELECT ph.id, ph.note, ph.created_at, a.full_name AS admin_name, sp.full_name AS provider_name
         FROM patient_history ph
         LEFT JOIN admins a ON ph.created_by_admin = a.id
         LEFT JOIN service_providers sp ON ph.created_by_provider = sp.id
         WHERE ph.patient_id = $1
         ORDER BY ph.created_at DESC
         LIMIT $2 OFFSET $3`,
        [patientId, limit, offset],
        db
      ),
    ]);
    return { data: historyResult.rows, total: countResult.rows[0]?.total || 0 };
  }

  async addHistory({ patientId, note, createdByAdmin, createdByProvider }, db = null) {
    return this._queryOne(
      `INSERT INTO patient_history (patient_id, note, created_by_admin, created_by_provider)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [patientId, note, createdByAdmin, createdByProvider],
      db
    );
  }
}

module.exports = PatientRepository;
