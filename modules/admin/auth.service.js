const bcrypt = require('bcryptjs'); // AUDIT-FIX: P3-AUTH-SRP - password hashing remains in the service layer.
const AuthRepository = require('../../repositories/AuthRepository'); // AUDIT-FIX: P3-AUTH-DIP - auth persistence now flows through the repository layer.
let configuredAuthService = null; // AUDIT-FIX: P3-STEP8-DIP - auth service composition is now configured externally instead of requiring config/db here.

function roleConfig(role) { // AUDIT-FIX: P3-AUTH-COMPAT - preserve the legacy roleConfig export used by existing callers.
  const configs = { // AUDIT-FIX: P3-AUTH-COMPAT - keep the existing role metadata intact.
    ADMIN: { table: 'admins', passwordField: 'password', extraFields: 'full_name' }, // AUDIT-FIX: P3-AUTH-COMPAT - preserve the current admin projection.
    PROVIDER: { table: 'service_providers', passwordField: 'password', extraFields: 'full_name, type, is_available, phone, avatar_url' }, // AUDIT-FIX: P3-AUTH-COMPAT - preserve the current provider projection.
    PATIENT: { table: 'patients', passwordField: 'password', extraFields: 'full_name, is_vip, vip_discount, total_points' }, // AUDIT-FIX: P3-AUTH-COMPAT - preserve the current patient projection.
  }; // AUDIT-FIX: P3-AUTH-COMPAT - keep role metadata centralized.
  return configs[role]; // AUDIT-FIX: P3-AUTH-COMPAT - preserve the legacy return shape.
} // AUDIT-FIX: P3-AUTH-COMPAT - legacy config helper stays exported.

function getPasswordTableByRole(role) { // AUDIT-FIX: P3-AUTH-COMPAT - preserve the existing role-to-table password helper.
  const map = { // AUDIT-FIX: P3-AUTH-COMPAT - keep the existing password-table mapping intact.
    ADMIN: 'admins', // AUDIT-FIX: P3-AUTH-COMPAT - preserve admin password table mapping.
    PROVIDER: 'service_providers', // AUDIT-FIX: P3-AUTH-COMPAT - preserve provider password table mapping.
    PATIENT: 'patients', // AUDIT-FIX: P3-AUTH-COMPAT - preserve patient password table mapping.
  }; // AUDIT-FIX: P3-AUTH-COMPAT - keep table mapping centralized.
  return map[role] || null; // AUDIT-FIX: P3-AUTH-COMPAT - preserve null semantics for unsupported roles.
} // AUDIT-FIX: P3-AUTH-COMPAT - helper behavior remains unchanged for existing callers.

