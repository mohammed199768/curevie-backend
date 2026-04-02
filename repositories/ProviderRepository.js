const BaseRepository = require('./BaseRepository');

class ProviderRepository extends BaseRepository {
  constructor(pool) {
    super(pool, 'service_providers');
  }

  async emailExistsGlobal(email, db = null) {
    const result = await this._query(
      `SELECT email FROM admins WHERE email = $1
       UNION
       SELECT email FROM service_providers WHERE email = $1
       UNION
       SELECT email FROM patients WHERE email = $1`,
      [email],
      db
    );
    return Boolean(result.rows[0]);
  }

  async createProvider({ full_name, email, hashedPassword, phone, type }, db = null) {
    return this._queryOne(
      `INSERT INTO service_providers (full_name, email, password, phone, type)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, full_name, email, phone, type, is_available, created_at`,
      [full_name, email, hashedPassword, phone || null, type],
      db
    );
  }

  async list({ search, type, is_available } = {}, { limit, offset } = {}, db = null) {
    const where = [];
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      where.push(`(full_name ILIKE $${params.length} OR email ILIKE $${params.length} OR phone ILIKE $${params.length})`);
    }
    if (type) {
      params.push(type);
      where.push(`type = $${params.length}`);
    }
    if (typeof is_available !== 'undefined') {
      const parsed = ['true', '1', 'yes'].includes(String(is_available).toLowerCase());
      params.push(parsed);
      where.push(`is_available = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countResult = await this._query(
      `SELECT COUNT(*)::int AS total FROM service_providers ${whereSql}`,
      params,
      db
    );

    params.push(limit);
    params.push(offset);

    const result = await this._query(
      `SELECT id, full_name, email, phone, type, is_available, created_at, updated_at
       FROM service_providers
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
      db
    );

    return { data: result.rows, total: countResult.rows[0].total };
  }

  async updateProvider(id, data, db = null) {
    return this.update(id, data, ['full_name', 'phone', 'type', 'is_available'], db);
  }

  async deleteProvider(id, db = null) {
    return this._queryOne(
      'DELETE FROM service_providers WHERE id = $1 RETURNING id, full_name, email',
      [id],
      db
    );
  }

  async getById(id, db = null) {
    return this._queryOne(
      'SELECT id, full_name, type FROM service_providers WHERE id = $1',
      [id],
      db
    );
  }

  async getRatingsSummary(providerId, db = null) {
    return this._queryOne(
      `SELECT
        COUNT(sr.id)::int AS total_ratings,
        COALESCE(ROUND(AVG(sr.rating)::numeric, 2), 0) AS average_rating
       FROM service_ratings sr
       JOIN service_requests req ON req.id = sr.request_id
       WHERE req.assigned_provider_id = $1`,
      [providerId],
      db
    );
  }

  async getRatingsCount(providerId, db = null) {
    const row = await this._queryOne(
      `SELECT COUNT(sr.id)::int AS total
       FROM service_ratings sr
       JOIN service_requests req ON req.id = sr.request_id
       WHERE req.assigned_provider_id = $1`,
      [providerId],
      db
    );
    return row.total;
  }

  async getRatings(providerId, limit, offset, db = null) {
    const result = await this._query(
      `SELECT
        sr.id, sr.request_id, sr.patient_id, sr.rating, sr.comment, sr.created_at,
        p.full_name AS patient_name
       FROM service_ratings sr
       JOIN service_requests req ON req.id = sr.request_id
       LEFT JOIN patients p ON p.id = sr.patient_id
       WHERE req.assigned_provider_id = $1
       ORDER BY sr.created_at DESC
       LIMIT $2 OFFSET $3`,
      [providerId, limit, offset],
      db
    );
    return result.rows;
  }

  async getAvatarInfo(id, db = null) {
    return this._queryOne(
      'SELECT id, full_name, avatar_url FROM service_providers WHERE id = $1',
      [id],
      db
    );
  }

  async updateAvatar(id, avatarUrl, db = null) {
    return this._queryOne(
      `UPDATE service_providers
       SET avatar_url = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, full_name, email, phone, type, is_available, avatar_url, updated_at`,
      [avatarUrl, id],
      db
    );
  }
}

module.exports = ProviderRepository;
