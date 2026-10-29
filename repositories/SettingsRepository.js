const BaseRepository = require('./BaseRepository');

/** Admin-editable settings stored as one JSON document per key (app_settings). */
class SettingsRepository extends BaseRepository {
  constructor(pool) {
    super(pool, 'app_settings');
  }

  async get(key, db = null) {
    const row = await this._queryOne('SELECT value FROM app_settings WHERE key = $1', [key], db);
    return row ? row.value : null;
  }

  async getAll(db = null) {
    const { rows } = await this._query('SELECT key, value, updated_at FROM app_settings ORDER BY key', [], db);
    return rows;
  }

  async set(key, value, adminId, db = null) {
    return this._queryOne(
      `INSERT INTO app_settings (key, value, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()
       RETURNING key, value, updated_at`,
      [key, JSON.stringify(value), adminId],
      db
    );
  }
}

module.exports = SettingsRepository;
