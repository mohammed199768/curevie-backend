const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const jwt = require('jsonwebtoken');

const { loadWithMocks } = require('./helpers/loadWithMocks');

const ROOT = path.resolve(__dirname, '..');
const AUTH_MIDDLEWARE_PATH = path.join(ROOT, 'middlewares', 'auth.js');
const AUTH_CONTROLLER_PATH = path.join(ROOT, 'modules', 'admin', 'auth.controller.js');
const UPLOAD_PATH = path.join(ROOT, 'utils', 'upload.js');
const CACHE_PATH = path.join(ROOT, 'utils', 'cache.js');
const RATE_LIMITER_PATH = path.join(ROOT, 'middlewares', 'rateLimiter.js');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';

class AppError extends Error {
  constructor(message, statusCode = 500, code = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
  }
}

function createResponseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function invokeMiddleware(middleware, req = {}) {
  const request = { headers: {}, ...req };
  const response = createResponseRecorder();
  const nextCalls = [];

  await middleware(request, response, (err) => {
    nextCalls.push(err || null);
  });

  return {
    req: request,
    res: response,
    nextCalls,
  };
}

function installCachedModule(modulePath, exportsObject) {
  const previous = require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: exportsObject,
  };

  return () => {
    if (previous) {
      require.cache[modulePath] = previous;
      return;
    }

    delete require.cache[modulePath];
  };
}

function loadAuthModule({ cacheMock, poolMock } = {}) {
  const auditCalls = [];
  const restoreCache = installCachedModule(
    CACHE_PATH,
    cacheMock || {
      isTokenBlacklisted: async () => false,
      blacklistToken: async () => {},
      getClient: async () => null,
    }
  );
  const auth = loadWithMocks(AUTH_MIDDLEWARE_PATH, {
    '../config/db': poolMock || { query: async () => ({ rows: [], rowCount: 0 }) },
    '../utils/cache': require.cache[CACHE_PATH].exports,
    '../utils/logger': {
      audit: (...args) => auditCalls.push(args),
    },
  });

  return { auth, auditCalls, restoreCache };
}

function createMulterMock({ singleError = null, arrayError = null } = {}) {
  class MulterError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  }

  const multer = (options) => ({
    single() {
      return (req, res, cb) => {
        if (singleError) return cb(singleError);
        if (req.testFile && options.fileFilter) {
          return options.fileFilter(req, req.testFile, (err) => cb(err || null));
        }
        return cb(null);
      };
    },
    array() {
      return (req, res, cb) => {
        if (arrayError) return cb(arrayError);
        if (Array.isArray(req.testFiles) && options.fileFilter) {
          let index = 0;
          const runNext = () => {
            if (index >= req.testFiles.length) return cb(null);
            const file = req.testFiles[index];
            index += 1;
            return options.fileFilter(req, file, (err) => {
              if (err) return cb(err);
              return runNext();
            });
          };
          return runNext();
        }
        return cb(null);
      };
    },
  });

  multer.memoryStorage = () => ({});
  multer.diskStorage = () => ({});
  multer.MulterError = MulterError;

  return { multer, MulterError };
}

function loadUploadModule({ multerOverride } = {}) {
  return loadWithMocks(UPLOAD_PATH, {
    multer: multerOverride || require('multer'),
    '../middlewares/errorHandler': { AppError },
  });
}

function loadAuthController({ authServiceMock }) {
  const auditCalls = [];
  const controller = loadWithMocks(AUTH_CONTROLLER_PATH, {
    '../../middlewares/auth': {
      generateAccessToken: () => 'new-access-token',
      generateRefreshToken: () => 'new-refresh-token',
      saveRefreshToken: async () => {},
    },
    '../../utils/logger': { audit: (...args) => auditCalls.push(args) },
    './auth.service': authServiceMock,
  });

  return { controller, auditCalls };
}