function createAuthService(authRepo) { // AUDIT-FIX: P3-AUTH-DIP - auth service now depends on an injected repository.
  async function getUserByEmail(email, role) { // AUDIT-FIX: P3-AUTH-SRP - login lookups now delegate to the repository.
    return authRepo.findUserByEmail(email, role); // AUDIT-FIX: P3-AUTH-DIP - remove direct SQL from the service layer.
  } // AUDIT-FIX: P3-AUTH-SRP - email lookup remains service-owned behaviorally.

  async function emailExists(email) { // AUDIT-FIX: P3-AUTH-SRP - cross-table email checks now delegate to the repository.
    return authRepo.emailExists(email); // AUDIT-FIX: P3-AUTH-DIP - remove direct SQL from the service layer.
  } // AUDIT-FIX: P3-AUTH-SRP - email-exists behavior remains unchanged.

  async function createPatient(data) { // AUDIT-FIX: P3-AUTH-SRP - patient registration now delegates persistence to the repository.
    return authRepo.createPatient(data); // AUDIT-FIX: P3-AUTH-DIP - remove direct SQL from the service layer.
  } // AUDIT-FIX: P3-AUTH-SRP - patient registration behavior remains unchanged.

  async function getRefreshToken(token) { // AUDIT-FIX: P3-AUTH-SRP - refresh-token lookup now delegates to the repository.
    return authRepo.findRefreshToken(token); // AUDIT-FIX: P3-AUTH-DIP - remove direct SQL from the service layer.
  } // AUDIT-FIX: P3-AUTH-SRP - refresh lookup behavior remains unchanged.

  async function revokeTokenById(id) { // AUDIT-FIX: P3-AUTH-SRP - refresh-token revocation now delegates to the repository.
    await authRepo.revokeTokenById(id); // AUDIT-FIX: P3-AUTH-DIP - remove direct SQL from the service layer.
  } // AUDIT-FIX: P3-AUTH-SRP - revoke-by-id behavior remains unchanged.

  async function revokeAllUserTokens(userId, role) { // AUDIT-FIX: P3-AUTH-SRP - bulk session revocation now delegates to the repository.
    await authRepo.revokeAllUserTokens(userId, role); // AUDIT-FIX: P3-AUTH-DIP - remove direct SQL from the service layer.
  } // AUDIT-FIX: P3-AUTH-SRP - bulk revoke behavior remains unchanged.

  async function revokeTokenByValue({ token, userId, role }) { // AUDIT-FIX: P3-AUTH-SRP - scoped token revocation now delegates to the repository.
    return authRepo.revokeTokenByValue({ token, userId, role }); // AUDIT-FIX: P3-AUTH-DIP - remove direct SQL from the service layer.
  } // AUDIT-FIX: P3-AUTH-SRP - scoped revoke behavior remains unchanged.

  async function getUserById(id, role) { // AUDIT-FIX: P3-AUTH-SRP - profile lookups now delegate to the repository.
    return authRepo.findUserById(id, role); // AUDIT-FIX: P3-AUTH-DIP - remove direct SQL from the service layer.
  } // AUDIT-FIX: P3-AUTH-SRP - profile lookup behavior remains unchanged.

  async function changeAdminPassword({ adminId, currentPassword, newPassword }) { // AUDIT-FIX: P3-AUTH-SRP - admin password changes now orchestrate repository operations.
    const admin = await authRepo.findPasswordRowById(adminId, 'ADMIN'); // AUDIT-FIX: P3-AUTH-DIP - password verification reads now use the repository.
    if (!admin) { // AUDIT-FIX: P3-AUTH-SRP - preserve the current not-found contract.
      return { notFound: true }; // AUDIT-FIX: P3-AUTH-COMPAT - preserve the current result shape.
    } // AUDIT-FIX: P3-AUTH-SRP - short-circuit when the admin record is missing.

    const passwordMatches = await bcrypt.compare(currentPassword, admin.password); // AUDIT-FIX: P3-AUTH-SRP - password validation stays in the service layer.
    if (!passwordMatches) { // AUDIT-FIX: P3-AUTH-SRP - preserve the current invalid-password contract.
      return { invalidCurrentPassword: true }; // AUDIT-FIX: P3-AUTH-COMPAT - preserve the current result shape.
    } // AUDIT-FIX: P3-AUTH-SRP - short-circuit when the current password is wrong.

    const hashedPassword = await bcrypt.hash(newPassword, 12); // AUDIT-FIX: P3-AUTH-SRP - password hashing remains in the service layer.
    await authRepo.withTransaction(async (client) => { // AUDIT-FIX: P3-AUTH-DIP - password-change transactions now use the repository transaction wrapper.
      await authRepo.updatePassword(adminId, 'ADMIN', hashedPassword, client); // AUDIT-FIX: P3-AUTH-DIP - password writes now go through the repository.
      await authRepo.deleteRefreshTokensForUser(adminId, 'ADMIN', client); // AUDIT-FIX: P3-AUTH-DIP - refresh-token cleanup now goes through the repository.
    }); // AUDIT-FIX: P3-AUTH-DIP - repository transaction wrapper now handles commit/rollback/release.

    return { success: true }; // AUDIT-FIX: P3-AUTH-COMPAT - preserve the current success result shape.
  } // AUDIT-FIX: P3-AUTH-SRP - admin password changes keep the same observable behavior.

  async function changeUserPassword({ userId, role, currentPassword, newPassword }) { // AUDIT-FIX: P3-AUTH-SRP - user password changes now orchestrate repository operations.
    if (!getPasswordTableByRole(role)) { // AUDIT-FIX: P3-AUTH-COMPAT - preserve the current unsupported-role contract.
      return { notFound: true }; // AUDIT-FIX: P3-AUTH-COMPAT - preserve the current result shape.
    } // AUDIT-FIX: P3-AUTH-SRP - short-circuit unsupported roles before any repository work.

    const user = await authRepo.findPasswordRowById(userId, role); // AUDIT-FIX: P3-AUTH-DIP - password verification reads now use the repository.
    if (!user) { // AUDIT-FIX: P3-AUTH-SRP - preserve the current not-found contract.
      return { notFound: true }; // AUDIT-FIX: P3-AUTH-COMPAT - preserve the current result shape.
    } // AUDIT-FIX: P3-AUTH-SRP - short-circuit when the user record is missing.

    const passwordMatches = await bcrypt.compare(currentPassword, user.password); // AUDIT-FIX: P3-AUTH-SRP - password validation stays in the service layer.
    if (!passwordMatches) { // AUDIT-FIX: P3-AUTH-SRP - preserve the current invalid-password contract.
      return { invalidCurrentPassword: true }; // AUDIT-FIX: P3-AUTH-COMPAT - preserve the current result shape.
    } // AUDIT-FIX: P3-AUTH-SRP - short-circuit when the current password is wrong.

    const hashedPassword = await bcrypt.hash(newPassword, 12); // AUDIT-FIX: P3-AUTH-SRP - password hashing remains in the service layer.
    await authRepo.withTransaction(async (client) => { // AUDIT-FIX: P3-AUTH-DIP - password-change transactions now use the repository transaction wrapper.
      await authRepo.updatePassword(userId, role, hashedPassword, client); // AUDIT-FIX: P3-AUTH-DIP - password writes now go through the repository.
      await authRepo.deleteRefreshTokensForUser(userId, role, client); // AUDIT-FIX: P3-AUTH-DIP - refresh-token cleanup now goes through the repository.
    }); // AUDIT-FIX: P3-AUTH-DIP - repository transaction wrapper now handles commit/rollback/release.

    return { success: true }; // AUDIT-FIX: P3-AUTH-COMPAT - preserve the current success result shape.
  } // AUDIT-FIX: P3-AUTH-SRP - user password changes keep the same observable behavior.

  return { // AUDIT-FIX: P3-AUTH-COMPAT - preserve the current auth-service public surface.
    roleConfig, // AUDIT-FIX: P3-AUTH-COMPAT - keep roleConfig available to existing callers.
    getUserByEmail, // AUDIT-FIX: P3-AUTH-COMPAT - preserve the current method export.
    emailExists, // AUDIT-FIX: P3-AUTH-COMPAT - preserve the current method export.
    createPatient, // AUDIT-FIX: P3-AUTH-COMPAT - preserve the current method export.
    getRefreshToken, // AUDIT-FIX: P3-AUTH-COMPAT - preserve the current method export.
    revokeTokenById, // AUDIT-FIX: P3-AUTH-COMPAT - preserve the current method export.
    revokeAllUserTokens, // AUDIT-FIX: P3-AUTH-COMPAT - preserve the current method export.
    revokeTokenByValue, // AUDIT-FIX: P3-AUTH-COMPAT - preserve the current method export.
    getUserById, // AUDIT-FIX: P3-AUTH-COMPAT - preserve the current method export.
    changeAdminPassword, // AUDIT-FIX: P3-AUTH-COMPAT - preserve the current method export.
    changeUserPassword, // AUDIT-FIX: P3-AUTH-COMPAT - preserve the current method export.
  }; // AUDIT-FIX: P3-AUTH-COMPAT - default auth-service API stays unchanged.
} // AUDIT-FIX: P3-AUTH-DIP - factory pattern enables repository injection for tests and composition.

