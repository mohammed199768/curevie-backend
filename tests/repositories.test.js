const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const BaseRepository = require('../repositories/BaseRepository');
const PatientRepository = require('../repositories/PatientRepository');
const RequestRepository = require('../repositories/RequestRepository');
const AuthRepository = require('../repositories/AuthRepository');

function createMockDb({
  queryImpl = async () => ({ rows: [], rowCount: 0 }),
  connectQueryImpl = null,
} = {}) {
  const queries = [];
  const clientQueries = [];
  let released = false;

  return {
    queries,
    clientQueries,
    get released() {
      return released;
    },
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      return queryImpl(sql, params, queries);
    },
    connect: async () => ({
      query: async (sql, params = []) => {
        clientQueries.push({ sql, params });
        if (connectQueryImpl) return connectQueryImpl(sql, params, clientQueries);
        return queryImpl(sql, params, clientQueries);
      },
      release: () => {
        released = true;
      },
    }),
  };
}

describe('BaseRepository', () => {
  it('returns null from findById when the database returns no rows', async () => {
    const repo = new BaseRepository(createMockDb(), 'patients');

    const result = await repo.findById('missing-id');

    assert.equal(result, null);
  });

  it('returns the first row from findById when the record exists', async () => {
    const repo = new BaseRepository(
      createMockDb({
        queryImpl: async () => ({ rows: [{ id: 'patient-1', full_name: 'John' }], rowCount: 1 }),
      }),
      'patients'
    );

    const result = await repo.findById('patient-1');

    assert.deepEqual(result, { id: 'patient-1', full_name: 'John' });
  });

  it('commits the transaction and returns the callback result when work succeeds', async () => {
    const db = createMockDb({
      connectQueryImpl: async (sql) => ({ rows: sql === 'SELECT 1' ? [{ value: 1 }] : [], rowCount: 1 }),
    });
    const repo = new BaseRepository(db, 'patients');

    const result = await repo.withTransaction(async (client) => {
      await client.query('SELECT 1');
      return { ok: true };
    });

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(
      db.clientQueries.map(({ sql }) => sql),
      ['BEGIN', 'SELECT 1', 'COMMIT']
    );
    assert.equal(db.released, true);
  });

  it('rolls back the transaction when the callback throws', async () => {
    const db = createMockDb();
    const repo = new BaseRepository(db, 'patients');

    await assert.rejects(
      () => repo.withTransaction(async () => {
        throw new Error('boom');
      }),
      /boom/
    );

    assert.deepEqual(
      db.clientQueries.map(({ sql }) => sql),
      ['BEGIN', 'ROLLBACK']
    );
    assert.equal(db.released, true);
  });

  it('releases the transaction client even when the callback fails', async () => {
    const db = createMockDb();
    const repo = new BaseRepository(db, 'patients');

    await assert.rejects(
      () => repo.withTransaction(async () => {
        throw new Error('still broken');
      }),
      /still broken/
    );

    assert.equal(db.released, true);
  });
});

describe('PatientRepository', () => {
  it('creates a patient row while null-normalizing optional profile fields', async () => {
    const db = createMockDb({
      queryImpl: async (sql, params) => ({
        rows: [{
          id: 'patient-1',
          full_name: params[0],
          email: params[1],
          phone: params[3],
          address: params[4],
          date_of_birth: params[5],
          gender: params[6],
        }],
        rowCount: 1,
      }),
    });
    const repo = new PatientRepository(db);

    const result = await repo.createPatient({
      full_name: 'Jane Patient',
      email: 'jane@example.com',
      password: 'hashed-password',
      phone: '+962700000003',
      address: '',
      date_of_birth: '',
      gender: '',
    });

    assert.equal(db.queries[0].params[4], null);
    assert.equal(db.queries[0].params[5], null);
    assert.equal(db.queries[0].params[6], null);
    assert.equal(result.email, 'jane@example.com');
  });

  it('returns paginated patient rows together with the total count', async () => {
    const db = createMockDb({
      queryImpl: async (sql, params) => {
        if (sql.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 7 }], rowCount: 1 };
        }

        if (sql.includes('FROM patients p')) {
          return {
            rows: [{ id: 'patient-1' }, { id: 'patient-2' }],
            rowCount: 2,
          };
        }

        throw new Error(`Unexpected SQL: ${sql}`);
      },
    });
    const repo = new PatientRepository(db);

    const result = await repo.list({ search: 'patient' }, { limit: 2, offset: 4 });

    assert.equal(result.total, 7);
    assert.deepEqual(result.data.map((row) => row.id), ['patient-1', 'patient-2']);
    assert.equal(db.queries[1].params.at(-2), 2);
    assert.equal(db.queries[1].params.at(-1), 4);
  });

  it('updates only the medical fields that are explicitly allowed by updateMedical', async () => {
    const db = createMockDb({
      queryImpl: async (sql, params) => ({
        rows: [{ id: params.at(-1), height: params[0], allergies: params[1] }],
        rowCount: 1,
      }),
    });
    const repo = new PatientRepository(db);

    await repo.updateMedical('patient-1', {
      height: 172,
      allergies: 'Pollen',
      email: 'should-not-be-updated@example.com',
    });

    assert.ok(db.queries[0].sql.includes('height = $1'));
    assert.ok(db.queries[0].sql.includes('allergies = $2'));
    assert.ok(!db.queries[0].sql.includes('email ='));
  });
});

