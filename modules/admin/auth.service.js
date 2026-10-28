const bcrypt = require('bcryptjs');
const pool = require('../../config/db');
const AuthRepository = require('../../repositories/AuthRepository');
const { generateAccessToken, generateRefreshToken, REFRESH_TOKEN_TTL_DAYS } = require('../../middlewares/auth');

const authRepo = new AuthRepository(pool);

// Compared against when the email is unknown, so response time does not reveal which emails exist.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('timing-equaliser-not-a-password', 12);

/** True when the account may hold a session (not deleted, providers not disabled). */
function isAccountUsable(user, role) {
  if (!user) return false;
  if (user.deleted_at) return false;
  if (role === 'PROVIDER' && user.is_active === false) return false;
  return true;
}

async function verifyCredentials(email, password, role) {
  const user = await authRepo.findUserByEmail(email, role);
  const passwordOk = await bcrypt.compare(password, user?.password || DUMMY_PASSWORD_HASH);
  if (!user || !passwordOk) return { user: null };
  return { user };
}

/** Issues an access token and a stored, rotating refresh token. */
async function issueSession(user, role) {
  const payload = { id: user.id, email: user.email, role };
  const accessToken = generateAccessToken(payload);
  const refreshToken = generateRefreshToken(payload);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  await authRepo.saveRefreshToken(user.id, role, refreshToken, expiresAt);
  return { accessToken, refreshToken };
}

async function changeUserPassword({ userId, role, currentPassword, newPassword }) {
  const user = await authRepo.findPasswordRowById(userId, role);
  if (!user) return { notFound: true };
  if (!(await bcrypt.compare(currentPassword, user.password))) return { invalidCurrentPassword: true };

  const hashedPassword = await bcrypt.hash(newPassword, 12);
  await authRepo.withTransaction(async (client) => {
    await authRepo.updatePassword(userId, role, hashedPassword, client);
    await authRepo.revokeAllUserTokens(userId, role, client);
  });
  return { success: true };
}

module.exports = {
  authRepo,
  isAccountUsable,
  verifyCredentials,
  issueSession,
  changeUserPassword,
};
