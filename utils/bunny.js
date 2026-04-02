const { randomUUID } = require('crypto');
const axios = require('axios');
const { logger } = require('./logger');

let configWarned = false;

function getBunnyConfig() {
  const config = {
    storageZone: String(process.env.BUNNY_STORAGE_ZONE || '').trim(),
    apiKey: String(process.env.BUNNY_API_KEY || '').trim(),
    cdnUrl: String(process.env.BUNNY_CDN_URL || '').trim().replace(/\/+$/, ''),
    region: String(process.env.BUNNY_STORAGE_REGION || '').trim().toLowerCase(),
  };

  const configured = Boolean(
    config.storageZone
    && config.apiKey
    && config.cdnUrl
    && config.region
  );

  return { ...config, configured };
}

function isBunnyConfigured() {
  return getBunnyConfig().configured;
}

function warnIfNotConfigured() {
  if (configWarned) return;
  configWarned = true;
  logger.warn('BunnyCDN media storage is not configured. Upload/delete operations are disabled.');
}

function resolveStorageHost(region) {
  return region === 'de' ? 'storage.bunnycdn.com' : `${region}.storage.bunnycdn.com`;
}

function sanitizePathPart(value) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.\./g, '');
}

function buildObjectPath(fileName, folder = '') {
  const safeFolder = sanitizePathPart(folder);
  const safeFileName = sanitizePathPart(fileName).replace(/\s+/g, '-');
  const uniqueFileName = `${Date.now()}-${randomUUID()}-${safeFileName || 'file'}`;
  return safeFolder ? `${safeFolder}/${uniqueFileName}` : uniqueFileName;
}

function getDeletePathFromUrl(fileUrl, config) {
  if (!fileUrl) return null;
  const input = String(fileUrl).trim();

  if (config.cdnUrl && input.startsWith(`${config.cdnUrl}/`)) {
    return sanitizePathPart(input.slice(config.cdnUrl.length + 1));
  }

  try {
    const parsed = new URL(input);
    const pathValue = parsed.pathname.replace(/^\/+/, '');
    const zonePrefix = `${config.storageZone}/`;
    if (pathValue.startsWith(zonePrefix)) {
      return sanitizePathPart(pathValue.slice(zonePrefix.length));
    }
    return sanitizePathPart(pathValue);
  } catch (_) {
    return null;
  }
}

async function uploadToBunny(fileBuffer, fileName, folder = '') {
  const config = getBunnyConfig();
  if (!config.configured) {
    warnIfNotConfigured();
    return null;
  }

  if (!fileBuffer || !Buffer.isBuffer(fileBuffer) || !fileBuffer.length) {
    logger.warn('Bunny upload skipped because file buffer is empty');
    return null;
  }

  const objectPath = buildObjectPath(fileName, folder);
  const storageHost = resolveStorageHost(config.region);
  const uploadUrl = `https://${storageHost}/${config.storageZone}/${objectPath}`;

  try {
    const response = await axios.put(uploadUrl, fileBuffer, {
      headers: {
        AccessKey: config.apiKey,
        'Content-Type': 'application/octet-stream',
      },
      validateStatus: () => true,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    if (response.status < 200 || response.status >= 300) {
      logger.warn('Bunny upload failed', {
        status: response.status,
      });
      return null;
    }

    return `${config.cdnUrl}/${objectPath}`;
  } catch (err) {
    logger.warn('Bunny upload error', { message: err.message });
    return null;
  }
}

async function deleteFromBunny(fileUrl) {
  const config = getBunnyConfig();
  if (!config.configured) {
    warnIfNotConfigured();
    return null;
  }

  const objectPath = getDeletePathFromUrl(fileUrl, config);
  if (!objectPath) {
    return null;
  }

  const storageHost = resolveStorageHost(config.region);
  const deleteUrl = `https://${storageHost}/${config.storageZone}/${objectPath}`;

  try {
    const response = await axios.delete(deleteUrl, {
      headers: { AccessKey: config.apiKey },
      validateStatus: () => true,
    });

    if ((response.status < 200 || response.status >= 300) && response.status !== 404) {
      logger.warn('Bunny delete failed', {
        status: response.status,
      });
      return false;
    }

    return true;
  } catch (err) {
    logger.warn('Bunny delete error', { message: err.message });
    return false;
  }
}

module.exports = {
  isBunnyConfigured,
  uploadToBunny,
  deleteFromBunny,
};
