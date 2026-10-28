/**
 * File storage for Curevie: everything lives on the server's disk under <backend>/uploads
 * (a persistent Docker volume in production).
 *
 * Two kinds of files exist:
 *  - PUBLIC media (avatars, catalog images) under uploads/public. The database stores the
 *    relative path ("services/<uuid>.jpg"); toPublicMediaUrl() turns it into the absolute URL
 *    served by GET /api/v1/media/<path>, so the frontends can use it directly as an <img src>.
 *  - PRIVATE files (provider uploads, chat attachments, generated reports) under uploads/private.
 *    Never served statically: the database stores a "local:<path>" key and the API streams the
 *    bytes after an access check.
 */
const fsPromises = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const { logger } = require('./logger');

const BACKEND_ROOT = path.join(__dirname, '..');
const UPLOADS_ROOT = path.join(BACKEND_ROOT, 'uploads');
const PRIVATE_ROOT = path.join(UPLOADS_ROOT, 'private');
const PUBLIC_ROOT = path.join(UPLOADS_ROOT, 'public');
const PUBLIC_MEDIA_ROUTE = '/api/v1/media';

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

/** Origin the API is reached at from browsers, used to build absolute public media URLs. */
function publicApiOrigin() {
  const configured = String(process.env.PUBLIC_API_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  return process.env.NODE_ENV === 'production'
    ? 'https://api.curevie.net'
    : `http://localhost:${process.env.PORT || 5000}`;
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

function localPathFor(root, relative) {
  const resolved = path.resolve(root, sanitizeRelativePath(relative));
  if (!resolved.startsWith(path.resolve(root) + path.sep)) {
    throw new Error('INVALID_STORAGE_KEY');
  }
  return resolved;
}

async function writeUnder(root, relative, buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('EMPTY_FILE');
  const target = localPathFor(root, relative);
  await fsPromises.mkdir(path.dirname(target), { recursive: true });
  await fsPromises.writeFile(target, buffer);
}

/**
 * Stores a private file and returns its storage key.
 * @param {Buffer} buffer
 * @param {{ folder: string, mimeType: string }} options
 */
async function savePrivateFile(buffer, { folder, mimeType }) {
  const relative = `${sanitizeRelativePath(folder)}/${randomUUID()}.${extensionFor(mimeType)}`;
  await writeUnder(PRIVATE_ROOT, relative, buffer);
  return `local:${relative}`;
}

function privateKeyPath(key) {
  const value = String(key || '').trim();
  if (!value.startsWith('local:')) throw new Error('FILE_NOT_FOUND');
  return localPathFor(PRIVATE_ROOT, value.slice('local:'.length));
}

/** Reads a private file by its storage key and returns its bytes. */
async function readStoredFile(key) {
  try {
    return await fsPromises.readFile(privateKeyPath(key));
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('FILE_NOT_FOUND');
    throw err;
  }
}

async function deleteStoredFile(key) {
  try {
    await fsPromises.unlink(privateKeyPath(key));
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn('STORAGE_DELETE_FAILED', { message: err.message });
    return false;
  }
}

/** Saves a public image and returns the value to store in the database (its relative path). */
async function uploadPublicMedia(buffer, { folder, mimeType }) {
  const relative = `${sanitizeRelativePath(folder)}/${randomUUID()}.${extensionFor(mimeType, 'jpg')}`;
  await writeUnder(PUBLIC_ROOT, relative, buffer);
  return relative;
}

/** Stored public media value -> relative path under uploads/public (null for foreign URLs). */
function publicMediaPath(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  if (!/^https?:\/\//i.test(normalized)) return sanitizeRelativePath(normalized);
  const prefix = `${publicApiOrigin()}${PUBLIC_MEDIA_ROUTE}/`;
  return normalized.startsWith(prefix) ? sanitizeRelativePath(normalized.slice(prefix.length)) : null;
}

/** Removes a previously uploaded public image. */
async function deletePublicMedia(value) {
  const relative = publicMediaPath(value);
  if (!relative) return false;
  try {
    await fsPromises.unlink(localPathFor(PUBLIC_ROOT, relative));
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn('PUBLIC_MEDIA_DELETE_FAILED', { message: err.message });
    return false;
  }
}

/** Turns a stored public media value into the absolute URL browsers load it from. */
function toPublicMediaUrl(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  if (/^https?:\/\//i.test(normalized)) return normalized;
  return `${publicApiOrigin()}${PUBLIC_MEDIA_ROUTE}/${sanitizeRelativePath(normalized)}`;
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
  PUBLIC_ROOT,
  PUBLIC_MEDIA_ROUTE,
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
