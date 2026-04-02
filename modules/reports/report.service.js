const ReportRepository = require('../../repositories/ReportRepository'); // AUDIT-FIX: P3-REPORT-DIP - report reads now flow through the repository layer.

function createReportService(reportRepo) { // AUDIT-FIX: P3-REPORT-DIP - report service now depends on an injected repository.
  async function getMedicalReportDataByRequestId(requestId) { // AUDIT-FIX: P3-REPORT-SRP - report assembly now orchestrates repository reads only.
    const requestRow = await reportRepo.getMedicalReportRequestRow(requestId); // AUDIT-FIX: P3-REPORT-DIP - request/invoice/patient joins now go through the repository.
    if (!requestRow) { // AUDIT-FIX: P3-REPORT-SRP - preserve the current null-on-missing-request behavior.
      return null; // AUDIT-FIX: P3-REPORT-COMPAT - preserve the current method contract.
    } // AUDIT-FIX: P3-REPORT-SRP - short-circuit when the request row does not exist.

    const support = await reportRepo.getLabReportQuerySupport(); // AUDIT-FIX: P3-REPORT-DIP - schema support detection now goes through the repository.
    const labResults = await reportRepo.getLabReportRows(requestId, support); // AUDIT-FIX: P3-REPORT-DIP - lab-result report rows now go through the repository.

    const patientName = requestRow.patient_full_name || requestRow.guest_name || '-'; // AUDIT-FIX: P3-REPORT-COMPAT - preserve current patient-name fallback behavior.
    const patientPhone = requestRow.patient_phone || requestRow.guest_phone || '-'; // AUDIT-FIX: P3-REPORT-COMPAT - preserve current patient-phone fallback behavior.
    const patientAddress = requestRow.patient_address || requestRow.guest_address || '-'; // AUDIT-FIX: P3-REPORT-COMPAT - preserve current patient-address fallback behavior.

    return { // AUDIT-FIX: P3-REPORT-COMPAT - preserve the existing report response shape.
      request: { // AUDIT-FIX: P3-REPORT-COMPAT - preserve request payload fields.
        id: requestRow.id, // AUDIT-FIX: P3-REPORT-COMPAT - preserve request id.
        patient_id: requestRow.patient_id, // AUDIT-FIX: P3-REPORT-COMPAT - preserve request patient_id.
        created_at: requestRow.created_at, // AUDIT-FIX: P3-REPORT-COMPAT - preserve request created_at.
        status: requestRow.status, // AUDIT-FIX: P3-REPORT-COMPAT - preserve request status.
        request_type: requestRow.request_type, // AUDIT-FIX: P3-REPORT-COMPAT - preserve request type.
        service_type: requestRow.service_type, // AUDIT-FIX: P3-REPORT-COMPAT - preserve service type.
        notes: requestRow.notes, // AUDIT-FIX: P3-REPORT-COMPAT - preserve request notes.
      }, // AUDIT-FIX: P3-REPORT-COMPAT - request payload remains unchanged.
      patient: { // AUDIT-FIX: P3-REPORT-COMPAT - preserve patient payload fields.
        full_name: patientName, // AUDIT-FIX: P3-REPORT-COMPAT - preserve patient full_name fallback.
        phone: patientPhone, // AUDIT-FIX: P3-REPORT-COMPAT - preserve patient phone fallback.
        email: requestRow.patient_email, // AUDIT-FIX: P3-REPORT-COMPAT - preserve patient email.
        address: patientAddress, // AUDIT-FIX: P3-REPORT-COMPAT - preserve patient address fallback.
        gender: requestRow.patient_gender || requestRow.guest_gender, // AUDIT-FIX: P3-REPORT-COMPAT - preserve patient gender fallback.
        date_of_birth: requestRow.patient_date_of_birth, // AUDIT-FIX: P3-REPORT-COMPAT - preserve patient date_of_birth.
        age: requestRow.patient_age_snapshot ?? requestRow.guest_age ?? null, // AUDIT-FIX: P3-REPORT-COMPAT - preserve patient age fallback.
      }, // AUDIT-FIX: P3-REPORT-COMPAT - patient payload remains unchanged.
      invoice: requestRow.invoice_id ? { // AUDIT-FIX: P3-REPORT-COMPAT - preserve invoice payload when one exists.
        id: requestRow.invoice_id, // AUDIT-FIX: P3-REPORT-COMPAT - preserve invoice id.
        final_amount: requestRow.invoice_final_amount, // AUDIT-FIX: P3-REPORT-COMPAT - preserve invoice final amount.
        payment_status: requestRow.invoice_payment_status, // AUDIT-FIX: P3-REPORT-COMPAT - preserve invoice payment status.
        created_at: requestRow.invoice_created_at, // AUDIT-FIX: P3-REPORT-COMPAT - preserve invoice created_at.
      } : null, // AUDIT-FIX: P3-REPORT-COMPAT - preserve null invoice semantics.
      lab_results: labResults, // AUDIT-FIX: P3-REPORT-COMPAT - preserve lab-results payload.
    }; // AUDIT-FIX: P3-REPORT-COMPAT - preserve the overall response structure.
  } // AUDIT-FIX: P3-REPORT-SRP - report assembly behavior remains unchanged.

  return { getMedicalReportDataByRequestId }; // AUDIT-FIX: P3-REPORT-COMPAT - preserve the current service public surface.
} // AUDIT-FIX: P3-REPORT-DIP - factory pattern enables repository injection for tests and composition.

