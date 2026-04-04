const pool = require('../config/db');

function normalizeOptionalAge(value) {
  if (value === null || value === undefined || value === '') return null;

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;

  return Math.max(0, Math.floor(numeric));
}

function resolvePatientAge(row) {
  if (row?.patient_date_of_birth) return null;
  return normalizeOptionalAge(row?.patient_age_snapshot ?? row?.guest_age);
}

function deduplicateProviderReports(reports, serviceType) {
  if (!['MEDICAL', 'PACKAGE'].includes(serviceType)) {
    return reports;
  }

  const byProvider = new Map();

  for (const report of reports) {
    const key = report.provider_id;
    if (!byProvider.has(key)) {
      byProvider.set(key, []);
    }
    byProvider.get(key).push(report);
  }

  const result = [];

  for (const [, providerReports] of byProvider) {
    const hasFinal = providerReports.some((report) => report.report_type === 'FINAL_REPORT');

    if (hasFinal) {
      result.push(...providerReports.filter((report) => report.report_type !== 'SUB_REPORT'));
    } else {
      result.push(...providerReports);
    }
  }

  return result;
}

/**
 * Build a complete report snapshot for a request.
 * Reads all data from DB and returns a frozen payload.
 * @param {string} requestId
 * @param {object} [client] - optional pg client for transaction use
 * @returns {Promise<object>} snapshot payload
 */
