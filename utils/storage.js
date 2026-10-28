/**
 * File storage for Curevie.
 *
 * Two kinds of files exist:
 *  - PUBLIC media (avatars, catalog images): uploaded to the Bunny CDN, the stored value is
 *    the full public URL so the frontends can use it directly as an <img src>.
 *  - PRIVATE files (provider uploads, chat attachments, generated reports): never served
 *    statically. The database stores an opaque storage key and the API streams the bytes
 *    after an access check.
 *
 * Private key formats:
 *   "bunny:<path>"   object in the Bunny storage zone (read with the Storage API key)
 *   "local:<path>"   file under <backend>/uploads/private (used when Bunny is not configured)
 * Legacy values written before this module are still readable:
 *   "/uploads/..."   file under <backend>/uploads
 *   "<path>"         relative Bunny object path
 *   "https://..."    URL on the configured Bunny CDN host
 */
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const axios = require('axios');
const { logger } = require('./logger');

const BACKEND_ROOT = path.join(__dirname, '..');
const UPLOADS_ROOT = path.join(BACKEND_ROOT, 'uploads');
const PRIVATE_ROOT = path.join(UPLOADS_ROOT, 'private');

const EXTENSION_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

const MIME_BY_EXTENSION = Object.fromEntries(
  Object.entries(EXTENSION_BY_MIME).map(([mime, ext]) => [ext, mime])
);
MIME_BY_EXTENSION.jpeg = 'image/jpeg';

function getBunnyConfig() {
  const config = {
    storageZone: String(process.env.BUNNY_STORAGE_ZONE || '').trim(),
    apiKey: String(process.env.BUNNY_API_KEY || '').trim(),
    cdnUrl: String(process.env.BUNNY_CDN_URL || '').trim().replace(/\/+$/, ''),
    storageHostname: String(process.env.BUNNY_STORAGE_HOSTNAME || '').trim().toLowerCase(),
    region: String(process.env.BUNNY_STORAGE_REGION || '').trim().toLowerCase(),
  };
  config.configured = Boolean(config.storageZone && config.apiKey && config.cdnUrl);
  return config;
}

function isBunnyConfigured() {
  return getBunnyConfig().configured;
}

function storageHost(config) {
  if (config.storageHostname) return config.storageHostname;
  if (!config.region || config.region === 'de') return 'storage.bunnycdn.com';
  return `${config.region}.storage.bunnycdn.com`;
}

/** Strips anything that could escape the intended folder. */
function sanitizeRelativePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) => part.replace(/[^a-zA-Z0-9._-]/g, '-'))
    .join('/');
}

function extensionFor(mimeType, fallback = 'bin') {
  return EXTENSION_BY_MIME[mimeType] || fallback;
}

function mimeTypeForKey(key) {
  const ext = path.extname(String(key || '').split('?')[0]).replace('.', '').toLowerCase();
  return MIME_BY_EXTENSION[ext] || 'application/octet-stream';
}

async function bunnyPut(objectPath, buffer) {
  const config = getBunnyConfig();
  const url = `https://${storageHost(config)}/${config.storageZone}/${objectPath}`;
  const response = await axios.put(url, buffer, {
    headers: { AccessKey: config.apiKey, 'Content-Type': 'application/octet-stream' },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 60000,
    validateStatus: () => true,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`BUNNY_UPLOAD_FAILED_${response.status}`);
  }
}

async function bunnyGet(objectPath) {
  const config = getBunnyConfig();
  if (!config.configured) throw new Error('STORAGE_NOT_CONFIGURED');
  const url = `https://${storageHost(config)}/${config.storageZone}/${objectPath}`;
  const response = await axios.get(url, {
    headers: { AccessKey: config.apiKey },
    responseType: 'arraybuffer',
    timeout: 30000,
    validateStatus: () => true,
  });
  if (response.status === 404) throw new Error('FILE_NOT_FOUND');
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`BUNNY_READ_FAILED_${response.status}`);
  }
  return Buffer.from(response.data);
}

async function bunnyDelete(objectPath) {
  const config = getBunnyConfig();
  if (!config.configured) return false;
  const url = `https://${storageHost(config)}/${config.storageZone}/${objectPath}`;
  const response = await axios.delete(url, {
    headers: { AccessKey: config.apiKey },
    timeout: 30000,
    validateStatus: () => true,
  });
  return (response.status >= 200 && response.status < 300) || response.status === 404;
}

/** Turns a CDN URL into its object path, or null when the URL is not on our CDN. */
function cdnUrlToObjectPath(url) {
  const config = getBunnyConfig();
  if (!config.cdnUrl) return null;
  try {
    const target = new URL(url);
    const cdn = new URL(config.cdnUrl);
    if (target.host.toLowerCase() !== cdn.host.toLowerCase()) return null;
    return sanitizeRelativePath(decodeURIComponent(target.pathname));
  } catch (_) {
    return null;
  }
}

