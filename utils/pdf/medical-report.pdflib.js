const { PDFDocument, rgb } = require('pdf-lib');
const { loadMedicalReportPdfData } = require('./report-data');
const {
  embedPdfFonts,
  formatPdfDate,
  formatPdfDateTime,
  humanizeEnum,
  getProviderTypeLabel,
  calculateAgeFromDate,
  getAttachmentFileName,
  loadEmbeddedLogoImage,
  createPdfTextToolkit,
} = require('./shared');
const {
  isImagingProviderReport,
  getAttachableProviderPdfReports,
  appendAttachedProviderPdfs,
} = require('./attachments');

async function generateMedicalReportPdf(reportData) {
  reportData = await loadMedicalReportPdfData(reportData);
  const pdfDoc = await PDFDocument.create();
  const { font, fontBold, allowUnicode } = await embedPdfFonts(pdfDoc);

  const PAGE_W = 595;
  const PAGE_H = 842;
  const MARGIN = 42;
  const CONTENT_W = PAGE_W - (MARGIN * 2);
  const BOTTOM_MARGIN = 52;
  const C = {
    brandPrimary: rgb(0x10 / 255, 0x4d / 255, 0x49 / 255),
    brandSecondary: rgb(0x30 / 255, 0x4a / 255, 0x43 / 255),
    brandAccent: rgb(0x86 / 255, 0xab / 255, 0x62 / 255),
    brandOlive: rgb(0x5a / 255, 0x7a / 255, 0x50 / 255),
    brandStone: rgb(0x9c / 255, 0x9f / 255, 0xa2 / 255),
    ink: rgb(0.12, 0.16, 0.16),
    muted: rgb(0.36, 0.41, 0.41),
    line: rgb(0.84, 0.87, 0.85),
    surfaceAlt: rgb(0.94, 0.96, 0.93),
    white: rgb(1, 1, 1),
  };

  const request = reportData.request || {};
  const patient = reportData.patient || {};
  const labResults = Array.isArray(reportData.lab_results) ? reportData.lab_results : [];
  const providerReports = Array.isArray(reportData.provider_reports) ? reportData.provider_reports : [];
  const reportMeta = reportData.report_meta || {};
  const primaryReport = providerReports.find((report) => report.report_type === 'FINAL_REPORT')
    || providerReports[0]
    || null;
  const attachedPdfReports = getAttachableProviderPdfReports(providerReports);
  const {
    asDisplay,
    measureText,
    wrapText,
    truncateText,
    drawTextLines,
  } = createPdfTextToolkit({ font, fontBold, allowUnicode });

  const serviceName = request.service_name || humanizeEnum(request.service_type) || 'Care Service';
  const serviceSummaryText = request.service_description || request.notes || 'No additional package or service notes were provided.';
  const providerName = primaryReport?.provider_name
    || request.provider_name
    || request.lead_provider_name
    || '-';
  const providerRole = getProviderTypeLabel(primaryReport?.provider_type || request.provider_type || request.lead_provider_type);
  const issuedAt = reportMeta.reviewed_at || reportMeta.published_at || request.closed_at || request.completed_at || new Date();
  const patientAge = patient.age != null ? patient.age : calculateAgeFromDate(patient.date_of_birth);
  const patientAgeLine = patientAge != null ? `${patientAge} years` : '-';
  const patientDobLine = patient.date_of_birth ? formatPdfDate(patient.date_of_birth) : '-';
  const patientGenderLine = humanizeEnum(patient.gender);
  const logoImage = await loadEmbeddedLogoImage(pdfDoc);

  let page = null;
  let y = 0;

  function drawPill(targetPage, text, x, yPos, {
    bg = C.surfaceAlt,
    textColor = C.brandSecondary,
    border = C.line,
    size = 8.5,
  } = {}) {
    const label = asDisplay(text, '');
    const width = measureText(fontBold, label, size) + 20;

    targetPage.drawRectangle({
      x,
      y: yPos - 2,
      width,
      height: 18,
      color: bg,
      borderColor: border,
      borderWidth: 0.7,
    });
    targetPage.drawText(label, {
      x: x + 10,
      y: yPos + 4,
      size,
      font: fontBold,
      color: textColor,
    });
  }

  function drawPageBackdrop(targetPage, { compact = false } = {}) {
    targetPage.drawRectangle({
      x: 0,
      y: 0,
      width: PAGE_W,
      height: PAGE_H,
      color: rgb(0.985, 0.989, 0.985),
    });
    targetPage.drawRectangle({
      x: PAGE_W - (compact ? 18 : 24),
      y: 0,
      width: compact ? 18 : 24,
      height: PAGE_H,
      color: C.surfaceAlt,
    });
    targetPage.drawRectangle({
      x: MARGIN - 18,
      y: PAGE_H - (compact ? 126 : 210),
      width: compact ? 120 : 170,
      height: 2,
      color: C.brandAccent,
      opacity: 0.75,
    });
    targetPage.drawRectangle({
      x: PAGE_W - (compact ? 150 : 220),
      y: PAGE_H - (compact ? 164 : 250),
      width: compact ? 92 : 150,
      height: compact ? 92 : 150,
      color: C.brandPrimary,
      opacity: 0.035,
    });
  }

  function drawPanel({
    targetPage,
    x,
    topY,
    width,
    height,
    background = C.white,
    borderColor = C.line,
    accentColor = C.brandAccent,
    shadow = true,
    accentWidth = 0,
  }) {
    if (shadow) {
      targetPage.drawRectangle({
        x: x + 6,
        y: topY - height - 6,
        width,
        height,
        color: C.brandPrimary,
        opacity: 0.05,
      });
    }

    targetPage.drawRectangle({
      x,
      y: topY - height,
      width,
      height,
      color: background,
      borderColor,
      borderWidth: 1,
    });

    if (accentWidth > 0) {
      targetPage.drawRectangle({
        x,
        y: topY - height,
        width: accentWidth,
        height,
        color: accentColor,
      });
    }
  }

  function drawPageHeader(targetPage, { compact = false } = {}) {
    const headerHeight = compact ? 102 : 178;
    const title = compact ? 'Curevie Medical Report' : 'Comprehensive Medical Report';
    drawPageBackdrop(targetPage, { compact });

    targetPage.drawRectangle({
      x: 0,
      y: PAGE_H - headerHeight,
      width: PAGE_W,
      height: headerHeight,
      color: C.brandPrimary,
    });
    targetPage.drawRectangle({
      x: 0,
      y: PAGE_H - headerHeight,
      width: PAGE_W,
      height: compact ? 10 : 14,
      color: C.brandAccent,
    });
    targetPage.drawRectangle({
      x: PAGE_W - (compact ? 196 : 248),
      y: PAGE_H - headerHeight + (compact ? 16 : 22),
      width: compact ? 150 : 194,
      height: compact ? 56 : 82,
      color: C.brandSecondary,
      opacity: 0.58,
    });
    targetPage.drawText(compact ? 'CUREVIE' : 'MEDICAL DOSSIER', {
      x: PAGE_W - (compact ? 188 : 236),
      y: PAGE_H - headerHeight + (compact ? 74 : 126),
      size: compact ? 23 : 34,
      font: fontBold,
      color: rgb(1, 1, 1),
      opacity: compact ? 0.06 : 0.08,
    });

    if (logoImage) {
      const logoMaxH = compact ? 38 : 56;
      const scale = logoMaxH / logoImage.height;
      const logoW = logoImage.width * scale;
      const logoH = logoImage.height * scale;
      targetPage.drawImage(logoImage, {
        x: MARGIN,
        y: PAGE_H - headerHeight + (compact ? 42 : 64),
        width: logoW,
        height: logoH,
      });
    } else {
      targetPage.drawText('CUREVIE', {
        x: MARGIN,
        y: PAGE_H - headerHeight + (compact ? 54 : 86),
        size: compact ? 18 : 24,
        font: fontBold,
        color: C.white,
      });
    }

    targetPage.drawText('CLINICAL RECORD', {
      x: MARGIN + (logoImage ? 88 : 0),
      y: PAGE_H - headerHeight + (compact ? 76 : 126),
      size: compact ? 8.5 : 9,
      font: fontBold,
      color: rgb(0.84, 0.92, 0.88),
    });

    targetPage.drawText(title, {
      x: MARGIN + (logoImage ? 86 : 0),
      y: PAGE_H - headerHeight + (compact ? 56 : 98),
      size: compact ? 16 : 26,
      font: fontBold,
      color: C.white,
    });

    const subtitle = compact
      ? `Generated ${formatPdfDateTime(issuedAt)}`
      : `${serviceName} - ${humanizeEnum(request.request_type || request.service_type)}`;
    const subtitleLines = wrapText(font, subtitle, compact ? 9 : 10, PAGE_W - (MARGIN * 2) - 110);
    drawTextLines(targetPage, subtitleLines, MARGIN + (logoImage ? 86 : 0), PAGE_H - headerHeight + (compact ? 38 : 78), {
      size: compact ? 9 : 10,
      color: rgb(0.93, 0.96, 0.94),
      lineGap: 11,
    });

    const metaBoxW = compact ? 150 : 194;
    const metaBoxX = PAGE_W - MARGIN - metaBoxW;
    const metaBaseY = PAGE_H - headerHeight + (compact ? 68 : 118);
    const metaRows = compact
      ? [
        ['Status', 'Confidential'],
        ['Issued', formatPdfDate(issuedAt)],
      ]
      : [
        ['Document', 'Confidential report'],
        ['Issued', formatPdfDate(issuedAt)],
        ['Provider', asDisplay(providerName)],
      ];

    metaRows.forEach(([label, value], rowIndex) => {
      const rowY = metaBaseY - (rowIndex * 18);
      const wrappedValue = wrapText(font, value, 8.7, metaBoxW - 84);
      const metaValue = truncateText(font, wrappedValue[0] || value, 8.7, metaBoxW - 84);
      targetPage.drawText(`${label.toUpperCase()}`, {
        x: metaBoxX + 14,
        y: rowY,
        size: 7.6,
        font: fontBold,
        color: rgb(0.78, 0.87, 0.83),
      });
      targetPage.drawText(metaValue, {
        x: metaBoxX + 68,
        y: rowY,
        size: 8.7,
        font,
        color: C.white,
      });
    });

    return PAGE_H - headerHeight - (compact ? 16 : 22);
  }

  function addPage({ compact = false } = {}) {
    page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    y = drawPageHeader(page, { compact });
  }

  function ensureSpace(heightNeeded = 24) {
    if (y - heightNeeded >= BOTTOM_MARGIN) return;
    addPage({ compact: true });
  }

  function drawSectionTitle(title, subtitle = null) {
    ensureSpace(subtitle ? 42 : 30);

    page.drawText('SECTION', {
      x: MARGIN,
      y: y + 13,
      size: 7.8,
      font: fontBold,
      color: C.brandStone,
    });
    page.drawText(asDisplay(title), {
      x: MARGIN,
      y,
      size: 16,
      font: fontBold,
      color: C.brandPrimary,
    });
    page.drawRectangle({
      x: MARGIN,
      y: y - 7,
      width: 110,
      height: 3,
      color: C.brandAccent,
    });
    page.drawLine({
      start: { x: MARGIN + 118, y: y - 5.5 },
      end: { x: PAGE_W - MARGIN, y: y - 5.5 },
      thickness: 0.8,
      color: C.line,
    });

    y -= 18;
    if (subtitle) {
      const subtitleLines = wrapText(font, subtitle, 9.5, CONTENT_W);
      y = drawTextLines(page, subtitleLines, MARGIN, y, {
        size: 9.5,
        color: C.muted,
        lineGap: 12,
      });
    }
    y -= 6;
  }

  function drawInfoCard({
    x,
    topY,
    width,
    height,
    title,
    headline,
    rows = [],
    body = '',
  }) {
    drawPanel({
      targetPage: page,
      x,
      topY,
      width,
      height,
      background: C.white,
      borderColor: C.line,
      accentColor: C.brandAccent,
      shadow: true,
    });
    page.drawRectangle({
      x,
      y: topY - 8,
      width,
      height: 8,
      color: C.brandAccent,
    });
    page.drawRectangle({
      x: x + 18,
      y: topY - 28,
      width: Math.min(96, width - 36),
      height: 18,
      color: C.surfaceAlt,
    });

    const innerX = x + 14;
    const innerWidth = width - 28;
    let cursorY = topY - 26;

    page.drawText(asDisplay(title), {
      x: innerX,
      y: cursorY,
      size: 9,
      font: fontBold,
      color: C.brandOlive,
    });
    cursorY -= 16;

    const headlineLines = wrapText(fontBold, headline, width > 280 ? 18 : 16, innerWidth).slice(0, 2);
    cursorY = drawTextLines(page, headlineLines, innerX, cursorY, {
      size: width > 280 ? 18 : 16,
      bold: true,
      color: C.brandSecondary,
      lineGap: 19,
    });
    cursorY -= 4;

    rows.slice(0, 4).forEach((row) => {
      const valueLines = wrapText(font, row.value, 9.5, innerWidth - 84).slice(0, 2);
      page.drawText(`${asDisplay(row.label)}:`, {
        x: innerX,
        y: cursorY,
        size: 8.5,
        font: fontBold,
        color: C.brandStone,
      });
      drawTextLines(page, valueLines, innerX + 78, cursorY, {
        size: 9.5,
        color: C.ink,
        lineGap: 11,
      });
      cursorY -= Math.max(15, valueLines.length * 11 + 3);
    });

    const bodyLines = wrapText(font, body, 9.5, innerWidth).slice(0, 4);
    if (bodyLines.length) {
      page.drawLine({
        start: { x: innerX, y: cursorY + 4 },
        end: { x: x + width - 14, y: cursorY + 4 },
        thickness: 0.6,
        color: C.line,
      });
      cursorY -= 12;
      drawTextLines(page, bodyLines, innerX, cursorY, {
        size: 9.5,
        color: C.muted,
        lineGap: 12,
      });
    }
  }

  function drawProviderStrip() {
    ensureSpace(104);

    drawPanel({
      targetPage: page,
      x: MARGIN,
      topY: y,
      width: CONTENT_W,
      height: 88,
      background: C.brandSecondary,
      borderColor: C.brandSecondary,
      accentColor: C.brandAccent,
      shadow: true,
      accentWidth: 10,
    });
    page.drawRectangle({
      x: PAGE_W - MARGIN - 130,
      y: y - 88,
      width: 130,
      height: 88,
      color: C.brandPrimary,
      opacity: 0.35,
    });

    page.drawText('Assigned Provider', {
      x: MARGIN + 22,
      y,
      size: 9,
      font: fontBold,
      color: rgb(0.84, 0.91, 0.88),
    });
    page.drawText(truncateText(fontBold, providerName, 19, CONTENT_W - 180), {
      x: MARGIN + 22,
      y: y - 24,
      size: 19,
      font: fontBold,
      color: C.white,
    });

    const providerMeta = `${providerRole}${primaryReport?.updated_at ? ` - Updated ${formatPdfDateTime(primaryReport.updated_at)}` : ''}`;
    const providerMetaLines = wrapText(font, providerMeta, 10, CONTENT_W - 184);
    drawTextLines(page, providerMetaLines, MARGIN + 22, y - 42, {
      size: 10,
      color: rgb(0.88, 0.93, 0.91),
      lineGap: 12,
    });

    drawPill(page, humanizeEnum(primaryReport?.report_type || 'FINAL_REPORT'), PAGE_W - MARGIN - 114, y - 16, {
      bg: rgb(1, 1, 1),
      textColor: C.brandPrimary,
      border: rgb(1, 1, 1),
      size: 8.5,
    });
    drawTextLines(page, wrapText(font, serviceName, 8.8, 104).slice(0, 2), PAGE_W - MARGIN - 114, y - 42, {
      size: 8.8,
      color: rgb(0.89, 0.93, 0.92),
      lineGap: 10,
    });

    y -= 106;
  }

  function buildNarrativeFields(report) {
    const rows = [];
    const seen = new Set();
    const pushField = (label, value) => {
      const cleaned = String(value || '').trim();
      if (!cleaned) return;
      const dedupeKey = `${label}:${cleaned.toLowerCase()}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      rows.push({ label, value: cleaned });
    };

    pushField('Clinical Summary', report?.symptoms_summary);
    pushField('Findings', report?.findings);
    pushField('Diagnosis', report?.diagnosis);
    pushField('Treatment Plan', report?.treatment_plan);
    pushField('Recommendations', report?.recommendations);
    pushField('Procedures', report?.procedures_done || report?.procedures_performed);
    pushField('Allergies', report?.patient_allergies || report?.allergies_noted);
    pushField('Lab Notes', report?.lab_notes);
    pushField('Imaging Notes', report?.imaging_notes);
    pushField('Nursing Notes', report?.nurse_notes);
    pushField('Care Notes', report?.notes);

    if (report?.pdf_report_url && rows.length === 0) {
      pushField(
        'Summary',
        'No structured clinical notes were submitted in text. The provider supplied a PDF attachment, and it is appended to this report.'
      );
    } else if (report?.pdf_report_url) {
      pushField('Diagnostic Attachment', 'The provider supplied a PDF attachment, and it is appended to this report.');
    }

    return rows;
  }

  function drawNarrativeRow(label, value) {
    const labelLines = wrapText(fontBold, label.toUpperCase(), 8.5, CONTENT_W);
    const valueLines = wrapText(font, value, 10.5, CONTENT_W);
    const rowHeight = Math.max(82, (labelLines.length * 11) + (valueLines.length * 14) + 30);

    ensureSpace(rowHeight + 8);
    drawPanel({
      targetPage: page,
      x: MARGIN,
      topY: y,
      width: CONTENT_W,
      height: rowHeight,
      background: C.white,
      borderColor: C.line,
      accentColor: C.brandAccent,
      shadow: true,
      accentWidth: 8,
    });
    page.drawRectangle({
      x: MARGIN + 20,
      y: y - 28,
      width: Math.min(136, CONTENT_W - 40),
      height: 18,
      color: C.surfaceAlt,
    });
    drawTextLines(page, labelLines, MARGIN + 20, y - 18, {
      size: 8.5,
      bold: true,
      color: C.brandOlive,
      lineGap: 11,
    });
    drawTextLines(page, valueLines.length ? valueLines : ['-'], MARGIN + 20, y - 42, {
      size: 10.5,
      color: C.ink,
      lineGap: 14,
    });
    y -= rowHeight + 12;
  }

  function drawProviderReportSection(report) {
    const reportRows = buildNarrativeFields(report);
    const reportTitle = report?.provider_name || providerName;
    const reportMetaText = `${getProviderTypeLabel(report?.provider_type)} - ${humanizeEnum(report?.report_type || 'SUB_REPORT')}${report?.updated_at ? ` - ${formatPdfDateTime(report.updated_at)}` : ''}`;

    ensureSpace(62);
    page.drawRectangle({
      x: MARGIN,
      y: y - 44,
      width: CONTENT_W,
      height: 44,
      color: C.brandSecondary,
    });
    page.drawRectangle({
      x: MARGIN,
      y: y - 44,
      width: 10,
      height: 44,
      color: C.brandAccent,
    });
    page.drawText(truncateText(fontBold, reportTitle, 13, CONTENT_W - 148), {
      x: MARGIN + 18,
      y: y - 17,
      size: 13,
      font: fontBold,
      color: C.white,
    });
    const reportMetaLines = wrapText(font, reportMetaText, 8.8, CONTENT_W - 150);
    drawTextLines(page, reportMetaLines, MARGIN + 18, y - 30, {
      size: 8.8,
      color: rgb(0.9, 0.94, 0.92),
      lineGap: 10,
    });
    drawPill(page, humanizeEnum(report?.status || 'SUBMITTED'), PAGE_W - MARGIN - 88, y - 28, {
      bg: rgb(1, 1, 1),
      textColor: C.brandPrimary,
      border: rgb(1, 1, 1),
      size: 8,
    });
    y -= 58;

    if (!reportRows.length) {
      drawNarrativeRow('Summary', 'No clinical notes were submitted for this report block.');
      return;
    }

    reportRows.forEach((row) => drawNarrativeRow(row.label, row.value));
  }

  function resolveLabFlag(result) {
    const explicitFlag = String(result.flag || '').trim().toUpperCase();
    if (explicitFlag) return explicitFlag;
    if (result.is_normal === true) return 'NORMAL';
    if (result.is_normal === false) return 'ABNORMAL';
    return 'PENDING';
  }

  function drawLabResultCard(result) {
    const unit = asDisplay(result.unit, '');
    const resultText = `${asDisplay(result.result)}${unit ? ` ${unit}` : ''}`;
    const flag = resolveLabFlag(result);
    const referenceParts = [];
    if (result.range_text) referenceParts.push(String(result.range_text).trim());
    else if (result.range_low !== null && result.range_low !== undefined && result.range_low !== '') {
      referenceParts.push(String(result.range_low));
    }
    if (result.range_high !== null && result.range_high !== undefined && result.range_high !== '') {
      referenceParts.push(String(result.range_high));
    }
    const referenceValue = referenceParts.length
      ? `${referenceParts.join(' - ')}${unit ? ` ${unit}` : ''}`
      : asDisplay(result.reference_range);

    const flagColors = {
      NORMAL: { bg: rgb(0.89, 0.95, 0.88), text: C.brandOlive, border: rgb(0.72, 0.82, 0.69) },
      LOW: { bg: rgb(0.9, 0.93, 0.98), text: rgb(0.18, 0.32, 0.54), border: rgb(0.72, 0.8, 0.92) },
      HIGH: { bg: rgb(0.99, 0.93, 0.86), text: rgb(0.7, 0.4, 0.12), border: rgb(0.9, 0.8, 0.66) },
      ABNORMAL: { bg: rgb(0.99, 0.9, 0.9), text: rgb(0.66, 0.18, 0.18), border: rgb(0.9, 0.72, 0.72) },
      PENDING: { bg: C.surfaceAlt, text: C.brandStone, border: C.line },
    };
    const flagStyle = flagColors[flag] || flagColors.PENDING;

    const notesLines = wrapText(font, result.notes || 'No additional notes.', 9.5, CONTENT_W - 28).slice(0, 4);
    const cardHeight = 106 + (notesLines.length * 12);

    ensureSpace(cardHeight + 12);
    drawPanel({
      targetPage: page,
      x: MARGIN,
      topY: y,
      width: CONTENT_W,
      height: cardHeight,
      background: C.white,
      borderColor: C.line,
      accentColor: C.brandAccent,
      shadow: true,
      accentWidth: 8,
    });
    page.drawRectangle({
      x: MARGIN,
      y: y - 10,
      width: CONTENT_W,
      height: 10,
      color: C.brandAccent,
    });

    page.drawText(asDisplay(result.test_name || 'Lab Result'), {
      x: MARGIN + 14,
      y: y - 28,
      size: 12,
      font: fontBold,
      color: C.brandSecondary,
    });

    const pillText = humanizeEnum(flag);
    const pillWidth = measureText(fontBold, pillText, 8.5) + 20;
    page.drawRectangle({
      x: PAGE_W - MARGIN - pillWidth,
      y: y - 32,
      width: pillWidth,
      height: 18,
      color: flagStyle.bg,
      borderColor: flagStyle.border,
      borderWidth: 0.7,
    });
    page.drawText(pillText, {
      x: PAGE_W - MARGIN - pillWidth + 10,
      y: y - 26,
      size: 8.5,
      font: fontBold,
      color: flagStyle.text,
    });

    page.drawText(`Result: ${asDisplay(resultText)}`, {
      x: MARGIN + 14,
      y: y - 48,
      size: 9.5,
      font,
      color: C.ink,
    });
    page.drawText(`Reference: ${asDisplay(referenceValue)}`, {
      x: MARGIN + 14,
      y: y - 62,
      size: 9.5,
      font,
      color: C.muted,
    });
    page.drawText(`Captured: ${formatPdfDateTime(result.created_at)}`, {
      x: MARGIN + 14,
      y: y - 76,
      size: 9,
      font,
      color: C.muted,
    });
    drawTextLines(page, notesLines, MARGIN + 14, y - 94, {
      size: 9.5,
      color: C.ink,
      lineGap: 12,
    });

    y -= cardHeight + 12;
  }

  addPage({ compact: false });

  const topCardHeight = 224;
  const gap = 14;
  const serviceCardWidth = Math.round((CONTENT_W * 0.58) * 10) / 10;
  const patientCardWidth = CONTENT_W - gap - serviceCardWidth;

  drawInfoCard({
    x: MARGIN,
    topY: y,
    width: serviceCardWidth,
    height: topCardHeight,
    title: request.request_type === 'PACKAGE' ? 'Package Overview' : 'Service Overview',
    headline: serviceName,
    rows: [
      { label: 'Request Type', value: humanizeEnum(request.request_type) },
      { label: 'Service Type', value: humanizeEnum(request.service_type) },
      { label: 'Category', value: request.service_category_name || '-' },
      { label: 'Scheduled For', value: formatPdfDateTime(request.scheduled_at || request.requested_at) },
    ],
    body: serviceSummaryText,
  });

  drawInfoCard({
    x: MARGIN + serviceCardWidth + gap,
    topY: y,
    width: patientCardWidth,
    height: topCardHeight,
    title: 'Patient Information',
    headline: patient.full_name || 'Patient',
    rows: [
      { label: 'Phone', value: patient.phone || '-' },
      { label: 'Gender', value: patientGenderLine },
      { label: 'Age', value: patientAgeLine },
      { label: 'Date of Birth', value: patientDobLine },
    ],
    body: patient.address || patient.email || 'No additional patient contact details were recorded.',
  });

  y -= topCardHeight + 18;
  drawProviderStrip();

  drawSectionTitle(
    'Comprehensive Report',
    'The summary below focuses on the clinical content of the request and omits administrative invoice and approval details.'
  );

  if (providerReports.length) {
    providerReports.forEach((report) => {
      drawProviderReportSection(report);
    });
  } else {
    drawNarrativeRow('Summary', 'No provider narrative was available when this report was generated.');
  }

  if (labResults.length) {
    drawSectionTitle('Laboratory Results', 'Structured lab outcomes captured during the request are listed below.');
    labResults.forEach((result) => drawLabResultCard(result));
  }

  if (attachedPdfReports.length) {
    drawSectionTitle(
      'Attached Diagnostic Documents',
      'Original provider PDFs are appended after the generated summary so the receiving team can review the uploaded file exactly as submitted.'
    );

    attachedPdfReports.forEach((report) => {
      const fileName = getAttachmentFileName(report.pdf_report_url);
      drawNarrativeRow(
        report.provider_name || 'Provider Attachment',
        `${fileName}${isImagingProviderReport(report) ? ' - Diagnostic imaging document' : ' - Provider uploaded PDF'}`
      );
    });
  }

  const generatedPageCount = pdfDoc.getPageCount();
  await appendAttachedProviderPdfs(pdfDoc, providerReports);

  const generatedPages = pdfDoc.getPages().slice(0, generatedPageCount);
  generatedPages.forEach((targetPage, index) => {
    targetPage.drawLine({
      start: { x: MARGIN, y: 36 },
      end: { x: PAGE_W - MARGIN, y: 36 },
      thickness: 0.8,
      color: C.line,
    });
    targetPage.drawText('Curevie Clinical Records', {
      x: MARGIN,
      y: 22,
      size: 8.5,
      font,
      color: C.brandStone,
    });
    const pageLabel = `Page ${index + 1} of ${generatedPageCount}`;
    const pageLabelWidth = measureText(fontBold, pageLabel, 8.5);
    targetPage.drawText(pageLabel, {
      x: PAGE_W - MARGIN - pageLabelWidth,
      y: 22,
      size: 8.5,
      font: fontBold,
      color: C.brandStone,
    });
  });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

module.exports = {
  generateMedicalReportPdf,
};
