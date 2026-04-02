const test = require('node:test');
const assert = require('node:assert/strict');

const RequestLifecycleService = require('../modules/requests/request.lifecycle.service');
const { createRequestSchema } = require('../utils/schemas');

function createLifecycleHarness() {
  const createCalls = [];
  const lifecycle = new RequestLifecycleService({
    requestRepo: {},
    workflowRepo: {},
    requestService: {
      async createRequest(payload) {
        createCalls.push(payload);
        return {
          request: {
            id: 'request-1',
            request_type: payload.request_type,
            service_type: payload.service_type,
          },
        };
      },
    },
    workflowService: {},
    notificationService: {
      async notifyRequestCreated() {
        return undefined;
      },
    },
    invoiceService: {},
    paymentService: {},
    snapshotUtil: {},
    storageUtil: {},
  });

  return { lifecycle, createCalls };
}

test('createRequest schema accepts seeded catalog UUIDs for lab package requests', () => {
  const payload = {
    request_type: 'GUEST',
    guest_name: 'Test User',
    guest_phone: '0790000000',
    guest_address: 'Amman',
    service_type: 'LAB',
    lab_package_id: '00000003-0000-0000-0000-000000000001',
  };

  const result = createRequestSchema.validate(payload);

  assert.equal(result.error, undefined);
});

test('request lifecycle forwards lab package and panel identifiers to request service', async () => {
  const actor = { id: 'guest-user', role: 'GUEST' };

  {
    const { lifecycle, createCalls } = createLifecycleHarness();
    await lifecycle.createRequest({
      request_type: 'GUEST',
      guest_name: 'Package Guest',
      guest_phone: '0790000000',
      guest_address: 'Amman',
      service_type: 'LAB',
      lab_package_id: '00000003-0000-0000-0000-000000000001',
    }, actor, '127.0.0.1');

    assert.equal(createCalls[0].lab_package_id, '00000003-0000-0000-0000-000000000001');
    assert.equal(createCalls[0].lab_panel_id, undefined);
  }

  {
    const { lifecycle, createCalls } = createLifecycleHarness();
    await lifecycle.createRequest({
      request_type: 'GUEST',
      guest_name: 'Panel Guest',
      guest_phone: '0790000000',
      guest_address: 'Amman',
      service_type: 'LAB',
      lab_panel_id: '00000002-0000-0000-0000-000000000005',
    }, actor, '127.0.0.1');

    assert.equal(createCalls[0].lab_panel_id, '00000002-0000-0000-0000-000000000005');
    assert.equal(createCalls[0].lab_package_id, undefined);
  }
});
