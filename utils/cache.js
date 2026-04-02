const Redis = require('ioredis');
const { logger } = require('./logger');

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
let client = null;
let clientPromise = null;
let lastFailureAt = 0;

const REDIS_CONNECT_TIMEOUT_MS = 3000;
const REDIS_RETRY_COOLDOWN_MS = 3000;

function logRedisUnavailable(message) {
  logger.warn('Redis cache unavailable, continuing without cache', {
    message,
    redisUrl,
  });
}

function removeListener(redis, event, handler) {
  if (typeof redis.off === 'function') {
    redis.off(event, handler);
    return;
  }
  if (typeof redis.removeListener === 'function') {
    redis.removeListener(event, handler);
  }
}

function attachRuntimeListeners(redis) {
  if (typeof redis.on !== 'function') return;

  redis.on('error', (err) => {
    if (client !== redis) return;
    client = null;
    lastFailureAt = Date.now();
    logger.warn('Redis cache connection error; retrying on next request', {
      message: err?.message,
      redisUrl,
    });
  });

  redis.on('close', () => {
    if (client !== redis) return;
    client = null;
    lastFailureAt = Date.now();
    logger.warn('Redis cache connection closed; retrying on next request', { redisUrl });
  });
}

async function getClient() {
  if (client?.status === 'ready') return client;
  if (clientPromise) return clientPromise;

  if (lastFailureAt && (Date.now() - lastFailureAt) < REDIS_RETRY_COOLDOWN_MS) {
    return null;
  }

  clientPromise = new Promise((resolve) => {
    const redis = new Redis(redisUrl, {
      connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (times) => times > 2 ? null : 500,
    });

    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clientPromise = null;
      resolve(value);
    };

    const handleInitialFailure = (err) => {
      if (client === redis) client = null;
      lastFailureAt = Date.now();
      logRedisUnavailable(err?.message || 'connect failed');
      redis.disconnect();
      finish(null);
    };

    const timeout = setTimeout(() => {
      handleInitialFailure(new Error('connect timeout'));
    }, REDIS_CONNECT_TIMEOUT_MS);

    redis.once('ready', () => {
      removeListener(redis, 'error', handleInitialFailure);
      clearTimeout(timeout);
      client = redis;
      lastFailureAt = 0;
      attachRuntimeListeners(redis);
      logger.info('Redis cache connected', { redisUrl });
      finish(client);
    });

    redis.once('error', handleInitialFailure);
  });

  return clientPromise;
}

async function run(action, fallback = null) {
  const redis = await getClient();
  if (!redis) return fallback;
  try {
    return await action(redis);
  } catch (err) {
    logger.warn('Redis operation failed', { message: err?.message });
    return fallback;
  }
}

async function deleteByPattern(redis, pattern) {
  let cursor = '0';
  let deleted = 0;
  do {
    const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = result[0];
    const keys = result[1];
    if (keys.length) deleted += await redis.del(...keys);
  } while (cursor !== '0');
  return deleted;
}

async function get(key) {
  const value = await run((redis) => redis.get(key), null);
  if (!value) return null;
  try { return JSON.parse(value); } catch (_) { return value; }
}

async function set(key, value, ttl) {
  const payload = typeof value === 'string' ? value : JSON.stringify(value);
  await run((redis) => ttl ? redis.set(key, payload, 'EX', ttl) : redis.set(key, payload));
}

async function del(key) {
  if (Array.isArray(key)) {
    let total = 0;
    for (const item of key) total += await del(item);
    return total;
  }
  if (typeof key === 'string' && key.includes('*')) {
    return run((redis) => deleteByPattern(redis, key), 0);
  }
  return run((redis) => redis.del(key), 0);
}

async function flush() {
  return run((redis) => redis.flushdb());
}

async function ping() {
  return run((redis) => redis.ping(), null);
}

// AUDIT-FIX: S4 — token blacklist using Redis
// Key: blacklist:jti:{jti}, Value: '1', TTL: remaining token lifetime
const TOKEN_BLACKLIST_PREFIX = 'blacklist:jti:';

// AUDIT-FIX: S4 — add a token's jti to the blacklist with TTL
async function blacklistToken(jti, expiresInSeconds) {
  if (!jti || !expiresInSeconds || expiresInSeconds <= 0) return;
  const redis = await getClient();
  if (!redis) {
    // AUDIT-FIX: S4 — if Redis is down, log but don't throw from blacklist write
    // The token will still expire naturally within 5 minutes
    logger.error('Redis unavailable for blacklist write', { jti });
    return;
  }
  // AUDIT-FIX: S4 — set with TTL so blacklist self-cleans after token expiry
  await redis.set(`${TOKEN_BLACKLIST_PREFIX}${jti}`, '1', 'EX', expiresInSeconds);
}

// AUDIT-FIX: S4 — check if a token's jti is blacklisted
async function isTokenBlacklisted(jti) {
  if (!jti) return false;
  const redis = await getClient();
  if (!redis) {
    // AUDIT-FIX: S4 — Redis down = fail secure = treat as blacklisted
    // Medical data demands fail-secure behavior
    logger.error('Redis unavailable for blacklist check — failing secure', { jti });
    return true;
  }
  try {
    const result = await redis.get(`${TOKEN_BLACKLIST_PREFIX}${jti}`);
    return result === '1';
  } catch (err) {
    // AUDIT-FIX: S4 — Redis error = fail secure
    logger.error('Redis blacklist read failed — failing secure', { jti, error: err.message });
    return true;
  }
}

module.exports = { get, set, del, flush, ping, blacklistToken, isTokenBlacklisted, getClient };