describe('authenticate middleware', () => {
  it('accepts a valid bearer token and attaches the decoded user to the request', async () => {
    const { auth, restoreCache } = loadAuthModule();

    try {
      const token = auth.generateAccessToken({ id: 'user-1', email: 'user@test.com', role: 'ADMIN' });

      const result = await invokeMiddleware(auth.authenticate, {
        headers: { authorization: `Bearer ${token}` },
      });

      assert.equal(result.res.statusCode, 200);
      assert.equal(result.nextCalls.length, 1);
      assert.equal(result.req.user.id, 'user-1');
      assert.equal(result.req.user.role, 'ADMIN');
      assert.ok(result.req.user.jti);
    } finally {
      restoreCache();
    }
  });

  it('rejects requests that do not send an Authorization header', async () => {
    const { auth, restoreCache } = loadAuthModule();

    try {
      const result = await invokeMiddleware(auth.authenticate, {});

      assert.equal(result.res.statusCode, 401);
      assert.equal(result.res.body.code, 'NO_TOKEN');
      assert.equal(result.nextCalls.length, 0);
    } finally {
      restoreCache();
    }
  });

  it('rejects malformed bearer tokens before any route handler runs', async () => {
    const { auth, restoreCache } = loadAuthModule();

    try {
      const result = await invokeMiddleware(auth.authenticate, {
        headers: { authorization: 'Bearer definitely-not-a-jwt' },
      });

      assert.equal(result.res.statusCode, 401);
      assert.equal(result.res.body.code, 'INVALID_TOKEN');
      assert.equal(result.nextCalls.length, 0);
    } finally {
      restoreCache();
    }
  });

  it('rejects expired bearer tokens instead of treating them as valid sessions', async () => {
    const { auth, restoreCache } = loadAuthModule();

    try {
      const expiredToken = jwt.sign(
        { id: 'user-1', email: 'user@test.com', role: 'ADMIN', jti: 'expired-jti' },
        process.env.JWT_SECRET,
        { expiresIn: -1 }
      );

      const result = await invokeMiddleware(auth.authenticate, {
        headers: { authorization: `Bearer ${expiredToken}` },
      });

      assert.equal(result.res.statusCode, 401);
      assert.equal(result.res.body.code, 'TOKEN_EXPIRED');
      assert.equal(result.nextCalls.length, 0);
    } finally {
      restoreCache();
    }
  });

  it('rejects a valid token immediately when its jti is already blacklisted', async () => {
    const { auth, restoreCache } = loadAuthModule({
      cacheMock: {
        isTokenBlacklisted: async () => true,
        blacklistToken: async () => {},
        getClient: async () => null,
      },
    });

    try {
      const token = auth.generateAccessToken({ id: 'user-1', email: 'user@test.com', role: 'ADMIN' });

      const result = await invokeMiddleware(auth.authenticate, {
        headers: { authorization: `Bearer ${token}` },
      });

      assert.equal(result.res.statusCode, 401);
      assert.equal(result.res.body.code, 'TOKEN_REVOKED');
      assert.equal(result.nextCalls.length, 0);
    } finally {
      restoreCache();
    }
  });

  it('denies access when the blacklist cache falls back to secure-deny mode', async () => {
    const { auth, restoreCache } = loadAuthModule({
      cacheMock: {
        isTokenBlacklisted: async () => true,
        blacklistToken: async () => {},
        getClient: async () => null,
      },
    });

    try {
      const token = auth.generateAccessToken({ id: 'user-1', email: 'user@test.com', role: 'ADMIN' });

      const result = await invokeMiddleware(auth.authenticate, {
        headers: { authorization: `Bearer ${token}` },
      });

      assert.equal(result.res.statusCode, 401);
      assert.equal(result.res.body.code, 'TOKEN_REVOKED');
    } finally {
      restoreCache();
    }
  });
});

describe('token blacklist cache fail-secure behavior', () => {
  it('treats a token as blacklisted when Redis lookup throws unexpectedly', async () => {
    class MockRedis {
      constructor() {
        this.handlers = {};
        setImmediate(() => this.handlers.ready?.());
      }

      once(event, handler) {
        this.handlers[event] = handler;
      }

      async get() {
        throw new Error('redis read failed');
      }

      disconnect() {}
    }

    const { isTokenBlacklisted } = loadWithMocks(CACHE_PATH, {
      ioredis: MockRedis,
      './logger': { logger: { warn() {}, error() {}, info() {} } },
    });

    const result = await isTokenBlacklisted('jti-1');

    assert.equal(result, true);
  });

  it('retries connecting to Redis after an initial connection failure', async () => {
    let attempt = 0;
    let now = 0;
    const originalDateNow = Date.now;

    class MockRedis {
      constructor() {
        this.handlers = {};
        attempt += 1;
        setImmediate(() => {
          if (attempt === 1) {
            this.handlers.error?.(new Error('ECONNREFUSED'));
            return;
          }
          this.status = 'ready';
          this.handlers.ready?.();
        });
      }

      once(event, handler) {
        this.handlers[event] = handler;
      }

      on(event, handler) {
        this.handlers[event] = handler;
      }

      off(event) {
        delete this.handlers[event];
      }

      disconnect() {}
    }

    Date.now = () => now;

    try {
      const { getClient } = loadWithMocks(CACHE_PATH, {
        ioredis: MockRedis,
        './logger': { logger: { warn() {}, error() {}, info() {} } },
      });

      const firstAttempt = await getClient();
      assert.equal(firstAttempt, null);

      now = 4000;

      const secondAttempt = await getClient();
      assert.ok(secondAttempt);
      assert.equal(attempt, 2);
    } finally {
      Date.now = originalDateNow;
    }
  });
});

