const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { loadWithMocks } = require('./helpers/loadWithMocks');
const { createPatientService } = require('../modules/patients/patient.service');

const NOTIFICATION_SERVICE_PATH = path.join(__dirname, '..', 'modules', 'notifications', 'notification.service.js');
const WORKFLOW_SERVICE_PATH = path.join(__dirname, '..', 'modules', 'requests', 'request.workflow.service.js');

class AppError extends Error {
  constructor(message, statusCode = 500, code = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function loadNotificationModule(tSpy) {
  return loadWithMocks(NOTIFICATION_SERVICE_PATH, {
    '../../utils/i18n/ar': {
      t: (key, params = {}) => {
        tSpy.push({ key, params });
        return `${key}:${JSON.stringify(params)}`;
      },
    },
  });
}

function loadWorkflowModule() {
  return loadWithMocks(WORKFLOW_SERVICE_PATH, {
    '../../middlewares/errorHandler': { AppError },
    '../chat/chat.service': {},
    '../../utils/requestSnapshots': {
      getProviderSnapshotById: async () => null,
      syncRequestProviderSnapshots: async () => null,
    },
  });
}

describe('PatientService (unit)', () => {
  it('returns standardized pagination metadata for patient history listings', async () => {
    const mockRepo = {
      getHistory: async () => ({
        data: [{ id: 'history-1' }, { id: 'history-2' }],
        total: 9,
      }),
    };
    const service = createPatientService(mockRepo);

    const result = await service.getPatientHistory('patient-1', { page: 2, limit: 3 });

    assert.equal(result.page, 2);
    assert.equal(result.limit, 3);
    assert.equal(result.pagination.total, 9);
    assert.equal(result.pagination.pages, 3);
    assert.equal(result.pagination.hasNext, true);
    assert.equal(result.pagination.hasPrev, true);
  });

  it('returns standardized pagination metadata for patient points logs', async () => {
    const mockRepo = {
      getPointsLog: async () => ({
        data: [{ id: 'points-1' }],
        total: 4,
      }),
    };
    const service = createPatientService(mockRepo);

    const result = await service.getPatientPointsLog('patient-1', { page: 1, limit: 2 });

    assert.deepEqual(result.data, [{ id: 'points-1' }]);
    assert.equal(result.pagination.total, 4);
    assert.equal(result.pagination.pages, 2);
    assert.equal(result.pagination.hasNext, true);
    assert.equal(result.pagination.hasPrev, false);
  });
});

describe('NotificationService (unit)', () => {
  it('builds new-request notification copy through the shared translation helper for admins and patients', async () => {
    const tSpy = [];
    const { createNotificationService } = loadNotificationModule(tSpy);
    const createdMany = [];
    const createdSingle = [];
    const service = createNotificationService({
      getAllAdminIds: async () => ['admin-1', 'admin-2'],
      createMany: async (rows) => { createdMany.push(rows); },
      createNotification: async (row) => { createdSingle.push(row); },
    });

    await service.notifyRequestCreated({
      requestId: 'request-1',
      requestType: 'GUEST',
      guestName: 'Guest Caller',
      patientId: 'patient-1',
      serviceType: 'LAB',
    });

    assert.deepEqual(
      tSpy.map(({ key }) => key),
      [
        'notifications.new_request.admin_title',
        'notifications.new_request.admin_body',
        'notifications.new_request.admin_title',
        'notifications.new_request.admin_body',
        'notifications.new_request.patient_title',
        'notifications.new_request.patient_body',
      ]
    );
    assert.equal(createdMany.length, 1);
    assert.deepEqual(
      createdMany[0].map((row) => row.userId),
      ['admin-1', 'admin-2']
    );
    assert.equal(createdSingle[0].userId, 'patient-1');
  });

  it('returns notification listings with standardized pagination metadata', async () => {
    const tSpy = [];
    const { createNotificationService } = loadNotificationModule(tSpy);
    const service = createNotificationService({
      getNotifications: async () => ({
        data: [{ id: 'notif-1' }],
        total: 5,
        unread_count: 2,
      }),
    });

    const result = await service.getNotifications('user-1', 'PATIENT', { page: 2, limit: 2 });

    assert.deepEqual(result.data, [{ id: 'notif-1' }]);
    assert.equal(result.unread_count, 2);
    assert.equal(result.pagination.total, 5);
    assert.equal(result.pagination.pages, 3);
    assert.equal(result.pagination.hasNext, true);
    assert.equal(result.pagination.hasPrev, true);
  });
});

describe('WorkflowService (unit)', () => {
  it('advances a TRIAGE request into IN_PROGRESS when the next stage is valid and work is assigned', async () => {
    const workflowService = loadWorkflowModule();
    const validateCalls = [];
    const lifecycleCalls = [];
    const mockRepo = {
      _db: {},
      async withTransaction(fn) {
        return fn({
          async query(sql) {
            if (sql.includes('UPDATE service_requests')) {
              return { rows: [{ id: 'request-1', workflow_stage: 'IN_PROGRESS' }], rowCount: 1 };
            }
            throw new Error(`Unexpected SQL: ${sql}`);
          },
        });
      },
      async getRequestCore() {
        return { id: 'request-1', workflow_stage: 'TRIAGE' };
      },
      getNextWorkflowStage() {
        return 'IN_PROGRESS';
      },
      validateTransition(from, to) {
        validateCalls.push({ from, to });
        return true;
      },
      async countAssignedActiveTasks() {
        return 1;
      },
      async logLifecycleEvent(event) {
        lifecycleCalls.push(event);
      },
    };

    workflowService.configureWorkflowService(mockRepo);
    const result = await workflowService.updateWorkflowStage({
      requestId: 'request-1',
      actor: { id: 'admin-1', role: 'ADMIN', name: 'Admin One' },
    });

    assert.deepEqual(validateCalls, [{ from: 'TRIAGE', to: 'IN_PROGRESS' }]);
    assert.equal(result.workflow_stage, 'IN_PROGRESS');
    assert.equal(lifecycleCalls[0].eventType, 'WORKFLOW_STAGE_CHANGED');
  });

  it('rejects a direct TRIAGE-to-PUBLISHED jump with INVALID_STATUS_TRANSITION details', async () => {
    const workflowService = loadWorkflowModule();
    const mockRepo = {
      _db: {},
      async withTransaction(fn) {
        return fn({ query: async () => ({ rows: [], rowCount: 0 }) });
      },
      async getRequestCore() {
        return { id: 'request-1', workflow_stage: 'TRIAGE' };
      },
      getNextWorkflowStage() {
        return 'IN_PROGRESS';
      },
      validateTransition() {
        throw new AppError('Invalid transition: TRIAGE -> PUBLISHED', 400, 'INVALID_STATUS_TRANSITION');
      },
    };

    workflowService.configureWorkflowService(mockRepo);

    await assert.rejects(
      () => workflowService.updateWorkflowStage({
        requestId: 'request-1',
        targetStage: 'PUBLISHED',
        actor: { id: 'admin-1', role: 'ADMIN', name: 'Admin One' },
      }),
      { code: 'INVALID_STATUS_TRANSITION' }
    );
  });

  it('rejects attempts to advance a request beyond PUBLISHED because terminal stages have no next stage', async () => {
    const workflowService = loadWorkflowModule();
    const mockRepo = {
      _db: {},
      async withTransaction(fn) {
        return fn({ query: async () => ({ rows: [], rowCount: 0 }) });
      },
      async getRequestCore() {
        return { id: 'request-1', workflow_stage: 'PUBLISHED' };
      },
      getNextWorkflowStage() {
        return null;
      },
    };

    workflowService.configureWorkflowService(mockRepo);

    await assert.rejects(
      () => workflowService.updateWorkflowStage({
        requestId: 'request-1',
        actor: { id: 'admin-1', role: 'ADMIN', name: 'Admin One' },
      }),
      { code: 'WORKFLOW_STAGE_FINAL' }
    );
  });

  it('blocks TRIAGE-to-IN_PROGRESS advancement until at least one active task is assigned', async () => {
    const workflowService = loadWorkflowModule();
    const mockRepo = {
      _db: {},
      async withTransaction(fn) {
        return fn({ query: async () => ({ rows: [], rowCount: 0 }) });
      },
      async getRequestCore() {
        return { id: 'request-1', workflow_stage: 'TRIAGE' };
      },
      getNextWorkflowStage() {
        return 'IN_PROGRESS';
      },
      validateTransition() {
        return true;
      },
      async countAssignedActiveTasks() {
        return 0;
      },
    };

    workflowService.configureWorkflowService(mockRepo);

    await assert.rejects(
      () => workflowService.updateWorkflowStage({
        requestId: 'request-1',
        actor: { id: 'admin-1', role: 'ADMIN', name: 'Admin One' },
      }),
      { code: 'WORKFLOW_STAGE_CONDITION_FAILED' }
    );
  });
});
