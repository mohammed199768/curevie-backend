const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { loadWithMocks } = require('./helpers/loadWithMocks');

const ROOT = path.resolve(__dirname, '..');
const CONTROLLER_PATH = path.join(ROOT, 'modules', 'labtests', 'labtest.controller.js');
const SERVICE_PATH = path.join(ROOT, 'modules', 'labtests', 'labtest.service.js');
const CACHE_PATH = path.join(ROOT, 'utils', 'cache.js');
const LOGGER_PATH = path.join(ROOT, 'utils', 'logger.js');
const BUNNY_PATH = path.join(ROOT, 'utils', 'bunny.js');

function createResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.payload = body;
      return this;
    },
  };
}

function loadController({
  serviceOverrides = {},
  bunnyOverrides = {},
  loggerOverrides = {},
} = {}) {
  const cache = {
    get: async () => null,
    set: async () => undefined,
    del: async () => undefined,
  };

  const service = {
    getLabTestMediaInfo: async () => ({ id: 'lab-1', image_url: 'https://cdn.example.com/old.png' }),
    updateLabTestImage: async (id, imageUrl) => ({ id, image_url: imageUrl }),
    ...serviceOverrides,
  };

  const logger = {
    warn() {},
    error() {},
    ...loggerOverrides,
  };

  const bunny = {
    isBunnyConfigured: () => true,
    uploadToBunny: async () => 'https://cdn.example.com/new.png',
    deleteFromBunny: async () => true,
    ...bunnyOverrides,
  };

  const controller = loadWithMocks(CONTROLLER_PATH, {
    [SERVICE_PATH]: service,
    [CACHE_PATH]: cache,
    [LOGGER_PATH]: { logger, audit() {} },
    [BUNNY_PATH]: bunny,
  });

  return { controller, service, bunny, logger };
}

test('labtest controller loads with deleteFromBunny and replaces assets in safe order', async () => {
  const calls = [];
  const { controller } = loadController({
    serviceOverrides: {
      getLabTestMediaInfo: async () => ({ id: 'lab-1', image_url: 'https://cdn.example.com/old.png' }),
      updateLabTestImage: async (id, imageUrl) => {
        calls.push(`persist:${id}:${imageUrl}`);
        return { id, image_url: imageUrl };
      },
    },
    bunnyOverrides: {
      uploadToBunny: async () => {
        calls.push('upload');
        return 'https://cdn.example.com/new.png';
      },
      deleteFromBunny: async () => {
        calls.push('delete');
        return true;
      },
    },
  });

  const req = {
    params: { id: 'lab-1' },
    file: { buffer: Buffer.from('image-bytes'), originalname: 'panel.png' },
    user: { id: 'admin-1', role: 'ADMIN' },
    ip: '127.0.0.1',
  };
  const res = createResponse();

  await controller.uploadLabTestImage(req, res);

  assert.deepEqual(calls, [
    'upload',
    'persist:lab-1:https://cdn.example.com/new.png',
    'delete',
  ]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.image_url, 'https://cdn.example.com/new.png');
});

test('labtest image replacement does not delete old asset when DB persistence fails', async () => {
  const calls = [];
  const { controller } = loadController({
    serviceOverrides: {
      getLabTestMediaInfo: async () => ({ id: 'lab-1', image_url: 'https://cdn.example.com/old.png' }),
      updateLabTestImage: async () => {
        calls.push('persist');
        throw new Error('db write failed');
      },
    },
    bunnyOverrides: {
      uploadToBunny: async () => {
        calls.push('upload');
        return 'https://cdn.example.com/new.png';
      },
      deleteFromBunny: async () => {
        calls.push('delete');
        return true;
      },
    },
  });

  const req = {
    params: { id: 'lab-1' },
    file: { buffer: Buffer.from('image-bytes'), originalname: 'panel.png' },
    user: { id: 'admin-1', role: 'ADMIN' },
    ip: '127.0.0.1',
  };
  const res = createResponse();

  await assert.rejects(
    () => controller.uploadLabTestImage(req, res),
    /db write failed/
  );

  assert.deepEqual(calls, ['upload', 'persist']);
});