async function buildReportSnapshot(requestId, client) {
  const db = client || pool;

  const requestResult = await db.query(
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
      COALESCE(sr.patient_full_name_snapshot, p.full_name, sr.guest_name) AS patient_name,
      COALESCE(sr.patient_phone_snapshot, p.phone, sr.guest_phone) AS patient_phone,
      COALESCE(sr.patient_email_snapshot, p.email) AS patient_email,
      COALESCE(sr.patient_address_snapshot, p.address, sr.guest_address) AS patient_address,
      COALESCE(sr.patient_gender_snapshot, p.gender, sr.guest_gender) AS patient_gender,
      COALESCE(sr.patient_date_of_birth_snapshot, p.date_of_birth) AS patient_date_of_birth,
      sr.patient_age_snapshot,
      COALESCE(sr.service_name_snapshot, svc.name, lt.name, lp.name_en, lpk.name_en, pk.name) AS service_name,
      COALESCE(sr.service_description_snapshot, svc.description, lt.description, lp.description_en, lpk.description_en, pk.description) AS service_description,
      COALESCE(
        sr.service_category_name_snapshot,
        svc_cat.name,
        lt_cat.name,
        CASE
          WHEN lp.id IS NOT NULL THEN 'Lab Panel'
          WHEN lpk.id IS NOT NULL THEN 'Lab Package'
          ELSE pk_cat.name
        END
      ) AS service_category_name,
      COALESCE(sr.service_price_snapshot, svc.price, lt.cost, lp.price, lpk.price, pk.total_cost) AS service_price,
      COALESCE(sr.assigned_provider_name_snapshot, asp.full_name, sr.lead_provider_name_snapshot, lsp.full_name) AS provider_name,
      COALESCE(sr.assigned_provider_phone_snapshot, asp.phone, sr.lead_provider_phone_snapshot, lsp.phone) AS provider_phone,
      COALESCE(sr.assigned_provider_type_snapshot, asp.type::text, sr.lead_provider_type_snapshot, lsp.type::text) AS provider_type,
      COALESCE(sr.lead_provider_name_snapshot, lsp.full_name) AS lead_provider_name,
      COALESCE(sr.lead_provider_phone_snapshot, lsp.phone) AS lead_provider_phone,
      COALESCE(sr.lead_provider_type_snapshot, lsp.type::text) AS lead_provider_type,
      i.id AS invoice_id,
      i.final_amount AS invoice_final_amount,
      i.payment_status AS invoice_payment_status,
      i.payment_method AS invoice_payment_method,
      i.created_at AS invoice_created_at
    FROM service_requests sr
    LEFT JOIN patients p ON p.id = sr.patient_id
    LEFT JOIN services svc ON svc.id = sr.service_id
    LEFT JOIN lab_tests lt ON lt.id = sr.lab_test_id
    LEFT JOIN lab_panels lp ON lp.id = sr.lab_panel_id
    LEFT JOIN lab_packages lpk ON lpk.id = sr.lab_package_id
    LEFT JOIN packages pk ON pk.id = sr.package_id
    LEFT JOIN service_categories svc_cat ON svc.category_id = svc_cat.id
    LEFT JOIN service_categories lt_cat ON lt.category_id = lt_cat.id
    LEFT JOIN service_categories pk_cat ON pk.category_id = pk_cat.id
    LEFT JOIN service_providers asp ON asp.id = sr.assigned_provider_id
    LEFT JOIN service_providers lsp ON lsp.id = sr.lead_provider_id
    LEFT JOIN invoices i ON i.request_id = sr.id
    WHERE sr.id = $1
    LIMIT 1
    `,
    [requestId]
  );

  if (!requestResult.rows.length) {
    throw new Error(`Request not found: ${requestId}`);
  }

  const req = requestResult.rows[0];

  const [providerReportsResult, labResultsResult, metaResult] = await Promise.all([
    db.query(
      `
      SELECT DISTINCT ON (rpr.provider_id, rpr.report_type)
        rpr.id,
        rpr.request_id,
        rpr.provider_id,
        rpr.task_id,
        rpr.report_type,
        rpr.status,
        rpr.symptoms_summary,
        rpr.procedures_performed,
        rpr.procedures_done,
        rpr.allergies_noted,
        rpr.patient_allergies,
        rpr.findings,
        rpr.diagnosis,
        rpr.treatment_plan,
        rpr.recommendations,
        rpr.lab_notes,
        rpr.imaging_notes,
        rpr.nurse_notes,
        rpr.notes,
        rpr.image_url,
        rpr.pdf_report_url,
        rpr.service_type,
        rpr.service_subtype,
        rpr.version,
        rpr.created_at,
        rpr.updated_at,
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
    db.query(
      `
      SELECT
        ltr.id,
        ltr.request_id,
        ltr.lab_test_id,
        ltr.result,
        ltr.is_normal,
        ltr.notes,
        ltr.flag,
        ltr.condition,
        ltr.created_at,
        COALESCE(ltr.test_name_snapshot, lt.name) AS test_name,
        COALESCE(ltr.unit_snapshot, lt.unit) AS unit,
        COALESCE(ltr.reference_range_snapshot, lt.reference_range) AS reference_range
      FROM lab_test_results ltr
      LEFT JOIN lab_tests lt ON lt.id = ltr.lab_test_id
      WHERE ltr.request_id = $1
      ORDER BY ltr.created_at ASC
      `,
      [requestId]
    ),
    db.query(
      `
      SELECT
        mr.reviewed_at,
        mr.published_at,
        mr.pdf_url,
        mr.admin_notes,
        mr.snapshot_updated_by,
        mr.snapshot_updated_at,
        a.full_name AS admin_name
      FROM medical_reports mr
      LEFT JOIN admins a ON a.id = mr.reviewed_by
      WHERE mr.request_id = $1
      LIMIT 1
      `,
      [requestId]
    ),
  ]);

  const meta = metaResult.rows[0] || {};
  const deduplicatedReports = deduplicateProviderReports(
    providerReportsResult.rows,
    req.service_type
  );

  return {
    version: 1,
    captured_at: new Date().toISOString(),
    request: {
      id: req.id,
      patient_id: req.patient_id,
      request_type: req.request_type,
      service_type: req.service_type,
      status: req.status,
      notes: req.notes,
      admin_close_notes: req.admin_close_notes,
      created_at: req.created_at,
      updated_at: req.updated_at,
      requested_at: req.requested_at,
      scheduled_at: req.scheduled_at,
      completed_at: req.completed_at,
      closed_at: req.closed_at,
      service_name: req.service_name,
      service_description: req.service_description,
      service_category_name: req.service_category_name,
      service_price: req.service_price,
      provider_name: req.provider_name,
      provider_phone: req.provider_phone,
      provider_type: req.provider_type,
      lead_provider_name: req.lead_provider_name,
      lead_provider_phone: req.lead_provider_phone,
      lead_provider_type: req.lead_provider_type,
    },
    patient: {
      full_name: req.patient_name || req.guest_name || '-',
      phone: req.patient_phone || req.guest_phone || '-',
      email: req.patient_email || null,
      address: req.patient_address || req.guest_address || '-',
      gender: req.patient_gender || req.guest_gender || null,
      date_of_birth: req.patient_date_of_birth || null,
      age: resolvePatientAge(req),
    },
    invoice: req.invoice_id
      ? {
        id: req.invoice_id,
        final_amount: req.invoice_final_amount,
        payment_status: req.invoice_payment_status,
        payment_method: req.invoice_payment_method,
        created_at: req.invoice_created_at,
      }
      : null,
    provider_reports: deduplicatedReports,
    lab_results: labResultsResult.rows,
    report_meta: {
      reviewed_at: meta.reviewed_at || null,
      published_at: meta.published_at || null,
      pdf_url: meta.pdf_url || null,
      admin_notes: meta.admin_notes || null,
      admin_name: meta.admin_name || null,
      snapshot_updated_by: meta.snapshot_updated_by || null,
      snapshot_updated_at: meta.snapshot_updated_at || null,
    },
  };
}

module.exports = { buildReportSnapshot };
