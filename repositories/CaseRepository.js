const BaseRepository = require('./BaseRepository');

class CaseRepository extends BaseRepository {
  constructor(pool) {
    super(pool, 'cases');
  }

  async createCase(data, client = null) {
    return this._queryOne(
      `
      INSERT INTO cases
        (patient_id, package_id, notes, guest_name, guest_phone, guest_address)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [
        data.patient_id || null,
        data.package_id || null,
        data.notes || null,
        data.guest_name || null,
        data.guest_phone || null,
        data.guest_address || null,
      ],
      client
    );
  }

  async findCaseById(id, client = null) {
    return this._queryOne(
      `
      SELECT
        c.*,
        COALESCE(p.full_name, c.guest_name) AS patient_name,
        COALESCE(p.phone, c.guest_phone) AS patient_phone,
        p.date_of_birth AS patient_dob,
        p.gender AS patient_gender,
        p.allergies AS patient_allergies,
        sp.full_name AS lead_provider_name
      FROM cases c
      LEFT JOIN patients p ON p.id = c.patient_id
      LEFT JOIN service_providers sp ON sp.id = c.lead_provider_id
      WHERE c.id = $1
      `,
      [id],
      client
    );
  }

  async findCasesByPatient(patientId, { page = 1, limit = 10 } = {}, client = null) {
    const safePage = Math.max(Number(page) || 1, 1);
    const safeLimit = Math.max(Number(limit) || 10, 1);
    const offset = (safePage - 1) * safeLimit;

    const [rowsResult, countResult] = await Promise.all([
      this._query(
        `
        SELECT c.*, p.full_name AS patient_name
        FROM cases c
        LEFT JOIN patients p ON p.id = c.patient_id
        WHERE c.patient_id = $1
        ORDER BY c.created_at DESC
        LIMIT $2 OFFSET $3
        `,
        [patientId, safeLimit, offset],
        client
      ),
      this._query(
        'SELECT COUNT(*)::int AS total FROM cases WHERE patient_id = $1',
        [patientId],
        client
      ),
    ]);

    return {
      cases: rowsResult.rows,
      total: countResult.rows[0]?.total || 0,
    };
  }

  async findCasesByGuest(guestPhone, client = null) {
    const result = await this._query(
      `
      SELECT c.* FROM cases c
      WHERE c.guest_phone = $1
      ORDER BY c.created_at DESC
      `,
      [guestPhone],
      client
    );

    return result.rows;
  }

  async findAllCases({ page = 1, limit = 10, status = null, patient_id = null } = {}, client = null) {
    const safePage = Math.max(Number(page) || 1, 1);
    const safeLimit = Math.max(Number(limit) || 10, 1);
    const offset = (safePage - 1) * safeLimit;

    const params = [status || null, patient_id || null, safeLimit, offset];

    const [rowsResult, countResult] = await Promise.all([
      this._query(
        `
        SELECT
          c.*,
          COALESCE(p.full_name, c.guest_name) AS patient_name,
          COALESCE(p.phone, c.guest_phone) AS patient_phone
        FROM cases c
        LEFT JOIN patients p ON p.id = c.patient_id
        WHERE ($1::text IS NULL OR c.status::text = $1)
          AND ($2::uuid IS NULL OR c.patient_id = $2)
        ORDER BY c.created_at DESC
        LIMIT $3 OFFSET $4
        `,
        params,
        client
      ),
      this._query(
        `
        SELECT COUNT(*)::int AS total
        FROM cases c
        WHERE ($1::text IS NULL OR c.status::text = $1)
          AND ($2::uuid IS NULL OR c.patient_id = $2)
        `,
        [status || null, patient_id || null],
        client
      ),
    ]);

    return {
      cases: rowsResult.rows,
      total: countResult.rows[0]?.total || 0,
    };
  }

  async addCaseService(data, client = null) {
    return this._queryOne(
      `
      INSERT INTO case_services
        (case_id, service_id, original_price, bundle_price, notes)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [
        data.case_id,
        data.service_id,
        data.original_price,
        data.bundle_price,
        data.notes || null,
      ],
      client
    );
  }

  async findServicesByCase(caseId, client = null) {
    const result = await this._query(
      `
      SELECT
        cs.*,
        s.name AS service_name,
        s.description AS service_description,
        sp.full_name AS provider_name,
        sp.type AS provider_type
      FROM case_services cs
      LEFT JOIN services s ON s.id = cs.service_id
      LEFT JOIN service_providers sp ON sp.id = cs.provider_id
      WHERE cs.case_id = $1
      ORDER BY cs.created_at ASC
      `,
      [caseId],
      client
    );

    return result.rows;
  }