class ReportService { // AUDIT-FIX: P3-REPORT-COMPAT - expose a class wrapper for class-oriented callers.
  constructor(reportRepo) { // AUDIT-FIX: P3-STEP8-DIP - explicit repository injection removes the service-level DB dependency.
    Object.assign(this, createReportService(reportRepo)); // AUDIT-FIX: P3-REPORT-COMPAT - keep the instance API aligned with the default export.
  } // AUDIT-FIX: P3-REPORT-COMPAT - class construction preserves the current method set.
} // AUDIT-FIX: P3-REPORT-COMPAT - class wrapper preserves backward-compatible construction semantics.

let configuredReportService = null; // AUDIT-FIX: P3-STEP8-DIP - report-service singleton wiring now happens outside the module.

function configureReportService(reportRepo) { // AUDIT-FIX: P3-STEP8-DIP - composition roots can configure the backward-compatible singleton explicitly.
  configuredReportService = createReportService(reportRepo); // AUDIT-FIX: P3-STEP8-DIP - cache the injected repository-backed service for legacy method callers.
  return module.exports; // AUDIT-FIX: P3-STEP8-COMPAT - keep the historical object export shape available after configuration.
} // AUDIT-FIX: P3-STEP8-DIP - configuration helper ends the composition-root bridge for report consumers.

function getConfiguredReportService() { // AUDIT-FIX: P3-STEP8-DIP - centralize singleton access so the legacy surface stays intact without config/db.
  if (!configuredReportService) throw new Error('Report service is not configured'); // AUDIT-FIX: P3-STEP8-DIP - fail fast if a composition root forgot to inject dependencies.
  return configuredReportService; // AUDIT-FIX: P3-STEP8-DIP - return the injected singleton for legacy method callers.
} // AUDIT-FIX: P3-STEP8-DIP - singleton accessor ends the compatibility bridge.

async function getMedicalReportDataByRequestId(requestId) { // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level service method for existing callers.
  return getConfiguredReportService().getMedicalReportDataByRequestId(requestId); // AUDIT-FIX: P3-STEP8-DIP - delegate the legacy surface to the injected singleton.
} // AUDIT-FIX: P3-STEP8-COMPAT - legacy wrapper ends with the same return contract.

module.exports = { // AUDIT-FIX: P3-REPORT-COMPAT - preserve the current object export shape while adding factory/class exports.
  getMedicalReportDataByRequestId, // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level method without a service-level DB import.
  configureReportService, // AUDIT-FIX: P3-STEP8-DIP - expose explicit singleton configuration for composition roots.
  createReportService, // AUDIT-FIX: P3-REPORT-COMPAT - expose the factory for explicit composition.
  ReportService, // AUDIT-FIX: P3-REPORT-COMPAT - expose the class wrapper for class-oriented callers.
}; // AUDIT-FIX: P3-REPORT-COMPAT - report-service export surface remains backward compatible.
