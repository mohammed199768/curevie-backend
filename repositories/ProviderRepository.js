const BaseRepository = require('./BaseRepository');
const { OPEN_SERVICE_STATUSES } = require('../modules/cases/case.constants');

const PROVIDER_COLUMNS = `
  sp.id, sp.full_name, sp.email, sp.phone, sp.type, sp.is_active, sp.is_available, sp.avatar_url,
  sp.created_at, sp.updated_at,
  COALESCE((
    SELECT json_agg(json_build_object('id', a.id, 'slug', a.slug, 'name_ar', a.name_ar, 'name_en', a.name_en)
                    ORDER BY a.sort_order)
    FROM provider_areas pa JOIN areas a ON a.id = pa.area_id
    WHERE pa.provider_id = sp.id
  ), '[]'::json) AS areas,
  (SELECT COUNT(*)::int FROM case_services cs
   WHERE cs.provider_id = sp.id AND cs.status::text = ANY($1::text[])) AS open_jobs,
  (SELECT COALESCE(ROUND(AVG(r.rating)::numeric, 2), 0) FROM case_service_ratings r WHERE r.provider_id = sp.id) AS average_rating,
  (SELECT COUNT(*)::int FROM case_service_ratings r WHERE r.provider_id = sp.id) AS total_ratings
`;

class ProviderRepository extends BaseRepository {
  constructor(pool) {
    super(pool, 'service_providers');
  }

  async emailExistsGlobal(email, db = null) {
    const result = await this._query(
      `SELECT email FROM admins WHERE email = $1
       UNION SELECT email FROM service_providers WHERE email = $1
       UNION SELECT email FROM patients WHERE email = $1`,
      [email],
      db
    );
    return Boolean(result.rows[0]);
  }

  async createProvider({ full_name, email, hashedPassword, phone, type }, db = null) {
    return this._queryOne(
      `INSERT INTO service_providers (full_name, email, password, phone, type)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [full_name, email, hashedPassword, phone || null, type],
      db
    );
  }

  async getById(id, db = null) {
    return this._queryOne(
      `SELECT ${PROVIDER_COLUMNS} FROM service_providers sp WHERE sp.id = $2 AND sp.deleted_at IS NULL`,
      [OPEN_SERVICE_STATUSES, id],
      db
    );
  }

  async list({ search, type, is_active: isActive, is_available: isAvailable, area_id: areaId } = {}, { limit, offset }, db = null) {
    const params = [OPEN_SERVICE_STATUSES];
    const where = ['sp.deleted_at IS NULL'];
    const add = (value) => {
      params.push(value);
      return `$${params.length}`;
    };

    if (search) {
      const p = add(`%${search}%`);
      where.push(`(sp.full_name ILIKE ${p} OR sp.email ILIKE ${p} OR sp.phone ILIKE ${p})`);
    }
    if (type) where.push(`sp.type = ${add(type)}`);
    if (typeof isActive === 'boolean') where.push(`sp.is_active = ${add(isActive)}`);
    if (typeof isAvailable === 'boolean') where.push(`sp.is_available = ${add(isAvailable)}`);
    if (areaId) {
      where.push(`EXISTS (SELECT 1 FROM provider_areas pa WHERE pa.provider_id = sp.id AND pa.area_id = ${add(areaId)})`);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const countParams = params.slice(1);
    const countSql = `SELECT COUNT(*)::int AS total FROM service_providers sp ${whereSql}`
      .replace(/\$(\d+)/g, (_, n) => `$${Number(n) - 1}`);

    const [rows, count] = await Promise.all([
      this._query(
        `SELECT ${PROVIDER_COLUMNS} FROM service_providers sp ${whereSql}
         ORDER BY sp.created_at DESC
         LIMIT ${add(limit)} OFFSET ${add(offset)}`,
        params,
        db
      ),
      this._query(countSql, countParams, db),
    ]);
    return { data: rows.rows, total: count.rows[0].total };
  }

  async updateProvider(id, data, db = null) {
    return this.update(id, data, ['full_name', 'phone', 'type', 'is_active', 'is_available'], db);
  }

  async replaceAreas(providerId, areaIds, db) {
    await this._query('DELETE FROM provider_areas WHERE provider_id = $1', [providerId], db);
    if (areaIds.length) {
      await this._query(
        `INSERT INTO provider_areas (provider_id, area_id)
         SELECT $1, a.id FROM areas a WHERE a.id = ANY($2::uuid[])`,
        [providerId, areaIds],
        db
      );
    }
  }

  async countKnownAreas(areaIds, db = null) {
    if (!areaIds.length) return 0;
    const row = await this._queryOne('SELECT COUNT(*)::int AS count FROM areas WHERE id = ANY($1::uuid[])', [areaIds], db);
    return row.count;
  }

  async countOpenJobs(providerId, db = null) {
    const row = await this._queryOne(
      'SELECT COUNT(*)::int AS count FROM case_services WHERE provider_id = $1 AND status::text = ANY($2::text[])',
      [providerId, OPEN_SERVICE_STATUSES],
      db
    );
    return row.count;
  }

  /** Soft delete keeps uploaded reports, chats and ratings attached to their author. */
  async softDelete(id, db = null) {
    return this._queryOne(
      `UPDATE service_providers
       SET deleted_at = NOW(), is_active = FALSE, is_available = FALSE, updated_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING id, full_name, email`,
      [id],
      db
    );
  }

  async getAvatarInfo(id, db = null) {
    return this._queryOne('SELECT id, avatar_url FROM service_providers WHERE id = $1 AND deleted_at IS NULL', [id], db);
  }

  async updateAvatar(id, avatarUrl, db = null) {
    await this._query('UPDATE service_providers SET avatar_url = $1, updated_at = NOW() WHERE id = $2', [avatarUrl, id], db);
  }
}

module.exports = ProviderRepository;