  async findProviderFilesByCase(caseId, client = null) {
    const result = await this._query(
      `
      SELECT cpf.*, s.name as service_name, sp.full_name as provider_name
      FROM case_provider_files cpf
      JOIN case_services cs ON cs.id = cpf.case_service_id
      LEFT JOIN services s ON s.id = cs.service_id
      LEFT JOIN service_providers sp ON sp.id = cpf.uploaded_by
      WHERE cs.case_id = $1
      ORDER BY cpf.created_at DESC
      `,
      [caseId],
      client
    );

    return result.rows;
  }

  async assignProvider(caseServiceId, providerId, client = null) {
    return this._queryOne(
      `
      UPDATE case_services
      SET provider_id = $2, status = 'ASSIGNED', updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [caseServiceId, providerId],
      client
    );
  }

  async setLeadProvider(caseId, providerId, client = null) {
    return this._queryOne(
      `
      UPDATE cases
      SET lead_provider_id = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [caseId, providerId],
      client
    );
  }

  async updateCaseStatus(caseId, status, client = null) {
    return this._queryOne(
      `
      UPDATE cases
      SET status = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [caseId, status],
      client
    );
  }

  async addAppointment(data, client = null) {
    return this._queryOne(
      `
      INSERT INTO case_appointments
        (case_service_id, scheduled_at, type, notes, created_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [
        data.case_service_id,
        data.scheduled_at,
        data.type,
        data.notes || null,
        data.created_by || null,
      ],
      client
    );
  }

  async findAppointmentsByCase(caseId, client = null) {
    const result = await this._query(
      `
      SELECT ca.*, cs.service_id, s.name AS service_name
      FROM case_appointments ca
      JOIN case_services cs ON cs.id = ca.case_service_id
      JOIN services s ON s.id = cs.service_id
      WHERE cs.case_id = $1
      ORDER BY ca.scheduled_at ASC
      `,
      [caseId],
      client
    );

    return result.rows;
  }

  async addLifecycleEvent(data, client = null) {
    return this._queryOne(
      `
      INSERT INTO case_lifecycle_events
        (case_id, actor_id, actor_role, event_type, notes)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [
        data.case_id,
        data.actor_id || null,
        data.actor_role,
        data.event_type,
        data.notes || null,
      ],
      client
    );
  }

  async closeCase(caseId, adminId, notes, client = null) {
    return this._queryOne(
      `
      UPDATE cases
      SET status = 'CLOSED',
          closed_at = NOW(),
          closed_by = $2,
          admin_close_notes = $3,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [caseId, adminId, notes || null],
      client
    );
  }

  async createSnapshot(data, client = null) {
    const values = [
      data.case_id,
      data.patient_data ? JSON.stringify(data.patient_data) : null,
      data.services_data ? JSON.stringify(data.services_data) : null,
      data.providers_data ? JSON.stringify(data.providers_data) : null,
      data.invoice_data ? JSON.stringify(data.invoice_data) : null,
      data.package_data ? JSON.stringify(data.package_data) : null,
    ];

    return this._queryOne(
      `
      INSERT INTO case_snapshots
        (case_id, patient_data, services_data, providers_data,
         invoice_data, package_data, is_locked, locked_at)
      VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, TRUE, NOW())
      ON CONFLICT (case_id) DO UPDATE SET
        patient_data = EXCLUDED.patient_data,
        services_data = EXCLUDED.services_data,
        providers_data = EXCLUDED.providers_data,
        invoice_data = EXCLUDED.invoice_data,
        package_data = EXCLUDED.package_data,
        is_locked = TRUE,
        locked_at = NOW(),
        updated_at = NOW(),
        unlocked_by = NULL,
        unlock_reason = NULL
      WHERE case_snapshots.is_locked = FALSE
      RETURNING *
      `,
      values,
      client
    );
  }

  async ensureMedicalReportRecord(caseId, client = null) {
    return this._queryOne(
      `
      INSERT INTO medical_reports (case_id, status)
      VALUES ($1, 'DRAFT')
      ON CONFLICT (case_id) DO UPDATE
      SET updated_at = NOW()
      RETURNING *
      `,
      [caseId],
      client
    );
  }

  async createInvoice(data, client = null) {
    return this._queryOne(
      `
      INSERT INTO case_invoices
        (case_id, original_amount, final_amount, total_paid,
         remaining_amount, payment_status)
      VALUES ($1, $2, $2, 0, $2, 'PENDING')
      RETURNING *
      `,
      [data.case_id, data.original_amount],
      client
    );
  }
}

module.exports = CaseRepository;
