const BaseRepository = require('./BaseRepository'); // AUDIT-FIX: P3-AUTH-DIP - auth persistence extends the shared repository base.
const { AppError } = require('../middlewares/errorHandler'); // AUDIT-FIX: P3-AUTH-SRP - invalid role lookups raise the shared application error type.

class AuthRepository extends BaseRepository { // AUDIT-FIX: P3-AUTH-DIP - auth data access moves behind an injected repository boundary.
  constructor(db) { // AUDIT-FIX: P3-AUTH-DIP - repository construction accepts the shared pool or a compatible executor.
    super(db, 'refresh_tokens'); // AUDIT-FIX: P3-AUTH-DIP - the default table for this repository is refresh_tokens.
    this._db = db; // AUDIT-FIX: P3-AUTH-DIP - keep a direct executor reference for optional client support.
  } // AUDIT-FIX: P3-AUTH-DIP - constructor keeps transaction-aware executor access explicit.

  _tableForRole(role) { // AUDIT-FIX: P3-AUTH-DRY - role-to-table mapping now lives in one place.
    const map = { // AUDIT-FIX: P3-AUTH-DRY - preserve the existing supported auth roles.
      admin: 'admins', // AUDIT-FIX: P3-AUTH-DRY - lower-case admin role maps to admins.
      ADMIN: 'admins', // AUDIT-FIX: P3-AUTH-DRY - upper-case admin role maps to admins.
      provider: 'service_providers', // AUDIT-FIX: P3-AUTH-DRY - lower-case provider role maps to service_providers.
      PROVIDER: 'service_providers', // AUDIT-FIX: P3-AUTH-DRY - upper-case provider role maps to service_providers.
      patient: 'patients', // AUDIT-FIX: P3-AUTH-DRY - lower-case patient role maps to patients.
      PATIENT: 'patients', // AUDIT-FIX: P3-AUTH-DRY - upper-case patient role maps to patients.
    }; // AUDIT-FIX: P3-AUTH-DRY - centralize all supported role mappings.
    const table = map[role]; // AUDIT-FIX: P3-AUTH-DRY - resolve the backing table from the provided role.
    if (!table) { // AUDIT-FIX: P3-AUTH-SRP - invalid roles fail fast here instead of in every query method.
      throw new AppError('Invalid role', 400, 'INVALID_ROLE'); // AUDIT-FIX: P3-AUTH-SRP - preserve API-level validation semantics.
    } // AUDIT-FIX: P3-AUTH-SRP - unsupported roles never reach SQL string interpolation.
    return table; // AUDIT-FIX: P3-AUTH-DRY - return the canonical table for the role.
  } // AUDIT-FIX: P3-AUTH-DRY - one helper now owns table resolution.

  _extraFieldsForRole(role) { // AUDIT-FIX: P3-AUTH-DRY - role-specific select projections are centralized.
    const map = { // AUDIT-FIX: P3-AUTH-DRY - preserve the existing auth-service projections.
      ADMIN: 'full_name', // AUDIT-FIX: P3-AUTH-DRY - admin reads include full_name only.
      PROVIDER: 'full_name, type, is_available, phone, avatar_url', // AUDIT-FIX: P3-AUTH-DRY - provider reads include the current extra fields.
      PATIENT: 'full_name, phone, secondary_phone, address, date_of_birth, gender, is_vip, vip_discount, total_points', // AUDIT-FIX: P3-AUTH-DRY - patient reads include the current extra fields.
    }; // AUDIT-FIX: P3-AUTH-DRY - centralize current select shapes by role.
    return map[String(role || '').toUpperCase()]; // AUDIT-FIX: P3-AUTH-DRY - normalize case before resolving extra fields.
  } // AUDIT-FIX: P3-AUTH-DRY - one helper now owns role-specific projections.

  async findUserByEmail(email, role, client = null) { // AUDIT-FIX: P3-AUTH-DIP - login lookups now go through the repository.
    const table = this._tableForRole(role); // AUDIT-FIX: P3-AUTH-DRY - resolve the auth table centrally.
    const extraFields = this._extraFieldsForRole(role); // AUDIT-FIX: P3-AUTH-DRY - resolve the role-specific select list centrally.
    return this._queryOne(
      `SELECT id, email, password, ${extraFields} FROM ${table} WHERE email = $1`, // AUDIT-FIX: P3-AUTH-DIP - preserve the existing auth select projection.
      [email],
      client
    ); // AUDIT-FIX: P3-AUTH-DIP - return the matching user row or null.
  } // AUDIT-FIX: P3-AUTH-SRP - user lookup by email is centralized.

