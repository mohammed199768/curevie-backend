// Fast tests that need no database: npm run test:unit
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'unit-refresh-secret';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { deriveCaseStatus, toMoney } = require('../modules/cases/case.service');
const schemas = require('../modules/cases/case.schemas');
const validate = require('../middlewares/validate');
const { mimeTypeForKey } = require('../utils/storage');

const s = (...statuses) => statuses.map((status) => ({ status }));

test('case status follows its line items', () => {
  assert.equal(deriveCaseStatus('PENDING', s('PENDING', 'PENDING')), 'PENDING');
  assert.equal(deriveCaseStatus('PENDING', s('ASSIGNED', 'PENDING')), 'ACCEPTED');
  assert.equal(deriveCaseStatus('ACCEPTED', s('ACCEPTED', 'IN_PROGRESS')), 'IN_PROGRESS');
  assert.equal(deriveCaseStatus('IN_PROGRESS', s('COMPLETED', 'ASSIGNED')), 'IN_PROGRESS');
  assert.equal(deriveCaseStatus('IN_PROGRESS', s('COMPLETED', 'COMPLETED')), 'COMPLETED');
  assert.equal(deriveCaseStatus('IN_PROGRESS', s('COMPLETED', 'CANCELLED')), 'COMPLETED');
  assert.equal(deriveCaseStatus('ACCEPTED', s('CANCELLED', 'CANCELLED')), 'CANCELLED');
  assert.equal(deriveCaseStatus('IN_PROGRESS', s('PENDING')), 'PENDING', 'reject of the only job returns the case to the queue');
});

test('closed and cancelled cases never change status', () => {
  assert.equal(deriveCaseStatus('CLOSED', s('PENDING')), 'CLOSED');
  assert.equal(deriveCaseStatus('CANCELLED', s('COMPLETED')), 'CANCELLED');
});

test('money is rounded to JOD fils (3 decimals)', () => {
  assert.equal(toMoney(0.1 + 0.2), 0.3);
  assert.equal(toMoney('12.34567'), 12.346);
  assert.equal(toMoney(undefined), 0);
});

test('order schema strips client prices and rejects duplicates', () => {
  const { value, error } = schemas.createCaseSchema.validate({
    area_id: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b',
    items: [{ type: 'SERVICE', id: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5c', bundle_price: 0 }],
  }, { stripUnknown: true });
  assert.equal(error, undefined);
  assert.equal(value.items[0].bundle_price, undefined);

  const duplicate = schemas.createCaseSchema.validate({
    area_id: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b',
    items: [
      { type: 'PACKAGE', id: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5c' },
      { type: 'PACKAGE', id: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5c' },
    ],
  });
  assert.ok(duplicate.error);
});

test('guest orders require contact details and an address', () => {
  const { error } = schemas.createGuestCaseSchema.validate({
    area_id: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b',
    items: [{ type: 'SERVICE', id: '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5c' }],
  });
  assert.match(error.message, /address|guest_name/);
});

test('validate() escapes HTML but leaves passwords and tokens untouched', () => {
  const Joi = require('joi');
  const req = { body: { note: '<script>x</script>', password: 'a<b>c', refresh_token: 'x<y' } };
  validate(Joi.object({ note: Joi.string(), password: Joi.string(), refresh_token: Joi.string() }))(req, {}, () => {});
  assert.equal(req.body.password, 'a<b>c');
  assert.equal(req.body.refresh_token, 'x<y');
  assert.ok(!req.body.note.includes('<script>'));
});

test('stored file keys map to safe content types', () => {
  assert.equal(mimeTypeForKey('local:case-files/a.pdf'), 'application/pdf');
  assert.equal(mimeTypeForKey('bunny:private/x.JPG'), 'image/jpeg');
  assert.equal(mimeTypeForKey('evil.html'), 'application/octet-stream');
});
