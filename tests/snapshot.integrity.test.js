const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { loadWithMocks } = require('./helpers/loadWithMocks');

const SNAPSHOT_UTIL_PATH = path.join(__dirname, '..', 'utils', 'requestSnapshots.js');
const REQUEST_SERVICE_PATH = path.join(__dirname, '..', 'modules', 'requests', 'request.service.js');

function createSnapshotRow(overrides = {}) {
  return {
    id: 'request-1',
    request_type: 'PATIENT',
    patient_id: 'patient-1',
    guest_name: null,
    guest_phone: null,
    guest_address: null,
    guest_gender: null,
    guest_age: null,
    service_type: 'MEDICAL',
    service_id: 'service-1',
    lab_test_id: null,
    package_id: null,
    notes: 'Initial request notes',
    requested_at: '2026-03-18T09:00:00.000Z',
    created_at: '2026-03-18T09:00:00.000Z',
    assigned_provider_id: null,
    assigned_provider_name_snapshot: null,
    assigned_provider_phone_snapshot: null,
    assigned_provider_type_snapshot: null,
    lead_provider_id: null,
    lead_provider_name_snapshot: null,
    lead_provider_phone_snapshot: null,
    lead_provider_type_snapshot: null,
    patient_full_name_snapshot: 'John Patient',
    patient_phone_snapshot: '+962700000001',
    patient_email_snapshot: 'john.patient@example.com',
    patient_address_snapshot: 'Amman',
    patient_gender_snapshot: 'male',
    patient_date_of_birth_snapshot: '1994-05-10',
    patient_age_snapshot: 31,
    service_name_snapshot: 'Home Visit',
    service_description_snapshot: 'General practitioner home visit',
    service_category_name_snapshot: 'General Medicine',
    service_price_snapshot: 75,
    package_components_snapshot: null,
    request_snapshot_payload: null,
    ...overrides,
  };
}

function createPoolWithClient(queryHandler) {
  const queries = [];
  let released = false;

  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      return queryHandler({ sql, params, queries });
    },
    release() {
      released = true;
    },
  };

  return {
    queries,
    client,
    get released() {
      return released;
    },
    pool: {
      async connect() {
        return client;
      },
    },
  };
}