  async emailExists(email, client = null) { // AUDIT-FIX: P3-AUTH-DIP - cross-table email checks now go through the repository.
    const row = await this._queryOne(
      `
      SELECT email FROM admins WHERE email = $1
      UNION
      SELECT email FROM service_providers WHERE email = $1
      UNION
      SELECT email FROM patients WHERE email = $1
      `,
      [email],
      client
    ); // AUDIT-FIX: P3-AUTH-DIP - preserve the existing union-based uniqueness check.
    return Boolean(row); // AUDIT-FIX: P3-AUTH-SRP - expose a boolean uniqueness result.
  } // AUDIT-FIX: P3-AUTH-SRP - email uniqueness checks are centralized.

  async createPatient(data, client = null) { // AUDIT-FIX: P3-AUTH-DIP - patient registration inserts now go through the repository.
    return this._queryOne(
      `
      INSERT INTO patients (full_name, email, password, phone, secondary_phone, address, date_of_birth, gender)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, full_name, email, phone, secondary_phone, address, date_of_birth, gender, is_vip, vip_discount, total_points, created_at
      `,
      [
        data.full_name,
        data.email,
        data.password,
        data.phone,
        data.secondary_phone || null,
        data.address || null,
        data.date_of_birth || null,
        data.gender || null,
      ],
      client
    ); // AUDIT-FIX: P3-AUTH-DIP - preserve the existing patient registration response shape.
  } // AUDIT-FIX: P3-AUTH-SRP - patient creation is centralized.

  async saveRefreshToken(userId, role, token, expiresAt, client = null) { // AUDIT-FIX: P3-AUTH-DIP - refresh-token persistence now goes through the repository.
    await this._query(
      `
      INSERT INTO refresh_tokens (user_id, role, token, expires_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (token) DO UPDATE SET revoked_at = NOW()
      `,
      [userId, role, token, expiresAt],
      client
    ); // AUDIT-FIX: P3-AUTH-DIP - preserve the existing refresh-token reuse semantics.
  } // AUDIT-FIX: P3-AUTH-SRP - refresh-token writes are centralized.

  async findRefreshToken(token, client = null) { // AUDIT-FIX: P3-AUTH-DIP - refresh-token lookups now go through the repository.
    return this._queryOne(
      `
      SELECT id, user_id, role, revoked_at, expires_at
      FROM refresh_tokens
      WHERE token = $1
      LIMIT 1
      `,
      [token],
      client
    ); // AUDIT-FIX: P3-AUTH-DIP - preserve the current refresh-token lookup shape.
  } // AUDIT-FIX: P3-AUTH-SRP - refresh-token reads are centralized.

