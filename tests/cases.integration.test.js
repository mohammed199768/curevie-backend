/**
 * End-to-end test of the order lifecycle against a real PostgreSQL database.
 *
 *   TEST_DATABASE_URL=postgres://user@localhost:5432/curevie_test npm run test:integration
 *
 * The target database is wiped (public schema dropped) on every run: never point it at real data.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = TEST_DATABASE_URL || '';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';
// No Redis in tests: the cache degrades to in-memory and socket.io runs on a single node.
delete process.env.REDIS_URL;
// Tests must never talk to the real CDN; private files go to local storage.
delete process.env.BUNNY_STORAGE_ZONE;
delete process.env.BUNNY_API_KEY;

const skip = !TEST_DATABASE_URL && 'TEST_DATABASE_URL is not set';

let server;
let baseUrl;
let pool;
const ids = {};
const tokens = {};

const MINIMAL_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'
);

async function api(method, path, { token, body, form, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (form) {
    init.body = form;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}/api/v1${path}`, init);
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, body: data, headers: res.headers };
}

async function login(email, password, role) {
  const res = await api('POST', '/auth/login', { body: { email, password, role } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { token: res.body.access_token, cookie: res.headers.get('set-cookie') };
}

function fileForm(buffer, name, type, extra = {}) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type }), name);
  Object.entries(extra).forEach(([key, value]) => form.append(key, value));
  return form;
}

before(async () => {
  if (skip) return;
  const { Client } = require('pg');
  const admin = new Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.end();

  const { runMigrations } = require('../config/runMigrations');
  await runMigrations({ log: () => {} });

  pool = require('../config/db');
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('Passw0rd!', 4);

  const area = await pool.query("SELECT id FROM areas WHERE slug = 'abdoun'");
  const otherArea = await pool.query("SELECT id FROM areas WHERE slug = 'khalda'");
  ids.area = area.rows[0].id;
  ids.otherArea = otherArea.rows[0].id;

  await pool.query('INSERT INTO admins (full_name, email, password) VALUES ($1, $2, $3)', ['Admin', 'admin@test.io', hash]);
  const providers = await pool.query(
    `INSERT INTO service_providers (full_name, email, password, type) VALUES
       ('Dr Area', 'doc.area@test.io', $1, 'DOCTOR'),
       ('Dr Far', 'doc.far@test.io', $1, 'DOCTOR'),
       ('Lab Tech', 'lab@test.io', $1, 'LAB_TECH')
     RETURNING id, email`,
    [hash]
  );
  for (const row of providers.rows) ids[row.email] = row.id;
  await pool.query('INSERT INTO provider_areas (provider_id, area_id) VALUES ($1, $2), ($3, $2)', [
    ids['doc.area@test.io'], ids.area, ids['lab@test.io'],
  ]);

  const services = await pool.query(
    `INSERT INTO services (name, price, service_kind, is_vip_exclusive, is_active) VALUES
       ('Home doctor visit', 25, 'MEDICAL', FALSE, TRUE),
       ('VIP visit', 50, 'MEDICAL', TRUE, TRUE),
       ('Old service', 5, 'MEDICAL', FALSE, FALSE)
     RETURNING id, name`
  );
  for (const row of services.rows) ids[row.name] = row.id;
  const lab = await pool.query("INSERT INTO services (name, price, service_kind) VALUES ('CBC', 7.5, 'LAB') RETURNING id");
  ids.labTest = lab.rows[0].id;
  const bundle = await pool.query("INSERT INTO packages (name, total_cost) VALUES ('Check-up', 30) RETURNING id");
  ids.package = bundle.rows[0].id;
  await pool.query('INSERT INTO package_services (package_id, service_id, display_order) VALUES ($1, $2, 1), ($1, $3, 2)', [
    ids.package, ids['Home doctor visit'], ids.labTest,
  ]);

  const app = require('../app');
  server = app.listen(0);
  require('../utils/socket').initSocketServer(server);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  tokens.admin = (await login('admin@test.io', 'Passw0rd!', 'ADMIN')).token;
  tokens.docArea = (await login('doc.area@test.io', 'Passw0rd!', 'PROVIDER')).token;
  tokens.docFar = (await login('doc.far@test.io', 'Passw0rd!', 'PROVIDER')).token;

  // A password containing "<" must survive validation untouched.
  const register = await api('POST', '/auth/register', {
    body: {
      full_name: 'Patient One',
      email: 'patient@test.io',
      password: 'Abc<12345',
      phone: '0790000000',
      address: 'Abdoun, street 1',
      area_id: ids.area,
    },
  });
  assert.equal(register.status, 201, JSON.stringify(register.body));
  ids.patient = register.body.user.id;
  tokens.patient = (await login('patient@test.io', 'Abc<12345', 'PATIENT')).token;
});

after(async () => {
  if (skip) return;
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  // The cache module may hold a pending Redis reconnect timer.
  setTimeout(() => process.exit(0), 100).unref();
});

test('ordering prices come from the server, never from the client', { skip }, async () => {
  const res = await api('POST', '/cases', {
    token: tokens.patient,
    body: {
      area_id: ids.area,
      items: [{ type: 'SERVICE', id: ids['Home doctor visit'], original_price: 0.001, bundle_price: 0 }],
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const view = res.body.data;
  assert.equal(Number(view.services[0].bundle_price), 25);
  assert.equal(Number(view.invoice.payment_status === 'PENDING'), 1);
  assert.equal(view.case.address, 'Abdoun, street 1', 'falls back to the profile address');
  ids.case1 = view.case.id;
  ids.case1Service = view.services[0].id;
});

test('order validation: duplicates, inactive, VIP-only and unknown area', { skip }, async () => {
  const dup = await api('POST', '/cases', {
    token: tokens.patient,
    body: { area_id: ids.area, items: [{ type: 'SERVICE', id: ids.labTest }, { type: 'SERVICE', id: ids.labTest }] },
  });
  assert.equal(dup.status, 400);

  const inactive = await api('POST', '/cases', {
    token: tokens.patient,
    body: { area_id: ids.area, items: [{ type: 'SERVICE', id: ids['Old service'] }] },
  });
  assert.equal(inactive.body.code, 'ITEM_INACTIVE');

  const vip = await api('POST', '/cases', {
    token: tokens.patient,
    body: { area_id: ids.area, items: [{ type: 'SERVICE', id: ids['VIP visit'] }] },
  });
  assert.equal(vip.status, 403);

  const area = await api('POST', '/cases', {
    token: tokens.patient,
    body: { area_id: '00000000-0000-4000-8000-000000000000', items: [{ type: 'SERVICE', id: ids.labTest }] },
  });
  assert.equal(area.body.code, 'INVALID_AREA');
});

test('VIP patients get their discount applied on the server', { skip }, async () => {
  await api('PUT', `/patients/${ids.patient}/vip`, { token: tokens.admin, body: { is_vip: true, vip_discount: 20 } });
  const res = await api('POST', '/cases', {
    token: tokens.patient,
    body: { area_id: ids.area, items: [{ type: 'SERVICE', id: ids['VIP visit'] }, { type: 'SERVICE', id: ids.labTest }] },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const prices = res.body.data.services.map((s) => Number(s.bundle_price)).sort((a, b) => a - b);
  assert.deepEqual(prices, [6, 40]);
  assert.equal(Number(res.body.data.invoice.final_amount), 46);
  assert.equal(Number(res.body.data.invoice.original_amount), 57.5);
  ids.case2 = res.body.data.case.id;
  ids.case2Services = res.body.data.services.map((s) => s.id);
  await api('PUT', `/patients/${ids.patient}/vip`, { token: tokens.admin, body: { is_vip: false } });
});

test('providers cannot read cases or patients they do not serve', { skip }, async () => {
  assert.equal((await api('GET', `/cases/${ids.case1}`, { token: tokens.docFar })).status, 404);
  assert.equal((await api('GET', `/patients/${ids.patient}`, { token: tokens.docFar })).status, 404);
  assert.equal((await api('GET', '/patients', { token: tokens.docFar })).status, 403);
  assert.equal((await api('PUT', `/patients/${ids.patient}/profile`, {
    token: tokens.docFar, body: { phone: '0711111111' },
  })).status, 404);
});

test('candidates are ranked by type and area', { skip }, async () => {
  const res = await api('GET', `/cases/${ids.case1}/services/${ids.case1Service}/candidates`, { token: tokens.admin });
  assert.equal(res.status, 200);
  const names = res.body.data.providers.map((p) => p.full_name);
  assert.deepEqual(names, ['Dr Area', 'Dr Far'], 'lab tech is excluded for a medical visit, area match first');
  assert.equal(res.body.data.providers[0].covers_area, true);
});

test('packages bundle services and lab items go to lab staff first', { skip }, async () => {
  const labOnly = await api('GET', '/services?service_kind=LAB');
  assert.equal(labOnly.status, 200, JSON.stringify(labOnly.body));
  assert.deepEqual(labOnly.body.data.map((s) => s.name), ['CBC']);

  const catalog = await api('GET', '/packages');
  assert.equal(catalog.status, 200);
  const bundle = catalog.body.data.find((p) => p.id === ids.package);
  assert.deepEqual(bundle.services.map((s) => s.name), ['Home doctor visit', 'CBC']);
  assert.equal(bundle.savings, '2.500');

  const order = await api('POST', '/cases', {
    token: tokens.patient,
    body: { area_id: ids.area, items: [{ type: 'PACKAGE', id: ids.package }, { type: 'SERVICE', id: ids.labTest }] },
  });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  assert.equal(Number(order.body.data.invoice.final_amount), 37.5);

  const labLine = order.body.data.services.find((s) => s.item_name === 'CBC');
  assert.equal(labLine.service_kind, 'LAB');
  const candidates = await api('GET', `/cases/${order.body.data.case.id}/services/${labLine.id}/candidates`, { token: tokens.admin });
  assert.deepEqual(candidates.body.data.allowed_provider_types, ['LAB_TECH', 'NURSE', 'DOCTOR']);
  assert.deepEqual(candidates.body.data.providers.map((p) => p.full_name), ['Lab Tech', 'Dr Area', 'Dr Far'],
    'in-area providers first, then the preferred type for the kind');

  await api('POST', `/cases/${order.body.data.case.id}/cancel`, { token: tokens.patient, body: {} });
});

test('full lifecycle: assign, accept, start, upload, complete, pay, close, rate', { skip }, async () => {
  const assign = await api('POST', `/cases/${ids.case1}/assign-team`, {
    token: tokens.admin,
    body: { assignments: [{ case_service_id: ids.case1Service, provider_id: ids['doc.area@test.io'] }], lead_provider_id: ids['doc.area@test.io'] },
  });
  assert.equal(assign.status, 200, JSON.stringify(assign.body));
  assert.equal(assign.body.data.case.status, 'ACCEPTED');
  assert.equal(assign.body.data.case.lead_provider_id, ids['doc.area@test.io']);

  assert.equal((await api('PUT', `/cases/${ids.case1}/services/${ids.case1Service}/accept`, { token: tokens.docFar })).status, 404);
  assert.equal((await api('PUT', `/cases/${ids.case1}/services/${ids.case1Service}/complete`, { token: tokens.docArea })).status, 409,
    'cannot complete before starting');

  const accepted = await api('PUT', `/cases/${ids.case1}/services/${ids.case1Service}/accept`, { token: tokens.docArea });
  assert.equal(accepted.body.data.services[0].status, 'ACCEPTED');

  const earlyUpload = await api('POST', `/cases/${ids.case1}/services/${ids.case1Service}/files`, {
    token: tokens.docArea, form: fileForm(MINIMAL_PDF, 'r.pdf', 'application/pdf'),
  });
  assert.equal(earlyUpload.status, 409, 'uploads need a started service');

  const started = await api('PUT', `/cases/${ids.case1}/services/${ids.case1Service}/start`, { token: tokens.docArea });
  assert.equal(started.body.data.case.status, 'IN_PROGRESS');

  const cancel = await api('POST', `/cases/${ids.case1}/cancel`, { token: tokens.patient, body: { reason: 'changed my mind' } });
  assert.equal(cancel.body.code, 'CASE_IN_PROGRESS');

  const disguised = await api('POST', `/cases/${ids.case1}/services/${ids.case1Service}/files`, {
    token: tokens.docArea, form: fileForm(Buffer.from('<html><script>alert(1)</script></html>'), 'x.pdf', 'application/pdf'),
  });
  assert.equal(disguised.status, 400, 'HTML disguised as PDF is rejected by magic bytes');

  const upload = await api('POST', `/cases/${ids.case1}/services/${ids.case1Service}/files`, {
    token: tokens.docArea, form: fileForm(MINIMAL_PDF, 'result.pdf', 'application/pdf'),
  });
  assert.equal(upload.status, 201, JSON.stringify(upload.body));
  ids.file = upload.body.data.id;
  assert.equal(upload.body.data.file_url, undefined, 'storage key never leaves the API');

  assert.equal((await api('GET', `/cases/${ids.case1}/files/${ids.file}`, { token: tokens.patient })).status, 404,
    'patient sees files only after the case is closed');

  const completed = await api('PUT', `/cases/${ids.case1}/services/${ids.case1Service}/complete`, { token: tokens.docArea });
  assert.equal(completed.body.data.case.status, 'COMPLETED');

  const overpay = await api('POST', `/cases/${ids.case1}/invoice/payments`, { token: tokens.admin, body: { amount: 30, method: 'CASH' } });
  assert.equal(overpay.body.code, 'OVERPAYMENT');
  const partial = await api('POST', `/cases/${ids.case1}/invoice/payments`, { token: tokens.admin, body: { amount: 10, method: 'CASH' } });
  assert.equal(partial.body.summary.payment_status, 'PARTIAL');
  const full = await api('POST', `/cases/${ids.case1}/invoice/payments`, { token: tokens.admin, body: { amount: 15, method: 'CLICK' } });
  assert.equal(full.body.summary.payment_status, 'PAID');

  const discount = await api('POST', `/cases/${ids.case1}/invoice/adjustments`, {
    token: tokens.admin, body: { amount: 5, type: 'DISCOUNT', reason: 'loyalty' },
  });
  assert.equal(discount.body.code, 'REFUND_REQUIRED', 'cannot discount below what was paid');

  assert.equal((await api('GET', `/cases/${ids.case1}/invoice`, { token: tokens.patient })).status, 403, 'invoice hidden until close');

  const closed = await api('POST', `/cases/${ids.case1}/close`, { token: tokens.admin, body: { notes: 'ok' } });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.data.case.status, 'CLOSED');

  const invoice = await api('GET', `/cases/${ids.case1}/invoice`, { token: tokens.patient });
  assert.equal(invoice.status, 200);
  assert.equal(Number(invoice.body.invoice.total_paid), 25);

  const download = await api('GET', `/cases/${ids.case1}/files/${ids.file}`, { token: tokens.patient });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.compare(download.body, MINIMAL_PDF), 0);

  const rate = await api('POST', `/cases/${ids.case1}/services/${ids.case1Service}/rate`, {
    token: tokens.patient, body: { rating: 4, comment: 'great' },
  });
  assert.equal(rate.status, 201);
  const again = await api('POST', `/cases/${ids.case1}/services/${ids.case1Service}/rate`, {
    token: tokens.patient, body: { rating: 5 },
  });
  assert.equal(again.body.code, 'ALREADY_RATED');

  const ratings = await api('GET', `/providers/${ids['doc.area@test.io']}/ratings`, { token: tokens.docArea });
  assert.equal(ratings.body.summary.total_ratings, 1);
  assert.equal(ratings.body.summary.average_rating, 4);
});

test('a case closes without any provider upload or medical report', { skip }, async () => {
  const order = await api('POST', '/cases', {
    token: tokens.patient,
    body: { area_id: ids.area, items: [{ type: 'SERVICE', id: ids['Home doctor visit'] }] },
  });
  assert.equal(order.status, 201, JSON.stringify(order.body));
  const caseId = order.body.data.case.id;
  const lineId = order.body.data.services[0].id;

  await api('POST', `/cases/${caseId}/assign-team`, {
    token: tokens.admin,
    body: { assignments: [{ case_service_id: lineId, provider_id: ids['doc.area@test.io'] }], lead_provider_id: ids['doc.area@test.io'] },
  });
  for (const step of ['accept', 'start', 'complete']) {
    const res = await api('PUT', `/cases/${caseId}/services/${lineId}/${step}`, { token: tokens.docArea });
    assert.equal(res.status, 200, `${step}: ${JSON.stringify(res.body)}`);
  }

  const files = await pool.query('SELECT COUNT(*)::int AS n FROM case_provider_files WHERE case_service_id = $1', [lineId]);
  assert.equal(files.rows[0].n, 0, 'nothing was uploaded');

  const closed = await api('POST', `/cases/${caseId}/close`, { token: tokens.admin, body: {} });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.data.case.status, 'CLOSED');

  const invoice = await api('GET', `/cases/${caseId}/invoice`, { token: tokens.patient });
  assert.equal(invoice.status, 200, 'the patient gets the invoice even without a report');
});

test('public catalog counts match what a visitor can order', { skip }, async () => {
  const res = await api('GET', '/services/counts');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const byKind = Object.fromEntries(res.body.data.services.map((row) => [row.service_kind, row.count]));
  assert.deepEqual(byKind, { MEDICAL: 1, LAB: 1 }, 'inactive and VIP-only services are not counted');
  assert.equal(res.body.data.packages, 1);
});

test('rejecting an assignment returns it to the admin and revokes access', { skip }, async () => {
  const [visitId] = await pool.query(
    "SELECT id FROM case_services WHERE case_id = $1 AND item_type = 'SERVICE' AND item_name = 'VIP visit'", [ids.case2]
  ).then((r) => r.rows.map((row) => row.id));

  await api('POST', `/cases/${ids.case2}/assign-team`, {
    token: tokens.admin, body: { assignments: [{ case_service_id: visitId, provider_id: ids['doc.area@test.io'] }] },
  });
  const rooms = await api('GET', `/cases/${ids.case2}/chat-rooms`, { token: tokens.patient });
  assert.equal(rooms.body.data.length, 1);
  const roomId = rooms.body.data[0].id;

  const send = await api('POST', `/cases/chat/rooms/${roomId}/messages`, { token: tokens.patient, form: (() => {
    const form = new FormData();
    form.append('content', 'Hello doctor <b>bold</b>');
    return form;
  })() });
  assert.equal(send.status, 201, JSON.stringify(send.body));
  const read = await api('GET', `/cases/chat/rooms/${roomId}/messages`, { token: tokens.docArea });
  assert.equal(read.body.data.length, 1);

  const noReason = await api('PUT', `/cases/${ids.case2}/services/${visitId}/reject`, { token: tokens.docArea, body: {} });
  assert.equal(noReason.status, 400);
  const reject = await api('PUT', `/cases/${ids.case2}/services/${visitId}/reject`, {
    token: tokens.docArea, body: { reason: 'Not available today' },
  });
  assert.equal(reject.status, 200, JSON.stringify(reject.body));
  assert.equal(reject.body.data.status, 'PENDING');

  assert.equal((await api('GET', `/cases/${ids.case2}`, { token: tokens.docArea })).status, 404);
  assert.equal((await api('GET', `/cases/chat/rooms/${roomId}/messages`, { token: tokens.docArea })).status, 404);

  const detail = await api('GET', `/cases/${ids.case2}`, { token: tokens.admin });
  assert.equal(detail.body.data.case.status, 'PENDING');
  assert.ok(detail.body.data.lifecycle.some((e) => e.event_type === 'SERVICE_REJECTED'));
});

test('admin cancels one line item and the invoice follows', { skip }, async () => {
  const labLine = await pool.query("SELECT id FROM case_services WHERE case_id = $1 AND item_type = 'SERVICE' AND item_name = 'CBC'", [ids.case2]);
  const res = await api('POST', `/cases/${ids.case2}/services/${labLine.rows[0].id}/cancel`, {
    token: tokens.admin, body: { reason: 'lab closed' },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(Number(res.body.data.invoice.final_amount), 40);
});

test('patient cancels a pending order', { skip }, async () => {
  const res = await api('POST', `/cases/${ids.case2}/cancel`, { token: tokens.patient, body: { reason: 'travelling' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.case.status, 'CANCELLED');
  assert.equal(res.body.data.invoice.payment_status, 'CANCELLED');
  const again = await api('POST', `/cases/${ids.case2}/cancel`, { token: tokens.patient, body: {} });
  assert.equal(again.status, 409);
});

test('guest orders get a tracking token that a patient can claim', { skip }, async () => {
  const res = await api('POST', '/cases/public', {
    body: {
      guest_name: 'Guest Person',
      guest_phone: '0781234567',
      address: 'Khalda, building 3',
      area_id: ids.otherArea,
      items: [{ type: 'SERVICE', id: ids.labTest, bundle_price: 0 }],
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const token = res.body.data.tracking_token;
  assert.ok(token && token.length >= 20);
  assert.equal(Number(res.body.data.case.services[0].bundle_price), 7.5);

  const track = await api('GET', `/cases/track/${token}`);
  assert.equal(track.status, 200);
  assert.equal(track.body.data.status, 'PENDING');
  assert.equal(JSON.stringify(track.body).includes('0781234567'), false, 'tracking view hides contact details');

  assert.equal((await api('GET', '/cases/track/not-a-real-token-1234567890')).status, 404);

  const claim = await api('POST', '/cases/claim', { token: tokens.patient, body: { tracking_token: token } });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  assert.equal(claim.body.data.case.patient_id, ids.patient);
  assert.equal((await api('GET', `/cases/track/${token}`)).status, 404, 'token is consumed by the claim');
});

test('provider accounts: self-edit limits, disable revokes sessions', { skip }, async () => {
  const escalate = await api('PUT', `/providers/${ids['doc.far@test.io']}`, { token: tokens.docFar, body: { is_active: true } });
  assert.equal(escalate.status, 403);

  const offline = await api('PUT', '/providers/me/availability', { token: tokens.docFar, body: { is_available: false } });
  assert.equal(offline.body.is_available, false);

  const session = await login('doc.far@test.io', 'Passw0rd!', 'PROVIDER');
  const disable = await api('PUT', `/providers/${ids['doc.far@test.io']}`, { token: tokens.admin, body: { is_active: false } });
  assert.equal(disable.status, 200);

  const refresh = await fetch(`${baseUrl}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { Cookie: session.cookie.split(';')[0], 'X-Auth-Role': 'PROVIDER' },
  });
  assert.equal(refresh.status, 401);

  assert.equal((await refresh.json()).code, 'ACCOUNT_INACTIVE');

  const relogin = await api('POST', '/auth/login', { body: { email: 'doc.far@test.io', password: 'Passw0rd!', role: 'PROVIDER' } });
  assert.equal(relogin.status, 401);
});

test('refresh tokens rotate and reuse revokes the family', { skip }, async () => {
  const session = await login('patient@test.io', 'Abc<12345', 'PATIENT');
  const cookie = session.cookie.split(';')[0];
  const first = await fetch(`${baseUrl}/api/v1/auth/refresh`, { method: 'POST', headers: { Cookie: cookie, 'X-Auth-Role': 'PATIENT' } });
  assert.equal(first.status, 200);
  const reuse = await fetch(`${baseUrl}/api/v1/auth/refresh`, { method: 'POST', headers: { Cookie: cookie, 'X-Auth-Role': 'PATIENT' } });
  assert.equal((await reuse.json()).code, 'TOKEN_REUSE_DETECTED');

  const { rows } = await pool.query('SELECT token_hash FROM refresh_tokens LIMIT 1');
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/, 'only hashes are stored');
});

test('admin listings and the financial report', { skip }, async () => {
  const list = await api('GET', '/cases?limit=100', { token: tokens.admin });
  assert.equal(list.status, 200);
  assert.ok(list.body.data.total >= 3);

  const mine = await api('GET', '/cases', { token: tokens.patient });
  assert.ok(mine.body.data.cases.every((c) => c.patient_name === 'Patient One'));

  const providerList = await api('GET', '/cases', { token: tokens.docArea });
  assert.ok(providerList.body.data.cases.every((c) => Array.isArray(c.my_services)));
  assert.equal(providerList.body.data.cases[0].final_amount, undefined, 'providers do not see billing');

  const invoices = await api('GET', '/cases/invoices', { token: tokens.admin });
  assert.equal(invoices.status, 200);

  const report = await api('GET', '/reports/cases/financial?period=yearly', { token: tokens.admin });
  assert.equal(report.status, 200, JSON.stringify(report.body));
  assert.equal(Number(report.body.summary.collected_revenue), 25);

  const areas = await api('GET', '/areas');
  assert.equal(areas.body.data.length, 39);
});

/**
 * Minimal socket.io v4 client over a raw WebSocket (engine.io protocol 4), enough for tests.
 * Packets: "0" open, "2"/"3" ping/pong, "40" connect (with auth), "44" connect error, "42" event.
 */