describe('syncRequestSnapshotPayload — transaction integrity', () => {
  it('writes a complete snapshot payload when the select and update queries both succeed', async () => {
    const snapshots = require(SNAPSHOT_UTIL_PATH);
    const requestRow = createSnapshotRow();
    let persistedPayload = null;
    const harness = createPoolWithClient(async ({ sql, params }) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 };
      if (sql === 'ROLLBACK') throw new Error('rollback should not run on success');
      if (sql.includes('FROM service_requests')) return { rows: [requestRow], rowCount: 1 };
      if (sql.includes('SET request_snapshot_payload = COALESCE')) {
        persistedPayload = JSON.parse(params[1]);
        return {
          rows: [{ ...requestRow, request_snapshot_payload: persistedPayload }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const result = await snapshots.syncRequestSnapshotPayload(harness.pool, requestRow.id);

    assert.equal(result.id, requestRow.id);
    assert.equal(harness.released, true);
    assert.deepEqual(
      harness.queries.map(({ sql }) => sql),
      ['BEGIN', harness.queries[1].sql, harness.queries[2].sql, 'COMMIT']
    );
    assert.equal(persistedPayload.request.id, requestRow.id);
    assert.equal(persistedPayload.patient.full_name, requestRow.patient_full_name_snapshot);
    assert.equal(persistedPayload.service.name, requestRow.service_name_snapshot);
  });

  it('rolls back the transaction when the snapshot update query fails after the request row is loaded', async () => {
    const snapshots = require(SNAPSHOT_UTIL_PATH);
    const requestRow = createSnapshotRow();
    const harness = createPoolWithClient(async ({ sql }) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (sql === 'COMMIT') throw new Error('commit should not run when update fails');
      if (sql.includes('FROM service_requests')) return { rows: [requestRow], rowCount: 1 };
      if (sql.includes('SET request_snapshot_payload = COALESCE')) {
        throw new Error('update exploded');
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await assert.rejects(
      () => snapshots.syncRequestSnapshotPayload(harness.pool, requestRow.id),
      /update exploded/
    );

    assert.equal(harness.released, true);
    assert.ok(harness.queries.some(({ sql }) => sql === 'ROLLBACK'));
    assert.ok(!harness.queries.some(({ sql }) => sql === 'COMMIT'));
  });

  it('logs snapshot failures without rolling back the already-created request record in createRequest', async () => {
    const loggerErrors = [];
    const createdRequests = [];
    const requestRepoMock = {
      _db: {},
      async withTransaction(fn) {
        return fn({});
      },
      async getServicePrice() {
        return 120;
      },
      async create(payload) {
        createdRequests.push(payload);
        return { id: 'request-1', workflow_stage: 'TRIAGE' };
      },
    };
    const requestService = loadWithMocks(REQUEST_SERVICE_PATH, {
      '../../repositories/RequestRepository': function RequestRepository() {},
      '../labtests/labrange.service': { evaluateResult: async () => ({}) },
      '../notifications/notification.service': { notifyPointsEarned: async () => {} },
      '../../utils/logger': { logger: { error: (...args) => loggerErrors.push(args) } },
      '../../middlewares/errorHandler': {
        AppError: class AppError extends Error {
          constructor(message, statusCode, code) {
            super(message);
            this.statusCode = statusCode;
            this.code = code;
          }
        },
      },
      './request.workflow.service': { addLifecycleEvent: async () => {} },
      '../../utils/requestSnapshots': {
        buildRequestSnapshot: async () => ({
          patient: {
            full_name: 'Guest Patient',
            phone: '+962700000002',
            email: null,
            address: 'Zarqa',
            gender: null,
            date_of_birth: null,
            age: null,
          },
          service: {
            name: 'General Consultation',
            description: 'Quick consultation',
            category_name: 'General',
            price: 120,
          },
          package_components: null,
        }),
        syncRequestSnapshotPayload: async () => {
          throw new Error('snapshot write failed');
        },
        syncRequestProviderSnapshots: async () => null,
        normalizePackageComponentsSnapshot: (value) => value,
      },
      '../../utils/pagination': {
        paginate: ({ page = 1, limit = 10 }) => ({ page, limit, offset: (page - 1) * limit }),
        paginationMeta: (total, page, limit) => ({ total, page, limit }),
      },
    });

    requestService.configureRequestService(requestRepoMock);

    const result = await requestService.createRequest({
      request_type: 'GUEST',
      guest_name: 'Guest Patient',
      guest_phone: '+962700000002',
      guest_address: 'Zarqa',
      service_type: 'MEDICAL',
      service_id: 'service-1',
      notes: 'Needs same-day visit',
    });

    assert.equal(createdRequests.length, 1);
    assert.equal(result.request.id, 'request-1');
    assert.equal(result.invoice.finalAmount, 120);
    assert.equal(loggerErrors.length, 1);
    assert.equal(loggerErrors[0][0], 'Snapshot creation failed after request creation');
  });

  it('keeps the final snapshot valid when two concurrent sync calls race for the same request', async () => {
    const snapshots = require(SNAPSHOT_UTIL_PATH);
    const requestRow = createSnapshotRow();
    let storedPayload = null;
    let updateCount = 0;

    const pool = {
      async connect() {
        return {
          async query(sql, params = []) {
            if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
              return { rows: [], rowCount: 0 };
            }

            if (sql.includes('FROM service_requests')) {
              return {
                rows: [{ ...requestRow, request_snapshot_payload: storedPayload }],
                rowCount: 1,
              };
            }

            if (sql.includes('SET request_snapshot_payload = COALESCE')) {
              updateCount += 1;
              const candidate = JSON.parse(params[1]);
              await new Promise((resolve) => setTimeout(resolve, updateCount === 1 ? 15 : 5));
              storedPayload = storedPayload || candidate;
              return {
                rows: [{ ...requestRow, request_snapshot_payload: storedPayload }],
                rowCount: 1,
              };
            }

            throw new Error(`Unexpected SQL: ${sql}`);
          },
          release() {},
        };
      },
    };

    const [first, second] = await Promise.all([
      snapshots.syncRequestSnapshotPayload(pool, requestRow.id),
      snapshots.syncRequestSnapshotPayload(pool, requestRow.id),
    ]);

    assert.equal(updateCount, 2);
    assert.ok(storedPayload);
    assert.equal(storedPayload.request.id, requestRow.id);
    assert.equal(first.request_snapshot_payload.request.id, requestRow.id);
    assert.equal(second.request_snapshot_payload.request.id, requestRow.id);
    assert.deepEqual(first.request_snapshot_payload, second.request_snapshot_payload);
  });
});