function localPathFor(root, relative) {
  const resolved = path.resolve(root, sanitizeRelativePath(relative));
  if (!resolved.startsWith(path.resolve(root) + path.sep)) {
    throw new Error('INVALID_STORAGE_KEY');
  }
  return resolved;
}

/**
 * Stores a private file and returns its storage key.
 * @param {Buffer} buffer
 * @param {{ folder: string, mimeType: string }} options
 */
async function savePrivateFile(buffer, { folder, mimeType }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('EMPTY_FILE');
  const relative = `${sanitizeRelativePath(folder)}/${randomUUID()}.${extensionFor(mimeType)}`;

  if (isBunnyConfigured()) {
    const objectPath = `private/${relative}`;
    await bunnyPut(objectPath, buffer);
    return `bunny:${objectPath}`;
  }

  const target = localPathFor(PRIVATE_ROOT, relative);
  await fsPromises.mkdir(path.dirname(target), { recursive: true });
  await fsPromises.writeFile(target, buffer);
  return `local:${relative}`;
}

/** Reads any stored file (current or legacy key format) and returns its bytes. */
async function readStoredFile(key) {
  const value = String(key || '').trim();
  if (!value) throw new Error('FILE_NOT_FOUND');

  if (value.startsWith('local:')) {
    return fsPromises.readFile(localPathFor(PRIVATE_ROOT, value.slice('local:'.length)));
  }
  if (value.startsWith('bunny:')) {
    return bunnyGet(sanitizeRelativePath(value.slice('bunny:'.length)));
  }
  if (value.startsWith('/uploads/') || value.startsWith('uploads/')) {
    const filePath = localPathFor(UPLOADS_ROOT, value.replace(/^\/?uploads\//, ''));
    if (!fs.existsSync(filePath)) throw new Error('FILE_NOT_FOUND');
    return fsPromises.readFile(filePath);
  }
  if (/^https?:\/\//i.test(value)) {
    const objectPath = cdnUrlToObjectPath(value);
    if (!objectPath) throw new Error('REMOTE_FILE_NOT_ALLOWED');
    return bunnyGet(objectPath);
  }
  return bunnyGet(sanitizeRelativePath(value));
}

async function deleteStoredFile(key) {
  const value = String(key || '').trim();
  if (!value) return false;
  try {
    if (value.startsWith('local:')) {
      await fsPromises.unlink(localPathFor(PRIVATE_ROOT, value.slice('local:'.length)));
      return true;
    }
    if (value.startsWith('/uploads/') || value.startsWith('uploads/')) {
      await fsPromises.unlink(localPathFor(UPLOADS_ROOT, value.replace(/^\/?uploads\//, '')));
      return true;
    }
    if (value.startsWith('bunny:')) return bunnyDelete(sanitizeRelativePath(value.slice('bunny:'.length)));
    if (/^https?:\/\//i.test(value)) {
      const objectPath = cdnUrlToObjectPath(value);
      return objectPath ? bunnyDelete(objectPath) : false;
    }
    return bunnyDelete(sanitizeRelativePath(value));
  } catch (err) {
    logger.warn('STORAGE_DELETE_FAILED', { message: err.message });
    return false;
  }
}

/**
 * Uploads a public image to the CDN and returns its absolute URL.
 * Returns null when the CDN is not configured.
 */
async function uploadPublicMedia(buffer, { folder, mimeType }) {
  const config = getBunnyConfig();
  if (!config.configured) return null;
  const objectPath = `${sanitizeRelativePath(folder)}/${randomUUID()}.${extensionFor(mimeType, 'jpg')}`;
  await bunnyPut(objectPath, buffer);
  return `${config.cdnUrl}/${objectPath}`;
}

/** Removes a previously uploaded public image. Accepts absolute CDN URLs and legacy relative paths. */
async function deletePublicMedia(url) {
  const value = String(url || '').trim();
  if (!value) return false;
  const objectPath = /^https?:\/\//i.test(value) ? cdnUrlToObjectPath(value) : sanitizeRelativePath(value);
  if (!objectPath) return false;
  try {
    return await bunnyDelete(objectPath);
  } catch (err) {
    logger.warn('PUBLIC_MEDIA_DELETE_FAILED', { message: err.message });
    return false;
  }
}

/** Normalises a stored public media value (legacy rows hold relative paths) into an absolute URL. */
function toPublicMediaUrl(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  if (/^https?:\/\//i.test(normalized)) return normalized;
  const { cdnUrl } = getBunnyConfig();
  return cdnUrl ? `${cdnUrl}/${sanitizeRelativePath(normalized)}` : null;
}

/** Sends stored bytes as a download with safe headers. */
function sendFile(res, buffer, { fileName, mimeType, inline = false }) {
  const safeName = String(fileName || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file';
  res.setHeader('Content-Type', mimeType || 'application/octet-stream');
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  return res.status(200).send(buffer);
}

module.exports = {
  isBunnyConfigured,
  savePrivateFile,
  readStoredFile,
  deleteStoredFile,
  uploadPublicMedia,
  deletePublicMedia,
  toPublicMediaUrl,
  mimeTypeForKey,
  extensionFor,
  sendFile,
};
