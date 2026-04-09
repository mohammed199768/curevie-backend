const express = require('express');
const path = require('path');
const router = express.Router({ mergeParams: true });
const pool = require('../../config/db');
const asyncHandler = require('../../utils/asyncHandler');
const {
  authenticate,
  adminOnly,
  staffOnly,
} = require('../../middlewares/auth');
const { logger } = require('../../utils/logger');
const { readStoredPdfBuffer } = require('../../utils/pdf/storage');
const {
  generateCaseReportPdf,
  generateSickLeavePdf,
} = require('../../utils/pdf/case-report.generator');

async function hasProviderCaseAccess(caseId, providerId) {
  const accessResult = await pool.query(
    `
    SELECT 1
    FROM cases c
    LEFT JOIN case_services cs ON cs.case_id = c.id
    WHERE c.id = $1
      AND (c.lead_provider_id = $2 OR cs.provider_id = $2)
    LIMIT 1
    `,
    [caseId, providerId]
  );

  return Boolean(accessResult.rows[0]);
}

async function getReportContext(caseId) {
  const result = await pool.query(
    `
    SELECT mr.*, c.status AS case_status, c.patient_id, c.lead_provider_id
    FROM medical_reports mr
    JOIN cases c ON c.id = mr.case_id
    WHERE mr.case_id = $1
    LIMIT 1
    `,
    [caseId]
  );

  return result.rows[0] || null;
}

async function ensureReportAccess(req, res, reportRecord) {
  if (!reportRecord) {
    res.status(404).json({ message: 'Report not found', code: 'NOT_FOUND' });
    return false;
  }

  if (req.user.role === 'ADMIN') {
    return true;
  }

  if (req.user.role === 'PATIENT') {
    if (reportRecord.patient_id !== req.user.id) {
      res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
      return false;
    }

    if (reportRecord.status !== 'PUBLISHED' || reportRecord.case_status !== 'CLOSED') {
      res.status(403).json({ message: 'Report is not available yet', code: 'REPORT_NOT_AVAILABLE' });
      return false;
    }

    return true;
  }

  if (req.user.role === 'PROVIDER') {
    const allowed = await hasProviderCaseAccess(reportRecord.case_id, req.user.id);
    if (!allowed) {
      res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
      return false;
    }

    return true;
  }

  res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
  return false;
}

router.post('/:id/report/generate', authenticate, adminOnly, asyncHandler(async (req, res) => {
  const { id } = req.params;

  const caseResult = await pool.query(
    'SELECT id, status FROM cases WHERE id = $1 LIMIT 1',
    [id]
  );
  const currentCase = caseResult.rows[0];

  if (!currentCase) {
    return res.status(404).json({ message: 'Case not found', code: 'NOT_FOUND' });
  }

  if (currentCase.status !== 'CLOSED') {
    return res.status(400).json({ message: 'Case must be CLOSED before report generation', code: 'INVALID_CASE_STATUS' });
  }

  const reportResult = await pool.query(
    'SELECT id FROM medical_reports WHERE case_id = $1 LIMIT 1',
    [id]
  );

  if (!reportResult.rows[0]) {
    return res.status(404).json({ message: 'medical_reports row not found for case', code: 'REPORT_RECORD_NOT_FOUND' });
  }

  const pdfUrl = await generateCaseReportPdf(id);
  if (!pdfUrl) {
    logger.warn('Case report generation returned an empty URL', { caseId: id, adminId: req.user.id });
    return res.status(500).json({ message: 'Failed to generate report PDF', code: 'PDF_GENERATION_FAILED' });
  }

  await pool.query(
    `
    UPDATE medical_reports
    SET pdf_url = $1,
        status = 'PUBLISHED',
        published_at = NOW(),
        published_by = $2,
        updated_at = NOW()
    WHERE case_id = $3
    `,
    [pdfUrl, req.user.id, id]
  );

  return res.json({ message: 'Report generated', pdf_url: pdfUrl });
}));

router.post('/:id/sick-leave/generate', authenticate, adminOnly, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { file_id } = req.body || {};

  if (!file_id) {
    return res.status(400).json({ message: 'file_id is required', code: 'FILE_ID_REQUIRED' });
  }

  const fileResult = await pool.query(
    `
    SELECT cpf.*, cs.case_id
    FROM case_provider_files cpf
    JOIN case_services cs ON cs.id = cpf.case_service_id
    WHERE cpf.id = $1
      AND cs.case_id = $2
    LIMIT 1
    `,
    [file_id, id]
  );
  const fileRecord = fileResult.rows[0];

  if (!fileRecord) {
    return res.status(404).json({ message: 'File not found for this case', code: 'NOT_FOUND' });
  }

  if (!fileRecord.is_sick_leave) {
    return res.status(400).json({ message: 'Selected file is not a sick leave file', code: 'INVALID_FILE_TYPE' });
  }

  const url = await generateSickLeavePdf(id, fileRecord);
  if (!url) {
    return res.status(500).json({ message: 'Failed to generate sick leave PDF', code: 'PDF_GENERATION_FAILED' });
  }

  const updateResult = await pool.query(
    `
    UPDATE medical_reports
    SET sick_leave_pdf_url = $1,
        updated_at = NOW()
    WHERE case_id = $2
    RETURNING id
    `,
    [url, id]
  );

  if (!updateResult.rows[0]) {
    return res.status(404).json({ message: 'medical_reports row not found for case', code: 'REPORT_RECORD_NOT_FOUND' });
  }

  return res.json({ message: 'Sick leave PDF ready', url });
}));

router.get('/:id/report', authenticate, asyncHandler(async (req, res) => {
  const reportRecord = await getReportContext(req.params.id);
  const allowed = await ensureReportAccess(req, res, reportRecord);

  if (!allowed) {
    return undefined;
  }

  return res.json(reportRecord);
}));

router.get('/:id/report/download', authenticate, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const reportRecord = await getReportContext(id);
  const allowed = await ensureReportAccess(req, res, reportRecord);

  if (!allowed) {
    return undefined;
  }

  if (!reportRecord.pdf_url) {
    return res.status(404).json({ message: 'Report PDF not found', code: 'PDF_NOT_FOUND' });
  }

  if (req.user.role === 'PATIENT' && reportRecord.case_status !== 'CLOSED') {
    return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
  }

  const pdfUrl = String(reportRecord.pdf_url);
  if (/^https?:\/\//i.test(pdfUrl)) {
    return res.redirect(pdfUrl);
  }

  if (pdfUrl.startsWith('/uploads/') || pdfUrl.startsWith('uploads/')) {
    const redirectUrl = pdfUrl.startsWith('/') ? pdfUrl : `/${pdfUrl}`;
    return res.redirect(redirectUrl);
  }

  const pdfBuffer = await readStoredPdfBuffer(pdfUrl);
  const shortCaseId = String(id || '').slice(0, 8) || 'report';

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="case-report-${path.basename(shortCaseId)}.pdf"`);
  res.setHeader('Content-Length', String(pdfBuffer.length));

  return res.status(200).send(pdfBuffer);
}));

module.exports = router;
