const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  generateAccessToken,
  generateRefreshToken,
  saveRefreshToken,
} = require('../../middlewares/auth');
const { audit } = require('../../utils/logger');
const authService = require('./auth.service');

const refreshCookieBaseOptions = { // FIX: F13 — define one secure cookie configuration for every refresh-token response.
  httpOnly: true, // FIX: F13 — prevent JavaScript from reading the long-lived refresh token.
  secure: process.env.NODE_ENV === 'production', // FIX: F13 — only require HTTPS for refresh cookies in production.
  sameSite: 'strict', // FIX: F13 — keep refresh-token cookies constrained to same-site requests.
  path: '/api/v1/auth', // FIX: F13 — send the refresh cookie only to auth endpoints.
}; // FIX: F13 — reuse the same base options when setting and clearing the refresh-token cookie.

const refreshCookieOptions = { // FIX: F13 — attach the backend refresh-token lifetime to the cookie itself.
  ...refreshCookieBaseOptions, // FIX: F13 — preserve the secure cookie defaults for issued refresh tokens.
  maxAge: 30 * 24 * 60 * 60 * 1000, // FIX: F13 — keep the refresh cookie alive for the same 30-day window as the token.
}; // FIX: F13 — keep refresh cookie settings centralized for login, register, and refresh responses.

const REFRESH_COOKIE_NAMES = {
  ADMIN: 'refresh_token_admin',
  PROVIDER: 'refresh_token_provider',
  PATIENT: 'refresh_token_patient',
};

function normalizeAuthRole(value) {
  const normalizedRole = String(value || '').trim().toUpperCase();
  return REFRESH_COOKIE_NAMES[normalizedRole] ? normalizedRole : null;
}

function getRefreshCookieName(role) {
  const normalizedRole = normalizeAuthRole(role);
  return normalizedRole ? REFRESH_COOKIE_NAMES[normalizedRole] : 'refresh_token';
}

function setRefreshCookie(res, role, token) {
  res.cookie(getRefreshCookieName(role), token, refreshCookieOptions);
  res.clearCookie('refresh_token', refreshCookieBaseOptions);
}

function clearRefreshCookies(res, role) {
  const normalizedRole = normalizeAuthRole(role);
  if (normalizedRole) {
    res.clearCookie(getRefreshCookieName(normalizedRole), refreshCookieBaseOptions);
  }

  res.clearCookie('refresh_token', refreshCookieBaseOptions);
}

function readRefreshCookie(req, role) {
  const normalizedRole = normalizeAuthRole(role || req.headers['x-auth-role']);
  if (normalizedRole) {
    return req.cookies?.[getRefreshCookieName(normalizedRole)] || req.cookies?.refresh_token || null;
  }

  if (req.cookies?.refresh_token) {
    return req.cookies.refresh_token;
  }

  const roleScopedTokens = Object.values(REFRESH_COOKIE_NAMES)
    .map((cookieName) => req.cookies?.[cookieName])
    .filter(Boolean);

  return roleScopedTokens.length === 1 ? roleScopedTokens[0] : null;
}