function getConfiguredAuthService() { // AUDIT-FIX: P3-STEP8-DIP - default auth-service calls now resolve through explicit composition state.
  if (!configuredAuthService) { // AUDIT-FIX: P3-STEP8-DIP - fail fast when routes have not wired the auth service yet.
    throw new Error('Auth service has not been configured. Configure it at the composition root first.'); // AUDIT-FIX: P3-STEP8-DIP - make missing composition explicit instead of silently requiring config/db here.
  } // AUDIT-FIX: P3-STEP8-DIP - prevent undefined method access on an unconfigured singleton.
  return configuredAuthService; // AUDIT-FIX: P3-STEP8-DIP - reuse the configured singleton for backward-compatible method exports.
} // AUDIT-FIX: P3-STEP8-DIP - singleton resolution is centralized for the proxy export surface.

function configureAuthService(authRepo) { // AUDIT-FIX: P3-STEP8-DIP - composition roots now inject the auth repository explicitly.
  configuredAuthService = createAuthService(authRepo); // AUDIT-FIX: P3-STEP8-DIP - persist the externally composed auth service singleton.
  return configuredAuthService; // AUDIT-FIX: P3-STEP8-DIP - allow routes to reuse the configured instance immediately if needed.
} // AUDIT-FIX: P3-STEP8-DIP - auth service no longer owns its own pool-backed construction.

