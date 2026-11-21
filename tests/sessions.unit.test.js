// Account-wide session revocation, run against an in-memory stand-in for Redis: npm run test:unit
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'unit-refresh-secret';
process.env.REDIS_URL = 'redis://in-memory.test:6379';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');

// Minimal ioredis replacement: connects at once and keeps keys in a Map (TTL is not needed here).
class InMemoryRedis extends EventEmitter {
  constructor() {
    super();
    this.status = 'connecting';
    this.store = new Map();
    setImmediate(() => {
      this.status = 'ready';
      this.emit('ready');
    });
  }

  async get(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  async set(key, value) {
    this.store.set(key, String(value));
    return 'OK';
  }

  disconnect() {}
}
require.cache[require.resolve('ioredis')] = { id: 'ioredis', loaded: true, exports: InMemoryRedis };

const { verifyAccessToken, revokeAccessTokens, generateAccessToken } = require('../middlewares/auth');

const now = () => Math.floor(Date.now() / 1000);
const tokenIssuedAt = (user, iat) => jwt.sign(
  { ...user, jti: randomUUID(), iat },
  process.env.JWT_SECRET,
  { expiresIn: '5m' }
);
const rejected = { name: 'TokenRevokedError' };

test('ending all sessions rejects access tokens that were already issued', async () => {
  const provider = { id: randomUUID(), email: 'p@test.io', role: 'PROVIDER' };
  const token = generateAccessToken(provider);
  assert.equal((await verifyAccessToken(token)).id, provider.id, 'valid before revocation');

  await revokeAccessTokens(provider.id, 'PROVIDER');
  await assert.rejects(verifyAccessToken(token), rejected);
});

test('a session started after the revocation works', async () => {
  const patient = { id: randomUUID(), email: 'pt@test.io', role: 'PATIENT' };
  await revokeAccessTokens(patient.id, 'PATIENT');
  const later = tokenIssuedAt(patient, now() + 1);
  assert.equal((await verifyAccessToken(later)).id, patient.id);
});

test('revocation is scoped to one account and one role', async () => {
  const id = randomUUID();
  await revokeAccessTokens(id, 'PROVIDER');

  const other = { id: randomUUID(), email: 'o@test.io', role: 'PROVIDER' };
  assert.equal((await verifyAccessToken(generateAccessToken(other))).id, other.id, 'other accounts unaffected');

  const sameIdOtherRole = { id, email: 'x@test.io', role: 'PATIENT' };
  assert.equal((await verifyAccessToken(generateAccessToken(sameIdOtherRole))).role, 'PATIENT');
});