async function login(req, res) {
  const { email, password, role } = req.body;
  const user = await authService.getUserByEmail(email, role);

  if (!user || !(await bcrypt.compare(password, user.password))) {
    audit('LOGIN_FAILED', { role, ip: req.ip, details: `email:${email}` });
    return res.status(401).json({ message: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
  }

  if (role === 'PROVIDER' && user.is_available === false) {
    return res.status(403).json({ message: 'Provider account is currently unavailable', code: 'PROVIDER_UNAVAILABLE' });
  }

  const payload = { id: user.id, email: user.email, role };
  const access_token = generateAccessToken(payload);
  const refresh_token = generateRefreshToken(payload);
  await saveRefreshToken(user.id, role, refresh_token);

  audit('LOGIN_SUCCESS', { userId: user.id, role, ip: req.ip });
  setRefreshCookie(res, role, refresh_token); // FIX: F15 — scope refresh cookies by role so admin/provider/patient sessions do not overwrite each other.

  const responseUser = { ...payload, full_name: user.full_name };
  if (role === 'PROVIDER') {
    responseUser.type = user.type;
    responseUser.is_available = user.is_available;
    responseUser.phone = user.phone ?? null;
    responseUser.avatar_url = user.avatar_url ?? null;
  }
  if (role === 'PATIENT') {
    responseUser.phone = user.phone ?? null;
    responseUser.secondary_phone = user.secondary_phone ?? null;
    responseUser.address = user.address ?? null;
    responseUser.date_of_birth = user.date_of_birth ?? null;
    responseUser.gender = user.gender ?? null;
    responseUser.is_vip = user.is_vip;
    responseUser.vip_discount = user.vip_discount;
    responseUser.total_points = user.total_points;
  }

  return res.json({
    message: 'Login successful',
    access_token,
    token_type: 'Bearer',
    expires_in: process.env.JWT_EXPIRES_IN || '5m',
    user: responseUser,
  });
}

async function register(req, res) {
  const {
    full_name,
    email,
    password,
    phone,
    secondary_phone,
    address,
    date_of_birth,
    gender,
  } = req.body;

  if (await authService.emailExists(email)) {
    return res.status(409).json({ message: 'Email already exists', code: 'EMAIL_EXISTS' });
  }

  const hashedPassword = await bcrypt.hash(password, 12);
  const patient = await authService.createPatient({
    full_name,
    email,
    password: hashedPassword,
    phone,
    secondary_phone,
    address,
    date_of_birth,
    gender,
  });

  const payload = { id: patient.id, email: patient.email, role: 'PATIENT' };
  const access_token = generateAccessToken(payload);
  const refresh_token = generateRefreshToken(payload);
  await saveRefreshToken(patient.id, 'PATIENT', refresh_token);

  audit('PATIENT_REGISTERED', { userId: patient.id, role: 'PATIENT', ip: req.ip });
  setRefreshCookie(res, 'PATIENT', refresh_token); // FIX: F15 — keep patient refresh state isolated from admin/provider browser sessions.
  const responseUser = { ...payload, full_name: patient.full_name, phone: patient.phone ?? null, secondary_phone: patient.secondary_phone ?? null, address: patient.address ?? null, date_of_birth: patient.date_of_birth ?? null, gender: patient.gender ?? null, is_vip: patient.is_vip, total_points: patient.total_points }; // FIX: F13 — preserve the patient auth payload while removing refresh_token from the JSON body.

  return res.status(201).json({
    message: 'Patient registered successfully',
    access_token,
    token_type: 'Bearer',
    expires_in: process.env.JWT_EXPIRES_IN || '5m',
    user: responseUser,
  });
}

async function refresh(req, res) {
  const requestedRole = normalizeAuthRole(req.headers['x-auth-role']);
  const refresh_token = readRefreshCookie(req); // FIX: F15 — prefer the caller's role-scoped refresh cookie and only fall back to the legacy shared cookie.
  if (!refresh_token) { // FIX: F13 — fail fast when the refresh cookie is missing.
    return res.status(401).json({ message: 'Refresh token missing', code: 'NO_TOKEN' }); // FIX: F13 — keep refresh failures explicit for frontend auth recovery.
  }

  let decoded;
  try {
    decoded = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET);
  } catch (_) {
    return res.status(401).json({ message: 'Invalid refresh token', code: 'INVALID_REFRESH_TOKEN' });
  }

  if (requestedRole && decoded.role !== requestedRole) {
    clearRefreshCookies(res, requestedRole);
    return res.status(401).json({ message: 'Refresh token role mismatch', code: 'REFRESH_TOKEN_ROLE_MISMATCH' });
  }

  const tokenRow = await authService.getRefreshToken(refresh_token);
  if (!tokenRow) {
    return res.status(401).json({ message: 'Refresh token not found', code: 'REFRESH_TOKEN_NOT_FOUND' });
  }

  if (tokenRow.revoked_at) {
    audit('REFRESH_TOKEN_REUSE_DETECTED', { userId: tokenRow.user_id, role: tokenRow.role, ip: req.ip });
    await authService.revokeAllUserTokens(tokenRow.user_id, tokenRow.role);
    return res.status(401).json({
      message: 'Token reuse detected. All sessions have been revoked.',
      code: 'TOKEN_REUSE_DETECTED',
    });
  }

  if (new Date(tokenRow.expires_at) <= new Date()) {
    return res.status(401).json({ message: 'Refresh token expired', code: 'REFRESH_TOKEN_EXPIRED' });
  }

  if (tokenRow.user_id !== decoded.id || tokenRow.role !== decoded.role) {
    return res.status(401).json({ message: 'Refresh token mismatch', code: 'REFRESH_TOKEN_MISMATCH' });
  }

  await authService.revokeTokenById(tokenRow.id);

  const payload = { id: decoded.id, email: decoded.email, role: decoded.role };
  const access_token = generateAccessToken(payload);
  const new_refresh_token = generateRefreshToken(payload);
  await saveRefreshToken(decoded.id, decoded.role, new_refresh_token);
  setRefreshCookie(res, decoded.role, new_refresh_token); // FIX: F15 — rotate the same role-scoped refresh cookie after each refresh.

  return res.json({
    message: 'Token refreshed successfully',
    access_token,
    token_type: 'Bearer',
    expires_in: process.env.JWT_EXPIRES_IN || '5m',
  });
}

async function logout(req, res) {
  const refresh_token = readRefreshCookie(req, req.user.role); // FIX: F15 — revoke the refresh token that belongs to the authenticated role session.
  if (refresh_token) { // FIX: F13 — only attempt token revocation when a refresh cookie is present.
    await authService.revokeTokenByValue({ // FIX: F13 — revoke the cookie-backed refresh token for the current session.
      token: refresh_token, // FIX: F13 — revoke the exact refresh token stored in the auth cookie.
      userId: req.user.id, // FIX: F13 — scope logout token revocation to the authenticated user.
      role: req.user.role, // FIX: F13 — scope logout token revocation to the authenticated role.
    });
  }

  audit('LOGOUT', { userId: req.user.id, role: req.user.role, ip: req.ip });

  // AUDIT-FIX: S4 — blacklist the current access token on logout
  if (req.user.jti && req.user.exp) {
    const { blacklistToken } = require('../../utils/cache');
    const remainingSeconds = req.user.exp - Math.floor(Date.now() / 1000);
    if (remainingSeconds > 0) await blacklistToken(req.user.jti, remainingSeconds);
  }

  clearRefreshCookies(res, req.user.role); // FIX: F15 — clear only this role's scoped cookie plus the legacy shared cookie.

  return res.json({ message: 'Logged out successfully' });
}

async function logoutAll(req, res) {
  await authService.revokeAllUserTokens(req.user.id, req.user.role);
  audit('LOGOUT_ALL', { userId: req.user.id, role: req.user.role, ip: req.ip });
  clearRefreshCookies(res, req.user.role); // FIX: F15 — clear this role's scoped cookie while leaving other app sessions intact.

  // AUDIT-FIX: S4 — blacklist the current access token on logout-all
  if (req.user.jti && req.user.exp) {
    const { blacklistToken } = require('../../utils/cache');
    const remainingSeconds = req.user.exp - Math.floor(Date.now() / 1000);
    if (remainingSeconds > 0) await blacklistToken(req.user.jti, remainingSeconds);
  }

  return res.json({ message: 'All sessions have been revoked successfully' });
}

async function me(req, res) {
  const user = await authService.getUserById(req.user.id, req.user.role);
  if (!user) {
    return res.status(404).json({ message: 'User not found', code: 'USER_NOT_FOUND' });
  }
  return res.json(user);
}

async function changePassword(req, res) {
  const { current_password, new_password } = req.body;
  const result = await authService.changeUserPassword({
    userId: req.user.id,
    role: req.user.role,
    currentPassword: current_password,
    newPassword: new_password,
  });

  if (result.notFound) {
    return res.status(404).json({ message: 'User not found', code: 'USER_NOT_FOUND' });
  }

  if (result.invalidCurrentPassword) {
    return res.status(403).json({ message: 'Current password is incorrect', code: 'INVALID_CURRENT_PASSWORD' });
  }

  audit('PASSWORD_CHANGED', {
    userId: req.user.id,
    role: req.user.role,
    ip: req.ip,
  });

  // AUDIT-FIX: S4 — blacklist the current access token immediately
  // so the old token cannot be used for the remaining expiry window
  if (req.user.jti && req.user.exp) {
    const { blacklistToken } = require('../../utils/cache');
    const remainingSeconds = req.user.exp - Math.floor(Date.now() / 1000);
    if (remainingSeconds > 0) {
      await blacklistToken(req.user.jti, remainingSeconds);
    }
  }

  return res.json({ message: 'Password changed successfully' });
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
