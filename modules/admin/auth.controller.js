const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { audit } = require('../../utils/logger');
const { blacklistToken } = require('../../utils/cache');
const { toPublicMediaUrl } = require('../../utils/storage');
const { ACCESS_TOKEN_TTL, REFRESH_TOKEN_TTL_DAYS } = require('../../middlewares/auth');
const authService = require('./auth.service');

const { authRepo } = authService;

const refreshCookieBaseOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  path: '/api/v1/auth',
};

const refreshCookieOptions = {
  ...refreshCookieBaseOptions,
  maxAge: REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
};

// One cookie per role so admin / provider / patient sessions in the same browser stay separate.
const REFRESH_COOKIE_NAMES = {
  ADMIN: 'refresh_token_admin',
  PROVIDER: 'refresh_token_provider',
  PATIENT: 'refresh_token_patient',
};

function normalizeAuthRole(value) {
  const role = String(value || '').trim().toUpperCase();
  return REFRESH_COOKIE_NAMES[role] ? role : null;
}

function setRefreshCookie(res, role, token) {
  res.cookie(REFRESH_COOKIE_NAMES[role], token, refreshCookieOptions);
}

function clearRefreshCookie(res, role) {
  if (role) res.clearCookie(REFRESH_COOKIE_NAMES[role], refreshCookieBaseOptions);
}

/** The role comes from the X-Auth-Role header, so each frontend only ever touches its own cookie. */
function readRefreshCookie(req, role) {
  return role ? req.cookies?.[REFRESH_COOKIE_NAMES[role]] || null : null;
}

async function blacklistCurrentAccessToken(user) {
  if (!user?.jti || !user?.exp) return;
  const remainingSeconds = user.exp - Math.floor(Date.now() / 1000);
  if (remainingSeconds > 0) await blacklistToken(user.jti, remainingSeconds);
}

function presentUser(user, role) {
  const base = { id: user.id, email: user.email, role, full_name: user.full_name };
  if (role === 'PROVIDER') {
    return {
      ...base,
      type: user.type,
      is_active: user.is_active,
      is_available: user.is_available,
      phone: user.phone ?? null,
      avatar_url: toPublicMediaUrl(user.avatar_url),
    };
  }
  if (role === 'PATIENT') {
    return {
      ...base,
      phone: user.phone ?? null,
      secondary_phone: user.secondary_phone ?? null,
      address: user.address ?? null,
      area_id: user.area_id ?? null,
      date_of_birth: user.date_of_birth ?? null,
      gender: user.gender ?? null,
      is_vip: user.is_vip,
      vip_discount: user.vip_discount,
      avatar_url: toPublicMediaUrl(user.avatar_url),
    };
  }
  return base;
}

function sessionResponse(res, { message, accessToken, user, role, status = 200 }) {
  return res.status(status).json({
    message,
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL,
    user: presentUser(user, role),
  });
}