function socketClient(token) {
  const WebSocket = require('ws');
  const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/socket.io/?EIO=4&transport=websocket`);
  const events = [];
  const waiters = [];
  const flush = () => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const index = events.findIndex((e) => e.name === waiters[i].name);
      if (index >= 0) waiters.splice(i, 1)[0].resolve(events.splice(index, 1)[0].payload);
    }
  };
  ws.on('message', (raw) => {
    const packet = raw.toString();
    if (packet.startsWith('0')) ws.send(`40${JSON.stringify(token ? { token } : {})}`);
    else if (packet === '2') ws.send('3');
    else if (packet.startsWith('40')) events.push({ name: 'connect' });
    else if (packet.startsWith('44')) events.push({ name: 'connect_error', payload: JSON.parse(packet.slice(2)) });
    else if (packet.startsWith('42')) {
      const [name, payload] = JSON.parse(packet.slice(2));
      events.push({ name, payload });
    }
    flush();
  });
  return {
    emit: (name, payload) => ws.send(`42${JSON.stringify([name, payload])}`),
    next: (name, timeoutMs = 3000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${name}`)), timeoutMs);
      waiters.push({ name, resolve: (payload) => { clearTimeout(timer); resolve(payload); } });
      flush();
    }),
    close: () => ws.close(),
  };
}

