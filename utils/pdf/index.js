const { generateInvoicePdf } = require('./invoice.generator');
const { generateMedicalReportPdf } = require('./medical-report.generator');
const {
  SUPPORTED_FORMATS,
  convertToPdf,
  addWatermark,
  processUploadedFile,
  cleanupOldFiles,
  OUTPUT_DIR,
  LOGO_PATH,
} = require('./conversion');

module.exports = {
  convertToPdf,
  addWatermark,
  generateInvoicePdf,
  generateMedicalReportPdf,
  processUploadedFile,
  cleanupOldFiles,
  SUPPORTED_FORMATS,
  OUTPUT_DIR,
  LOGO_PATH,
};