  async revokeTokenById(id, client = null) { // AUDIT-FIX: P3-AUTH-DIP - refresh-token revocation by id now goes through the repository.
    await this._query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1',
      [id],
      client
    ); // AUDIT-FIX: P3-AUTH-DIP - preserve the current refresh-token revocation behavior.
  } // AUDIT-FIX: P3-AUTH-SRP - token-by-id revocation is centralized.

  async revokeToken(token, client = null) { // AUDIT-FIX: P3-AUTH-DIP - generic refresh-token revocation now goes through the repository.
    await this._query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token = $1 AND revoked_at IS NULL',
      [token],
      client
    ); // AUDIT-FIX: P3-AUTH-DIP - allow token-value revocation without caller SQL.
  } // AUDIT-FIX: P3-AUTH-SRP - generic token revocation is centralized.

  async revokeTokenByValue({ token, userId, role }, client = null) { // AUDIT-FIX: P3-AUTH-DIP - scoped refresh-token revocation now goes through the repository.
    return this._queryOne(
      `
      UPDATE refresh_tokens
      SET revoked_at = NOW()
      WHERE token = $1 AND user_id = $2 AND role = $3 AND revoked_at IS NULL
      RETURNING id
      `,
      [token, userId, role],
      client
    ); // AUDIT-FIX: P3-AUTH-DIP - preserve the current logout response shape.
  } // AUDIT-FIX: P3-AUTH-SRP - scoped token revocation is centralized.

  async revokeAllUserTokens(userId, role, client = null) { // AUDIT-FIX: P3-AUTH-DIP - bulk refresh-token revocation now goes through the repository.
    await this._query(
      `
      UPDATE refresh_tokens
      SET revoked_at = NOW()
      WHERE user_id = $1 AND role = $2 AND revoked_at IS NULL
      `,
      [userId, role],
      client
    ); // AUDIT-FIX: P3-AUTH-DIP - preserve the current bulk revoke semantics.
  } // AUDIT-FIX: P3-AUTH-SRP - bulk token revocation is centralized.

  async findUserById(id, role, client = null) { // AUDIT-FIX: P3-AUTH-DIP - profile lookups by role now go through the repository.
    const table = this._tableForRole(role); // AUDIT-FIX: P3-AUTH-DRY - resolve the auth table centrally.
    const extraFields = this._extraFieldsForRole(role); // AUDIT-FIX: P3-AUTH-DRY - resolve the role-specific select list centrally.
    return this._queryOne(
      `SELECT id, email, ${extraFields}, created_at, updated_at FROM ${table} WHERE id = $1`,
      [id],
      client
    ); // AUDIT-FIX: P3-AUTH-DIP - preserve the current profile response shape.
  } // AUDIT-FIX: P3-AUTH-SRP - user lookups by id are centralized.

  async findAdminById(id, client = null) { // AUDIT-FIX: P3-AUTH-DIP - admin lookups now go through the repository.
    return this.findUserById(id, 'ADMIN', client); // AUDIT-FIX: P3-AUTH-DRY - reuse the generic role-based lookup.
  } // AUDIT-FIX: P3-AUTH-SRP - admin lookup is centralized.

  async findProviderById(id, client = null) { // AUDIT-FIX: P3-AUTH-DIP - provider lookups now go through the repository.
    return this.findUserById(id, 'PROVIDER', client); // AUDIT-FIX: P3-AUTH-DRY - reuse the generic role-based lookup.
  } // AUDIT-FIX: P3-AUTH-SRP - provider lookup is centralized.

  async findPatientById(id, client = null) { // AUDIT-FIX: P3-AUTH-DIP - patient lookups now go through the repository.
    return this.findUserById(id, 'PATIENT', client); // AUDIT-FIX: P3-AUTH-DRY - reuse the generic role-based lookup.
  } // AUDIT-FIX: P3-AUTH-SRP - patient lookup is centralized.

  async findPasswordRowById(userId, role, client = null) { // AUDIT-FIX: P3-AUTH-DIP - password verification reads now go through the repository.
    const table = this._tableForRole(role); // AUDIT-FIX: P3-AUTH-DRY - resolve the auth table centrally.
    return this._queryOne(
      `SELECT id, password FROM ${table} WHERE id = $1 LIMIT 1`,
      [userId],
      client
    ); // AUDIT-FIX: P3-AUTH-DIP - preserve the current password verification row shape.
  } // AUDIT-FIX: P3-AUTH-SRP - password reads are centralized.

  async updatePassword(userId, role, hashedPassword, client = null) { // AUDIT-FIX: P3-AUTH-DIP - password writes now go through the repository.
    const table = this._tableForRole(role); // AUDIT-FIX: P3-AUTH-DRY - resolve the auth table centrally.
    await this._query(
      `UPDATE ${table} SET password = $1, updated_at = NOW() WHERE id = $2`,
      [hashedPassword, userId],
      client
    ); // AUDIT-FIX: P3-AUTH-DIP - preserve the current password-update semantics.
  } // AUDIT-FIX: P3-AUTH-SRP - password writes are centralized.

  async deleteRefreshTokensForUser(userId, role, client = null) { // AUDIT-FIX: P3-AUTH-DIP - role-scoped refresh-token deletion now goes through the repository.
    await this._query(
      'DELETE FROM refresh_tokens WHERE user_id = $1 AND role = $2',
      [userId, role],
      client
    ); // AUDIT-FIX: P3-AUTH-DIP - preserve the current refresh-token cleanup behavior.
  } // AUDIT-FIX: P3-AUTH-SRP - role-scoped token cleanup is centralized.
} // AUDIT-FIX: P3-AUTH-DIP - auth repository now owns user and refresh-token persistence.

module.exports = AuthRepository; // AUDIT-FIX: P3-AUTH-DIP - export the repository for composition-root injection.