test('socket.io: auth, room access, live messages and case updates', { skip }, async () => {
  const anonymous = socketClient(null);
  const refused = await anonymous.next('connect_error');
  assert.match(refused.message, /Authentication required/);
  anonymous.close();

  const order = await api('POST', '/cases', {
    token: tokens.patient,
    body: { area_id: ids.area, items: [{ type: 'SERVICE', id: ids['Home doctor visit'] }] },
  });
  const caseId = order.body.data.case.id;
  const serviceId = order.body.data.services[0].id;
  const assigned = await api('POST', `/cases/${caseId}/assign-team`, {
    token: tokens.admin, body: { assignments: [{ case_service_id: serviceId, provider_id: ids['doc.area@test.io'] }] },
  });
  const roomId = assigned.body.data.services[0].chat_room_id;
  assert.ok(roomId);

  const patient = socketClient(tokens.patient);
  const doctor = socketClient(tokens.docArea);
  await Promise.all([patient.next('connect'), doctor.next('connect')]);

  patient.emit('join_room', { room_id: roomId });
  doctor.emit('join_room', { room_id: roomId });
  await Promise.all([patient.next('joined_room'), doctor.next('joined_room')]);

  doctor.emit('send_message', { room_id: roomId, content: 'I will be there at 5' });
  const message = await patient.next('new_message');
  assert.equal(message.content, 'I will be there at 5');
  assert.equal(message.sender_role, 'PROVIDER');

  const caseUpdate = patient.next('case:updated');
  await api('PUT', `/cases/${caseId}/services/${serviceId}/accept`, { token: tokens.docArea });
  const update = await caseUpdate;
  assert.equal(update.case_id, caseId);
  assert.equal(update.service_status, 'ACCEPTED');

  const outsider = socketClient((await login('lab@test.io', 'Passw0rd!', 'PROVIDER')).token);
  await outsider.next('connect');
  outsider.emit('join_room', { room_id: roomId });
  const denied = await outsider.next('error');
  assert.match(denied.message, /access denied/i);

  [patient, doctor, outsider].forEach((client) => client.close());
});

test('deleting a patient is a soft delete that keeps their cases', { skip }, async () => {
  const del = await api('DELETE', `/patients/${ids.patient}`, { token: tokens.admin });
  assert.equal(del.status, 200);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM cases WHERE patient_id = $1', [ids.patient]);
  assert.ok(rows[0].count >= 3);
  const relogin = await api('POST', '/auth/login', { body: { email: 'patient@test.io', password: 'Abc<12345', role: 'PATIENT' } });
  assert.equal(relogin.status, 401);
});
