const { PDFDocument } = require('pdf-lib');
const { logger } = require('../logger');
const { loadMedicalReportPdfData } = require('./report-data');
const {
  LOGO_PATH,
  FONT_ARABIC,
  FONT_ARABIC_BOLD,
  PDF_FONT_REGULAR_CANDIDATES,
  PDF_FONT_BOLD_CANDIDATES,
  getFirstExistingPath,
} = require('./shared');
const { appendAttachedProviderPdfs } = require('./attachments');
const { fileToDataUri, renderPdfFromHtml } = require('./html-renderer');
const { renderMedicalReportHtml } = require('./medical-report.template');
const {
  generateMedicalReportPdf: generateMedicalReportPdfWithPdfLib,
} = require('./medical-report.pdflib');

async function buildTemplateAssets() {
  const regularFontPath = getFirstExistingPath(PDF_FONT_REGULAR_CANDIDATES);
  const boldFontPath = getFirstExistingPath(PDF_FONT_BOLD_CANDIDATES);
  const arabicFontPath = getFirstExistingPath([FONT_ARABIC, regularFontPath].filter(Boolean));
  const arabicBoldFontPath = getFirstExistingPath([FONT_ARABIC_BOLD, boldFontPath].filter(Boolean));

  const [
    logoDataUri,
    regularFontDataUri,
    boldFontDataUri,
    arabicFontDataUri,
    arabicBoldFontDataUri,
  ] = await Promise.all([
    fileToDataUri(LOGO_PATH),
    fileToDataUri(regularFontPath),
    fileToDataUri(boldFontPath),
    fileToDataUri(arabicFontPath),
    fileToDataUri(arabicBoldFontPath),
  ]);

  return {
    logoDataUri,
    regularFontDataUri,
    boldFontDataUri,
    arabicFontDataUri,
    arabicBoldFontDataUri,
  };
}

async function renderMedicalReportPdf(resolvedReportData) {
  try {
    const assets = await buildTemplateAssets();
    const html = renderMedicalReportHtml(resolvedReportData, assets);
    const basePdfBuffer = await renderPdfFromHtml(html, {
      displayHeaderFooter: true,
      marginTop: '14px',
      marginRight: '14px',
      marginBottom: '64px',
      marginLeft: '14px',
      footerTemplate: `
        <div style="width:100%;padding:0 16px 10px 16px;font-family:Arial,sans-serif;font-size:8px;color:#6f7f7d;display:flex;justify-content:flex-end;align-items:center;">
          <span style="font-weight:600;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
        </div>
      `,
    });
    const pdfDoc = await PDFDocument.load(basePdfBuffer);

    await appendAttachedProviderPdfs(pdfDoc, resolvedReportData.provider_reports || []);
    return Buffer.from(await pdfDoc.save());
  } catch (error) {
    logger.warn('HTML medical report generation failed, falling back to pdf-lib renderer', {
      requestId: resolvedReportData?.request?.id || null,
      error: error.message,
    });

    return generateMedicalReportPdfWithPdfLib(resolvedReportData);
  }
}

async function generateMedicalReportPdf(reportData) {
  const resolvedReportData = await loadMedicalReportPdfData(reportData);
  return renderMedicalReportPdf(resolvedReportData);
}

/**
 * Generate a medical report PDF directly from a pre-built snapshot.
 * Does NOT read from DB. Uses the snapshot as the only data source.
 * @param {object} snapshot
 * @returns {Promise<Buffer>}
 */
async function generateMedicalReportPdfFromSnapshot(snapshot) {
  if (!snapshot || !snapshot.request) {
    throw new Error('Invalid snapshot: missing request field');
  }

  return renderMedicalReportPdf(snapshot);
}

module.exports = {
  generateMedicalReportPdf,
  generateMedicalReportPdfFromSnapshot,
};
