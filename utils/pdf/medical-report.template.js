function escapeHtml(value) {
  if (value === null || value === undefined) return '-';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeMultilineHtml(value) {
  return escapeHtml(value).replace(/\r?\n/g, '<br />');
}

function humanizeEnum(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '-';
  return normalized
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function getProviderTypeLabel(type) {
  const normalized = String(type || '').trim().toUpperCase();
  if (normalized === 'DOCTOR') return 'Doctor';
  if (normalized === 'LAB_TECH') return 'Lab Technician';
  if (normalized === 'RADIOLOGY_TECH') return 'Radiology Technician';
  if (normalized === 'NURSE') return 'Nurse';
  return humanizeEnum(type);
}

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString('en-GB') : '-';
}

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString('en-GB') : '-';
}

function calculateAge(dateOfBirth) {
  if (!dateOfBirth) return null;
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return null;

  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
    age -= 1;
  }

  return Math.max(0, age);
}

function normalizeOptionalAge(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.floor(numeric));
}

function resolvePatientAge(patient = {}) {
  return calculateAge(patient.date_of_birth) ?? normalizeOptionalAge(patient.age);
}

const RTL_CHAR_PATTERN = /[\u0590-\u08FF\uFB1D-\uFDFD\uFE70-\uFEFC]/;
const LTR_CHAR_PATTERN = /[A-Za-z]/;
const DIGIT_CHAR_PATTERN = /[0-9]/;
const BIDI_TOKEN_PATTERN = /[\u0590-\u08FF\uFB1D-\uFDFD\uFE70-\uFEFC]+|[A-Za-z0-9]+(?:[/:.,_%+-][A-Za-z0-9]+)*|\s+|./g;

function containsArabicText(value) {
  return RTL_CHAR_PATTERN.test(String(value || ''));
}

function detectTextDirection(value) {
  const normalized = String(value || '');

  for (const char of normalized) {
    if (RTL_CHAR_PATTERN.test(char)) return 'rtl';
    if (LTR_CHAR_PATTERN.test(char) || DIGIT_CHAR_PATTERN.test(char)) return 'ltr';
  }

  return containsArabicText(normalized) ? 'rtl' : 'ltr';
}

function joinClasses(...classes) {
  return classes.filter(Boolean).join(' ');
}

function renderInlineSegments(value, fallbackDirection = 'ltr') {
  const tokens = String(value || '').match(BIDI_TOKEN_PATTERN) || [];

  return tokens.map((token) => {
    if (/^\s+$/.test(token)) return token;

    const direction = containsArabicText(token)
      ? 'rtl'
      : (LTR_CHAR_PATTERN.test(token) || DIGIT_CHAR_PATTERN.test(token) ? 'ltr' : fallbackDirection);

    return `<bdi dir="${direction}" class="${joinClasses('text-fragment', direction === 'rtl' ? 'arabic-text' : 'latin-text')}">${escapeHtml(token)}</bdi>`;
  }).join('');
}

function renderTextBlock(value, {
  fallback = '-',
  className = '',
  multiline = true,
  dir = 'auto',
} = {}) {
  const rawValue = value === null || value === undefined ? '' : String(value).replace(/\r/g, '');
  const trimmed = rawValue.trim();
  const content = trimmed || fallback;
  const lines = content.split('\n');
  const baseDirection = dir === 'auto' ? detectTextDirection(content) : dir;

  return `
    <div class="${joinClasses('text-block', baseDirection === 'rtl' ? 'rtl-block' : 'ltr-block', multiline ? 'multiline-block' : 'singleline-block', className)}" dir="${baseDirection}">
      ${lines.map((line) => {
        const lineDirection = line.trim() ? detectTextDirection(line) : baseDirection;
        return `<div class="${joinClasses('text-line', multiline ? 'multiline-line' : 'singleline-line', lineDirection === 'rtl' ? 'rtl-line' : 'ltr-line')}" dir="${lineDirection}">${line.trim() ? renderInlineSegments(line, lineDirection) : '&nbsp;'}</div>`;
      }).join('')}
    </div>
  `;
}

