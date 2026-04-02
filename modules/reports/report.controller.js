const reportService = require('./report.service');
const { generateMedicalReportPdf } = require('../../utils/pdfEngine');
const {
  readStoredPdfBuffer,
  storeGeneratedPdf,
  deleteStoredPdf,
} = require('../../utils/pdf/storage');
const { providerHasRequestAccess } = require('../requests/request.workflow.service');

let reportRepository = null; // AUDIT-FIX: P3-STEP8-DIP - report repository is injected from the composition root instead of being created in the controller.

function createReportController(deps = {}) { // AUDIT-FIX: P3-STEP8-DIP - report routes now wire the concrete repository explicitly.
  reportRepository = deps.reportRepository || reportRepository; // AUDIT-FIX: P3-STEP8-DIP - preserve the plain-object controller shape while accepting injected dependencies.
  return module.exports; // AUDIT-FIX: P3-STEP8-COMPAT - keep the historical plain-object controller export for existing callers.
} // AUDIT-FIX: P3-STEP8-DIP - factory ends the composition-root bridge for report routes.

async function canAccessMedicalReport(user, reportData) {
  if (!user) return false;
  if (user.role === 'ADMIN') return true;
  if (user.role === 'PROVIDER') {
    return providerHasRequestAccess(reportData.request.id, user.id);
  }
  if (user.role === 'PATIENT') {
    return Boolean(reportData.request.patient_id) && reportData.request.patient_id === user.id;
  }
  return false;
}

function toTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(value);
  const time = parsed.getTime();
  return Number.isFinite(time) ? time : null;
}

function getLatestReportContentTimestamp(reportData) {
  const candidates = [
    reportData?.request?.updated_at,
    reportData?.request?.closed_at,
    reportData?.report_meta?.reviewed_at,
    reportData?.report_meta?.published_at,
    ...(Array.isArray(reportData?.provider_reports) ? reportData.provider_reports.map((report) => report?.updated_at) : []),
    ...(Array.isArray(reportData?.lab_results)
      ? reportData.lab_results.map((result) => result?.updated_at || result?.created_at)
      : []),
  ]
    .map(toTimestamp)
    .filter((value) => value !== null);

  return candidates.length ? Math.max(...candidates) : null;
}

async function downloadMedicalRequestPdf(req, res) {
  const requestId = req.params.id;
  const reportData = await reportService.getMedicalReportDataByRequestId(requestId);

  if (!reportData) {
    return res.status(404).json({ message: 'Request not found' });
  }

  if (!(await canAccessMedicalReport(req.user, reportData))) {
    return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
  }

  // Check report publish status
  const reportRecord = await reportRepository.getMedicalReportRecord(requestId); // AUDIT-FIX: P3-STEP7B-DIP - direct report-record reads now go through the repository.
  const reportStatus = reportRecord?.status; // AUDIT-FIX: P3-STEP7B-SRP - controller reads the normalized repository result directly.
  let storedPdfUrl = reportRecord?.pdf_url || null; // AUDIT-FIX: P3-STEP7B-SRP - controller keeps only HTTP/PDF flow state.
  const cachedPdfUpdatedAt = toTimestamp(reportRecord?.updated_at);
  const latestReportContentUpdatedAt = getLatestReportContentTimestamp(reportData);
  const hasFreshCachedPdf = Boolean(
    reportStatus === 'PUBLISHED'
    && storedPdfUrl
    && cachedPdfUpdatedAt
    && (latestReportContentUpdatedAt === null || latestReportContentUpdatedAt < cachedPdfUpdatedAt)
  );

  // Patients can only download PUBLISHED reports
  if (req.user.role === 'PATIENT') {
    if (!reportStatus || reportStatus !== 'PUBLISHED') {
      return res.status(403).json({
        message: 'Report is not yet available. Please wait for admin review.',
        code: 'REPORT_NOT_PUBLISHED',
      });
    }
  }
  // Admins and Providers can always download (even DRAFT)

  try {
    let pdfBuffer = null;

    if (hasFreshCachedPdf && storedPdfUrl) {
      try {
        pdfBuffer = await readStoredPdfBuffer(storedPdfUrl);
      } catch (_) {
        pdfBuffer = null;
      }
    }

    if (!pdfBuffer) {
      const previousPdfUrl = storedPdfUrl;
      pdfBuffer = await generateMedicalReportPdf(reportData);

      if (reportStatus === 'PUBLISHED') {
        const persistedPdfUrl = await storeGeneratedPdf(
          pdfBuffer,
          `medical-report-${requestId}.pdf`,
          'medical-reports'
        );

        if (persistedPdfUrl) {
          storedPdfUrl = persistedPdfUrl; // AUDIT-FIX: P3-STEP7B-SRP - keep the persisted URL in controller-local flow state.
          await reportRepository.updateMedicalReportPdfUrl(requestId, persistedPdfUrl); // AUDIT-FIX: P3-STEP7B-DIP - direct report-record writes now go through the repository.
          if (previousPdfUrl && previousPdfUrl !== persistedPdfUrl) {
            await deleteStoredPdf(previousPdfUrl).catch(() => {});
          }
        }
      }
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="medical_report_${requestId}.pdf"`);
    res.setHeader('Content-Length', String(pdfBuffer.length));

    return res.status(200).send(pdfBuffer);
  } catch (error) {
    return res.status(500).json({ message: 'Failed to generate medical report PDF' });
  }
}

module.exports = {
  createReportController,
  downloadMedicalRequestPdf,
};
