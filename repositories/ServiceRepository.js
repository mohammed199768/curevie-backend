const BaseRepository = require('./BaseRepository');

const RADIOLOGY_MATCHER = `(
  LOWER(COALESCE(s.name, '')) ~ '(xray|x-ray|radiology|scan|اشعة|أشعة)'
  OR LOWER(COALESCE(c.name, '')) ~ '(xray|x-ray|radiology|scan|اشعة|أشعة)'
)`;

class ServiceRepository extends BaseRepository {
  constructor(pool) {
    super(pool, 'services');
  }

  // --- Categories ---

  async listCategories({ search } = {}, { limit, offset } = {}, db = null) {
    const params = [];
    let whereSql = '';
    if (search) {
      params.push(`%${search}%`);
      whereSql = 'WHERE name ILIKE $1';
    }

    const countResult = await this._query(
      `SELECT COUNT(*)::int AS total FROM service_categories ${whereSql}`,
      params, db
    );
    params.push(limit);
    params.push(offset);
    const dataResult = await this._query(
      `SELECT id, name, description, created_at
       FROM service_categories ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params, db
    );
    return { data: dataResult.rows, total: countResult.rows[0].total };
  }

  async createCategory({ name, description }, db = null) {
    return this._queryOne(
      'INSERT INTO service_categories (name, description) VALUES ($1, $2) RETURNING *',
      [name, description || null], db
    );
  }

  async updateCategory(id, data, db = null) {
    const allowedFields = ['name', 'description'];
    const sets = [];
    const values = [];
    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(data, field)) {
        values.push(data[field]);
        sets.push(`${field} = $${values.length}`);
      }
    }
    if (!sets.length) return { noUpdates: true };
    values.push(id);
    return {
      noUpdates: false,
      row: await this._queryOne(
        `UPDATE service_categories SET ${sets.join(', ')}
         WHERE id = $${values.length}
         RETURNING id, name, description, created_at`,
        values, db
      ),
    };
  }

  async deleteCategory(id, db = null) {
    return this._queryOne(
      'DELETE FROM service_categories WHERE id = $1 RETURNING id, name, description, created_at',
      [id], db
    );
  }

  // --- Services ---

  async listServices({ search, category_id, is_active, is_vip_exclusive, service_kind } = {}, { limit, offset } = {}, db = null) {
    const where = [];
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      where.push(`(s.name ILIKE $${params.length} OR s.description ILIKE $${params.length})`);
    }
    if (category_id) {
      params.push(category_id);
      where.push(`s.category_id = $${params.length}`);
    }
    if (typeof is_active !== 'undefined') {
      params.push(is_active);
      where.push(`s.is_active = $${params.length}`);
    } else {
      params.push(true);
      where.push(`s.is_active = $${params.length}`);
    }
    if (typeof is_vip_exclusive !== 'undefined') {
      params.push(is_vip_exclusive);
      where.push(`s.is_vip_exclusive = $${params.length}`);
    }
    if (service_kind === 'RADIOLOGY') {
      where.push(RADIOLOGY_MATCHER);
    } else if (service_kind === 'MEDICAL') {
      where.push(`NOT ${RADIOLOGY_MATCHER}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countResult = await this._query(
      `SELECT COUNT(*)::int AS total
       FROM services s LEFT JOIN service_categories c ON s.category_id = c.id
       ${whereSql}`,
      params, db
    );
    params.push(limit);
    params.push(offset);
    const dataResult = await this._query(
      `SELECT s.*, c.name AS category_name
       FROM services s LEFT JOIN service_categories c ON s.category_id = c.id
       ${whereSql}
       ORDER BY s.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params, db
    );
    return { data: dataResult.rows, total: countResult.rows[0].total };
  }

  async createService({ name, description, price, category_id, is_vip_exclusive }, db = null) {
    return this._queryOne(
      `INSERT INTO services (name, description, price, category_id, is_vip_exclusive)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, description || null, price, category_id || null, Boolean(is_vip_exclusive)],
      db
    );
  }

  async getServiceById(id, db = null) {
    return this._queryOne(
      `SELECT s.id, s.name, s.description, s.price, s.category_id,
              s.is_vip_exclusive, s.is_active, s.image_url, s.created_at, s.updated_at,
              c.name AS category_name, c.description AS category_description
       FROM services s LEFT JOIN service_categories c ON s.category_id = c.id
       WHERE s.id = $1`,
      [id], db
    );
  }

  async updateService(id, data, db = null) {
    return this.update(id, data, ['name', 'description', 'price', 'category_id', 'is_vip_exclusive', 'is_active'], db);
  }

  async deactivateService(id, db = null) {
    return this._queryOne(
      'UPDATE services SET is_active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING *',
      [id], db
    );
  }

  async getMediaInfo(id, db = null) {
    return this._queryOne(
      'SELECT id, name, image_url FROM services WHERE id = $1',
      [id], db
    );
  }

  async updateImage(id, imageUrl, db = null) {
    return this._queryOne(
      'UPDATE services SET image_url = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [imageUrl, id], db
    );
  }

  // --- Ratings ---

  async getDirectRating(patientId, serviceId, db = null) {
    return this._queryOne(
      `SELECT id FROM service_ratings
       WHERE patient_id = $1 AND service_id = $2 LIMIT 1`,
      [patientId, serviceId], db
    );
  }

  async createDirectRating({ patientId, serviceId, rating, comment }, db = null) {
    return this._queryOne(
      `INSERT INTO service_ratings (patient_id, service_id, rating, comment, rating_type)
       VALUES ($1, $2, $3, $4, 'SERVICE') RETURNING *`,
      [patientId, serviceId, rating, comment || null], db
    );
  }

  async getRatingsSummary(serviceId, db = null) {
    return this._queryOne(
      `SELECT COUNT(id)::int AS total_ratings,
              COALESCE(ROUND(AVG(rating)::numeric, 2), 0) AS average_rating
       FROM service_ratings
       WHERE service_id = $1 AND rating_type = 'SERVICE'`,
      [serviceId], db
    );
  }

  async listRatings(serviceId, { limit, offset } = {}, db = null) {
    const [countResult, result] = await Promise.all([
      this._query(
        `SELECT COUNT(*)::int AS total FROM service_ratings
         WHERE service_id = $1 AND rating_type = 'SERVICE'`,
        [serviceId], db
      ),
      this._query(
        `SELECT sr.id, sr.patient_id, sr.rating, sr.comment, sr.created_at,
                p.full_name AS patient_name
         FROM service_ratings sr LEFT JOIN patients p ON p.id = sr.patient_id
         WHERE sr.service_id = $1 AND sr.rating_type = 'SERVICE'
         ORDER BY sr.created_at DESC
         LIMIT $2 OFFSET $3`,
        [serviceId, limit, offset], db
      ),
    ]);
    return { data: result.rows, total: countResult.rows[0]?.total || 0 };
  }
}

module.exports = ServiceRepository;
