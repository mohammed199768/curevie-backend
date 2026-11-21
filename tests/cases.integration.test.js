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
  // Older tests check their own totals; the lab home-visit fee has dedicated tests that switch it on.
  await pool.query("UPDATE app_settings SET value = '{\"amount\": 0}'::jsonb WHERE key = 'lab.home_visit_fee'");
  // Likewise identity checks: their own test switches them on.
  await pool.query("UPDATE app_settings SET value = '{\"require_id\": false, \"require_phone\": false}'::jsonb WHERE key = 'verification'");
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
  process.env.PUBLIC_API_URL = baseUrl;

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

test('orders get a unique 6-digit number and candidates follow the care recipient', { skip }, async () => {
  await pool.query("UPDATE service_providers SET gender = 'MALE' WHERE id = $1", [ids['doc.area@test.io']]);
  await pool.query("UPDATE service_providers SET gender = 'FEMALE', serves_children = FALSE WHERE id = $1", [ids['doc.far@test.io']]);
  try {
    const order = (recipient) => api('POST', '/cases', {
      token: tokens.patient,
      body: { area_id: ids.area, items: [{ type: 'SERVICE', id: ids['Home doctor visit'] }], ...recipient },
    });
    const candidates = async (view) => (await api(
      'GET',
      `/cases/${view.case.id}/services/${view.services[0].id}/candidates`,
      { token: tokens.admin }
    )).body.data;

    const woman = await order({ recipient_gender: 'FEMALE', recipient_age_group: 'ADULT' });
    assert.equal(woman.status, 201, JSON.stringify(woman.body));
    assert.match(woman.body.data.case.reference_number, /^[1-9]\d{5}$/);
    assert.equal(woman.body.data.case.recipient_gender, 'FEMALE');
    assert.equal(woman.body.data.case.recipient_age_group, 'ADULT');

    const forWoman = await candidates(woman.body.data);
    assert.deepEqual(forWoman.providers.map((p) => p.full_name), ['Dr Far', 'Dr Area'],
      'the female doctor ranks first although she does not cover the area');
    assert.equal(forWoman.providers[0].gender_match, true);
    assert.equal(forWoman.providers[1].gender_match, false);
    assert.equal(forWoman.recipient_gender, 'FEMALE');

    const boy = await order({ recipient_gender: 'MALE', recipient_age_group: 'CHILD' });
    const forBoy = await candidates(boy.body.data);
    assert.deepEqual(forBoy.providers.map((p) => p.full_name), ['Dr Area', 'Dr Far']);
    assert.equal(forBoy.providers[1].age_match, false, 'Dr Far does not see children');

    const unknown = await order({});
    assert.equal(unknown.status, 201, 'recipient is optional for older clients');
    assert.equal(unknown.body.data.case.recipient_gender, null);

    const bad = await order({ recipient_gender: 'OTHER' });
    assert.equal(bad.status, 400);

    const { rows } = await pool.query('SELECT COUNT(*)::int AS total, COUNT(DISTINCT reference_number)::int AS unique FROM cases');
    assert.equal(rows[0].total, rows[0].unique, 'every order number is unique');

    const ref = woman.body.data.case.reference_number;
    const found = await api('GET', `/cases?search=${encodeURIComponent(`#${ref}`)}`, { token: tokens.admin });
    assert.deepEqual(found.body.data.cases.map((c) => c.id), [woman.body.data.case.id], 'admin finds an order by its number');
    assert.equal(found.body.data.cases[0].reference_number, ref);

    const guest = await api('POST', '/cases/public', {
      body: {
        guest_name: 'Guest Two', guest_phone: '0781112222', address: 'Abdoun, building 9', area_id: ids.area,
        items: [{ type: 'SERVICE', id: ids.labTest }], recipient_gender: 'FEMALE', recipient_age_group: 'CHILD',
      },
    });
    assert.equal(guest.status, 201, JSON.stringify(guest.body));
    const track = await api('GET', `/cases/track/${guest.body.data.tracking_token}`);
    assert.match(track.body.data.reference, /^#[1-9]\d{5}$/);
    assert.equal(track.body.data.recipient_age_group, 'CHILD');

    for (const view of [woman.body.data, boy.body.data, unknown.body.data]) {
      await api('POST', `/cases/${view.case.id}/cancel`, { token: tokens.patient, body: {} });
    }
  } finally {
    await pool.query('UPDATE service_providers SET gender = NULL, serves_children = TRUE WHERE id = ANY($1::uuid[])', [
      [ids['doc.area@test.io'], ids['doc.far@test.io']],
    ]);
  }
});

test('admins record a provider gender and the age groups they serve', { skip }, async () => {
  const update = await api('PUT', `/providers/${ids['lab@test.io']}`, {
    token: tokens.admin,
    body: { gender: 'FEMALE', serves_children: false },
  });
  assert.equal(update.status, 200, JSON.stringify(update.body));
  assert.equal(update.body.gender, 'FEMALE');
  assert.equal(update.body.serves_children, false);
  assert.equal(update.body.serves_adults, true);
  assert.equal((await api('PUT', `/providers/${ids['lab@test.io']}`, { token: tokens.admin, body: { gender: 'X' } })).status, 400);
  await api('PUT', `/providers/${ids['lab@test.io']}`, { token: tokens.admin, body: { gender: null, serves_children: true } });
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

test('payment status follows every payment, deletion, adjustment and finalization live', { skip }, async () => {
  const order = await api('POST', '/cases', {
    token: tokens.patient,
    body: { area_id: ids.area, items: [{ type: 'SERVICE', id: ids['Home doctor visit'] }] },
  });
  const caseId = order.body.data.case.id;
  const lineId = order.body.data.services[0].id;
  assert.equal(order.body.data.invoice.payment_status, 'PENDING');
  await api('POST', `/cases/${caseId}/assign-team`, {
    token: tokens.admin,
    body: { assignments: [{ case_service_id: lineId, provider_id: ids['doc.area@test.io'] }], lead_provider_id: ids['doc.area@test.io'] },
  });

  const lead = socketClient(tokens.docArea);
  await lead.next('connect');
  const status = async () => (await api('GET', `/cases/${caseId}/invoice`, { token: tokens.admin })).body.invoice;
  const pay = (amount, method) => api('POST', `/cases/${caseId}/invoice/payments`, { token: tokens.admin, body: { amount, method } });

  const first = await pay(10, 'CASH');
  assert.equal(first.body.summary.payment_status, 'PARTIAL');
  const live = await lead.next('case:updated');
  assert.equal(live.case_id, caseId);
  assert.equal(live.event, 'PAYMENT_RECORDED');

  const second = await pay(15, 'CLICK');
  assert.equal(second.body.summary.payment_status, 'PAID');
  assert.equal((await status()).payment_method, 'CLICK');
  await lead.next('case:updated');

  await api('DELETE', `/cases/${caseId}/invoice/payments/${second.body.payment.id}`, { token: tokens.admin });
  const afterDelete = await status();
  assert.equal(afterDelete.payment_status, 'PARTIAL');
  assert.equal(Number(afterDelete.remaining_amount), 15);
  assert.equal(afterDelete.payment_method, null, 'method is cleared once the invoice is no longer paid');
  assert.equal((await lead.next('case:updated')).event, 'PAYMENT_DELETED');

  await pay(15, 'CARD');
  await lead.next('case:updated');
  await api('POST', `/cases/${caseId}/invoice/adjustments`, {
    token: tokens.admin, body: { amount: 5, type: 'SURCHARGE', reason: 'extra supplies' },
  });
  const surcharged = await status();
  assert.equal(surcharged.payment_status, 'PARTIAL', 'a surcharge reopens a paid invoice');
  assert.equal(Number(surcharged.remaining_amount), 5);
  assert.equal((await lead.next('case:updated')).event, 'INVOICE_ADJUSTED');

  await pay(5, 'CASH');
  await lead.next('case:updated');
  const finalized = await api('PUT', `/cases/${caseId}/invoice/finalize`, { token: tokens.admin });
  assert.equal(finalized.status, 200);
  assert.equal((await lead.next('case:updated')).event, 'INVOICE_FINALIZED');
  const payments = (await api('GET', `/cases/${caseId}/invoice`, { token: tokens.admin })).body.payments;
  const locked = await api('DELETE', `/cases/${caseId}/invoice/payments/${payments[0].id}`, { token: tokens.admin });
  assert.equal(locked.body.code, 'INVOICE_FINALIZED');
  const events = await pool.query('SELECT event_type FROM case_lifecycle_events WHERE case_id = $1 ORDER BY created_at', [caseId]);
  assert.ok(events.rows.some((row) => row.event_type === 'INVOICE_FINALIZED'));

  const patientView = (await api('GET', `/cases/${caseId}`, { token: tokens.patient })).body.data.invoice;
  assert.deepEqual(Object.keys(patientView).sort(), ['final_amount', 'is_patient_visible', 'original_amount', 'payment_status'],
    'before closing, the patient sees only the summary');
  assert.equal(patientView.payment_status, 'PAID');
  lead.close();
  await api('POST', `/cases/${caseId}/services/${lineId}/cancel`, { token: tokens.admin, body: {} }).catch(() => {});
});

test('CliQ details are edited by the admin and shown publicly only when complete', { skip }, async () => {
  assert.equal((await api('GET', '/settings/public')).body.data.cliq, null, 'no alias yet, so nothing to show');
  assert.equal((await api('PUT', '/settings/payments.cliq', {
    token: tokens.patient, body: { enabled: true, alias: 'X', beneficiary_name: 'Y' },
  })).status, 403);
  const invalid = await api('PUT', '/settings/payments.cliq', {
    token: tokens.admin, body: { enabled: true, alias: '', beneficiary_name: 'Curevie' },
  });
  assert.equal(invalid.status, 400);
  const saved = await api('PUT', '/settings/payments.cliq', {
    token: tokens.admin, body: { enabled: true, alias: 'CUREVIE', beneficiary_name: 'Curevie Home Care', bank_name: 'Test Bank' },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const cliq = (await api('GET', '/settings/public')).body.data.cliq;
  assert.equal(cliq.alias, 'CUREVIE');
  assert.equal(cliq.beneficiary_name, 'Curevie Home Care');
  await api('PUT', '/settings/payments.cliq', { token: tokens.admin, body: { enabled: false, alias: 'CUREVIE', beneficiary_name: 'Curevie Home Care' } });
  assert.equal((await api('GET', '/settings/public')).body.data.cliq, null, 'switched off');
});

test('provider earnings: share per item or default, locked at completion, adjusted and paid out', { skip }, async () => {
  const visit = ids['Home doctor visit'];
  const setShare = (body) => api('PUT', `/services/${visit}`, { token: tokens.admin, body });
  assert.equal((await setShare({ provider_share_type: 'PERCENT', provider_share_value: 120 })).status, 400);
  assert.equal((await setShare({ provider_share_type: 'FIXED', provider_share_value: 10 })).status, 200);

  const publicList = (await api('GET', '/services')).body.data.find((s) => s.id === visit);
  assert.equal('provider_share_type' in publicList, false, 'the share is never public');
  const adminList = (await api('GET', '/services', { token: tokens.admin })).body.data.find((s) => s.id === visit);
  assert.equal(adminList.provider_share_type, 'FIXED');

  const order = await api('POST', '/cases', {
    token: tokens.patient,
    body: { area_id: ids.area, items: [{ type: 'SERVICE', id: visit }, { type: 'SERVICE', id: ids.labTest }] },
  });
  const caseId = order.body.data.case.id;
  const visitLine = order.body.data.services.find((s) => s.service_id === visit).id;
  const labLine = order.body.data.services.find((s) => s.service_id === ids.labTest).id;
  await api('POST', `/cases/${caseId}/assign-team`, {
    token: tokens.admin,
    body: {
      assignments: [
        { case_service_id: visitLine, provider_id: ids['doc.area@test.io'] },
        { case_service_id: labLine, provider_id: ids['doc.area@test.io'] },
      ],
      lead_provider_id: ids['doc.area@test.io'],
    },
  });

  const before = (await api('GET', `/cases/${caseId}`, { token: tokens.docArea })).body.data.services;
  const visitEstimate = before.find((s) => s.id === visitLine).my_earning;
  assert.deepEqual([visitEstimate.amount, visitEstimate.locked, visitEstimate.share_source], [10, false, 'ITEM']);
  const labEstimate = before.find((s) => s.id === labLine).my_earning;
  assert.deepEqual([labEstimate.amount, labEstimate.share_source], [5.25, 'DEFAULT'], '70% default of 7.5');
  assert.equal((await api('GET', `/cases/${caseId}`, { token: tokens.patient })).body.data.services[0].my_earning, undefined);

  const listed = (await api('GET', '/cases?limit=100', { token: tokens.docArea })).body.data.cases.find((c) => c.id === caseId);
  assert.equal(listed.my_earning_total, 15.25);

  for (const line of [visitLine, labLine]) {
    for (const step of ['accept', 'start', 'complete']) {
      assert.equal((await api('PUT', `/cases/${caseId}/services/${line}/${step}`, { token: tokens.docArea })).status, 200);
    }
  }
  await setShare({ provider_share_type: 'PERCENT', provider_share_value: 50 });
  const adminView = (await api('GET', `/cases/${caseId}`, { token: tokens.admin })).body.data.services;
  assert.deepEqual(
    [adminView.find((s) => s.id === visitLine).provider_earning.amount, adminView.find((s) => s.id === visitLine).provider_earning.locked],
    [10, true],
    'later catalog changes do not touch a locked earning'
  );

  const mine = await api('GET', '/earnings/me?status=PENDING', { token: tokens.docArea });
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  const row = mine.body.data.find((e) => e.case_service_id === labLine);
  assert.equal(Number(row.amount), 5.25);

  const adjusted = await api('PATCH', `/earnings/${row.id}`, { token: tokens.admin, body: { amount: 6, reason: 'night visit' } });
  assert.equal(Number(adjusted.body.data.amount), 6);
  assert.equal(Number(adjusted.body.data.calculated_amount), 5.25, 'the calculated amount is kept for review');
  assert.equal((await api('PATCH', `/earnings/${row.id}`, { token: tokens.docArea, body: { amount: 99, reason: 'me' } })).status, 403);

  const balances = (await api('GET', '/earnings/balances', { token: tokens.admin })).body.data;
  const docBalance = balances.find((b) => b.provider_id === ids['doc.area@test.io']);
  assert.ok(docBalance.pending_total >= 16);

  const payout = await api('POST', '/earnings/payouts', {
    token: tokens.admin, body: { provider_id: ids['doc.area@test.io'], earning_ids: [row.id], method: 'CLICK', reference: 'TX-1' },
  });
  assert.equal(payout.status, 201, JSON.stringify(payout.body));
  assert.equal(Number(payout.body.data.payout.amount), 6);
  assert.equal((await api('PATCH', `/earnings/${row.id}`, { token: tokens.admin, body: { amount: 1, reason: 'late fix' } })).body.code, 'EARNING_PAID');
  const again = await api('POST', '/earnings/payouts', {
    token: tokens.admin, body: { provider_id: ids['doc.area@test.io'], earning_ids: [row.id], method: 'CASH' },
  });
  assert.equal(again.body.code, 'EARNINGS_NOT_PENDING', 'an earning is never paid twice');

  const after = await api('GET', '/earnings/me', { token: tokens.docArea });
  assert.ok(after.body.payouts.some((p) => p.id === payout.body.data.payout.id));
  assert.equal(after.body.payouts[0].created_by, undefined);

  await setShare({ provider_share_type: null, provider_share_value: null });
});

test('public catalog counts match what a visitor can order', { skip }, async () => {
  const res = await api('GET', '/services/counts');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const byKind = Object.fromEntries(res.body.data.services.map((row) => [row.service_kind, row.count]));
  assert.deepEqual(byKind, { MEDICAL: 1, LAB: 1 }, 'inactive and VIP-only services are not counted');
  assert.equal(res.body.data.packages, 1);
});

test('catalog images are stored on disk and served publicly', { skip }, async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const upload = (name) => api('PUT', `/services/${ids['Home doctor visit']}/image`, {
    token: tokens.admin, form: fileForm(png, name, 'image/png'),
  });

  const first = await upload('a.png');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.ok(first.body.image_url.startsWith(`${baseUrl}/api/v1/media/services/`), first.body.image_url);
  assert.match(first.body.image_url, /\/[0-9a-f-]{36}\.png$/);

  const image = await fetch(first.body.image_url);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.match(image.headers.get('cache-control'), /immutable/);
  assert.equal(Buffer.compare(Buffer.from(await image.arrayBuffer()), png), 0);

  const second = await upload('b.png');
  assert.notEqual(second.body.image_url, first.body.image_url);
  assert.equal((await fetch(first.body.image_url)).status, 404, 'the replaced image is deleted');
  assert.equal((await fetch(`${baseUrl}/api/v1/media/..%2F..%2F.env`)).status, 404, 'no path traversal');
  assert.equal((await fetch(`${baseUrl}/api/v1/media/..%2Fprivate%2Fx`)).status, 404);
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
  const collected = await pool.query("SELECT COALESCE(SUM(amount), 0) AS total FROM case_payment_records WHERE approval_status = 'APPROVED'");
  assert.equal(Number(report.body.summary.collected_revenue), Number(collected.rows[0].total));
  assert.ok(Number(collected.rows[0].total) > 0);

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

test('lab orders go straight to the partner lab with one home-visit fee', { skip }, async () => {
  const setting = (key, body) => api('PUT', `/settings/${key}`, { token: tokens.admin, body });
  const bad = await setting('routing.partners', { lab_provider_id: ids.patient, radiology_provider_id: null });
  assert.equal(bad.body.code, 'INVALID_PARTNER', 'a patient id cannot be the lab partner');
  assert.equal((await setting('routing.partners', { lab_provider_id: ids['lab@test.io'], radiology_provider_id: null })).status, 200);
  assert.equal((await setting('lab.home_visit_fee', { amount: 5 })).status, 200);
  try {
    const order = await api('POST', '/cases', {
      token: tokens.patient,
      body: {
        area_id: ids.area,
        items: [{ type: 'SERVICE', id: ids.labTest }, { type: 'SERVICE', id: ids['Home doctor visit'] }],
        recipient_gender: 'MALE',
        recipient_age_group: 'ADULT',
      },
    });
    assert.equal(order.status, 201, JSON.stringify(order.body));
    const view = order.body.data;
    const lab = view.services.find((line) => line.service_id === ids.labTest);
    const visit = view.services.find((line) => line.service_id === ids['Home doctor visit']);
    const fees = view.services.filter((line) => line.service_system_key === 'lab_home_visit');
    assert.equal(fees.length, 1, 'one fee per order');
    assert.equal(Number(fees[0].bundle_price), 5, 'the fee is never discounted');
    assert.deepEqual([lab.status, lab.provider_id], ['ASSIGNED', ids['lab@test.io']], 'lab test goes to the partner');
    assert.deepEqual([fees[0].status, fees[0].provider_id], ['ASSIGNED', ids['lab@test.io']], 'the fee belongs to the lab');
    assert.deepEqual([visit.status, visit.provider_id], ['PENDING', null], 'other lines still wait for the admin');
    assert.equal(view.case.status, 'ACCEPTED');

    const labToken = (await login('lab@test.io', 'Passw0rd!', 'PROVIDER')).token;
    assert.equal((await api('GET', `/cases/${view.case.id}`, { token: labToken })).status, 200, 'the lab sees its order');

    const direct = await api('POST', '/cases', {
      token: tokens.patient,
      body: { area_id: ids.area, items: [{ type: 'SERVICE', id: fees[0].service_id }] },
    });
    assert.equal(direct.body.code, 'ITEM_NOT_FOUND', 'the fee cannot be ordered on its own');

    const catalog = await api('GET', '/services?service_kind=LAB&limit=100');
    assert.equal(catalog.body.data.some((service) => service.system_key), false, 'system items are never listed');
    assert.equal((await api('GET', `/services/${fees[0].service_id}`)).status, 404);

    const cancelled = await api('POST', `/cases/${view.case.id}/services/${lab.id}/cancel`, {
      token: tokens.admin, body: { reason: 'test' },
    });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    const feeAfter = cancelled.body.data.services.find((line) => line.id === fees[0].id);
    assert.equal(feeAfter.status, 'CANCELLED', 'no lab test left, no visit fee');
    assert.equal(Number(cancelled.body.data.invoice.final_amount), Number(visit.bundle_price));
    await api('POST', `/cases/${view.case.id}/cancel`, { token: tokens.admin, body: {} });
  } finally {
    await setting('routing.partners', { lab_provider_id: null, radiology_provider_id: null });
    await setting('lab.home_visit_fee', { amount: 0 });
  }
});

test('lab catalog: groups in admin order, popular first page, search, reorder', { skip }, async () => {
  const group = await api('POST', '/services/categories', {
    token: tokens.admin,
    body: { name: 'lab-kidney-test', name_ar: 'الكلى', name_en: 'Kidneys', service_kind: 'LAB' },
  });
  assert.equal(group.status, 201, JSON.stringify(group.body));
  const made = [];
  for (const [name, popular] of [['Creatinine', true], ['Urea', true], ['Cystatin C', false]]) {
    const res = await api('POST', '/services', {
      token: tokens.admin,
      body: { name, name_en: name, name_ar: `${name} ar`, price: 3, service_kind: 'LAB', category_id: group.body.id, is_popular: popular },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    made.push(res.body.id);
  }
  const groups = await api('GET', '/services/categories?service_kind=LAB');
  const listedGroup = groups.body.data.find((row) => row.id === group.body.id);
  assert.equal(listedGroup.active_count, 3);
  assert.equal(listedGroup.name_ar, 'الكلى');

  const popular = await api('GET', `/services?category_id=${group.body.id}&is_popular=true&limit=10`);
  assert.equal(popular.body.data.length, 2);
  const searched = await api('GET', `/services?service_kind=LAB&search=${encodeURIComponent('Cystatin C ar')}`);
  assert.deepEqual(searched.body.data.map((row) => row.id), [made[2]], 'Arabic names are searchable');

  const reordered = await api('PUT', '/services/reorder', { token: tokens.admin, body: { ids: [made[2], made[0], made[1]] } });
  assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
  const ordered = await api('GET', `/services?category_id=${group.body.id}&limit=10`);
  assert.deepEqual(ordered.body.data.map((row) => row.id), [made[2], made[0], made[1]]);
  assert.equal((await api('PUT', '/services/reorder', { token: tokens.patient, body: { ids: made } })).status, 403);

  for (const id of made) await api('DELETE', `/services/${id}`, { token: tokens.admin });
});

test('insurance lab request: lab prices it, patient approves, money is tracked', { skip }, async () => {
  const setting = (key, body) => api('PUT', `/settings/${key}`, { token: tokens.admin, body });
  await setting('routing.partners', { lab_provider_id: ids['lab@test.io'], radiology_provider_id: null });
  await setting('lab.home_visit_fee', { amount: 5 });
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  try {
    const created = await api('POST', '/cases/insurance', {
      token: tokens.patient,
      form: fileForm(png, 'card.png', 'image/png', { area_id: ids.area, recipient_gender: 'FEMALE', recipient_age_group: 'ADULT' }),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const caseId = created.body.data.case.id;
    assert.equal(created.body.data.case.is_insurance, true);
    assert.equal(created.body.data.insurance.status, 'SUBMITTED');
    const testsLine = created.body.data.services.find((line) => line.service_system_key === 'lab_insurance_tests');
    const feeLine = created.body.data.services.find((line) => line.service_system_key === 'lab_home_visit');
    assert.equal(testsLine.provider_id, ids['lab@test.io']);
    assert.equal(Number(feeLine.bundle_price), 5);

    const labToken = (await login('lab@test.io', 'Passw0rd!', 'PROVIDER')).token;
    const card = await api('GET', `/cases/${caseId}/insurance/card`, { token: labToken });
    assert.equal(card.status, 200);
    assert.equal(card.headers.get('content-type'), 'image/png');
    assert.equal((await api('GET', `/cases/${caseId}/insurance/card`, { token: tokens.docFar })).status, 404, 'other providers cannot see it');

    assert.equal((await api('POST', `/cases/${caseId}/insurance/approve`, { token: tokens.patient })).status, 409, 'nothing to approve yet');
    assert.equal((await api('PUT', `/cases/${caseId}/services/${testsLine.id}/accept`, { token: labToken })).status, 200);
    const early = await api('PUT', `/cases/${caseId}/services/${testsLine.id}/start`, { token: labToken });
    assert.equal(early.body.code, 'INSURANCE_NOT_APPROVED');

    const notMine = await api('PUT', `/cases/${caseId}/insurance/quote`, {
      token: tokens.docArea, body: { tests_description: 'CBC', patient_amount: 1, lab_owes_amount: 1 },
    });
    assert.equal(notMine.status, 404);
    const quote = await api('PUT', `/cases/${caseId}/insurance/quote`, {
      token: labToken, body: { tests_description: 'CBC, TSH, Vitamin D', patient_amount: 12, lab_owes_amount: 20 },
    });
    assert.equal(quote.status, 200, JSON.stringify(quote.body));
    assert.equal(Number(quote.body.data.insurance.lab_owes_amount), 20);

    const patientView = (await api('GET', `/cases/${caseId}`, { token: tokens.patient })).body.data;
    assert.equal(patientView.insurance.status, 'QUOTED');
    assert.equal(patientView.insurance.amount_to_pay, 17, 'patient amount + visit fee');
    assert.equal('lab_owes_amount' in patientView.insurance, false, 'patients never see what the lab owes Curevie');
    assert.equal(Number(patientView.invoice.final_amount), 17);

    const approved = await api('POST', `/cases/${caseId}/insurance/approve`, { token: tokens.patient });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.data.insurance.status, 'APPROVED');

    for (const line of [testsLine, feeLine]) {
      if (line.id !== testsLine.id) {
        assert.equal((await api('PUT', `/cases/${caseId}/services/${line.id}/accept`, { token: labToken })).status, 200);
      }
      for (const step of ['start', 'complete']) {
        const res = await api('PUT', `/cases/${caseId}/services/${line.id}/${step}`, { token: labToken });
        assert.equal(res.status, 200, `${step}: ${JSON.stringify(res.body)}`);
      }
    }
    const { rows } = await pool.query(
      'SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM provider_earnings WHERE case_id = $1 AND provider_id = $2',
      [caseId, ids['lab@test.io']]
    );
    assert.equal(Number(rows[0].total), 17, 'the lab earns the patient amount + the visit fee, paid out by an admin');

    const list = await api('GET', '/cases/insurance/requests', { token: tokens.admin });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const row = list.body.data.find((item) => item.case_id === caseId);
    assert.equal(Number(row.lab_owes_amount), 20);
    assert.equal(row.lab_provider_name, 'Lab Tech');
    assert.ok(list.body.summary.receivable_pending >= 20);
    const received = await api('PATCH', `/cases/${caseId}/insurance/receivable`, { token: tokens.admin, body: { status: 'RECEIVED' } });
    assert.equal(received.body.data.receivable_status, 'RECEIVED');
    assert.equal((await api('GET', '/cases/insurance/requests', { token: tokens.patient })).status, 403);
  } finally {
    await setting('routing.partners', { lab_provider_id: null, radiology_provider_id: null });
    await setting('lab.home_visit_fee', { amount: 0 });
  }
});

test('lab results reach the patient as soon as the lab uploads them', { skip }, async () => {
  const order = await api('POST', '/cases', {
    token: tokens.patient,
    body: { area_id: ids.area, items: [{ type: 'SERVICE', id: ids.labTest }], recipient_gender: 'MALE', recipient_age_group: 'ADULT' },
  });
  const caseId = order.body.data.case.id;
  const line = order.body.data.services[0];
  await api('POST', `/cases/${caseId}/assign-team`, {
    token: tokens.admin, body: { assignments: [{ case_service_id: line.id, provider_id: ids['lab@test.io'] }] },
  });
  const labToken = (await login('lab@test.io', 'Passw0rd!', 'PROVIDER')).token;
  for (const step of ['accept', 'start']) await api('PUT', `/cases/${caseId}/services/${line.id}/${step}`, { token: labToken });
  const upload = await api('POST', `/cases/${caseId}/services/${line.id}/files`, {
    token: labToken, form: fileForm(MINIMAL_PDF, 'result.pdf', 'application/pdf'),
  });
  assert.equal(upload.status, 201, JSON.stringify(upload.body));

  const patientView = (await api('GET', `/cases/${caseId}`, { token: tokens.patient })).body.data;
  assert.equal(patientView.case.status, 'IN_PROGRESS', 'the order is still open');
  assert.equal(patientView.provider_files.length, 1, 'the lab result is visible before the case is closed');
  const download = await api('GET', `/cases/${caseId}/files/${upload.body.data.id}`, { token: tokens.patient });
  assert.equal(download.status, 200);
});

test('providers add services: their own kind to them, lab to the partner, the rest to the admin', { skip }, async () => {
  const setting = (key, body) => api('PUT', `/settings/${key}`, { token: tokens.admin, body });
  await setting('routing.partners', { lab_provider_id: ids['lab@test.io'], radiology_provider_id: null });
  await setting('lab.home_visit_fee', { amount: 5 });
  const nursing = await api('POST', '/services', {
    token: tokens.admin, body: { name: 'Wound dressing', price: 10, service_kind: 'NURSING' },
  });
  try {
    const order = await api('POST', '/cases', {
      token: tokens.patient,
      body: { area_id: ids.area, items: [{ type: 'SERVICE', id: ids['Home doctor visit'] }], recipient_gender: 'MALE', recipient_age_group: 'ADULT' },
    });
    const caseId = order.body.data.case.id;
    const first = order.body.data.services[0];
    await api('POST', `/cases/${caseId}/assign-team`, {
      token: tokens.admin, body: { assignments: [{ case_service_id: first.id, provider_id: ids['doc.area@test.io'] }] },
    });
    await api('PUT', `/cases/${caseId}/services/${first.id}/accept`, { token: tokens.docArea });
    const before = Number((await api('GET', `/cases/${caseId}`, { token: tokens.admin })).body.data.invoice.final_amount);

    const items = [
      { type: 'SERVICE', id: ids['Home doctor visit'], notes: 'follow-up' },
      { type: 'SERVICE', id: ids.labTest },
      { type: 'SERVICE', id: nursing.body.id },
    ];
    assert.equal((await api('POST', `/cases/${caseId}/services`, { token: tokens.docFar, body: { items } })).status, 404,
      'only providers on the order can add to it');
    assert.equal((await api('POST', `/cases/${caseId}/services`, { token: tokens.patient, body: { items } })).status, 403);

    const added = await api('POST', `/cases/${caseId}/services`, { token: tokens.docArea, body: { items } });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const adminView = (await api('GET', `/cases/${caseId}`, { token: tokens.admin })).body.data;
    const lines = adminView.services.filter((line) => line.id !== first.id);
    const visit = lines.find((line) => line.service_id === ids['Home doctor visit']);
    const lab = lines.find((line) => line.service_id === ids.labTest);
    const care = lines.find((line) => line.service_id === nursing.body.id);
    const fee = lines.find((line) => line.service_system_key === 'lab_home_visit');
    assert.deepEqual([visit.status, visit.provider_id], ['ACCEPTED', ids['doc.area@test.io']], 'own kind: assigned to the doctor');
    assert.deepEqual([lab.status, lab.provider_id], ['ASSIGNED', ids['lab@test.io']], 'lab test: to the partner lab');
    assert.deepEqual([care.status, care.provider_id], ['PENDING', null], 'nursing: waits for the admin');
    assert.equal(fee.provider_id, ids['lab@test.io']);
    const expected = before + Number(visit.bundle_price) + Number(lab.bundle_price) + Number(care.bundle_price) + 5;
    assert.equal(Number(adminView.invoice.final_amount), Number(expected.toFixed(3)), 'the invoice follows, no approval step');
    assert.ok(adminView.lifecycle.some((event) => event.event_type === 'SERVICE_ADDED_BY_PROVIDER'));

    await api('POST', `/cases/${caseId}/cancel`, { token: tokens.admin, body: {} });
  } finally {
    await api('DELETE', `/services/${nursing.body.id}`, { token: tokens.admin });
    await setting('routing.partners', { lab_provider_id: null, radiology_provider_id: null });
    await setting('lab.home_visit_fee', { amount: 0 });
  }
});

test('provider expenses: receipt, admin review, paid with the next payout, never shown to the patient', { skip }, async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const order = await api('POST', '/cases', {
    token: tokens.patient,
    body: { area_id: ids.area, items: [{ type: 'SERVICE', id: ids['Home doctor visit'] }], recipient_gender: 'MALE', recipient_age_group: 'ADULT' },
  });
  const caseId = order.body.data.case.id;
  const line = order.body.data.services[0];
  await api('POST', `/cases/${caseId}/assign-team`, {
    token: tokens.admin, body: { assignments: [{ case_service_id: line.id, provider_id: ids['doc.area@test.io'] }] },
  });
  await api('PUT', `/cases/${caseId}/services/${line.id}/accept`, { token: tokens.docArea });
  const invoiceBefore = (await api('GET', `/cases/${caseId}`, { token: tokens.patient })).body.data.invoice.final_amount;

  const submit = (token) => api('POST', `/cases/${caseId}/expenses`, {
    token, form: fileForm(png, 'receipt.png', 'image/png', { amount: '7.5', description: 'Paracetamol given at the visit' }),
  });
  assert.equal((await submit(tokens.docFar)).status, 404, 'only providers on the order');
  const created = await submit(tokens.docArea);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const expense = created.body.data;
  assert.equal(expense.status, 'PENDING');
  assert.equal(expense.amount, 7.5);
  assert.equal('receipt_file_key' in expense, false, 'storage keys never leave the server');
  assert.equal((await api('POST', `/cases/${caseId}/expenses`, {
    token: tokens.docArea, body: { amount: 1, description: 'no receipt' },
  })).status, 400, 'a receipt is required');

  const patientView = (await api('GET', `/cases/${caseId}`, { token: tokens.patient })).body.data;
  assert.equal('expenses' in patientView, false, 'patients never see expenses');
  assert.equal(patientView.invoice.final_amount, invoiceBefore, 'and are never charged for them');
  const providerView = (await api('GET', `/cases/${caseId}`, { token: tokens.docArea })).body.data;
  assert.equal(providerView.case_actions.can_add_expense, true);
  assert.equal(providerView.expenses.length, 1);

  const awaiting = await api('GET', '/earnings/expenses?status=PENDING', { token: tokens.admin });
  assert.ok(awaiting.body.data.some((row) => row.id === expense.id));
  assert.ok(awaiting.body.summary.awaiting_review_total >= 7.5);
  assert.equal((await api('GET', `/earnings/expenses/${expense.id}/receipt`, { token: tokens.docFar })).status, 404);
  assert.equal((await api('GET', `/earnings/expenses/${expense.id}/receipt`, { token: tokens.docArea })).status, 200);

  assert.equal((await api('PATCH', `/earnings/expenses/${expense.id}`, { token: tokens.admin, body: { action: 'reject' } })).status, 400,
    'a rejection needs a reason');
  const approved = await api('PATCH', `/earnings/expenses/${expense.id}`, { token: tokens.admin, body: { action: 'approve' } });
  assert.equal(approved.body.data.status, 'APPROVED');
  assert.equal((await api('PATCH', `/earnings/expenses/${expense.id}`, { token: tokens.admin, body: { action: 'approve' } })).status, 409);

  const balances = (await api('GET', '/earnings/balances', { token: tokens.admin })).body.data;
  const mine = balances.find((row) => row.provider_id === ids['doc.area@test.io']);
  assert.ok(mine.expenses_pending_total >= 7.5);
  assert.equal(mine.owed_total, Number((mine.pending_total + mine.expenses_pending_total).toFixed(3)));

  const payout = await api('POST', '/earnings/payouts', {
    token: tokens.admin, body: { provider_id: ids['doc.area@test.io'], method: 'CASH' },
  });
  assert.equal(payout.status, 201, JSON.stringify(payout.body));
  assert.equal(Number(payout.body.data.payout.amount), mine.owed_total, 'earnings and approved expenses are paid together');
  assert.equal(payout.body.data.expenses_count >= 1, true);
  const paid = (await api('GET', `/cases/${caseId}/expenses`, { token: tokens.docArea })).body.data[0];
  assert.equal(paid.status, 'PAID');
  await api('POST', `/cases/${caseId}/cancel`, { token: tokens.admin, body: {} });
});

test('identity: ID document once per account, guests verify ID and phone per order, tracking message logged', { skip }, async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const setRules = (value) => pool.query("UPDATE app_settings SET value = $1::jsonb WHERE key = 'verification'", [JSON.stringify(value)]);
  const blocked = await api('PUT', '/settings/verification', { token: tokens.admin, body: { require_id: true, require_phone: true } });
  assert.equal(blocked.status, 400, 'phone checks cannot be required while no message provider is configured');
  assert.equal((await api('PUT', '/settings/verification', { token: tokens.admin, body: { require_id: true, require_phone: false } })).status, 200);
  try {
    const publicSettings = await api('GET', '/settings/public');
    assert.deepEqual(publicSettings.body.data.verification, { require_id: true, require_phone: false });

    // Registered patient: ID once, then every order goes through.
    const orderBody = { area_id: ids.area, items: [{ type: 'SERVICE', id: ids['Home doctor visit'] }], recipient_gender: 'MALE', recipient_age_group: 'ADULT' };
    const refused = await api('POST', '/cases', { token: tokens.patient, body: orderBody });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'VERIFICATION_REQUIRED');
    assert.deepEqual(refused.body.details.missing, ['id_document']);
    const uploaded = await api('POST', '/verification/id-document', { token: tokens.patient, form: fileForm(png, 'id.png', 'image/png') });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const status = (await api('GET', '/verification/status', { token: tokens.patient })).body.data;
    assert.equal(status.id_document_uploaded, true);
    const ordered = await api('POST', '/cases', { token: tokens.patient, body: orderBody });
    assert.equal(ordered.status, 201, JSON.stringify(ordered.body));
    assert.equal('identity' in ordered.body.data, false, 'only admins see identity details');
    assert.equal('patient_has_id_document' in ordered.body.data.case, false);
    const adminOrder = (await api('GET', `/cases/${ordered.body.data.case.id}`, { token: tokens.admin })).body.data;
    assert.equal(adminOrder.identity.id_document_path, `/verification/id-documents/patients/${ids.patient}`);
    assert.equal((await api('GET', adminOrder.identity.id_document_path, { token: tokens.admin })).status, 200);
    assert.equal((await api('GET', adminOrder.identity.id_document_path, { token: tokens.patient })).status, 403);
    const messages = (await api('GET', adminOrder.identity.messages_path, { token: tokens.admin })).body.data;
    assert.deepEqual(messages.map((m) => [m.kind, m.channel, m.status]), [['ORDER_TRACKING', 'LOG', 'LOGGED']],
      'the tracking-link message is recorded (log driver: no provider configured)');

    // Guests: ID + phone code on every order.
    await setRules({ require_id: true, require_phone: true });
    const guestBody = {
      guest_name: 'Verified Guest', guest_phone: '0781112233', address: 'Abdoun, building 4', area_id: ids.area,
      items: [{ type: 'SERVICE', id: ids['Home doctor visit'] }], recipient_gender: 'FEMALE', recipient_age_group: 'ADULT',
    };
    const noProof = await api('POST', '/cases/public', { body: guestBody });
    assert.deepEqual(noProof.body.details?.missing, ['phone', 'id_document']);

    const idUpload = await api('POST', '/verification/id-document', { form: fileForm(png, 'id.png', 'image/png') });
    assert.equal(idUpload.status, 201);
    const codeRequest = await api('POST', '/verification/phone/request', { body: { phone: '0781112233' } });
    assert.equal(codeRequest.status, 200, JSON.stringify(codeRequest.body));
    assert.match(codeRequest.body.data.dev_code, /^\d{6}$/, 'outside production, with no provider, the code is returned for testing');
    assert.equal((await api('POST', '/verification/phone/request', { body: { phone: '0612345678' } })).body.code, 'INVALID_PHONE',
      'landlines and foreign numbers cannot receive the code');
    const wrong = await api('POST', '/verification/phone/confirm', {
      body: { phone: '0781112233', code: codeRequest.body.data.dev_code === '000000' ? '111111' : '000000' },
    });
    assert.equal(wrong.body.code, 'INVALID_CODE');
    const confirmed = await api('POST', '/verification/phone/confirm', { body: { phone: '+962 78 111 2233', code: codeRequest.body.data.dev_code } });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));

    const otherPhone = await api('POST', '/cases/public', {
      body: { ...guestBody, guest_phone: '0790000001', id_document_token: idUpload.body.data.id_document_token,
        phone_verification_token: confirmed.body.data.verification_token },
    });
    assert.deepEqual(otherPhone.body.details?.missing, ['phone'], 'the code proves one number only');
    const guestOrder = await api('POST', '/cases/public', {
      body: { ...guestBody, id_document_token: idUpload.body.data.id_document_token,
        phone_verification_token: confirmed.body.data.verification_token },
    });
    assert.equal(guestOrder.status, 201, JSON.stringify(guestOrder.body));
    const guestCase = (await pool.query('SELECT id FROM cases WHERE guest_name = $1 ORDER BY created_at DESC LIMIT 1', ['Verified Guest'])).rows[0];
    const guestAdmin = (await api('GET', `/cases/${guestCase.id}`, { token: tokens.admin })).body.data;
    assert.equal(guestAdmin.identity.phone_verified, true);
    assert.equal((await api('GET', guestAdmin.identity.id_document_path, { token: tokens.admin })).status, 200);
    const reused = await api('POST', '/cases/public', {
      body: { ...guestBody, id_document_token: idUpload.body.data.id_document_token,
        phone_verification_token: confirmed.body.data.verification_token },
    });
    assert.equal(reused.body.code, 'ID_DOCUMENT_EXPIRED', 'an uploaded ID serves one order');

    for (const caseId of [ordered.body.data.case.id, guestCase.id]) {
      await api('POST', `/cases/${caseId}/cancel`, { token: tokens.admin, body: {} });
    }
  } finally {
    await setRules({ require_id: false, require_phone: false });
  }
});

test('deleting a patient is a soft delete that keeps their cases', { skip }, async () => {
  const del = await api('DELETE', `/patients/${ids.patient}`, { token: tokens.admin });
  assert.equal(del.status, 200);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM cases WHERE patient_id = $1', [ids.patient]);
  assert.ok(rows[0].count >= 3);
  const relogin = await api('POST', '/auth/login', { body: { email: 'patient@test.io', password: 'Abc<12345', role: 'PATIENT' } });
  assert.equal(relogin.status, 401);
});
