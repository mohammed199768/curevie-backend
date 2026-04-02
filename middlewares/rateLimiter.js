const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { getClient } = require('../utils/cache');
const { logger } = require('../utils/logger');

const isDevelopment = process.env.NODE_ENV !== 'production';

const onLimitReached = (req, res, options) => {
  logger.warn('Rate limit exceeded', {
    ip: req.ip,
    path: req.path,
    method: req.method,
    userId: req.user?.id || 'guest',
  });
};

// AUDIT-FIX: Rate limiter Redis store for multi-instance deployments
// Uses ioredis client from cache.js; sendCommand maps to ioredis .call()
// Lazy init: on first request, checks Redis availability and creates the
// appropriate store (Redis for multi-instance, in-memory as fallback)
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

// Strict: Login/Register — 5 attempts per 15 min
const authLimiter = createLimiter({
  prefix: 'auth',
  windowMs: 15 * 60 * 1000,
  max: isDevelopment ? 200 : 5,
  message: { message: 'Too many attempts. Please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res, next, options) => {
    onLimitReached(req, res, options);
    res.status(429).json(options.message);
  },
});

// Medium: General API — 100 requests per 10 min
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

// Relaxed: Read endpoints — 300 requests per 10 min
const readLimiter = createLimiter({
  prefix: 'read',
  windowMs: 10 * 60 * 1000,
  max: isDevelopment ? 15000 : 300,
  message: { message: 'Too many requests.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict: Guest requests — 10 per hour per IP
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

module.exports = { authLimiter, apiLimiter, readLimiter, guestRequestLimiter };
