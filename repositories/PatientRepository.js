const BaseRepository = require('./BaseRepository');

const PATIENT_LIST_COLUMNS = `p.id, p.full_name, p.email, p.phone, p.secondary_phone, p.address, p.date_of_birth, p.gender,
       p.height, p.weight, p.allergies, p.is_vip, p.vip_discount, p.total_points,
       p.created_at, p.updated_at`;

const PATIENT_DETAIL_COLUMNS = `id, full_name, email, phone, secondary_phone, address, date_of_birth, gender,
       height, weight, allergies, is_vip, vip_discount, total_points,
       created_at, updated_at`;

const PATIENT_CREATE_RETURNING = `id, full_name, email, phone, address, date_of_birth, gender,
              is_vip, vip_discount, total_points, created_at, updated_at`;

class PatientRepository extends BaseRepository {
  constructor(pool) {
    super(pool, 'patients');
  }

  async getById(id, db = null) {
    return this._queryOne(
      `SELECT ${PATIENT_DETAIL_COLUMNS} FROM patients WHERE id = $1`,
      [id],
      db
    );
  }

  async createPatient(data, db = null) {
    const { full_name, email, password, phone, address, date_of_birth, gender } = data;
    return this._queryOne(
      `INSERT INTO patients (full_name, email, password, phone, address, date_of_birth, gender)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${PATIENT_CREATE_RETURNING}`,
      [full_name, email, password, phone, address || null, date_of_birth || null, gender || null],
      db
    );
  }

  async list({ search } = {}, { limit, offset } = {}, db = null) {
    const params = [];
    const where = [];

    if (search) {
      params.push(`%${search}%`);
      where.push(`(p.full_name ILIKE $${params.length} OR p.email ILIKE $${params.length} OR p.phone ILIKE $${params.length})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countResult = await this._query(
      `SELECT COUNT(*)::int AS total FROM patients p ${whereSql}`,
      params,
      db
    );

    params.push(limit);
    params.push(offset);

    const dataResult = await this._query(
      `SELECT ${PATIENT_LIST_COLUMNS}
       FROM patients p
       ${whereSql}
       ORDER BY p.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
      db
    );

    return { data: dataResult.rows, total: countResult.rows[0].total };
  }

  async updateMedical(id, data, db = null) {
    return this.update(id, data, ['height', 'weight', 'allergies', 'gender'], db);
  }

  async updateProfile(id, data, db = null) {
    return this.update(id, data, ['full_name', 'phone', 'secondary_phone', 'address', 'gender', 'date_of_birth'], db);
  }

  async updateVip(id, isVip, vipDiscount, db = null) {
    return this._queryOne(
      `UPDATE patients
       SET is_vip = $1, vip_discount = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING id, full_name, is_vip, vip_discount, updated_at`,
      [isVip, isVip ? vipDiscount : 0, id],
      db
    );
  }

  async updateAvatar(id, avatarUrl, db = null) {
    return this._queryOne(
      `UPDATE patients
       SET avatar_url = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, full_name, email, avatar_url, updated_at`,
      [avatarUrl, id],
      db
    );
  }

  async getAvatarInfo(id, db = null) {
    return this._queryOne(
      'SELECT id, full_name, avatar_url FROM patients WHERE id = $1',
      [id],
      db
    );
  }

  async deletePatient(id, db = null) {
    return this._queryOne(
      'DELETE FROM patients WHERE id = $1 RETURNING id, full_name, email',
      [id],
      db
    );
  }

  // --- patient_history queries ---

  async getHistory(patientId, { limit, offset } = {}, db = null) {
    const [countResult, historyResult] = await Promise.all([
      this._query(
        'SELECT COUNT(*)::int AS total FROM patient_history WHERE patient_id = $1',
        [patientId],
        db
      ),
      this._query(
        `SELECT ph.id, ph.note, ph.created_at,
                a.full_name AS admin_name,
                sp.full_name AS provider_name
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

  async getHistoryCount(patientId, db = null) {
    const result = await this._queryOne(
      'SELECT COUNT(*)::int AS total FROM patient_history WHERE patient_id = $1',
      [patientId],
      db
    );
    return result?.total || 0;
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

  // --- cross-table queries ---

  async getRecentRequests(patientId, db = null) {
    const result = await this._query(
      `SELECT id, request_type, service_type, status, requested_at, scheduled_at, completed_at, created_at
       FROM service_requests
       WHERE patient_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [patientId],
      db
    );
    return result.rows;
  }

  async getPointsLog(patientId, { limit, offset } = {}, db = null) {
    try {
      const [countResult, dataResult] = await Promise.all([
        this._query(
          'SELECT COUNT(*)::int AS total FROM points_log WHERE patient_id = $1',
          [patientId],
          db
        ),
        this._query(
          `SELECT
            id,
            LOWER(reason::text) AS type,
            ABS(points)::int AS amount,
            points,
            reason,
            request_id AS reference_id,
            'request'::text AS source,
            note,
            created_at
          FROM points_log
          WHERE patient_id = $1
          ORDER BY created_at DESC
          LIMIT $2 OFFSET $3`,
          [patientId, limit, offset],
          db
        ),
      ]);
      return { data: dataResult.rows, total: countResult.rows[0]?.total || 0 };
    } catch (err) {
      if (err.code !== '42P01') throw err;
      return this.getPointsLogFromInvoices(patientId, { limit, offset }, db);
    }
  }

  async getPointsLogFromInvoices(patientId, { limit, offset } = {}, db = null) {
    const [countResult, dataResult] = await Promise.all([
      this._query(
        `SELECT COUNT(*)::int AS total
         FROM invoices
         WHERE patient_id = $1 AND COALESCE(points_used, 0) > 0`,
        [patientId],
        db
      ),
      this._query(
        `SELECT
          'redeemed'::text AS type,
          points_used::int AS amount,
          created_at,
          id AS reference_id,
          'invoice'::text AS source
        FROM invoices
        WHERE patient_id = $1 AND COALESCE(points_used, 0) > 0
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
        [patientId, limit, offset],
        db
      ),
    ]);
    return { data: dataResult.rows, total: countResult.rows[0]?.total || 0 };
  }
}

module.exports = PatientRepository;
