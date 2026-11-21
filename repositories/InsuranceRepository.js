const BaseRepository = require('./BaseRepository');

// One row per insurance lab order (table case_insurance_requests, migration 004).
class InsuranceRepository extends BaseRepository {
  constructor(pool) {
    super(pool, 'case_insurance_requests');
  }

  async insert({ caseId, cardFileKey, cardFileName, cardMime }, client) {
    return this._queryOne(
      `INSERT INTO case_insurance_requests (case_id, card_file_key, card_file_name, card_mime)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [caseId, cardFileKey, cardFileName || null, cardMime || null],
      client
    );
  }

  async findByCase(caseId, client = null) {
    return this._queryOne('SELECT * FROM case_insurance_requests WHERE case_id = $1', [caseId], client);
  }

  async lockByCase(caseId, client) {
    return this._queryOne('SELECT * FROM case_insurance_requests WHERE case_id = $1 FOR UPDATE', [caseId], client);
  }

  async saveQuote(caseId, { testsDescription, patientAmount, labOwesAmount, notes, providerId }, client) {
    return this._queryOne(
      `UPDATE case_insurance_requests
       SET tests_description = $2, patient_amount = $3, lab_owes_amount = $4, quote_notes = $5,
           quoted_by = $6, quoted_at = NOW(), status = 'QUOTED', updated_at = NOW()
       WHERE case_id = $1 RETURNING *`,
      [caseId, testsDescription, patientAmount, labOwesAmount, notes || null, providerId],
      client
    );
  }

  async setStatus(caseId, status, client) {
    return this._queryOne(
      `UPDATE case_insurance_requests
       SET status = $2::text, decided_at = CASE WHEN $2::text IN ('APPROVED', 'DECLINED') THEN NOW() ELSE decided_at END,
           updated_at = NOW()
       WHERE case_id = $1 RETURNING *`,
      [caseId, status],
      client
    );
  }

  async setReceivable(caseId, { status, notes, adminId }, client = null) {
    return this._queryOne(
      `UPDATE case_insurance_requests
       SET receivable_status = $2, receivable_notes = CASE WHEN $5 THEN NULLIF($3, '') ELSE receivable_notes END,
           receivable_updated_at = NOW(), receivable_updated_by = $4, updated_at = NOW()
       WHERE case_id = $1 RETURNING *`,
      // notes undefined = keep the old note; '' or null = clear it.
      [caseId, status, notes ?? null, adminId, notes !== undefined],
      client
    );
  }

  /** Admin list with the order number, patient, lab and money per request, plus totals. */
  async list({ status, receivableStatus, providerId }, { limit, offset }) {
    const params = [];
    const where = [];
    const add = (value) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (status) where.push(`ir.status = ${add(status)}`);
    if (receivableStatus) where.push(`ir.receivable_status = ${add(receivableStatus)}`);
    if (providerId) where.push(`line.provider_id = ${add(providerId)}`);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const from = `
      FROM case_insurance_requests ir
      JOIN cases c ON c.id = ir.case_id
      LEFT JOIN patients p ON p.id = c.patient_id
      LEFT JOIN LATERAL (
        SELECT cs.provider_id FROM case_services cs
        JOIN services s ON s.id = cs.service_id
        WHERE cs.case_id = c.id AND s.system_key = 'lab_insurance_tests'
        ORDER BY cs.created_at LIMIT 1
      ) line ON TRUE
      LEFT JOIN service_providers sp ON sp.id = line.provider_id
      LEFT JOIN case_invoices inv ON inv.case_id = c.id
      ${whereSql}`;

    const [rows, totals] = await Promise.all([
      this._query(
        `SELECT ir.case_id, c.reference_number, c.status AS case_status, ir.status, ir.tests_description,
                ir.patient_amount, ir.lab_owes_amount, ir.receivable_status, ir.receivable_updated_at,
                ir.receivable_notes, ir.quoted_at, ir.decided_at, ir.created_at,
                COALESCE(p.full_name, c.guest_name) AS patient_name,
                line.provider_id AS lab_provider_id, sp.full_name AS lab_provider_name,
                inv.final_amount, inv.total_paid, inv.payment_status
         ${from}
         ORDER BY ir.created_at DESC
         LIMIT ${add(limit)} OFFSET ${add(offset)}`,
        params
      ),
      this._queryOne(
        `SELECT COUNT(*)::int AS total,
                COALESCE(SUM(ir.lab_owes_amount) FILTER (WHERE ir.receivable_status = 'PENDING'
                  AND ir.status = 'APPROVED'), 0) AS receivable_pending,
                COALESCE(SUM(ir.lab_owes_amount) FILTER (WHERE ir.receivable_status = 'RECEIVED'), 0) AS receivable_received
         ${from}`,
        params.slice(0, params.length - 2)
      ),
    ]);
    return { data: rows.rows, totals };
  }
}

module.exports = InsuranceRepository;
