const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { getClient } = require('../utils/cache');
const { logger } = require('../utils/logger');

const isDevelopment = process.env.NODE_ENV !== 'production';

function normalizeValue(value, fallback = 'unknown') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || fallback;
}

function normalizeRole(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized || 'UNKNOWN';
}

function getIpAddress(req) {
  const forwardedFor = req.headers?.['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function buildLimiterKey(...parts) {
  return parts
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(':');
}

const onLimitReached = (req, res, options) => {
  logger.warn('Rate limit exceeded', {
    ip: getIpAddress(req),
    path: req.path,
    method: req.method,
    userId: req.user?.id || 'guest',
  });
};

function createLimiter(opts) {
  const { prefix, ...rateLimitOpts } = opts;
  let limiter = null;
  let initPromise = null;

  async function init() {
    const client = await getClient();
    if (client) {
      limiter = rateLimit({
        ...rateLimitOpts,
        store: new RedisStore({
          prefix: `rl:${prefix}:`,
          sendCommand: (...args) => client.call(...args),
        }),
      });
    } else {
      logger.warn('Rate limiter using in-memory store (single-instance only)', { prefix });
      limiter = rateLimit(rateLimitOpts);
    }
  }

  return async (req, res, next) => {
    if (!limiter) {
      if (!initPromise) initPromise = init();
      await initPromise;
    }
    limiter(req, res, next);
  };
}

const loginLimiter = createLimiter({
  prefix: 'auth-login',
  windowMs: 15 * 60 * 1000,
  max: isDevelopment ? 200 : 5,
  keyGenerator: (req) =>
    buildLimiterKey(
      getIpAddress(req),
      normalizeRole(req.body?.role),
      normalizeValue(req.body?.email)
    ),
  message: { message: 'Too many attempts. Please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    onLimitReached(req, res, options);
    res.status(429).json(options.message);
  },
});

const registerLimiter = createLimiter({
  prefix: 'auth-register',
  windowMs: 15 * 60 * 1000,
  max: isDevelopment ? 200 : 5,
  keyGenerator: (req) =>
    buildLimiterKey(getIpAddress(req), normalizeValue(req.body?.email)),
  message: { message: 'Too many attempts. Please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    onLimitReached(req, res, options);
    res.status(429).json(options.message);
  },
});

const refreshLimiter = createLimiter({
  prefix: 'auth-refresh',
  windowMs: 15 * 60 * 1000,
  max: isDevelopment ? 500 : 30,
  keyGenerator: (req) =>
    buildLimiterKey(
      getIpAddress(req),
      normalizeRole(req.headers?.['x-auth-role'])
    ),
  message: { message: 'Too many attempts. Please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    onLimitReached(req, res, options);
    res.status(429).json(options.message);
  },
});

const logoutLimiter = createLimiter({
  prefix: 'auth-logout',
  windowMs: 15 * 60 * 1000,
  max: isDevelopment ? 500 : 30,
  keyGenerator: (req) =>
    buildLimiterKey(
      getIpAddress(req),
      normalizeRole(req.user?.role),
      normalizeValue(req.user?.id)
    ),
  message: { message: 'Too many attempts. Please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    onLimitReached(req, res, options);
    res.status(429).json(options.message);
  },
});

const accountActionLimiter = createLimiter({
  prefix: 'auth-account-action',
  windowMs: 15 * 60 * 1000,
  max: isDevelopment ? 200 : 10,
  keyGenerator: (req) =>
    buildLimiterKey(
      getIpAddress(req),
      normalizeRole(req.user?.role || req.body?.role),
      normalizeValue(req.user?.id || req.body?.email)
    ),
  message: { message: 'Too many attempts. Please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    onLimitReached(req, res, options);
    res.status(429).json(options.message);
  },
});

const apiLimiter = createLimiter({
  prefix: 'api',
  windowMs: 10 * 60 * 1000,
  max: isDevelopment ? 5000 : 100,
  message: { message: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    onLimitReached(req, res, options);
    res.status(429).json(options.message);
  },
});

const readLimiter = createLimiter({
  prefix: 'read',
  windowMs: 10 * 60 * 1000,
  max: isDevelopment ? 15000 : 300,
  message: { message: 'Too many requests.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const guestRequestLimiter = createLimiter({
  prefix: 'guest',
  windowMs: 60 * 60 * 1000,
  max: isDevelopment ? 300 : 10,
  message: { message: 'Too many requests from this IP. Try again in an hour.' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    onLimitReached(req, res, options);
    res.status(429).json(options.message);
  },
});

module.exports = {
  authLimiter: loginLimiter,
  loginLimiter,
  registerLimiter,
  refreshLimiter,
  logoutLimiter,
  accountActionLimiter,
  apiLimiter,
  readLimiter,
  guestRequestLimiter,
};
