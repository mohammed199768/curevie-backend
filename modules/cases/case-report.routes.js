// Medical report and sick-leave PDFs for a closed case (mounted under /api/v1/cases).
const express = require('express');
const Joi = require('joi');
const pool = require('../../config/db');
const asyncHandler = require('../../utils/asyncHandler');
const validate = require('../../middlewares/validate');
const { authenticate, adminOnly } = require('../../middlewares/auth');
const { apiLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const { AppError } = require('../../middlewares/errorHandler');
const { logger } = require('../../utils/logger');
const { readStoredFile, deleteStoredFile, sendFile } = require('../../utils/storage');
const { generateCaseReportPdf, generateSickLeavePdf } = require('../../utils/pdf/case-report.generator');
const caseService = require('./case.service');
const events = require('./case.events');
const { CASE_STATUS } = require('./case.constants');

const router = express.Router({ mergeParams: true });
const { caseRepo } = caseService;

const caseParams = Joi.object({ id: Joi.string().uuid().required() });
const sickLeaveSchema = Joi.object({ file_id: Joi.string().uuid().required() });

async function findReport(caseId) {
  const { rows } = await pool.query('SELECT * FROM medical_reports WHERE case_id = $1', [caseId]);
  return rows[0] || null;
}

/** Report metadata safe for any viewer: storage keys are replaced by flags. */
function presentReport(report) {
  if (!report) return null;
  return {
    id: report.id,
    case_id: report.case_id,
    status: report.status,
    has_pdf: Boolean(report.pdf_url),
    has_sick_leave: Boolean(report.sick_leave_pdf_url),
    published_at: report.published_at,
    created_at: report.created_at,
    updated_at: report.updated_at,
  };
}

/** Loads the report when the user may read it; patients only after it was published on a closed case. */
async function loadReadableReport(req) {
  const caseRow = await caseService.loadAccessibleCase(req.params.id, req.user);
  const report = await findReport(req.params.id);
  if (!report) throw new AppError('Report not found', 404, 'NOT_FOUND');

  if (req.user.role === 'PATIENT'
    && (report.status !== 'PUBLISHED' || caseRow.status !== CASE_STATUS.CLOSED)) {
    throw new AppError('Report is not available yet', 403, 'REPORT_NOT_AVAILABLE');
  }
  return { caseRow, report };
}

async function streamPdf(res, key, fileName) {
  let buffer;
  try {
    buffer = await readStoredFile(key);
  } catch (err) {
    logger.warn('REPORT_PDF_READ_FAILED', { message: err.message });
    throw new AppError('PDF is not available', 404, 'PDF_NOT_FOUND');
  }
  return sendFile(res, buffer, { fileName, mimeType: 'application/pdf' });
}

router.post(
  '/:id/report/generate',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(caseParams, 'params'),
  asyncHandler(async (req, res) => {
    const caseRow = await caseRepo.findCaseById(req.params.id);
    if (!caseRow) throw new AppError('Case not found', 404, 'NOT_FOUND');
    if (caseRow.status !== CASE_STATUS.CLOSED) {
      throw new AppError('Case must be CLOSED before report generation', 409, 'INVALID_CASE_STATUS');
    }

    const previous = await caseRepo.ensureMedicalReportRecord(req.params.id);

    let pdfKey;
    try {
      pdfKey = await generateCaseReportPdf(req.params.id);
    } catch (error) {
      logger.error('CASE_REPORT_GENERATION_FAILED', { caseId: req.params.id, message: error.message });
      throw new AppError('Failed to generate report PDF', 500, 'PDF_GENERATION_FAILED');
    }

    const { rows } = await pool.query(
      `UPDATE medical_reports
       SET pdf_url = $1, status = 'PUBLISHED', published_at = NOW(), published_by = $2,
           pdf_generation_attempts = 0, updated_at = NOW()
       WHERE case_id = $3
       RETURNING *`,
      [pdfKey, req.user.id, req.params.id]
    );
    if (previous?.pdf_url && previous.pdf_url !== pdfKey) await deleteStoredFile(previous.pdf_url);

    events.reportPublished({ caseId: req.params.id, patientId: caseRow.patient_id });
    events.emitCaseUpdated({
      caseId: req.params.id,
      status: caseRow.status,
      patientId: caseRow.patient_id,
      event: 'REPORT_PUBLISHED',
    });

    return res.json({ message: 'Report generated', data: presentReport(rows[0]) });
  })
);

router.post(
  '/:id/sick-leave/generate',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(caseParams, 'params'),
  validate(sickLeaveSchema),
  asyncHandler(async (req, res) => {
    const file = await caseRepo.findProviderFile(req.params.id, req.body.file_id);
    if (!file) throw new AppError('File not found for this case', 404, 'NOT_FOUND');
    if (!file.is_sick_leave) throw new AppError('Selected file is not a sick leave file', 400, 'INVALID_FILE_TYPE');

    const previous = await caseRepo.ensureMedicalReportRecord(req.params.id);
    const key = await generateSickLeavePdf(req.params.id, file);
    if (!key) throw new AppError('Failed to generate sick leave PDF', 500, 'PDF_GENERATION_FAILED');

    const { rows } = await pool.query(
      `UPDATE medical_reports SET sick_leave_pdf_url = $1, updated_at = NOW()
       WHERE case_id = $2 RETURNING *`,
      [key, req.params.id]
    );
    if (previous?.sick_leave_pdf_url && previous.sick_leave_pdf_url !== key) {
      await deleteStoredFile(previous.sick_leave_pdf_url);
    }

    return res.json({ message: 'Sick leave PDF ready', data: presentReport(rows[0]) });
  })
);

router.get(
  '/:id/report',
  authenticate,
  readLimiter,
  validate(caseParams, 'params'),
  asyncHandler(async (req, res) => {
    const { report } = await loadReadableReport(req);
    return res.json({ data: presentReport(report) });
  })
);

router.get(
  '/:id/report/download',
  authenticate,
  readLimiter,
  validate(caseParams, 'params'),
  asyncHandler(async (req, res) => {
    const { report } = await loadReadableReport(req);
    if (!report.pdf_url) throw new AppError('Report PDF not found', 404, 'PDF_NOT_FOUND');
    return streamPdf(res, report.pdf_url, `case-report-${req.params.id.slice(0, 8)}.pdf`);
  })
);

router.get(
  '/:id/sick-leave/download',
  authenticate,
  readLimiter,
  validate(caseParams, 'params'),
  asyncHandler(async (req, res) => {
    const { report } = await loadReadableReport(req);
    if (!report.sick_leave_pdf_url) throw new AppError('Sick leave PDF not found', 404, 'PDF_NOT_FOUND');
    return streamPdf(res, report.sick_leave_pdf_url, `sick-leave-${req.params.id.slice(0, 8)}.pdf`);
  })
);

module.exports = router;
