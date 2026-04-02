const test = require('node:test');
const assert = require('node:assert/strict');
const { createPatientService } = require('../modules/patients/patient.service');

function createMockRepo(overrides = {}) {
  return {
    createPatient: async (data) => ({ id: 'p-1', ...data }),
    getById: async () => ({ id: 'p-1', full_name: 'Alice', email: 'a@b.com' }),
    exists: async () => true,
    list: async () => ({ data: [], total: 0 }),
    updateMedical: async () => ({ noUpdates: false, row: { id: 'p-1' } }),
    updateProfile: async () => ({ noUpdates: false, row: { id: 'p-1' } }),
    updateVip: async (id, isVip, d) => ({ id, is_vip: isVip, vip_discount: d }),
    updateAvatar: async (id, url) => ({ id, avatar_url: url }),
    getAvatarInfo: async () => ({ id: 'p-1', full_name: 'Alice', avatar_url: null }),
    deletePatient: async (id) => ({ id, full_name: 'Alice', email: 'a@b.com' }),
    getHistory: async () => ({ data: [], total: 0 }),
    getHistoryCount: async () => 0,
    addHistory: async (data) => ({ id: 'h-1', ...data }),
    getRecentRequests: async () => [],
    getPointsLog: async () => ({ data: [], total: 0 }),
    ...overrides,
  };
}

test('createPatient delegates to repo.createPatient', async () => {
  const calls = [];
  const repo = createMockRepo({
    createPatient: async (data) => { calls.push(data); return { id: 'p-1', ...data }; },
  });
  const service = createPatientService(repo);
  const result = await service.createPatient({
    full_name: 'Alice', email: 'a@test.com', password: 'hashed',
    phone: '555', address: '', date_of_birth: null, gender: null,
  });
  assert.equal(result.id, 'p-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].full_name, 'Alice');
});

test('listPatients computes offset and calls repo.list', async () => {
  const calls = [];
  const repo = createMockRepo({
    list: async (filters, opts) => { calls.push({ filters, opts }); return { data: [{ id: 'p-1' }], total: 1 }; },
  });
  const service = createPatientService(repo);
  const result = await service.listPatients({ page: 2, limit: 10, search: 'alice' });
  assert.equal(result.total, 1);
  assert.equal(result.data.length, 1);
  assert.equal(calls[0].opts.offset, 10);
  assert.equal(calls[0].opts.limit, 10);
  assert.equal(calls[0].filters.search, 'alice');
});

test('getPatientById delegates to repo.getById', async () => {
  const repo = createMockRepo({
    getById: async (id) => ({ id, full_name: 'Bob' }),
  });
  const service = createPatientService(repo);
  const result = await service.getPatientById('p-42');
  assert.equal(result.id, 'p-42');
  assert.equal(result.full_name, 'Bob');
});

test('getPatientById returns null when not found', async () => {
  const repo = createMockRepo({ getById: async () => null });
  const service = createPatientService(repo);
  assert.equal(await service.getPatientById('missing'), null);
});

test('patientExists delegates to repo.exists', async () => {
  const repo = createMockRepo({ exists: async () => false });
  const service = createPatientService(repo);
  assert.equal(await service.patientExists('p-1'), false);
});

test('getPatientHistory applies safe pagination bounds', async () => {
  const calls = [];
  const repo = createMockRepo({
    getHistory: async (id, opts) => { calls.push({ id, opts }); return { data: [], total: 50 }; },
  });
  const service = createPatientService(repo);

  const result = await service.getPatientHistory('p-1', { page: -1, limit: 999 });
  assert.equal(result.page, 1);
  assert.equal(result.limit, 100);
  assert.equal(calls[0].opts.offset, 0);
  assert.equal(calls[0].opts.limit, 100);
});

test('updatePatientMedical delegates to repo.updateMedical', async () => {
  const calls = [];
  const repo = createMockRepo({
    updateMedical: async (id, data) => { calls.push({ id, data }); return { noUpdates: false, row: { id } }; },
  });
  const service = createPatientService(repo);
  const result = await service.updatePatientMedical('p-1', { height: 180 });
  assert.equal(result.noUpdates, false);
  assert.equal(calls[0].id, 'p-1');
  assert.deepEqual(calls[0].data, { height: 180 });
});

test('updatePatientProfile delegates to repo.updateProfile', async () => {
  const repo = createMockRepo({
    updateProfile: async () => ({ noUpdates: true }),
  });
  const service = createPatientService(repo);
  const result = await service.updatePatientProfile('p-1', { unknown: 'x' });
  assert.equal(result.noUpdates, true);
});

test('addPatientHistory maps id to patientId', async () => {
  const calls = [];
  const repo = createMockRepo({
    addHistory: async (data) => { calls.push(data); return { id: 'h-1', ...data }; },
  });
  const service = createPatientService(repo);
  await service.addPatientHistory({ id: 'p-1', note: 'test', createdByAdmin: 'a-1', createdByProvider: null });
  assert.equal(calls[0].patientId, 'p-1');
  assert.equal(calls[0].note, 'test');
});

test('updatePatientVip delegates to repo.updateVip', async () => {
  const calls = [];
  const repo = createMockRepo({
    updateVip: async (id, isVip, discount) => { calls.push({ id, isVip, discount }); return { id, is_vip: isVip }; },
  });
  const service = createPatientService(repo);
  await service.updatePatientVip('p-1', { is_vip: true, vip_discount: 15 });
  assert.equal(calls[0].isVip, true);
  assert.equal(calls[0].discount, 15);
});

test('deletePatient returns null when repo returns null', async () => {
  const repo = createMockRepo({ deletePatient: async () => null });
  const service = createPatientService(repo);
  assert.equal(await service.deletePatient('p-missing'), null);
});

test('getPatientAvatarInfo delegates to repo.getAvatarInfo', async () => {
  const repo = createMockRepo({
    getAvatarInfo: async (id) => ({ id, avatar_url: 'http://img.test/a.jpg' }),
  });
  const service = createPatientService(repo);
  const result = await service.getPatientAvatarInfo('p-1');
  assert.equal(result.avatar_url, 'http://img.test/a.jpg');
});

test('updatePatientAvatar delegates to repo.updateAvatar', async () => {
  const calls = [];
  const repo = createMockRepo({
    updateAvatar: async (id, url) => { calls.push({ id, url }); return { id, avatar_url: url }; },
  });
  const service = createPatientService(repo);
  await service.updatePatientAvatar('p-1', 'http://img.test/new.jpg');
  assert.equal(calls[0].url, 'http://img.test/new.jpg');
});

test('getPatientPointsLog applies safe pagination and shapes response', async () => {
  const repo = createMockRepo({
    getPointsLog: async () => ({ data: [{ id: 'pt-1' }], total: 25 }),
  });
  const service = createPatientService(repo);
  const result = await service.getPatientPointsLog('p-1', { page: 2, limit: 10 });
  assert.equal(result.pagination.page, 2);
  assert.equal(result.pagination.limit, 10);
  assert.equal(result.pagination.total, 25);
  assert.equal(result.pagination.pages, 3);
  assert.equal(result.data.length, 1);
});

test('getRecentPatientRequests delegates to repo', async () => {
  const repo = createMockRepo({
    getRecentRequests: async () => [{ id: 'r-1', status: 'PENDING' }],
  });
  const service = createPatientService(repo);
  const result = await service.getRecentPatientRequests('p-1');
  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'PENDING');
});
