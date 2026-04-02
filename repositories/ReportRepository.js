const BaseRepository = require('./BaseRepository'); // AUDIT-FIX: P3-REPORT-DIP - report reads extend the shared repository base.

class ReportRepository extends BaseRepository { // AUDIT-FIX: P3-REPORT-DIP - report data access moves behind an injected repository boundary.
  constructor(db) { // AUDIT-FIX: P3-REPORT-DIP - repository construction accepts the shared pool or a compatible executor.
    super(db, 'service_requests'); // AUDIT-FIX: P3-REPORT-DIP - reports read request-centered data by default.
    this._supportCache = null; // AUDIT-FIX: P3-REPORT-PERF - cache schema support probes across calls.
  } // AUDIT-FIX: P3-REPORT-DIP - constructor keeps repository-owned cache state explicit.

  async hasColumn(tableName, columnName, client = null) { // AUDIT-FIX: P3-REPORT-DIP - schema detection is abstracted into the repository.
    const row = await this._queryOne(
      `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
      `,
      [tableName, columnName],
      client
    ); // AUDIT-FIX: P3-REPORT-DIP - information_schema checks now go through the repository.
    return row !== null; // AUDIT-FIX: P3-REPORT-SRP - expose a boolean column-exists result.
  } // AUDIT-FIX: P3-REPORT-SRP - schema probing is centralized.

  async hasTable(tableName, client = null) { // AUDIT-FIX: P3-REPORT-DIP - table-presence checks now go through the repository.
    const row = await this._queryOne(
      "SELECT to_regclass($1) AS table_ref",
      [`public.${tableName}`],
      client
    ); // AUDIT-FIX: P3-REPORT-DIP - table-exists probes now go through the repository.
    return Boolean(row?.table_ref); // AUDIT-FIX: P3-REPORT-SRP - expose a boolean table-exists result.
  } // AUDIT-FIX: P3-REPORT-SRP - table probing is centralized.

  async getLabReportQuerySupport(client = null) { // AUDIT-FIX: P3-REPORT-DIP - schema capability checks now go through the repository.
    if (!this._supportCache) { // AUDIT-FIX: P3-REPORT-PERF - probe dynamic schema support only once per process.
      this._supportCache = (async () => { // AUDIT-FIX: P3-REPORT-PERF - cache the async probe promise itself.
        try { // AUDIT-FIX: P3-REPORT-RESILIENCE - preserve the existing fail-soft probe behavior.
          const [hasFlag, hasMatchedRangeId, hasCondition, hasRangesTable] = await Promise.all([
            this.hasColumn('lab_test_results', 'flag', client),
            this.hasColumn('lab_test_results', 'matched_range_id', client),
            this.hasColumn('lab_test_results', 'condition', client),
            this.hasTable('lab_test_reference_ranges', client),
          ]); // AUDIT-FIX: P3-REPORT-PERF - perform schema probes concurrently.

          return { hasFlag, hasMatchedRangeId, hasCondition, hasRangesTable }; // AUDIT-FIX: P3-REPORT-SRP - expose a simple schema-support map.
        } catch (_) { // AUDIT-FIX: P3-REPORT-RESILIENCE - preserve current behavior when schema probes fail.
          return {
            hasFlag: false,
            hasMatchedRangeId: false,
            hasCondition: false,
            hasRangesTable: false,
          }; // AUDIT-FIX: P3-REPORT-RESILIENCE - default to the legacy query path on probe failure.
        } // AUDIT-FIX: P3-REPORT-RESILIENCE - schema probe failures remain non-fatal.
      })(); // AUDIT-FIX: P3-REPORT-PERF - keep the schema-support promise cached.
    } // AUDIT-FIX: P3-REPORT-PERF - cache initialization only happens once.

    return this._supportCache; // AUDIT-FIX: P3-REPORT-PERF - reuse the cached schema-support probe.
  } // AUDIT-FIX: P3-REPORT-SRP - schema capability detection is centralized.

