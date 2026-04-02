const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const pool = require('../config/db');
const { audit } = require('../utils/logger');

// AUDIT-FIX: LOW — removed hardcoded fallback, app fails fast if misconfigured
if (!process.env.JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET environment variable is not set.');
}

const generateAccessToken = (payload) => {
  return jwt.sign(
    {
      ...payload,
      // AUDIT-FIX: S4 — jti (JWT ID) allows blacklisting specific tokens
      jti: randomUUID(),
    },
    process.env.JWT_SECRET,
    {
      // AUDIT-FIX: S4 — 5m expiry, backed by Redis blacklist for immediate revocation
      expiresIn: process.env.JWT_EXPIRES_IN || '5m',
    }
  );
};

const generateRefreshToken = (payload) => {
  return jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
    expiresIn: '30d',
  });
};

const saveRefreshToken = async (userId, role, token) => {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, role, token, expires_at)
     VALUES ($1, $2, $3, $4)
     -- AUDIT-FIX: S5 — refresh token reuse detection
     ON CONFLICT (token) DO UPDATE SET revoked_at = NOW()`,
    [userId, role, token, expiresAt]
  );
};

const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'No token provided', code: 'NO_TOKEN' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // AUDIT-FIX: S4 — check if this specific token has been blacklisted
    // Runs on every authenticated request — Redis O(1) lookup
    if (decoded.jti) {
      const { isTokenBlacklisted } = require('../utils/cache');
      const blacklisted = await isTokenBlacklisted(decoded.jti);
      if (blacklisted) {
        return res.status(401).json({
          message: 'Token has been revoked. Please log in again.',
          code: 'TOKEN_REVOKED',
        });
      }
    }

    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ message: 'Invalid token', code: 'INVALID_TOKEN' });
  }
};

const guestOrAuthenticated = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // AUDIT-FIX: S4 — check blacklist for guest-or-auth routes too
    if (decoded.jti) {
      const { isTokenBlacklisted } = require('../utils/cache');
      const blacklisted = await isTokenBlacklisted(decoded.jti);
      if (blacklisted) {
        return res.status(401).json({
          message: 'Token has been revoked. Please log in again.',
          code: 'TOKEN_REVOKED',
        });
      }
    }

    req.user = decoded;
    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ message: 'Invalid token', code: 'INVALID_TOKEN' });
  }
};

const adminOnly = (req, res, next) => {
  if (req.user.role !== 'ADMIN') {
    audit('FORBIDDEN_ACCESS', { userId: req.user.id, role: req.user.role, ip: req.ip, details: req.path });
    return res.status(403).json({ message: 'Admin access required', code: 'FORBIDDEN' });
  }
  next();
};

const staffOnly = (req, res, next) => {
  if (!['ADMIN', 'PROVIDER'].includes(req.user.role)) {
    audit('FORBIDDEN_ACCESS', { userId: req.user.id, role: req.user.role, ip: req.ip, details: req.path });
    return res.status(403).json({ message: 'Staff access required', code: 'FORBIDDEN' });
  }
  next();
};

const selfOrStaff = (req, res, next) => {
  const isStaff = ['ADMIN', 'PROVIDER'].includes(req.user.role);
  const isSelf = req.user.role === 'PATIENT' && req.user.id === req.params.id;
  if (!isStaff && !isSelf) {
    return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
  }
  next();
};

const selfOrAdmin = (req, res, next) => {
  if (req.user.role === 'ADMIN') return next();
  if (req.user.role === 'PROVIDER' && req.params.id === req.user.id) return next();
  if (req.user.role === 'PATIENT' && req.params.id === req.user.id) return next();
  return res.status(403).json({ message: 'Forbidden', code: 'FORBIDDEN' });
};

// Keep generateToken for backward compatibility
const generateToken = generateAccessToken;

module.exports = {
  authenticate, guestOrAuthenticated, adminOnly, staffOnly, selfOrStaff, selfOrAdmin,
  generateToken, generateAccessToken, generateRefreshToken, saveRefreshToken,
};
