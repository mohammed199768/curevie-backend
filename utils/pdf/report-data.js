const pool = require('../../config/db');

const DISPLAYABLE_PROVIDER_REPORT_STATUSES = new Set(['DRAFT', 'SUBMITTED', 'APPROVED']);
const CLINICAL_FIELD_KEYS = [
  'symptoms_summary',
  'procedures',
  'allergies',
  'findings',
  'diagnosis',
  'recommendations',
  'treatment_plan',
  'lab_notes',
  'imaging_notes',
  'nurse_notes',
  'notes',
  'image_url',
  'pdf_report_url',
];

function normalizeReportValue(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function normalizeOptionalAge(value) {
  if (value === null || value === undefined || value === '') return null;

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;

  return Math.max(0, Math.floor(numeric));
}

function getClinicalFieldValue(report, field) {
  if (!report) return '';

  switch (field) {
    case 'procedures':
      return report.procedures_done || report.procedures_performed || '';
    case 'allergies':
      return report.patient_allergies || report.allergies_noted || '';
    default:
      return report[field] || '';
  }
}

function getReportTimestamp(report) {
  const createdAt = new Date(report?.created_at || 0).getTime();
  const updatedAt = new Date(report?.updated_at || 0).getTime();
  return Math.max(createdAt, updatedAt);
}

function hasEquivalentClinicalContent(finalReport, subReport) {
  let matchingPopulatedFields = 0;

  for (const field of CLINICAL_FIELD_KEYS) {
    const finalValue = normalizeReportValue(getClinicalFieldValue(finalReport, field));
    const subValue = normalizeReportValue(getClinicalFieldValue(subReport, field));

    if (!finalValue && !subValue) {
      continue;
    }

    if (finalValue !== subValue) {
      return false;
    }

    if (finalValue && subValue) {
      matchingPopulatedFields += 1;
    }
  }

  return matchingPopulatedFields > 0;
}

function isSupersededClonePair(finalReport, subReport) {
  if (!finalReport || !subReport) return false;
  if (finalReport.report_type !== 'FINAL_REPORT' || subReport.report_type !== 'SUB_REPORT') return false;
  if (finalReport.request_id !== subReport.request_id || finalReport.provider_id !== subReport.provider_id) return false;
  if (finalReport.task_id !== null || !subReport.task_id) return false;
  if (!DISPLAYABLE_PROVIDER_REPORT_STATUSES.has(String(finalReport.status || '').toUpperCase())) return false;
  if (String(subReport.status || '').toUpperCase() === 'REJECTED') return false;
  if (getReportTimestamp(finalReport) < getReportTimestamp(subReport)) return false;

  return hasEquivalentClinicalContent(finalReport, subReport);
}

function findBestSupersededSubReport(finalReport, reports, hiddenIds) {
  const matches = reports
    .filter((report) => !hiddenIds.has(report.id) && isSupersededClonePair(finalReport, report))
    .sort((left, right) => getReportTimestamp(right) - getReportTimestamp(left));

  return matches[0] || null;
}

function dedupeProviderReportsForPdf(reports) {
  if (!Array.isArray(reports) || reports.length === 0) {
    return [];
  }

  const hiddenIds = new Set();
  const finalReports = reports
    .filter((report) => report.report_type === 'FINAL_REPORT')
    .sort((left, right) => getReportTimestamp(right) - getReportTimestamp(left));

  for (const finalReport of finalReports) {
    const supersededReport = findBestSupersededSubReport(finalReport, reports, hiddenIds);
    if (!supersededReport) continue;
    hiddenIds.add(supersededReport.id);
  }

  return reports.filter((report) => !hiddenIds.has(report.id));
}

function resolvePatientAgeSnapshot(row) {
  if (row?.patient_date_of_birth) return null;
  return normalizeOptionalAge(row?.patient_age_snapshot ?? row?.guest_age);
}

async function loadMedicalReportPdfData(input) {
  const requestId = typeof input === 'string'
    ? input
    : input?.request?.id;

  if (!requestId) {
    return input || {};
  }

  const requestResult = await pool.query(
    `
    SELECT
      sr.id,
      sr.patient_id,
      sr.request_type,
      sr.service_type,
      sr.status,
      sr.notes,
      sr.admin_close_notes,
      sr.created_at,
      sr.updated_at,
      sr.requested_at,
      sr.scheduled_at,
      sr.completed_at,
      sr.closed_at,
      sr.guest_name,
      sr.guest_phone,
      sr.guest_address,
      sr.guest_gender,
      sr.guest_age,
      COALESCE(sr.service_name_snapshot, svc.name, lt.name, pk.name) AS service_name,
      COALESCE(sr.service_description_snapshot, svc.description, lt.description, pk.description) AS service_description,
      COALESCE(sr.service_category_name_snapshot, svc_cat.name, lt_cat.name, pk_cat.name) AS service_category_name,
      COALESCE(sr.assigned_provider_name_snapshot, sp.full_name) AS provider_name,
      COALESCE(sr.assigned_provider_phone_snapshot, sp.phone) AS provider_phone,
      COALESCE(sr.assigned_provider_type_snapshot, sp.type::text) AS provider_type,
      COALESCE(sr.lead_provider_name_snapshot, lp.full_name) AS lead_provider_name,
      COALESCE(sr.lead_provider_phone_snapshot, lp.phone) AS lead_provider_phone,
      COALESCE(sr.lead_provider_type_snapshot, lp.type::text) AS lead_provider_type,
      COALESCE(sr.patient_full_name_snapshot, p.full_name, sr.guest_name) AS patient_full_name,
      COALESCE(sr.patient_phone_snapshot, p.phone, sr.guest_phone) AS patient_phone,
      COALESCE(sr.patient_email_snapshot, p.email) AS patient_email,
      COALESCE(sr.patient_address_snapshot, p.address, sr.guest_address) AS patient_address,
      COALESCE(sr.patient_gender_snapshot, p.gender, sr.guest_gender) AS patient_gender,
      COALESCE(sr.patient_date_of_birth_snapshot, p.date_of_birth) AS patient_date_of_birth,
      sr.patient_age_snapshot,
      i.id AS invoice_id,
      i.final_amount AS invoice_final_amount,
      i.payment_status AS invoice_payment_status,
      i.payment_method AS invoice_payment_method,
      i.created_at AS invoice_created_at,
      mr.reviewed_at,
      mr.published_at,
      mr.pdf_url,
      a.full_name AS admin_name
    FROM service_requests sr
    LEFT JOIN patients p ON p.id = sr.patient_id
    LEFT JOIN service_providers sp ON sp.id = sr.assigned_provider_id
    LEFT JOIN service_providers lp ON lp.id = sr.lead_provider_id
    LEFT JOIN services svc ON svc.id = sr.service_id
    LEFT JOIN lab_tests lt ON lt.id = sr.lab_test_id
    LEFT JOIN packages pk ON pk.id = sr.package_id
    LEFT JOIN service_categories svc_cat ON svc.category_id = svc_cat.id
    LEFT JOIN service_categories lt_cat ON lt.category_id = lt_cat.id
    LEFT JOIN service_categories pk_cat ON pk.category_id = pk_cat.id
    LEFT JOIN invoices i ON i.request_id = sr.id
    LEFT JOIN medical_reports mr ON mr.request_id = sr.id
    LEFT JOIN admins a ON a.id = mr.reviewed_by
    WHERE sr.id = $1
    LIMIT 1
    `,
    [requestId]
  );

  const requestRow = requestResult.rows[0];
  if (!requestRow) {
    return input || {};
  }

  const [providerReportsResult, labResultsResult] = await Promise.all([
    pool.query(
      `
      SELECT DISTINCT ON (rpr.provider_id, rpr.report_type)
        rpr.*,
        COALESCE(rpr.provider_name_snapshot, sp.full_name) AS provider_name,
        COALESCE(rpr.provider_phone_snapshot, sp.phone) AS provider_phone,
        COALESCE(rpr.provider_type_snapshot, sp.type::text) AS provider_type
      FROM request_provider_reports rpr
      LEFT JOIN service_providers sp ON sp.id = rpr.provider_id
      WHERE rpr.request_id = $1
        AND rpr.status IN ('DRAFT', 'SUBMITTED', 'APPROVED')
      ORDER BY rpr.provider_id, rpr.report_type, rpr.version DESC, rpr.updated_at DESC
      `,
      [requestId]
    ),
    pool.query(
      `
      SELECT
        ltr.*,
        lt.name AS test_name,
        lt.unit,
        lt.reference_range
      FROM lab_test_results ltr
      LEFT JOIN lab_tests lt ON lt.id = ltr.lab_test_id
      WHERE ltr.request_id = $1
      ORDER BY ltr.created_at ASC
      `,
      [requestId]
    ),
  ]);

  const base = typeof input === 'object' && input ? input : {};

  return {
    ...base,
    request: {
      ...(base.request || {}),
      id: requestRow.id,
      patient_id: requestRow.patient_id,
      request_type: requestRow.request_type,
      service_type: requestRow.service_type,
      status: requestRow.status,
      notes: requestRow.notes,
      admin_close_notes: requestRow.admin_close_notes,
      created_at: requestRow.created_at,
      updated_at: requestRow.updated_at,
      requested_at: requestRow.requested_at,
      scheduled_at: requestRow.scheduled_at,
      completed_at: requestRow.completed_at,
      closed_at: requestRow.closed_at,
      service_name: requestRow.service_name,
      service_description: requestRow.service_description,
      service_category_name: requestRow.service_category_name,
      provider_name: requestRow.provider_name || requestRow.lead_provider_name,
      provider_phone: requestRow.provider_phone || requestRow.lead_provider_phone,
      provider_type: requestRow.provider_type || requestRow.lead_provider_type,
      lead_provider_name: requestRow.lead_provider_name,
      lead_provider_phone: requestRow.lead_provider_phone,
      lead_provider_type: requestRow.lead_provider_type,
    },
    patient: {
      ...(base.patient || {}),
      full_name: requestRow.patient_full_name || requestRow.guest_name || '-',
      phone: requestRow.patient_phone || requestRow.guest_phone || '-',
      email: requestRow.patient_email || null,
      address: requestRow.patient_address || requestRow.guest_address || '-',
      gender: requestRow.patient_gender || requestRow.guest_gender || null,
      date_of_birth: requestRow.patient_date_of_birth || null,
      age: resolvePatientAgeSnapshot(requestRow),
    },
    invoice: requestRow.invoice_id
      ? {
        ...(base.invoice || {}),
        id: requestRow.invoice_id,
        final_amount: requestRow.invoice_final_amount,
        payment_status: requestRow.invoice_payment_status,
        payment_method: requestRow.invoice_payment_method,
        created_at: requestRow.invoice_created_at,
      }
      : (base.invoice || null),
    lab_results: Array.isArray(base.lab_results) && base.lab_results.length
      ? base.lab_results
      : labResultsResult.rows,
    provider_reports: dedupeProviderReportsForPdf(providerReportsResult.rows),
    report_meta: {
      reviewed_at: requestRow.reviewed_at,
      published_at: requestRow.published_at,
      pdf_url: requestRow.pdf_url,
      admin_name: requestRow.admin_name,
    },
  };
}

module.exports = {
  loadMedicalReportPdfData,
};
