const BaseRepository = require('./BaseRepository');

class ServiceRepository extends BaseRepository {
  constructor(pool) {
    super(pool, 'services');
  }

  // --- Categories ---

  /**
   * Groups in the admin's order. `active_count` = orderable, non-system services in the group.
   * @param {{ search?, service_kind?, is_specialized? }} filters
   */
  async listCategories({ search, service_kind: serviceKind, is_specialized: isSpecialized } = {}, { limit, offset } = {}, db = null) {
    const params = [];
    const where = [];
    if (search) {
      params.push(`%${search}%`);
      where.push(`(c.name ILIKE $${params.length} OR c.name_ar ILIKE $${params.length} OR c.name_en ILIKE $${params.length})`);
    }
    if (serviceKind) {
      params.push(serviceKind);
      where.push(`c.service_kind = $${params.length}`);
    }
    if (typeof isSpecialized !== 'undefined') {
      params.push(isSpecialized);
      where.push(`c.is_specialized = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countResult = await this._query(
      `SELECT COUNT(*)::int AS total FROM service_categories c ${whereSql}`,
      params, db
    );
    params.push(limit);
    params.push(offset);
    const dataResult = await this._query(
      `SELECT c.id, c.name, c.description, c.name_ar, c.name_en, c.description_ar, c.description_en,
              c.slug, c.service_kind, c.sort_order, c.is_specialized, c.created_at,
              (SELECT COUNT(*)::int FROM services s
               WHERE s.category_id = c.id AND s.is_active = TRUE AND s.system_key IS NULL) AS active_count
       FROM service_categories c ${whereSql}
       ORDER BY c.sort_order ASC, c.created_at DESC, c.id ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params, db
    );
    return { data: dataResult.rows, total: countResult.rows[0].total };
  }

  async createCategory({
    name, description, name_ar: nameAr, name_en: nameEn, description_ar: descriptionAr, description_en: descriptionEn,
    service_kind: serviceKind, is_specialized: isSpecialized,
  }, db = null) {
    return this._queryOne(
      `INSERT INTO service_categories
        (name, description, name_ar, name_en, description_ar, description_en, service_kind, is_specialized, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               COALESCE((SELECT MAX(sort_order) + 1 FROM service_categories), 1))
       RETURNING *`,
      [name, description || null, nameAr || null, nameEn || null, descriptionAr || null, descriptionEn || null,
        serviceKind || null, Boolean(isSpecialized)],
      db
    );
  }

  /** Sets sort_order = position (1-based) for each id, in one statement. */
  async reorder(table, ids, db = null) {
    if (!['services', 'service_categories'].includes(table)) throw new Error(`Cannot reorder ${table}`);
    const result = await this._query(
      `UPDATE ${table} t SET sort_order = o.position
       FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, position)
       WHERE t.id = o.id
       RETURNING t.id`,
      [ids], db
    );
    return result.rowCount;
  }

  async updateCategory(id, data, db = null) {
    const allowedFields = [
      'name', 'description', 'name_ar', 'name_en', 'description_ar', 'description_en', 'service_kind', 'is_specialized',
    ];
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
         RETURNING *`,
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

  async listServices({ search, category_id, is_active, is_vip_exclusive, service_kind, is_popular } = {}, { limit, offset } = {}, db = null) {
    // System items (e.g. the lab home-visit fee) are added by the server and never listed.
    const where = ['s.system_key IS NULL'];
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      where.push(`(s.name ILIKE $${params.length} OR s.name_ar ILIKE $${params.length}
        OR s.name_en ILIKE $${params.length} OR s.description ILIKE $${params.length})`);
    }
    if (typeof is_popular !== 'undefined') {
      params.push(is_popular);
      where.push(`s.is_popular = $${params.length}`);
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
    if (service_kind) {
      params.push(service_kind);
      where.push(`s.service_kind = $${params.length}`);
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
      `SELECT s.*, c.name AS category_name, c.name_ar AS category_name_ar, c.name_en AS category_name_en
       FROM services s LEFT JOIN service_categories c ON s.category_id = c.id
       ${whereSql}
       ORDER BY s.sort_order ASC, s.created_at DESC, s.id ASC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params, db
    );
    return { data: dataResult.rows, total: countResult.rows[0].total };
  }

  async createService(
    {
      name, name_ar, name_en, description, description_ar, description_en, price, service_kind, category_id,
      is_vip_exclusive, provider_share_type, provider_share_value, is_popular, requires_fasting,
    },
    db = null
  ) {
    return this._queryOne(
      `INSERT INTO services (
        name, name_ar, name_en, description, description_ar, description_en, price, service_kind, category_id,
        is_vip_exclusive, provider_share_type, provider_share_value, is_popular, requires_fasting
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [
        name,
        name_ar || null,
        name_en || null,
        description || null,
        description_ar || null,
        description_en || null,
        price,
        service_kind || 'MEDICAL',
        category_id || null,
        Boolean(is_vip_exclusive),
        provider_share_type ?? null,
        provider_share_value ?? null,
        Boolean(is_popular),
        Boolean(requires_fasting),
      ],
      db
    );
  }

  async getServiceById(id, db = null) {
    return this._queryOne(
      `SELECT s.id, s.name, s.name_ar, s.name_en, s.description, s.description_ar, s.description_en,
              s.price, s.service_kind, s.category_id,
              s.is_vip_exclusive, s.is_active, s.image_url, s.created_at, s.updated_at,
              s.provider_share_type, s.provider_share_value,
              s.sort_order, s.is_popular, s.requires_fasting, s.source_name, s.system_key,
              c.name AS category_name, c.description AS category_description,
              c.name_ar AS category_name_ar, c.name_en AS category_name_en
       FROM services s LEFT JOIN service_categories c ON s.category_id = c.id
       WHERE s.id = $1`,
      [id], db
    );
  }

  async updateService(id, data, db = null) {
    return this.update(
      id,
      data,
      [
        'name',
        'name_ar',
        'name_en',
        'description',
        'description_ar',
        'description_en',
        'price',
        'service_kind',
        'category_id',
        'is_vip_exclusive',
        'is_active',
        'provider_share_type',
        'provider_share_value',
        'is_popular',
        'requires_fasting',
      ],
      db
    );
  }

  async deactivateService(id, db = null) {
    return this._queryOne(
      'UPDATE services SET is_active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING *',
      [id], db
    );
  }

  /** What a public visitor can order: active, non-VIP services grouped by kind and category, plus packages. */
  async countPublicCatalog(db = null) {
    const [services, packages] = await Promise.all([
      this._query(
        `SELECT service_kind, category_id, COUNT(*)::int AS count
         FROM services
         WHERE is_active = TRUE AND is_vip_exclusive = FALSE AND system_key IS NULL
         GROUP BY service_kind, category_id`,
        [], db
      ),
      this._query('SELECT COUNT(*)::int AS count FROM packages WHERE is_active = TRUE AND is_vip_exclusive = FALSE', [], db),
    ]);
    return { services: services.rows, packages: packages.rows[0].count };
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
}

module.exports = ServiceRepository;
