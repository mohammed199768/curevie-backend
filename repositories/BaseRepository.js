class BaseRepository {
  constructor(pool, tableName) {
    this.pool = pool;
    this.table = tableName;
  }

  async _query(sql, params = [], db = null) {
    return (db || this.pool).query(sql, params);
  }

  async _queryOne(sql, params = [], db = null) {
    const result = await this._query(sql, params, db);
    return result.rows[0] || null;
  }

  async findById(id, db = null, columns = '*') {
    return this._queryOne(
      `SELECT ${columns} FROM ${this.table} WHERE id = $1 LIMIT 1`,
      [id],
      db
    );
  }

  async findOneBy(field, value, db = null) {
    return this._queryOne(
      `SELECT * FROM ${this.table} WHERE ${field} = $1 LIMIT 1`,
      [value],
      db
    );
  }

  async exists(id, db = null) {
    const result = await this._query(
      `SELECT 1 FROM ${this.table} WHERE id = $1 LIMIT 1`,
      [id],
      db
    );
    return result.rowCount > 0;
  }

  async create(data, db = null) {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const cols = keys.join(', ');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    return this._queryOne(
      `INSERT INTO ${this.table} (${cols}) VALUES (${placeholders}) RETURNING *`,
      values,
      db
    );
  }

  async update(id, data, allowedFields, db = null) {
    const sets = [];
    const values = [];
    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(data, field)) {
        values.push(data[field] === '' ? null : data[field]);
        sets.push(`${field} = $${values.length}`);
      }
    }
    if (!sets.length) return { noUpdates: true };
    values.push(id);
    return {
      noUpdates: false,
      row: await this._queryOne(
        `UPDATE ${this.table} SET ${sets.join(', ')}, updated_at = NOW()
         WHERE id = $${values.length} RETURNING *`,
        values,
        db
      ),
    };
  }

  async delete(id, db = null) {
    return this._queryOne(
      `DELETE FROM ${this.table} WHERE id = $1 RETURNING *`,
      [id],
      db
    );
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

module.exports = BaseRepository;
