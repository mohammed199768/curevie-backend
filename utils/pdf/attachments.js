const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const axios = require('axios');
const { PDFDocument } = require('pdf-lib');
const { logger } = require('../logger');
const { generateSignedUrl, isBunnyConfigured } = require('../bunny');

function isImagingProviderReport(report = {}) {
  const providerType = String(report.provider_type || '').trim().toUpperCase();
  const serviceType = String(report.service_type || '').trim().toUpperCase();

  return providerType === 'RADIOLOGY_TECH'
    || serviceType === 'RADIOLOGY';
}

function getAttachableProviderPdfReports(providerReports = []) {
  const seenPdfUrls = new Set();

  return providerReports.filter((report) => {
    const pdfUrl = String(report?.pdf_report_url || '').trim();
    if (!pdfUrl) return false;

    const normalizedKey = pdfUrl.toLowerCase();
    if (seenPdfUrls.has(normalizedKey)) return false;
    seenPdfUrls.add(normalizedKey);

    return true;
  });
}

// AUDIT-FIX: PATH — use __dirname so local PDF resolution targets backend/
// __dirname = backend/utils/pdf → BACKEND_ROOT = backend/
const BACKEND_ROOT = path.join(__dirname, '..', '..');

function resolveLocalPdfPath(fileUrl) {
  if (!fileUrl) return null;

  const rawValue = String(fileUrl).trim();
  if (!rawValue) return null;

  const candidatePaths = [];

  if (path.isAbsolute(rawValue)) {
    candidatePaths.push(rawValue);
  }

  if (/^https?:\/\//i.test(rawValue)) {
    try {
      const parsedUrl = new URL(rawValue);
      const normalizedPathname = decodeURIComponent(parsedUrl.pathname || '');

      if (normalizedPathname.startsWith('/uploads/')) {
        candidatePaths.push(
          path.join(BACKEND_ROOT, normalizedPathname.replace(/^\/+/, '').replace(/\//g, path.sep))
        );
      }
    } catch (_) {}
  } else {
    const normalizedRelativePath = decodeURIComponent(rawValue.replace(/^\/+/, ''));
    if (normalizedRelativePath) {
      candidatePaths.push(
        path.join(BACKEND_ROOT, normalizedRelativePath.replace(/\//g, path.sep))
      );
    }
  }

  return candidatePaths.find((candidatePath) => candidatePath && fs.existsSync(candidatePath)) || null;
}

function getAllowedRemotePdfHosts() {
  const hosts = new Set();
  const bunnyCdnUrl = String(process.env.BUNNY_CDN_URL || '').trim();

  if (bunnyCdnUrl) {
    try {
      hosts.add(new URL(bunnyCdnUrl).host.toLowerCase());
    } catch (_) {}
  }

  return hosts;
}

function isAllowedRemotePdfUrl(fileUrl) {
  try {
    const parsedUrl = new URL(fileUrl);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return false;
    }

    return getAllowedRemotePdfHosts().has(parsedUrl.host.toLowerCase());
  } catch (_) {
    return false;
  }
}

async function fetchPdfBufferFromUrl(fileUrl) {
  const localPdfPath = resolveLocalPdfPath(fileUrl);
  if (localPdfPath) {
    return fsPromises.readFile(localPdfPath);
  }

  const rawValue = String(fileUrl || '').trim();
  if (!rawValue) {
    throw new Error('PDF_URL_REQUIRED');
  }

  let remoteUrl = rawValue;
  if (!/^https?:\/\//i.test(rawValue)) {
    const normalizedPath = rawValue.replace(/\\/g, '/');
    if (normalizedPath.startsWith('/uploads/') || normalizedPath.startsWith('uploads/')) {
      throw new Error('LOCAL_PDF_NOT_FOUND');
    }
    if (!isBunnyConfigured()) {
      throw new Error('REMOTE_PDF_URL_NOT_ALLOWED');
    }
    remoteUrl = generateSignedUrl(rawValue);
  }

  if (!isAllowedRemotePdfUrl(remoteUrl)) {
    throw new Error('REMOTE_PDF_URL_NOT_ALLOWED');
  }

  const response = await axios.get(remoteUrl, {
    responseType: 'arraybuffer',
    timeout: 20000,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP_${response.status}`);
  }

  return Buffer.from(response.data);
}

async function appendAttachedProviderPdfs(pdfDoc, providerReports = []) {
  const attachedReports = getAttachableProviderPdfReports(providerReports);

  for (const report of attachedReports) {
    try {
      const sourceBytes = await fetchPdfBufferFromUrl(report.pdf_report_url);
      const sourcePdf = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
      const copiedPages = await pdfDoc.copyPages(sourcePdf, sourcePdf.getPageIndices());
      copiedPages.forEach((page) => pdfDoc.addPage(page));
    } catch (err) {
      logger.warn('Failed to append provider imaging PDF to generated medical report', {
        requestId: report.request_id || null,
        providerId: report.provider_id || null,
        pdfUrl: report.pdf_report_url,
        error: err.message,
      });
    }
  }

  return attachedReports;
}

module.exports = {
  isImagingProviderReport,
  getAttachableProviderPdfReports,
  resolveLocalPdfPath,
  fetchPdfBufferFromUrl,
  appendAttachedProviderPdfs,
};
