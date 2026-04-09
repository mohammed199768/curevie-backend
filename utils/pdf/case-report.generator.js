const fsPromises = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const axios = require('axios');
const pool = require('../../config/db');
const { logger } = require('../logger');
const { generateSignedUrl, isBunnyConfigured } = require('../bunny');
const { resolveLocalPdfPath } = require('./attachments');
const { addWatermark } = require('./conversion');
const { renderPdfFromHtml, fileToDataUri } = require('./html-renderer');
const { readStoredPdfBuffer, storeGeneratedPdf } = require('./storage');
const { LOGO_PATH, TEMP_DIR } = require('./shared');

function escapeHtml(value) {
  return String(value ?? '-')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function normalizeJsonValue(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;

  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function formatDate(value) {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '-';
  return parsed.toLocaleDateString('en-GB');
}

function formatDateTime(value) {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '-';
  return parsed.toLocaleString('en-GB');
}

function formatDisplayValue(value, fallback = '-') {
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
    return normalized.length ? normalized.join(', ') : fallback;
  }

  if (value && typeof value === 'object') {
    return JSON.stringify(value);
  }

  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function getFileExtension(fileUrl, fallbackExtension = '') {
  const normalizedFallback = String(fallbackExtension || '').trim();
  const safeFallback = normalizedFallback
    ? (normalizedFallback.startsWith('.') ? normalizedFallback : `.${normalizedFallback}`)
    : '';

  const rawValue = String(fileUrl || '').trim();
  if (!rawValue) return safeFallback;

  try {
    const parsed = /^https?:\/\//i.test(rawValue) ? new URL(rawValue) : null;
    const ext = path.extname(parsed ? parsed.pathname : rawValue);
    return ext || safeFallback;
  } catch (_) {
    return path.extname(rawValue) || safeFallback;
  }
}

async function safeUnlink(filePath) {
  if (!filePath) return;
  await fsPromises.unlink(filePath).catch(() => {});
}

async function fetchFileBuffer(fileUrl) {
  const localPath = resolveLocalPdfPath(fileUrl);
  if (localPath) {
    return fsPromises.readFile(localPath);
  }

  const rawValue = String(fileUrl || '').trim();
  if (!rawValue) {
    throw new Error('FILE_URL_REQUIRED');
  }

  let resolvedUrl = rawValue;
  if (!/^https?:\/\//i.test(rawValue)) {
    if (!isBunnyConfigured()) {
      throw new Error('REMOTE_FILE_URL_NOT_ALLOWED');
    }
    resolvedUrl = generateSignedUrl(rawValue);
  }

  const response = await axios.get(resolvedUrl, {
    responseType: 'arraybuffer',
    timeout: 20000,
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP_${response.status}`);
  }

  return Buffer.from(response.data);
}

async function fileUrlToDataUri(fileUrl, fallbackExtension = '.png') {
  const localPath = resolveLocalPdfPath(fileUrl);
  if (localPath) {
    return fileToDataUri(localPath);
  }

  const fileBuffer = await fetchFileBuffer(fileUrl);
  const tempPath = path.join(TEMP_DIR, `${randomUUID()}${getFileExtension(fileUrl, fallbackExtension)}`);

  try {
    await fsPromises.mkdir(TEMP_DIR, { recursive: true });
    await fsPromises.writeFile(tempPath, fileBuffer);
    return await fileToDataUri(tempPath);
  } finally {
    await safeUnlink(tempPath);
  }
}

async function applyWatermarkToPdfBuffer(pdfBuffer, text) {
  const inputPath = path.join(TEMP_DIR, `${randomUUID()}.pdf`);
  let outputPath = null;

  try {
    await fsPromises.mkdir(TEMP_DIR, { recursive: true });
    await fsPromises.writeFile(inputPath, pdfBuffer);
    outputPath = await addWatermark(inputPath, { text });
    return await fsPromises.readFile(outputPath);
  } finally {
    await safeUnlink(inputPath);
    await safeUnlink(outputPath);
  }
}

function buildInfoRow(label, value, direction = 'rtl') {
  return `
    <div class="info-row">
      <span class="info-label">${escapeHtml(label)}</span>
      <span class="info-value ${direction === 'ltr' ? 'ltr' : 'rtl'}">${escapeHtml(formatDisplayValue(value))}</span>
    </div>
  `;
}

function buildCaseReportHtml({ caseRecord, patient, serviceNames, providerSections, logoDataUri }) {
  const shortCaseId = String(caseRecord.id || '').slice(0, 8).toUpperCase() || '-';
  const closedAt = formatDate(caseRecord.closed_at);
  const generatedAt = formatDateTime(new Date());
  const serviceSummary = serviceNames.length ? serviceNames.join(' - ') : 'No case services available';

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <title>Curvie Case Report</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      background: #f8fafc;
      color: #1f2937;
      font-family: Arial, sans-serif;
      line-height: 1.6;
    }
    .page {
      width: 100%;
    }
    .hero {
      background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%);
      border: 1px solid #bfdbfe;
      border-radius: 18px;
      padding: 24px 28px;
      margin-bottom: 20px;
    }
    .hero-top {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 20px;
      direction: ltr;
    }
    .brand-block {
      max-width: 240px;
    }
    .brand-logo {
      height: 62px;
      width: auto;
      object-fit: contain;
      display: block;
      margin-bottom: 10px;
    }
    .brand-name {
      font-size: 13px;
      font-weight: 700;
      color: #2563eb;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .hero-copy {
      flex: 1;
      text-align: right;
      direction: rtl;
    }
    .hero-title {
      margin: 0 0 6px;
      font-size: 28px;
      color: #1d4ed8;
    }
    .hero-subtitle {
      margin: 0;
      font-size: 14px;
      color: #334155;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
      margin-top: 20px;
    }
    .card {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      padding: 18px;
      box-shadow: 0 12px 32px rgba(37, 99, 235, 0.08);
    }
    .card-title {
      margin: 0 0 12px;
      font-size: 16px;
      color: #2563eb;
      font-weight: 700;
    }
    .info-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding: 7px 0;
      border-bottom: 1px solid #e5e7eb;
    }
    .info-row:last-child {
      border-bottom: none;
      padding-bottom: 0;
    }
    .info-label {
      color: #475569;
      font-size: 13px;
      font-weight: 700;
      min-width: 120px;
    }
    .info-value {
      flex: 1;
      color: #111827;
      font-size: 13px;
    }
    .rtl {
      direction: rtl;
      text-align: right;
    }
    .ltr {
      direction: ltr;
      text-align: left;
    }
    .section {
      background: #ffffff;
      border: 1px solid #dbeafe;
      border-radius: 18px;
      padding: 18px;
      margin-bottom: 18px;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .section-header {
      border-right: 4px solid #2563eb;
      padding-right: 12px;
      margin-bottom: 12px;
    }
    .section-title {
      margin: 0 0 4px;
      font-size: 18px;
      color: #1d4ed8;
    }
    .section-meta {
      margin: 0;
      color: #64748b;
      font-size: 13px;
    }
    .image-frame {
      margin-top: 14px;
      border: 1px solid #e2e8f0;
      border-radius: 14px;
      padding: 14px;
      background: #f8fafc;
      text-align: center;
    }
    .image-frame img {
      max-width: 100%;
      height: auto;
      border-radius: 10px;
      display: block;
      margin: 0 auto;
    }
    .placeholder {
      margin-top: 12px;
      background: #eff6ff;
      border: 1px dashed #93c5fd;
      border-radius: 12px;
      padding: 16px;
      color: #1e40af;
      font-size: 14px;
    }
    .footer {
      margin-top: 10px;
      color: #64748b;
      font-size: 12px;
      text-align: center;
    }
    @media print {
      body {
        background: #ffffff;
      }
      .hero, .card, .section {
        box-shadow: none;
      }
    }
  </style>
</head>
<body>
  <div class="page">
    <section class="hero">
      <div class="hero-top">
        <div class="brand-block">
          ${logoDataUri ? `<img class="brand-logo" src="${logoDataUri}" alt="Curvie logo" />` : ''}
          <div class="brand-name">Curvie Clinical Report</div>
        </div>
        <div class="hero-copy">
          <h1 class="hero-title">التقرير الطبي للحالة</h1>
          <p class="hero-subtitle">ملف مجمع للحالة المغلقة يشمل مرفقات مقدمي الخدمة والصور الطبية.</p>
        </div>
      </div>

      <div class="meta-grid">
        <div class="card">
          <h2 class="card-title">بيانات المريض</h2>
          ${buildInfoRow('الاسم', patient.full_name)}
          ${buildInfoRow('الهاتف', patient.phone, 'ltr')}
          ${buildInfoRow('تاريخ الميلاد', formatDate(patient.date_of_birth), 'ltr')}
          ${buildInfoRow('الجنس', patient.gender)}
          ${buildInfoRow('الحساسية', patient.allergies)}
        </div>

        <div class="card">
          <h2 class="card-title">بيانات الحالة</h2>
          ${buildInfoRow('رقم الحالة', shortCaseId, 'ltr')}
          ${buildInfoRow('تاريخ الإغلاق', closedAt, 'ltr')}
          ${buildInfoRow('الحالة', caseRecord.status)}
          ${buildInfoRow('الخدمات', serviceSummary)}
          ${buildInfoRow('تاريخ التوليد', generatedAt, 'ltr')}
        </div>
      </div>
    </section>

    ${providerSections || `
      <section class="section">
        <div class="section-header">
          <h2 class="section-title">لا توجد مرفقات متاحة</h2>
          <p class="section-meta">لم يتم العثور على ملفات مزودين غير خاصة بالإجازة المرضية لهذه الحالة.</p>
        </div>
      </section>
    `}

    <div class="footer">Curvie Medical Records</div>
  </div>
</body>
</html>`;
}

async function generateCaseReportPdf(caseId) {
  const caseResult = await pool.query(
    `
    SELECT c.*,
      p.full_name AS patient_name, p.phone, p.date_of_birth,
      p.gender, p.allergies,
      cs_snap.patient_data, cs_snap.services_data
    FROM cases c
    JOIN patients p ON p.id = c.patient_id
    LEFT JOIN case_snapshots cs_snap ON cs_snap.case_id = c.id
    WHERE c.id = $1
    LIMIT 1
    `,
    [caseId]
  );

  const caseRecord = caseResult.rows[0];
  if (!caseRecord) {
    throw new Error('CASE_NOT_FOUND');
  }

  const providerFilesResult = await pool.query(
    `
    SELECT cpf.*, cs.service_id, s.name AS service_name,
           sp.full_name AS provider_name
    FROM case_provider_files cpf
    JOIN case_services cs ON cs.id = cpf.case_service_id
    JOIN services s ON s.id = cs.service_id
    JOIN service_providers sp ON sp.id = cpf.uploaded_by
    WHERE cs.case_id = $1 AND cpf.is_sick_leave = FALSE
    ORDER BY cpf.created_at ASC
    `,
    [caseId]
  );

  const patientSnapshot = normalizeJsonValue(caseRecord.patient_data) || {};
  const servicesSnapshot = normalizeJsonValue(caseRecord.services_data);
  const patient = {
    full_name: patientSnapshot.full_name || caseRecord.patient_name || '-',
    phone: patientSnapshot.phone || caseRecord.phone || '-',
    date_of_birth: patientSnapshot.date_of_birth || caseRecord.date_of_birth || null,
    gender: patientSnapshot.gender || caseRecord.gender || '-',
    allergies: patientSnapshot.allergies || caseRecord.allergies || '-',
  };
  const serviceNames = Array.from(new Set(
    (
      Array.isArray(servicesSnapshot) && servicesSnapshot.length
        ? servicesSnapshot.map((service) => formatDisplayValue(service?.service_name || service?.name))
        : providerFilesResult.rows.map((fileRecord) => formatDisplayValue(fileRecord.service_name))
    ).filter(Boolean)
  ));
  const logoDataUri = await fileToDataUri(LOGO_PATH);

  const renderedSections = [];
  for (const fileRecord of providerFilesResult.rows) {
    const serviceName = formatDisplayValue(fileRecord.service_name, 'Service');
    const providerName = formatDisplayValue(fileRecord.provider_name, 'Provider');

    if (String(fileRecord.file_type || '').toUpperCase() === 'PDF') {
      logger.warn('Case report generator skipped PDF embedding because Puppeteer cannot inline PDFs', {
        caseId,
        fileId: fileRecord.id,
        serviceName,
        providerName,
        fileUrl: fileRecord.file_url,
      });

      renderedSections.push(`
        <section class="section">
          <div class="section-header">
            <h2 class="section-title">${escapeHtml(serviceName)}</h2>
            <p class="section-meta">${escapeHtml(providerName)} - ${escapeHtml(formatDateTime(fileRecord.created_at))}</p>
          </div>
          <div class="placeholder">تقرير مرفق: ${escapeHtml(serviceName)} - ${escapeHtml(providerName)}</div>
        </section>
      `);
      continue;
    }

    try {
      const imageDataUri = await fileUrlToDataUri(fileRecord.file_url, '.png');

      if (!imageDataUri) {
        throw new Error('IMAGE_DATA_URI_EMPTY');
      }

      renderedSections.push(`
        <section class="section">
          <div class="section-header">
            <h2 class="section-title">${escapeHtml(serviceName)}</h2>
            <p class="section-meta">${escapeHtml(providerName)} - ${escapeHtml(formatDateTime(fileRecord.created_at))}</p>
          </div>
          <div class="image-frame">
            <img src="${imageDataUri}" alt="${escapeHtml(`${serviceName} image`)}" />
          </div>
        </section>
      `);
    } catch (error) {
      logger.warn('Case report generator failed to embed provider image', {
        caseId,
        fileId: fileRecord.id,
        fileUrl: fileRecord.file_url,
        error: error.message,
      });

      renderedSections.push(`
        <section class="section">
          <div class="section-header">
            <h2 class="section-title">${escapeHtml(serviceName)}</h2>
            <p class="section-meta">${escapeHtml(providerName)} - ${escapeHtml(formatDateTime(fileRecord.created_at))}</p>
          </div>
          <div class="placeholder">تعذر تحميل الصورة المرفقة لهذه الخدمة.</div>
        </section>
      `);
    }
  }

  const html = buildCaseReportHtml({
    caseRecord,
    patient,
    serviceNames,
    providerSections: renderedSections.join('\n'),
    logoDataUri,
  });

  const pdfBuffer = await renderPdfFromHtml(html, {
    marginTop: '20mm',
    marginBottom: '20mm',
    marginLeft: '15mm',
    marginRight: '15mm',
  });

  const storedUrl = await storeGeneratedPdf(pdfBuffer, `case-report-${caseId}.pdf`, 'case-reports');
  if (!storedUrl) {
    throw new Error('CASE_REPORT_STORE_FAILED');
  }

  return storedUrl;
}

async function generateSickLeavePdf(caseId, fileRecord) {
  try {
    if (!fileRecord || !fileRecord.file_url) {
      throw new Error('INVALID_FILE_RECORD');
    }

    let basePdfBuffer = null;

    if (String(fileRecord.file_type || '').toUpperCase() === 'PDF') {
      basePdfBuffer = await readStoredPdfBuffer(fileRecord.file_url);
    } else if (String(fileRecord.file_type || '').toUpperCase() === 'IMAGE') {
      const imageDataUri = await fileUrlToDataUri(fileRecord.file_url, '.png');
      if (!imageDataUri) {
        throw new Error('IMAGE_DATA_URI_EMPTY');
      }

      const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <style>
    @page { size: A4; margin: 0; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: #ffffff;
      font-family: Arial, sans-serif;
    }
    .page {
      width: 100%;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 12mm;
    }
    img {
      display: block;
      max-width: 100%;
      max-height: calc(100vh - 24mm);
      object-fit: contain;
      margin: 0 auto;
    }
  </style>
</head>
<body>
  <div class="page">
    <img src="${imageDataUri}" alt="Sick leave document" />
  </div>
</body>
</html>`;

      basePdfBuffer = await renderPdfFromHtml(html, {
        marginTop: '0mm',
        marginBottom: '0mm',
        marginLeft: '0mm',
        marginRight: '0mm',
      });
    } else {
      throw new Error(`UNSUPPORTED_FILE_TYPE_${fileRecord.file_type}`);
    }

    const watermarkedBuffer = await applyWatermarkToPdfBuffer(basePdfBuffer, 'Curvie');
    const storedUrl = await storeGeneratedPdf(watermarkedBuffer, `sick-leave-${caseId}.pdf`, 'sick-leave');
    return storedUrl || null;
  } catch (error) {
    logger.warn('Failed to generate sick leave PDF', {
      caseId,
      fileId: fileRecord?.id || null,
      fileType: fileRecord?.file_type || null,
      error: error.message,
    });
    return null;
  }
}

module.exports = {
  generateCaseReportPdf,
  generateSickLeavePdf,
};
