const fsPromises = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const { isBunnyConfigured, uploadToBunny, deleteFromBunny } = require('../bunny');
const { OUTPUT_DIR } = require('./shared');
const { fetchPdfBufferFromUrl, resolveLocalPdfPath } = require('./attachments');

function sanitizePathPart(value) {
  return String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.\./g, '');
}

function sanitizeFileName(fileName) {
  const baseName = path.basename(String(fileName || 'document.pdf'));
  const normalized = baseName.replace(/[^a-zA-Z0-9._-]/g, '-');
  return normalized.toLowerCase().endsWith('.pdf') ? normalized : `${normalized}.pdf`;
}

// AUDIT-FIX: PATH — use __dirname so relative URL is computed from backend/
// __dirname = backend/utils/pdf → BACKEND_ROOT = backend/
const BACKEND_ROOT = path.join(__dirname, '..', '..');

function publicPdfUrlFromAbsolutePath(filePath) {
  const relativePath = path.relative(BACKEND_ROOT, filePath).replace(/\\/g, '/');
  return `/${relativePath}`;
}

async function storeGeneratedPdf(buffer, fileName, folder = '') {
  if (!buffer || !Buffer.isBuffer(buffer) || !buffer.length) {
    return null;
  }

  if (isBunnyConfigured()) {
    return uploadToBunny(buffer, fileName, folder);
  }

  const safeFolder = sanitizePathPart(folder);
  const safeName = sanitizeFileName(fileName);
  const targetDir = safeFolder
    ? path.join(OUTPUT_DIR, ...safeFolder.split('/'))
    : OUTPUT_DIR;

  await fsPromises.mkdir(targetDir, { recursive: true });
  const storedName = `${Date.now()}-${randomUUID()}-${safeName}`;
  const storedPath = path.join(targetDir, storedName);

  await fsPromises.writeFile(storedPath, buffer);
  return publicPdfUrlFromAbsolutePath(storedPath);
}

async function readStoredPdfBuffer(fileUrl) {
  return fetchPdfBufferFromUrl(fileUrl);
}

async function deleteStoredPdf(fileUrl) {
  if (!fileUrl) return false;

  const localPath = resolveLocalPdfPath(fileUrl);
  if (localPath) {
    await fsPromises.unlink(localPath).catch(() => {});
    return true;
  }

  // If it looks like a storage path (no http), delete via Bunny storage path
  if (!/^https?:\/\//i.test(String(fileUrl))) {
    return deleteFromBunny(fileUrl);
  }
  // Legacy: handle old full CDN URLs that may still exist in DB
  return deleteFromBunny(fileUrl);
}

module.exports = {
  publicPdfUrlFromAbsolutePath,
  storeGeneratedPdf,
  readStoredPdfBuffer,
  deleteStoredPdf,
};