  async getMedicalReportRequestRow(requestId, client = null) { // AUDIT-FIX: P3-REPORT-DIP - report request/invoice/patient joins now go through the repository.
    return this._queryOne(
      `
      SELECT
        sr.id,
        sr.patient_id,
        sr.request_type,
        sr.service_type,
        sr.status,
        sr.notes,
        sr.created_at,
        sr.guest_name,
        sr.guest_phone,
        sr.guest_address,
        sr.guest_gender,
        sr.guest_age,
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
        i.created_at AS invoice_created_at
      FROM service_requests sr
      LEFT JOIN patients p ON p.id = sr.patient_id
      LEFT JOIN invoices i ON i.request_id = sr.id
      WHERE sr.id = $1
      LIMIT 1
      `,
      [requestId],
      client
    ); // AUDIT-FIX: P3-REPORT-DIP - preserve the current report-request row shape.
  } // AUDIT-FIX: P3-REPORT-SRP - request row assembly is centralized.

  async getLabReportRows(requestId, support, client = null) { // AUDIT-FIX: P3-REPORT-DIP - lab-result report rows now go through the repository.
    const supportsSmartRanges = support.hasFlag && support.hasMatchedRangeId && support.hasCondition && support.hasRangesTable; // AUDIT-FIX: P3-REPORT-SRP - determine the correct query path once.
    const sql = supportsSmartRanges
      ? `
        SELECT
          ltr.id,
          lt.name AS test_name,
          ltr.result,
          COALESCE(ltrr.unit, lt.unit) AS unit,
          lt.reference_range,
          ltr.is_normal,
          ltr.notes,
          ltr.created_at,
          ltr.flag,
          ltr.condition,
          ltr.matched_range_id,
          ltrr.range_low,
          ltrr.range_high,
          ltrr.range_text
        FROM lab_test_results ltr
        LEFT JOIN lab_tests lt ON lt.id = ltr.lab_test_id
        LEFT JOIN lab_test_reference_ranges ltrr ON ltrr.id = ltr.matched_range_id
        WHERE ltr.request_id = $1
        ORDER BY ltr.created_at ASC
      `
      : `
        SELECT
          ltr.id,
          lt.name AS test_name,
          ltr.result,
          lt.unit,
          lt.reference_range,
          ltr.is_normal,
          ltr.notes,
          ltr.created_at,
          NULL::varchar AS flag,
          NULL::varchar AS condition,
          NULL::uuid AS matched_range_id,
          NULL::numeric AS range_low,
          NULL::numeric AS range_high,
          NULL::text AS range_text
        FROM lab_test_results ltr
        LEFT JOIN lab_tests lt ON lt.id = ltr.lab_test_id
        WHERE ltr.request_id = $1
        ORDER BY ltr.created_at ASC
      `; // AUDIT-FIX: P3-REPORT-SRP - keep both the smart-range and legacy query paths in one repository method.
    const result = await this._query(sql, [requestId], client); // AUDIT-FIX: P3-REPORT-DIP - lab-result queries now execute through the repository.
    return result.rows; // AUDIT-FIX: P3-REPORT-SRP - expose only the report row array to callers.
  } // AUDIT-FIX: P3-REPORT-SRP - lab-result row assembly is centralized.

  async getMedicalReportRecord(requestId, client = null) { // AUDIT-FIX: P3-REPORT-DIP - report-record reads now go through the repository.
    return this._queryOne(
      `
      SELECT status, pdf_url, updated_at, reviewed_at, published_at
      FROM medical_reports
      WHERE request_id = $1
      `,
      [requestId],
      client
    ); // AUDIT-FIX: P3-REPORT-COMPAT - preserve the current report-record read shape.
  } // AUDIT-FIX: P3-REPORT-SRP - report-record lookup is centralized.

  async updateMedicalReportPdfUrl(requestId, pdfUrl, client = null) { // AUDIT-FIX: P3-REPORT-DIP - report PDF URL writes now go through the repository.
    return this._queryOne(
      `
      UPDATE medical_reports
      SET pdf_url = $2,
          updated_at = NOW()
      WHERE request_id = $1
      RETURNING status, pdf_url
      `,
      [requestId, pdfUrl],
      client
    ); // AUDIT-FIX: P3-REPORT-COMPAT - preserve the current report PDF persistence semantics.
  } // AUDIT-FIX: P3-REPORT-SRP - report PDF URL persistence is centralized.
} // AUDIT-FIX: P3-REPORT-DIP - report repository now owns report-related reads and schema probes.

module.exports = ReportRepository; // AUDIT-FIX: P3-REPORT-DIP - export the repository for composition-root injection.