describe('file upload validation — S1 + S2', () => {
  it('rejects an unsupported MIME type before buffering the upload so S1 cannot regress', async () => {
    const { multer } = createMulterMock();
    const upload = loadUploadModule({ multerOverride: multer });
    let nextError = null;

    await upload.uploadSingleImage(
      { testFile: { mimetype: 'application/x-httpd-php' } },
      {},
      (err) => { nextError = err || null; }
    );

    assert.ok(nextError instanceof AppError);
    assert.equal(nextError.code, 'INVALID_FILE_TYPE');
  });

  it('rejects a PHP payload disguised as image/jpeg when magic-byte validation runs', async () => {
    const upload = loadUploadModule();
    const req = {
      file: {
        mimetype: 'image/jpeg',
        buffer: Buffer.from('<?php echo "pwned"; ?>'),
      },
    };
    let nextError = null;

    await upload.validateImageContents(req, {}, (err) => { nextError = err || null; });

    assert.ok(nextError instanceof AppError);
    assert.equal(nextError.code, 'INVALID_FILE_CONTENTS');
  });

  it('rejects an HTML payload disguised as image/png when magic-byte validation runs', async () => {
    const upload = loadUploadModule();
    const req = {
      file: {
        mimetype: 'image/png',
        buffer: Buffer.from('<html><body>not an image</body></html>'),
      },
    };
    let nextError = null;

    await upload.validateImageContents(req, {}, (err) => { nextError = err || null; });

    assert.ok(nextError instanceof AppError);
    assert.equal(nextError.code, 'INVALID_FILE_CONTENTS');
  });

  it('accepts a real JPEG buffer and normalizes the verified MIME type for downstream code', async () => {
    const upload = loadUploadModule();
    const jpegMagic = Buffer.from([
      0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10,
      0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
      0x01, 0x01, 0x00, 0x48, 0x00, 0x48,
      0x00, 0x00,
    ]);
    const req = {
      file: {
        mimetype: 'image/jpeg',
        buffer: jpegMagic,
      },
    };
    let nextError = null;

    await upload.validateImageContents(req, {}, (err) => { nextError = err || null; });

    assert.equal(nextError, null);
    assert.equal(req.file.mimetype, 'image/jpeg');
    assert.equal(req.file.detectedExt, 'jpg');
  });

  it('rejects a single-image upload that exceeds the configured file-size limit', async () => {
    const { multer, MulterError } = createMulterMock();
    const limitError = new MulterError('LIMIT_FILE_SIZE');
    const multerWithLimitError = Object.assign(
      () => ({
        single() {
          return (req, res, cb) => cb(limitError);
        },
        array() {
          return (req, res, cb) => cb(null);
        },
      }),
      {
        memoryStorage: multer.memoryStorage,
        diskStorage: multer.diskStorage,
        MulterError,
      }
    );
    const upload = loadUploadModule({ multerOverride: multerWithLimitError });
    let nextError = null;

    await upload.uploadSingleImage({}, {}, (err) => { nextError = err || null; });

    assert.ok(nextError instanceof AppError);
    assert.equal(nextError.code, 'FILE_TOO_LARGE');
  });
});

describe('rate limiter Redis-store fallback', () => {
  it('falls back to the in-memory limiter when Redis is unavailable at first use', async () => {
    const loggerCalls = [];
    const rateLimitCalls = [];
    const rateLimitMock = (options) => {
      rateLimitCalls.push(options);
      return async (req, res, next) => next();
    };

    class MockRedisStore {
      constructor(options) {
        this.options = options;
      }
    }

    const { authLimiter } = loadWithMocks(RATE_LIMITER_PATH, {
      'express-rate-limit': rateLimitMock,
      'rate-limit-redis': { RedisStore: MockRedisStore },
      '../utils/cache': { getClient: async () => null },
      '../utils/logger': { logger: { warn: (...args) => loggerCalls.push(args) } },
    });

    const result = await invokeMiddleware(authLimiter, { ip: '127.0.0.1', method: 'POST', path: '/auth/login' });

    assert.equal(result.nextCalls.length, 1);
    assert.equal(rateLimitCalls.length, 1);
    assert.ok(loggerCalls.some(([message]) => String(message).includes('in-memory store')));
  });
});

describe('refresh token reuse detection — S5', () => {
  it('revokes every session and returns TOKEN_REUSE_DETECTED when a reused refresh token is presented', async () => {
    const revokeAllCalls = [];
    const authServiceMock = {
      getRefreshToken: async () => ({
        id: 'rt-1',
        user_id: 'patient-1',
        role: 'PATIENT',
        revoked_at: new Date('2026-01-01T00:00:00.000Z').toISOString(),
        expires_at: new Date('2026-12-31T00:00:00.000Z').toISOString(),
      }),
      revokeAllUserTokens: async (userId, role) => { revokeAllCalls.push({ userId, role }); },
    };
    const { controller, auditCalls } = loadAuthController({ authServiceMock });
    const refreshToken = jwt.sign(
      { id: 'patient-1', email: 'patient@test.com', role: 'PATIENT' },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: '30d' }
    );
    const req = {
      body: { refresh_token: refreshToken },
      ip: '127.0.0.1',
    };
    const res = createResponseRecorder();

    await controller.refresh(req, res);

    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'TOKEN_REUSE_DETECTED');
    assert.deepEqual(revokeAllCalls, [{ userId: 'patient-1', role: 'PATIENT' }]);
    assert.equal(auditCalls[0][0], 'REFRESH_TOKEN_REUSE_DETECTED');
  });
});
