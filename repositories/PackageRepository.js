const BaseRepository = require('./BaseRepository');

// Packages are fixed-price bundles of services (any kind, including lab tests).
const PACKAGE_COLUMNS = `
  p.id, p.name, p.name_ar, p.name_en, p.description, p.description_ar, p.description_en,
  p.total_cost, p.category_id, c.name AS category_name, p.is_vip_exclusive, p.is_active,
  p.times_ordered, p.image_url, p.created_at, p.updated_at, p.provider_share_type, p.provider_share_value,
  COALESCE(items.services, '[]'::json) AS services,
  COALESCE(items.services_count, 0)::int AS services_count,
  COALESCE(items.items_total, 0) AS items_total
`;

const PACKAGE_JOINS = `
  FROM packages p
  LEFT JOIN service_categories c ON c.id = p.category_id
  LEFT JOIN LATERAL (
    SELECT
      json_agg(json_build_object(
        'id', s.id, 'name', s.name, 'name_ar', s.name_ar, 'name_en', s.name_en,
        'price', s.price, 'service_kind', s.service_kind, 'is_active', s.is_active
      ) ORDER BY ps.display_order, s.name) AS services,
      COUNT(*) AS services_count,
      SUM(s.price) AS items_total
    FROM package_services ps
    JOIN services s ON s.id = ps.service_id
    WHERE ps.package_id = p.id
  ) items ON TRUE
`;

const EDITABLE_FIELDS = [
  'name', 'name_ar', 'name_en', 'description', 'description_ar', 'description_en',
  'total_cost', 'category_id', 'is_vip_exclusive', 'is_active', 'provider_share_type', 'provider_share_value',
];

class PackageRepository extends BaseRepository {
  constructor(pool) {
    super(pool, 'packages');
  }

  async list({ search, category_id: categoryId, is_active: isActive, is_vip_exclusive: isVip }, { limit, offset }) {
    const params = [];
    const where = [];
    const add = (value) => {
      params.push(value);
      return `$${params.length}`;
    };

    if (search) {
      const p = add(`%${search}%`);
      where.push(`(p.name ILIKE ${p} OR p.name_ar ILIKE ${p} OR p.name_en ILIKE ${p} OR p.description ILIKE ${p})`);
    }
    if (categoryId) where.push(`p.category_id = ${add(categoryId)}`);
    if (typeof isActive === 'boolean') where.push(`p.is_active = ${add(isActive)}`);
    if (typeof isVip === 'boolean') where.push(`p.is_vip_exclusive = ${add(isVip)}`);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows, count] = await Promise.all([
      this._query(
        `SELECT ${PACKAGE_COLUMNS} ${PACKAGE_JOINS} ${whereSql}
         ORDER BY p.created_at DESC
         LIMIT ${add(limit)} OFFSET ${add(offset)}`,
        params
      ),
      this._query(`SELECT COUNT(*)::int AS total FROM packages p ${whereSql}`, params.slice(0, params.length - 2)),
    ]);
    return { data: rows.rows, total: count.rows[0].total };
  }

  async getById(id, db = null) {
    return this._queryOne(`SELECT ${PACKAGE_COLUMNS} ${PACKAGE_JOINS} WHERE p.id = $1`, [id], db);
  }

  async countKnownServices(serviceIds, db = null) {
    const row = await this._queryOne('SELECT COUNT(*)::int AS count FROM services WHERE id = ANY($1::uuid[])', [serviceIds], db);
    return row.count;
  }

  async create(data, db) {
    return this._queryOne(
      `INSERT INTO packages (name, name_ar, name_en, description, description_ar, description_en,
                             total_cost, category_id, is_vip_exclusive, provider_share_type, provider_share_value)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        data.name,
        data.name_ar || null,
        data.name_en || null,
        data.description || null,
        data.description_ar || null,
        data.description_en || null,
        data.total_cost,
        data.category_id || null,
        Boolean(data.is_vip_exclusive),
        data.provider_share_type ?? null,
        data.provider_share_value ?? null,
      ],
      db
    );
  }

  async updateFields(id, data, db) {
    return this.update(id, data, EDITABLE_FIELDS, db);
  }

  /** Replaces the bundle contents, keeping the given order. */
  async replaceServices(packageId, serviceIds, db) {
    await this._query('DELETE FROM package_services WHERE package_id = $1', [packageId], db);
    await this._query(
      `INSERT INTO package_services (package_id, service_id, display_order)
       SELECT $1, item.id, item.ord
       FROM unnest($2::uuid[]) WITH ORDINALITY AS item(id, ord)`,
      [packageId, serviceIds],
      db
    );
  }

  async getMediaInfo(id, db = null) {
    return this._queryOne('SELECT id, image_url FROM packages WHERE id = $1', [id], db);
  }

  async updateImage(id, imageUrl, db = null) {
    await this._query('UPDATE packages SET image_url = $1, updated_at = NOW() WHERE id = $2', [imageUrl, id], db);
  }

  async deactivate(id, db = null) {
    return this._queryOne(
      'UPDATE packages SET is_active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING id',
      [id],
      db
    );
  }
}

module.exports = PackageRepository;