function renderFieldRows(fields = []) {
  return `
    <div class="field-list">
      ${fields.map((field) => `
        <div class="field-row">
          <div class="field-label">${escapeHtml(field.label)}</div>
          <div class="${joinClasses('field-value', field.valueClass)}">
            ${renderTextBlock(field.value, {
              multiline: field.multiline !== false,
              className: field.blockClass || '',
              dir: field.dir || 'auto',
            })}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderHeroMetaRow(label, value, dir = 'auto') {
  return `
    <div class="hero-meta-row">
      <span class="hero-meta-label">${escapeHtml(label)}</span>
      <div class="hero-meta-value">${renderTextBlock(value, { multiline: false, dir })}</div>
    </div>
  `;
}

function renderLabStat(label, value, dir = 'auto') {
  return `
    <div class="lab-stat">
      <span class="lab-stat-label">${escapeHtml(label)}</span>
      <div class="lab-stat-value">${renderTextBlock(value, { multiline: false, dir })}</div>
    </div>
  `;
}

function resolveLabFlag(result) {
  const flag = String(result.flag || '').trim().toUpperCase();
  if (flag && flag !== 'NO_RANGE') return flag;
  if (result.is_normal === true) return 'NORMAL';
  if (result.is_normal === false) return 'ABNORMAL';
  return 'NO_RANGE';
}

function buildFontFaceCss(assets = {}) {
  const entries = [];
  if (assets.regularFontDataUri) {
    entries.push(`
      @font-face {
        font-family: 'ReportSans';
        font-weight: 400;
        font-style: normal;
        src: url('${assets.regularFontDataUri}') format('truetype');
      }
    `);
  }
  if (assets.boldFontDataUri) {
    entries.push(`
      @font-face {
        font-family: 'ReportSans';
        font-weight: 700;
        font-style: normal;
        src: url('${assets.boldFontDataUri}') format('truetype');
      }
    `);
  }
  if (assets.arabicFontDataUri) {
    entries.push(`
      @font-face {
        font-family: 'ReportArabic';
        font-weight: 400;
        font-style: normal;
        src: url('${assets.arabicFontDataUri}') format('truetype');
      }
    `);
  }
  if (assets.arabicBoldFontDataUri) {
    entries.push(`
      @font-face {
        font-family: 'ReportArabic';
        font-weight: 700;
        font-style: normal;
        src: url('${assets.arabicBoldFontDataUri}') format('truetype');
      }
    `);
  }
  return entries.join('\n');
}

function renderLabFlag(flag) {
  const map = {
    NORMAL: { label: 'Normal', className: 'flag-normal' },
    HIGH: { label: 'High', className: 'flag-high' },
    LOW: { label: 'Low', className: 'flag-low' },
    ABNORMAL: { label: 'Abnormal', className: 'flag-abnormal' },
    NO_RANGE: { label: 'No Range', className: 'flag-norange' },
    PENDING: { label: 'Pending', className: 'flag-norange' },
  };
  const state = map[flag] || map.NO_RANGE;
  return `<span class="flag-pill ${state.className}">${state.label}</span>`;
}

function renderProviderReport(report) {
  const role = getProviderTypeLabel(report.provider_type);
  const status = humanizeEnum(report.status || 'Submitted');
  const type = humanizeEnum(report.report_type || 'Report');
  const updatedAt = report.updated_at ? formatDateTime(report.updated_at) : null;

  const fields = [];
  const pushField = (label, value) => {
    const normalized = String(value || '').trim();
    if (normalized) fields.push({ label, value: normalized });
  };

  pushField('Clinical Summary', report.symptoms_summary);
  pushField('Findings', report.findings);
  pushField('Diagnosis', report.diagnosis);
  pushField('Treatment Plan', report.treatment_plan);
  pushField('Recommendations', report.recommendations);
  pushField('Procedures', report.procedures_done || report.procedures_performed);
  pushField('Allergies', report.patient_allergies || report.allergies_noted);
  pushField('Lab Notes', report.lab_notes);
  pushField('Imaging Notes', report.imaging_notes);
  pushField('Nursing Notes', report.nurse_notes);
  pushField('Care Notes', report.notes);
  if (report.pdf_report_url && fields.length === 0) {
    pushField(
      'Summary',
      'No structured clinical notes were submitted in text. The provider supplied a PDF attachment, and it is appended to this report.'
    );
  } else if (report.pdf_report_url) {
    pushField('Diagnostic Attachment', 'The provider supplied a PDF attachment, and it is appended to this report.');
  }

  return `
    <div class="provider-block">
      <div class="provider-block-header">
        <div class="provider-block-meta">
          ${renderTextBlock(report.provider_name || '-', {
            multiline: false,
            className: 'provider-block-name',
          })}
          <span class="provider-block-role">${escapeHtml(`${role} - ${type}`)}</span>
          ${updatedAt ? `<span class="provider-block-role provider-block-updated">Updated ${escapeHtml(updatedAt)}</span>` : ''}
        </div>
        <span class="status-badge">${escapeHtml(status)}</span>
      </div>
      <div class="narrative-list">
        ${
          fields.length
            ? fields.map((field) => `
              <div class="narrative-row">
                <div class="narrative-label">${escapeHtml(field.label)}</div>
                <div class="narrative-value">${renderTextBlock(field.value, { multiline: true, className: 'narrative-copy' })}</div>
              </div>
            `).join('')
            : `
              <div class="narrative-row">
                <div class="narrative-label">Summary</div>
                <div class="narrative-value">${renderTextBlock('No clinical notes were submitted for this report block.', {
                  multiline: true,
                  className: 'narrative-copy muted-text',
                  dir: 'ltr',
                })}</div>
              </div>
            `
        }
      </div>
    </div>
  `;
}

function renderLabCard(result) {
  const flag = resolveLabFlag(result);
  const unit = String(result.unit || '').trim();
  const resultText = `${result.result || '-'}${unit ? ` ${unit}` : ''}`;

  const referenceParts = [];
  if (result.range_text) {
    referenceParts.push(String(result.range_text).trim());
  } else {
    if (result.range_low !== null && result.range_low !== undefined && result.range_low !== '') {
      referenceParts.push(String(result.range_low));
    }
    if (result.range_high !== null && result.range_high !== undefined && result.range_high !== '') {
      referenceParts.push(String(result.range_high));
    }
  }

  const referenceText = referenceParts.length
    ? `${referenceParts.join(' - ')}${unit ? ` ${unit}` : ''}`
    : String(result.reference_range || '-');

  return `
    <div class="lab-card flag-card-${flag.toLowerCase()}">
      <div class="lab-card-header">
        <div class="lab-card-name">${renderTextBlock(result.test_name || 'Lab Result', {
          multiline: false,
          className: 'lab-card-name-copy',
        })}</div>
        ${renderLabFlag(flag)}
      </div>
      <div class="lab-card-body">
        ${renderLabStat('Result', resultText)}
        ${renderLabStat('Reference', referenceText)}
        ${renderLabStat('Captured', formatDateTime(result.created_at), 'ltr')}
        ${result.notes ? `<div class="lab-note">${renderTextBlock(result.notes, { multiline: true, className: 'lab-note-copy' })}</div>` : ''}
      </div>
    </div>
  `;
}

function renderAttachmentRow(report) {
  return `
    <div class="attachment-row">
      <div class="attachment-icon">PDF</div>
      <div class="attachment-body">
        <div class="attachment-name">${renderTextBlock(report.provider_name || 'Provider Attachment', {
          multiline: false,
          className: 'attachment-name-copy',
        })}</div>
        <div class="attachment-meta">${escapeHtml(`${getProviderTypeLabel(report.provider_type)} uploaded a diagnostic document that is appended after this report.`)}</div>
      </div>
    </div>
  `;
}

function renderMedicalReportHtml(reportData, assets = {}) {
  const request = reportData.request || {};
  const patient = reportData.patient || {};
  const providerReports = Array.isArray(reportData.provider_reports) ? reportData.provider_reports : [];
  const labResults = Array.isArray(reportData.lab_results) ? reportData.lab_results : [];
  const reportMeta = reportData.report_meta || {};

  const primaryReport = providerReports.find((report) => report.report_type === 'FINAL_REPORT')
    || providerReports[0]
    || null;

  const serviceName = request.service_name || humanizeEnum(request.service_type) || 'Care Service';
  const providerName = primaryReport?.provider_name || request.provider_name || request.lead_provider_name || '-';
  const providerRole = getProviderTypeLabel(primaryReport?.provider_type || request.provider_type || request.lead_provider_type);
  const issuedAt = reportMeta.reviewed_at || reportMeta.published_at || request.closed_at || request.completed_at || new Date();
  const patientAge = resolvePatientAge(patient);
  const reportNumber = request.id ? request.id.slice(0, 8).toUpperCase() : '-';
  const generatedAt = new Date().toLocaleString('en-GB');

  const logoHtml = assets.logoDataUri
    ? `<img class="hero-logo" src="${assets.logoDataUri}" alt="Curevie" style="height:60px;max-width:220px;object-fit:contain;display:block;margin-bottom:8px;" />`
    : `<span class="hero-wordmark">CUREVIE</span>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Curevie Medical Report</title>
  <style>
    ${buildFontFaceCss(assets)}

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      background: #eef1ed;
      color: #131f1e;
      font-family: 'ReportSans', 'ReportArabic', 'Noto Naskh Arabic', 'Trebuchet MS', 'Segoe UI', Arial, sans-serif;
      direction: ltr;
      font-size: 13px;
      line-height: 1.6;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    @page { size: A4; margin: 0; }
    .page-shell { padding: 14px; }
    .text-block, .text-line {
      max-width: 100%;
      min-width: 0;
    }
    .text-line {
      overflow-wrap: anywhere;
      word-break: break-word;
      unicode-bidi: plaintext;
    }
    .multiline-line {
      white-space: pre-wrap;
    }
    .singleline-line {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .rtl-block, .rtl-line {
      direction: rtl;
      text-align: right;
    }
    .ltr-block, .ltr-line {
      direction: ltr;
      text-align: left;
    }
    .text-fragment {
      unicode-bidi: isolate;
    }
    .arabic-text {
      direction: rtl;
      text-align: right;
      unicode-bidi: embed;
      font-family: 'ReportArabic', 'Noto Naskh Arabic', Arial, sans-serif;
    }
    .latin-text {
      direction: ltr;
      text-align: left;
      unicode-bidi: isolate;
      font-family: 'ReportSans', 'Segoe UI', Arial, sans-serif;
    }
    .report-page {
      background: #f7faf7;
      border-radius: 20px;
      overflow: hidden;
      position: relative;
    }

    .hero {
      background: #0d4440;
      padding: 0;
      position: relative;
      overflow: hidden;
    }
    .hero::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 5px;
      background: #c69d2e;
    }
    .hero::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: #4e7a3c;
    }
    .hero-inner {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      padding: 32px 38px 28px;
    }
    .hero-left { flex: 1; }
    .hero-logo { height: 44px; margin-bottom: 14px; display: block; }
    .hero-wordmark {
      font-size: 22pt;
      font-weight: 700;
      color: #ffffff;
      letter-spacing: 0.06em;
      display: block;
      margin-bottom: 14px;
    }
    .hero-title {
      font-size: 22pt;
      font-weight: 700;
      color: #ffffff;
      line-height: 1.15;
      margin-bottom: 8px;
    }
    .hero-service {
      color: #9fccc0;
      max-width: 360px;
    }
    .hero-service .text-line {
      font-size: 10pt;
    }
    .hero-meta-box {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 12px;
      padding: 18px 20px;
      min-width: 175px;
      flex-shrink: 0;
      margin-left: 28px;
    }
    .hero-meta-row {
      display: flex;
      flex-direction: column;
      margin-bottom: 10px;
    }
    .hero-meta-row:last-child { margin-bottom: 0; }
    .hero-meta-label {
      font-size: 6.5pt;
      font-weight: 700;
      color: #78b09e;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      margin-bottom: 2px;
    }
    .hero-meta-value {
      color: #ffffff;
      font-weight: 400;
    }
    .hero-meta-value .text-line {
      font-size: 8.5pt;
    }

    .report-body { padding: 32px 38px 38px; }
    .report-section { margin-top: 28px; }

    .overview-row {
      display: grid;
      grid-template-columns: 1.4fr 1fr;
      gap: 14px;
      margin-bottom: 20px;
    }
    .overview-card {
      background: #ffffff;
      border-radius: 16px;
      border: 1px solid #dde6dc;
      overflow: hidden;
      position: relative;
    }
    .overview-card-accent { height: 6px; background: #0d4440; }
    .overview-card-accent.gold { background: #c69d2e; }
    .overview-card-inner { padding: 18px 20px 20px; }
    .overview-card-tag {
      display: inline-block;
      font-size: 7pt;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: #4e7a3c;
      background: #edf4e8;
      border-radius: 4px;
      padding: 3px 8px;
      margin-bottom: 10px;
    }
    .overview-card-tag.gold-tag { color: #7a5a0a; background: #f7f0dc; }
    .overview-card-headline {
      margin-bottom: 14px;
    }
    .overview-card-headline .text-line {
      font-size: 15pt;
      font-weight: 700;
      color: #0d4440;
      line-height: 1.2;
    }
    .field-list {
      display: flex;
      flex-direction: column;
      margin-bottom: 12px;
    }
    .field-row {
      display: flex;
      justify-content: space-between;
      gap: 14px;
      padding: 6px 0;
      border-bottom: 1px solid #f1f5f9;
    }
    .field-row:last-child {
      border-bottom: none;
    }
    .field-label {
      color: #64748b;
      font-size: 12px;
      min-width: 140px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .field-value {
      flex: 1;
      min-width: 0;
    }
    .field-value .rtl-block,
    .field-value .ltr-block {
      text-align: right;
    }
    .field-value .text-line {
      font-size: 9pt;
      font-weight: 500;
      color: #131f1e;
    }
    .overview-note {
      border-top: 1px solid #e4ece3;
      padding-top: 10px;
    }
    .overview-note .text-line {
      font-size: 8pt;
      color: #617270;
    }

    .provider-banner {
      background: #0d4440;
      border-radius: 14px;
      padding: 18px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 28px;
      position: relative;
      overflow: hidden;
    }
    .provider-banner::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 7px;
      background: #c69d2e;
    }
    .provider-banner-left { padding-left: 16px; flex: 1; }
    .provider-banner-caption {
      font-size: 7.5pt;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #78b09e;
      margin-bottom: 4px;
    }
    .provider-banner-name {
      margin-bottom: 4px;
    }
    .provider-banner-name .text-line {
      font-size: 17pt;
      font-weight: 700;
      color: #ffffff;
    }
    .provider-banner-meta { font-size: 9pt; color: #9fccc0; }
    .provider-banner-badge {
      background: #c69d2e;
      color: #3a2800;
      font-size: 8pt;
      font-weight: 700;
      padding: 5px 14px;
      border-radius: 20px;
      white-space: nowrap;
      flex-shrink: 0;
    }

    .section-heading { margin: 28px 0 16px; }
    .section-eyebrow {
      font-size: 7pt;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #8fa8a5;
      margin-bottom: 4px;
    }
    .section-title {
      font-size: 16pt;
      font-weight: 700;
      color: #0d4440;
      line-height: 1.1;
    }
    .section-rule {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 7px;
    }
    .section-rule-accent {
      width: 88px;
      height: 3px;
      background: #4e7a3c;
      border-radius: 2px;
      flex-shrink: 0;
    }
    .section-rule-line {
      flex: 1;
      height: 1px;
      background: #dde6dc;
    }
    .section-subtitle {
      font-size: 8.5pt;
      color: #617270;
      margin-top: 8px;
      line-height: 1.5;
    }

    .provider-block { margin-bottom: 14px; }
    .provider-report-list { display: block; }
    .provider-block-header {
      background: #1a5550;
      border-radius: 10px 10px 0 0;
      padding: 13px 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: relative;
      overflow: hidden;
    }
    .provider-block-header::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 6px;
      background: #c69d2e;
    }
    .provider-block-meta { padding-left: 14px; }
    .provider-block-name {
      display: block;
    }
    .provider-block-name .text-line {
      font-size: 11.5pt;
      font-weight: 700;
      color: #ffffff;
    }
    .provider-block-role {
      display: block;
      font-size: 8pt;
      color: #9fccc0;
      margin-top: 2px;
    }
    .provider-block-updated {
      opacity: 0.9;
    }
    .status-badge {
      background: rgba(255,255,255,0.15);
      color: #ffffff;
      font-size: 7.5pt;
      font-weight: 700;
      padding: 4px 12px;
      border-radius: 20px;
      white-space: nowrap;
    }
    .narrative-list {
      border: 1px solid #dde6dc;
      border-top: none;
      border-radius: 0 0 10px 10px;
      overflow: hidden;
    }
    .narrative-row {
      display: grid;
      grid-template-columns: 160px 1fr;
      border-bottom: 1px solid #edf1ec;
      background: #ffffff;
    }
    .narrative-row:last-child { border-bottom: none; }
    .narrative-row:nth-child(odd) { background: #f9fbf8; }
    .narrative-label {
      padding: 11px 14px;
      font-size: 7.5pt;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #4e7a3c;
      background: #f1f6ee;
      border-right: 1px solid #e0e9de;
    }
    .narrative-value {
      padding: 11px 16px;
    }
    .narrative-copy .text-line {
      font-size: 9.5pt;
      color: #131f1e;
      line-height: 1.55;
    }
    .muted-text {
      color: #8fa8a5;
      font-style: italic;
    }

    .lab-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .lab-card {
      background: #ffffff;
      border-radius: 12px;
      border: 1px solid #dde6dc;
      overflow: hidden;
    }
    .lab-card-header {
      padding: 12px 16px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid #edf1ec;
    }
    .lab-card-name {
      display: block;
      flex: 1;
      min-width: 0;
    }
    .lab-card-name-copy .text-line {
      font-size: 11pt;
      font-weight: 700;
      color: #0d4440;
    }
    .lab-card-body { padding: 12px 16px; }
    .lab-stat {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      margin-bottom: 6px;
    }
    .lab-stat:last-child { margin-bottom: 0; }
    .lab-stat-label {
      font-size: 7.5pt;
      font-weight: 700;
      color: #8fa8a5;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .lab-stat-value {
      display: block;
      max-width: 65%;
      flex: 1;
      min-width: 0;
    }
    .lab-stat-value .rtl-block,
    .lab-stat-value .ltr-block {
      text-align: right;
    }
    .lab-stat-value .text-line {
      font-size: 9pt;
      color: #131f1e;
    }
    .lab-note {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid #edf1ec;
    }
    .lab-note-copy .text-line {
      font-size: 8.5pt;
      color: #617270;
      line-height: 1.5;
    }

    .flag-card-normal   { border-left: 5px solid #3b7a42; }
    .flag-card-high     { border-left: 5px solid #c47415; }
    .flag-card-low      { border-left: 5px solid #2e62b8; }
    .flag-card-abnormal { border-left: 5px solid #b52222; }
    .flag-card-no_range { border-left: 5px solid #9aaca8; }
    .flag-card-pending  { border-left: 5px solid #9aaca8; }

    .flag-pill {
      font-size: 7.5pt;
      font-weight: 700;
      padding: 3px 11px;
      border-radius: 20px;
      white-space: nowrap;
      border: 1px solid transparent;
    }
    .flag-normal   { background: #e5f5e7; color: #1f5c26; border-color: #a8d9ac; }
    .flag-high     { background: #fdf0e0; color: #7a4400; border-color: #f2be74; }
    .flag-low      { background: #e8eef9; color: #1b3a7a; border-color: #95b0e0; }
    .flag-abnormal { background: #fde8e8; color: #7a1515; border-color: #f0a0a0; }
    .flag-norange  { background: #f0f3f2; color: #4a5c5a; border-color: #c8d4d2; }

    .attachment-row {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 12px 16px;
      background: #ffffff;
      border: 1px solid #dde6dc;
      border-radius: 10px;
      margin-bottom: 8px;
    }
    .attachment-icon {
      width: 36px;
      height: 36px;
      background: #edf4e8;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      font-size: 11px;
      font-weight: 700;
      color: #4e7a3c;
    }
    .attachment-body {
      min-width: 0;
      flex: 1;
    }
    .attachment-name-copy .text-line {
      font-size: 9pt;
      font-weight: 700;
      color: #0d4440;
    }
    .attachment-meta {
      font-size: 8pt;
      color: #8fa8a5;
      margin-top: 2px;
      overflow-wrap: anywhere;
    }

    .report-footer {
      background: #0d4440;
      padding: 18px 38px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: relative;
    }
    .report-footer::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: #c69d2e;
    }
    .footer-brand {
      font-size: 9pt;
      font-weight: 700;
      color: #9fccc0;
    }
    .footer-confidential {
      font-size: 7.5pt;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: #c69d2e;
    }
    .footer-date {
      font-size: 7.5pt;
      color: #78b09e;
    }

    @media print {
      .page-shell { padding: 0; }
      .report-page { border-radius: 0; }
      .report-body {
        padding-bottom: 56px;
      }
      .section-heading,
      .report-section,
      .provider-banner,
      .provider-block,
      .lab-card,
      .attachment-row,
      .report-footer,
      .overview-card {
        break-inside: avoid !important;
        page-break-inside: avoid !important;
      }
      .section-heading {
        page-break-after: avoid !important;
        break-after: avoid-page !important;
      }
      .section-heading + .provider-block,
      .section-heading + .provider-report-list,
      .section-heading + .lab-grid,
      .section-heading + .attachment-row {
        page-break-before: avoid !important;
        break-before: avoid-page !important;
      }
      .lab-grid {
        display: block !important;
      }
      .lab-card {
        display: block !important;
        margin-bottom: 12px !important;
      }
      .overview-row {
        display: block !important;
      }
      .overview-card {
        margin-bottom: 14px !important;
      }
      .narrative-row {
        break-inside: avoid !important;
        page-break-inside: avoid !important;
      }
      .provider-block-header {
        page-break-after: avoid !important;
        break-after: avoid-page !important;
      }
      .provider-banner,
      .overview-card,
      .lab-card,
      .narrative-row,
      .provider-block-header {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
      .report-footer {
        margin-top: 24px;
      }
    }
  </style>
</head>
<body>
<div class="page-shell">
  <div class="report-page">
    <header class="hero">
      <div class="hero-inner">
        <div class="hero-left">
          ${logoHtml}
          <div class="hero-service">${renderTextBlock(serviceName, { multiline: false })}</div>
        </div>
        <div class="hero-meta-box">
          ${renderHeroMetaRow('Document', 'Confidential Report', 'ltr')}
          ${renderHeroMetaRow('Issued', formatDate(issuedAt), 'ltr')}
          ${renderHeroMetaRow('Provider', providerName)}
          ${renderHeroMetaRow('Ref #', reportNumber, 'ltr')}
        </div>
      </div>
    </header>

    <div class="report-body">
      <div class="overview-row" style="grid-template-columns: 1fr;">
        <div class="overview-card">
          <div class="overview-card-accent gold"></div>
          <div class="overview-card-inner">
            <span class="overview-card-tag gold-tag">Patient Information</span>
            <div class="overview-card-headline">${renderTextBlock(patient.full_name || 'Patient', { multiline: true })}</div>
            ${renderFieldRows([
              { label: 'Phone', value: patient.phone || '-', multiline: false, dir: 'ltr' },
              { label: 'Gender', value: humanizeEnum(patient.gender), multiline: false, dir: 'ltr' },
              { label: 'Age', value: patientAge != null ? `${patientAge} years` : '-', multiline: false, dir: 'ltr' },
              { label: 'Date of Birth', value: formatDate(patient.date_of_birth), multiline: false, dir: 'ltr' },
            ])}
            <div class="overview-note">${renderTextBlock(patient.address || patient.email || 'No additional contact details.', { multiline: true })}</div>
          </div>
        </div>
      </div>

      <div class="provider-banner">
        <div class="provider-banner-left">
          <div class="provider-banner-caption">Assigned Provider</div>
          <div class="provider-banner-name">${renderTextBlock(providerName, { multiline: false })}</div>
          <div class="provider-banner-meta">${escapeHtml(`${providerRole}${primaryReport?.updated_at ? ` - Updated ${formatDateTime(primaryReport.updated_at)}` : ''}`)}</div>
        </div>
        <div class="provider-banner-badge">${escapeHtml(humanizeEnum(primaryReport?.report_type || 'Final Report'))}</div>
      </div>

      <section class="report-section">
        <div class="provider-report-list">
          ${
            providerReports.length
              ? providerReports.map((report) => renderProviderReport(report)).join('')
              : renderProviderReport({
                  provider_name: providerName,
                  provider_type: primaryReport?.provider_type,
                  report_type: 'SUMMARY',
                  status: 'pending',
                })
          }
        </div>
      </section>

      ${
        labResults.length
          ? `
            <section class="report-section">
              <div class="section-heading">
                <div class="section-eyebrow">Section</div>
                <div class="section-title">Laboratory Results</div>
                <div class="section-rule">
                  <div class="section-rule-accent"></div>
                  <div class="section-rule-line"></div>
                </div>
                <div class="section-subtitle">Structured lab outcomes captured during the request are listed below.</div>
              </div>
              <div class="lab-grid">
                ${labResults.map((result) => renderLabCard(result)).join('')}
              </div>
            </section>
          `
          : ''
      }

      ${
        providerReports.some((report) => report?.pdf_report_url)
          ? `
            <section class="report-section">
              <div class="section-heading">
                <div class="section-eyebrow">Section</div>
                <div class="section-title">Attached Diagnostic Documents</div>
                <div class="section-rule">
                  <div class="section-rule-accent"></div>
                  <div class="section-rule-line"></div>
                </div>
                <div class="section-subtitle">Original provider PDFs are appended after this generated summary.</div>
              </div>
              ${providerReports.filter((report) => report?.pdf_report_url).map((report) => renderAttachmentRow(report)).join('')}
            </section>
          `
          : ''
      }
    </div>

    <footer class="report-footer">
      <div class="footer-brand">Curevie Clinical Records</div>
      <div class="footer-confidential">Confidential</div>
      <div class="footer-date">Generated: ${escapeHtml(generatedAt)}</div>
    </footer>
  </div>
</div>
</body>
</html>`;
}

module.exports = {
  renderMedicalReportHtml,
};
