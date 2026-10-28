const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { audit } = require('../utils/logger');
const { isTokenBlacklisted } = require('../utils/cache');

// Fail fast when secrets are missing or reused: the app must never sign tokens with a weak key.
if (!process.env.JWT_SECRET || !process.env.JWT_REFRESH_SECRET) {
  throw new Error('FATAL: JWT_SECRET and JWT_REFRESH_SECRET environment variables must be set.');
}
if (process.env.JWT_SECRET === process.env.JWT_REFRESH_SECRET) {
  throw new Error('FATAL: JWT_SECRET and JWT_REFRESH_SECRET must be different.');
}

const ACCESS_TOKEN_TTL = process.env.JWT_EXPIRES_IN || '5m';
const REFRESH_TOKEN_TTL_DAYS = 30;

const generateAccessToken = (payload) => jwt.sign(
  { ...payload, jti: randomUUID() },
  process.env.JWT_SECRET,
  { expiresIn: ACCESS_TOKEN_TTL }
);

const generateRefreshToken = (payload) => jwt.sign(
  { ...payload, jti: randomUUID() },
  process.env.JWT_REFRESH_SECRET,
  { expiresIn: `${REFRESH_TOKEN_TTL_DAYS}d` }
);

/** Verifies a bearer token and rejects blacklisted ones. Returns the payload or throws. */
async function verifyAccessToken(token) {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  if (decoded.jti && await isTokenBlacklisted(decoded.jti)) {
    const error = new Error('Token revoked');
    error.name = 'TokenRevokedError';
    throw error;
  }
  return decoded;
}

function readBearer(req) {
  const header = req.headers.authorization;
  return header && header.startsWith('Bearer ') ? header.slice(7) : null;
}

const authenticate = async (req, res, next) => {
  const token = readBearer(req);
  if (!token) return res.status(401).json({ message: 'No token provided', code: 'NO_TOKEN' });

  try {
    req.user = await verifyAccessToken(token);
    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    if (err.name === 'TokenRevokedError') {
      return res.status(401).json({ message: 'Token has been revoked. Please log in again.', code: 'TOKEN_REVOKED' });
    }
    return res.status(401).json({ message: 'Invalid token', code: 'INVALID_TOKEN' });
  }
};

/** Attaches req.user when a valid token is present, otherwise continues as a guest. */
const guestOrAuthenticated = async (req, res, next) => {
  const token = readBearer(req);
  req.user = null;
  if (!token) return next();
  try {
    req.user = await verifyAccessToken(token);
  } catch (_) {
    req.user = null;
  }
  return next();
};

function requireRole(...roles) {
  return (req, res, next) => {
    if (req.user && roles.includes(req.user.role)) return next();
    audit('FORBIDDEN_ACCESS', { userId: req.user?.id, role: req.user?.role, ip: req.ip, details: req.path });
    return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
  };
}

const adminOnly = requireRole('ADMIN');
const providerOnly = requireRole('PROVIDER');
const patientOnly = requireRole('PATIENT');
const staffOnly = requireRole('ADMIN', 'PROVIDER');

/** Admin, or the provider/patient whose id is in :id. */
const selfOrAdmin = (req, res, next) => {
  if (req.user.role === 'ADMIN') return next();
  if (['PROVIDER', 'PATIENT'].includes(req.user.role) && req.params.id === req.user.id) return next();
  return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
};

module.exports = {
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL_DAYS,
  authenticate,
  guestOrAuthenticated,
  requireRole,
  adminOnly,
  providerOnly,
  patientOnly,
  staffOnly,
  selfOrAdmin,
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
};