class AuthService { // AUDIT-FIX: P3-AUTH-COMPAT - expose a class wrapper for class-oriented callers.
  constructor(authRepo = null) { // AUDIT-FIX: P3-STEP8-DIP - class callers now receive explicit composition instead of an internal pool default.
    Object.assign(this, authRepo ? createAuthService(authRepo) : getConfiguredAuthService()); // AUDIT-FIX: P3-STEP8-DIP - preserve class-style usage through the configured singleton when no repo is passed.
  } // AUDIT-FIX: P3-AUTH-COMPAT - class construction preserves the current method set.
} // AUDIT-FIX: P3-AUTH-COMPAT - class wrapper preserves backward-compatible construction semantics.

module.exports = { // AUDIT-FIX: P3-AUTH-COMPAT - preserve the current object export shape while adding factory/class exports.
  roleConfig, // AUDIT-FIX: P3-STEP8-COMPAT - keep the legacy helper available even before singleton configuration.
  getUserByEmail: (...args) => getConfiguredAuthService().getUserByEmail(...args), // AUDIT-FIX: P3-STEP8-COMPAT - preserve the existing method name while delegating through configured composition.
  emailExists: (...args) => getConfiguredAuthService().emailExists(...args), // AUDIT-FIX: P3-STEP8-COMPAT - preserve the existing method name while delegating through configured composition.
  createPatient: (...args) => getConfiguredAuthService().createPatient(...args), // AUDIT-FIX: P3-STEP8-COMPAT - preserve the existing method name while delegating through configured composition.
  getRefreshToken: (...args) => getConfiguredAuthService().getRefreshToken(...args), // AUDIT-FIX: P3-STEP8-COMPAT - preserve the existing method name while delegating through configured composition.
  revokeTokenById: (...args) => getConfiguredAuthService().revokeTokenById(...args), // AUDIT-FIX: P3-STEP8-COMPAT - preserve the existing method name while delegating through configured composition.
  revokeAllUserTokens: (...args) => getConfiguredAuthService().revokeAllUserTokens(...args), // AUDIT-FIX: P3-STEP8-COMPAT - preserve the existing method name while delegating through configured composition.
  revokeTokenByValue: (...args) => getConfiguredAuthService().revokeTokenByValue(...args), // AUDIT-FIX: P3-STEP8-COMPAT - preserve the existing method name while delegating through configured composition.
  getUserById: (...args) => getConfiguredAuthService().getUserById(...args), // AUDIT-FIX: P3-STEP8-COMPAT - preserve the existing method name while delegating through configured composition.
  changeAdminPassword: (...args) => getConfiguredAuthService().changeAdminPassword(...args), // AUDIT-FIX: P3-STEP8-COMPAT - preserve the existing method name while delegating through configured composition.
  changeUserPassword: (...args) => getConfiguredAuthService().changeUserPassword(...args), // AUDIT-FIX: P3-STEP8-COMPAT - preserve the existing method name while delegating through configured composition.
  createAuthService, // AUDIT-FIX: P3-AUTH-COMPAT - expose the factory for explicit composition.
  configureAuthService, // AUDIT-FIX: P3-STEP8-DIP - expose explicit singleton wiring for route-level composition roots.
  AuthService, // AUDIT-FIX: P3-AUTH-COMPAT - expose the class wrapper for class-oriented callers.
}; // AUDIT-FIX: P3-AUTH-COMPAT - auth-service export surface remains backward compatible.