async function login(req, res) {
  const { email, password, role } = req.body;
  const { user } = await authService.verifyCredentials(email, password, role);

  if (!user || !authService.isAccountUsable(user, role)) {
    audit('LOGIN_FAILED', { role, ip: req.ip, details: `email:${email}` });
    // Same answer for unknown email, wrong password, deleted or disabled account.
    return res.status(401).json({ message: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
  }

  const { accessToken, refreshToken } = await authService.issueSession(user, role);
  setRefreshCookie(res, role, refreshToken);
  audit('LOGIN_SUCCESS', { userId: user.id, role, ip: req.ip });

  return sessionResponse(res, { message: 'Login successful', accessToken, user, role });
}

async function register(req, res) {
  const { password, ...profile } = req.body;

  if (await authRepo.emailExists(profile.email)) {
    return res.status(409).json({ message: 'An account with this email already exists', code: 'EMAIL_EXISTS' });
  }

  const patient = await authRepo.createPatient({ ...profile, password: await bcrypt.hash(password, 12) });
  const { accessToken, refreshToken } = await authService.issueSession(patient, 'PATIENT');
  setRefreshCookie(res, 'PATIENT', refreshToken);
  audit('PATIENT_REGISTERED', { userId: patient.id, role: 'PATIENT', ip: req.ip });

  return sessionResponse(res, {
    message: 'Patient registered successfully',
    accessToken,
    user: patient,
    role: 'PATIENT',
    status: 201,
  });
}

async function refresh(req, res) {
  const role = normalizeAuthRole(req.headers?.['x-auth-role']);
  if (!role) {
    return res.status(400).json({ message: 'X-Auth-Role header is required', code: 'ROLE_REQUIRED' });
  }

  const refreshToken = readRefreshCookie(req, role);
  if (!refreshToken) {
    return res.status(401).json({ message: 'Refresh token missing', code: 'NO_TOKEN' });
  }

  let decoded;
  try {
    decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
  } catch (_) {
    clearRefreshCookie(res, role);
    return res.status(401).json({ message: 'Invalid refresh token', code: 'INVALID_REFRESH_TOKEN' });
  }

  const tokenRow = await authRepo.findRefreshToken(refreshToken);
  if (!tokenRow || tokenRow.user_id !== decoded.id || tokenRow.role !== role || decoded.role !== role) {
    clearRefreshCookie(res, role);
    return res.status(401).json({ message: 'Invalid refresh token', code: 'INVALID_REFRESH_TOKEN' });
  }

  // Checked before reuse detection: disabling an account revokes its tokens, and the client
  // should be told the account is inactive rather than that a token was reused.
  const user = await authRepo.findUserById(decoded.id, role);
  if (!authService.isAccountUsable(user, role)) {
    await authRepo.revokeAllUserTokens(decoded.id, role);
    clearRefreshCookie(res, role);
    return res.status(401).json({ message: 'Account is no longer active', code: 'ACCOUNT_INACTIVE' });
  }

  if (tokenRow.revoked_at) {
    audit('REFRESH_TOKEN_REUSE_DETECTED', { userId: tokenRow.user_id, role, ip: req.ip });
    await authRepo.revokeAllUserTokens(tokenRow.user_id, role);
    clearRefreshCookie(res, role);
    return res.status(401).json({
      message: 'Token reuse detected. All sessions have been revoked.',
      code: 'TOKEN_REUSE_DETECTED',
    });
  }

  if (new Date(tokenRow.expires_at) <= new Date()) {
    clearRefreshCookie(res, role);
    return res.status(401).json({ message: 'Refresh token expired', code: 'REFRESH_TOKEN_EXPIRED' });
  }

  await authRepo.revokeTokenById(tokenRow.id);
  const session = await authService.issueSession(user, role);
  setRefreshCookie(res, role, session.refreshToken);

  return res.json({
    message: 'Token refreshed successfully',
    access_token: session.accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL,
  });
}

/** Works with or without a valid access token so an expired session can still be ended cleanly. */
async function logout(req, res) {
  const role = req.user?.role || normalizeAuthRole(req.headers?.['x-auth-role']);
  const refreshToken = readRefreshCookie(req, role);
  if (refreshToken) await authRepo.revokeToken(refreshToken);

  await blacklistCurrentAccessToken(req.user);
  clearRefreshCookie(res, role);
  if (req.user) audit('LOGOUT', { userId: req.user.id, role: req.user.role, ip: req.ip });

  return res.json({ message: 'Logged out successfully' });
}

async function logoutAll(req, res) {
  await authRepo.revokeAllUserTokens(req.user.id, req.user.role);
  await blacklistCurrentAccessToken(req.user);
  clearRefreshCookie(res, req.user.role);
  audit('LOGOUT_ALL', { userId: req.user.id, role: req.user.role, ip: req.ip });
  return res.json({ message: 'All sessions have been revoked successfully' });
}

async function me(req, res) {
  const user = await authRepo.findUserById(req.user.id, req.user.role);
  if (!authService.isAccountUsable(user, req.user.role)) {
    return res.status(404).json({ message: 'User not found', code: 'USER_NOT_FOUND' });
  }
  return res.json(presentUser(user, req.user.role));
}

async function changePassword(req, res) {
  const result = await authService.changeUserPassword({
    userId: req.user.id,
    role: req.user.role,
    currentPassword: req.body.current_password,
    newPassword: req.body.new_password,
  });

  if (result.notFound) return res.status(404).json({ message: 'User not found', code: 'USER_NOT_FOUND' });
  if (result.invalidCurrentPassword) {
    return res.status(403).json({ message: 'Current password is incorrect', code: 'INVALID_CURRENT_PASSWORD' });
  }

  await blacklistCurrentAccessToken(req.user);
  clearRefreshCookie(res, req.user.role);
  audit('PASSWORD_CHANGED', { userId: req.user.id, role: req.user.role, ip: req.ip });
  return res.json({ message: 'Password changed successfully. Please log in again.' });
}

module.exports = {
  login,
  register,
  refresh,
  logout,
  logoutAll,
  me,
  changePassword,
};
