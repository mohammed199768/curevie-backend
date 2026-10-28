const crypto = require('crypto');
const BaseRepository = require('./BaseRepository');
const { AppError } = require('../middlewares/errorHandler');

const TABLE_BY_ROLE = {
  ADMIN: 'admins',
  PROVIDER: 'service_providers',
  PATIENT: 'patients',
};

// Columns returned for each role (password is selected separately when needed).
const FIELDS_BY_ROLE = {
  ADMIN: 'full_name',
  PROVIDER: 'full_name, type, is_active, is_available, phone, avatar_url, deleted_at',
  PATIENT: 'full_name, phone, secondary_phone, address, area_id, date_of_birth, gender, is_vip, vip_discount, avatar_url, deleted_at',
};

/** Refresh tokens are only ever stored as SHA-256 digests. */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

class AuthRepository extends BaseRepository {
  constructor(db) {
    super(db, 'refresh_tokens');
  }

  _tableForRole(role) {
    const table = TABLE_BY_ROLE[String(role || '').toUpperCase()];
    if (!table) throw new AppError('Invalid role', 400, 'INVALID_ROLE');
    return table;
  }

  _fieldsForRole(role) {
    return FIELDS_BY_ROLE[String(role || '').toUpperCase()];
  }

  async findUserByEmail(email, role, client = null) {
    return this._queryOne(
      `SELECT id, email, password, ${this._fieldsForRole(role)} FROM ${this._tableForRole(role)} WHERE email = $1`,
      [email],
      client
    );
  }

  async findUserById(id, role, client = null) {
    return this._queryOne(
      `SELECT id, email, ${this._fieldsForRole(role)}, created_at, updated_at FROM ${this._tableForRole(role)} WHERE id = $1`,
      [id],
      client
    );
  }

  async emailExists(email, client = null) {
    const row = await this._queryOne(
      `SELECT email FROM admins WHERE email = $1
       UNION SELECT email FROM service_providers WHERE email = $1
       UNION SELECT email FROM patients WHERE email = $1`,
      [email],
      client
    );
    return Boolean(row);
  }

  async createPatient(data, client = null) {
    return this._queryOne(
      `INSERT INTO patients (full_name, email, password, phone, secondary_phone, address, area_id, date_of_birth, gender)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, email, ${FIELDS_BY_ROLE.PATIENT}, created_at`,
      [
        data.full_name,
        data.email,
        data.password,
        data.phone,
        data.secondary_phone || null,
        data.address || null,
        data.area_id || null,
        data.date_of_birth || null,
        data.gender || null,
      ],
      client
    );
  }

  async saveRefreshToken(userId, role, token, expiresAt, client = null) {
    await this._query(
      `INSERT INTO refresh_tokens (user_id, role, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (token_hash) DO UPDATE SET revoked_at = NOW()`,
      [userId, role, hashToken(token), expiresAt],
      client
    );
  }

  async findRefreshToken(token, client = null) {
    return this._queryOne(
      `SELECT id, user_id, role, revoked_at, expires_at FROM refresh_tokens WHERE token_hash = $1`,
      [hashToken(token)],
      client
    );
  }

  async revokeTokenById(id, client = null) {
    await this._query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1', [id], client);
  }

  async revokeToken(token, client = null) {
    await this._query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL',
      [hashToken(token)],
      client
    );
  }

  async revokeAllUserTokens(userId, role, client = null) {
    await this._query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND role = $2 AND revoked_at IS NULL',
      [userId, role],
      client
    );
  }

  async findPasswordRowById(userId, role, client = null) {
    return this._queryOne(
      `SELECT id, password FROM ${this._tableForRole(role)} WHERE id = $1`,
      [userId],
      client
    );
  }

  async updatePassword(userId, role, hashedPassword, client = null) {
    await this._query(
      `UPDATE ${this._tableForRole(role)} SET password = $1, updated_at = NOW() WHERE id = $2`,
      [hashedPassword, userId],
      client
    );
  }
}

module.exports = AuthRepository;
module.exports.hashToken = hashToken;