describe('RequestRepository', () => {
  it('returns null from findById when no matching request exists', async () => {
    const repo = new RequestRepository(createMockDb());

    const result = await repo.findById('request-missing');

    assert.equal(result, null);
  });

  it('returns the updated request row when updateStatus changes the request state', async () => {
    const db = createMockDb({
      queryImpl: async (sql, params) => ({
        rows: [{ id: params[0], status: params[1] }],
        rowCount: 1,
      }),
    });
    const repo = new RequestRepository(db);

    const result = await repo.updateStatus('request-1', 'COMPLETED');

    assert.deepEqual(result, { id: 'request-1', status: 'COMPLETED' });
    assert.ok(db.queries[0].sql.includes('SET status = $2'));
  });

  it('uses the shared transaction wrapper to commit atomic request operations', async () => {
    const db = createMockDb({
      connectQueryImpl: async (sql) => ({ rows: sql === 'SELECT 1' ? [{ ok: true }] : [], rowCount: 1 }),
    });
    const repo = new RequestRepository(db);

    const result = await repo.withTransaction(async (client) => {
      await client.query('SELECT 1');
      return 'done';
    });

    assert.equal(result, 'done');
    assert.deepEqual(
      db.clientQueries.map(({ sql }) => sql),
      ['BEGIN', 'SELECT 1', 'COMMIT']
    );
  });
});

describe('AuthRepository', () => {
  it('queries the admins table when authenticating an admin by email', async () => {
    const db = createMockDb({
      queryImpl: async () => ({ rows: [{ id: 'admin-1' }], rowCount: 1 }),
    });
    const repo = new AuthRepository(db);

    await repo.findUserByEmail('admin@example.com', 'ADMIN');

    assert.ok(db.queries[0].sql.includes('FROM admins'));
  });

  it('queries the service_providers table when authenticating a provider by email', async () => {
    const db = createMockDb({
      queryImpl: async () => ({ rows: [{ id: 'provider-1' }], rowCount: 1 }),
    });
    const repo = new AuthRepository(db);

    await repo.findUserByEmail('provider@example.com', 'PROVIDER');

    assert.ok(db.queries[0].sql.includes('FROM service_providers'));
  });

  it('queries the patients table when authenticating a patient by email', async () => {
    const db = createMockDb({
      queryImpl: async () => ({ rows: [{ id: 'patient-1' }], rowCount: 1 }),
    });
    const repo = new AuthRepository(db);

    await repo.findUserByEmail('patient@example.com', 'PATIENT');

    assert.ok(db.queries[0].sql.includes('FROM patients'));
  });

  it('rejects unknown auth roles with the INVALID_ROLE application error code', async () => {
    const repo = new AuthRepository(createMockDb());

    await assert.rejects(
      () => repo.findUserByEmail('unknown@example.com', 'HACKER'),
      { code: 'INVALID_ROLE' }
    );
  });

  it('revokes refresh tokens only for the specified user-role pair', async () => {
    const db = createMockDb();
    const repo = new AuthRepository(db);

    await repo.revokeAllUserTokens('user-1', 'PATIENT');

    assert.ok(db.queries[0].sql.includes('UPDATE refresh_tokens'));
    assert.deepEqual(db.queries[0].params, ['user-1', 'PATIENT']);
  });
});
