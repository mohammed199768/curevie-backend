const BaseRepository = require('./BaseRepository');
const { SERVICE_KIND_SQL, OPEN_SERVICE_STATUSES } = require('../modules/cases/case.constants');

const CASE_DETAIL_SELECT = `
  SELECT
    c.id, c.patient_id, c.guest_name, c.guest_phone, c.guest_address,
    c.area_id, c.address, c.scheduled_for, c.lead_provider_id, c.status, c.notes,
    c.cancelled_at, c.cancelled_by, c.cancelled_by_role, c.cancel_reason,
    c.closed_at, c.closed_by, c.admin_close_notes, c.created_at, c.updated_at,
    (c.patient_id IS NULL) AS is_guest,
    COALESCE(p.full_name, c.guest_name) AS patient_name,
    COALESCE(p.phone, c.guest_phone) AS patient_phone,
    p.secondary_phone AS patient_secondary_phone,
    p.email AS patient_email,
    p.date_of_birth AS patient_dob,
    p.gender AS patient_gender,
    p.allergies AS patient_allergies,
    p.height AS patient_height,
    p.weight AS patient_weight,
    p.is_vip AS patient_is_vip,
    a.name_ar AS area_name_ar,
    a.name_en AS area_name_en,
    lp.full_name AS lead_provider_name
  FROM cases c
  LEFT JOIN patients p ON p.id = c.patient_id
  LEFT JOIN areas a ON a.id = c.area_id
  LEFT JOIN service_providers lp ON lp.id = c.lead_provider_id
`;

const CASE_SERVICE_SELECT = `
  SELECT
    cs.id, cs.case_id, cs.item_type, cs.service_id, cs.package_id, cs.item_name,
    cs.item_name AS service_name,
    ${SERVICE_KIND_SQL} AS service_kind,
    cs.provider_id, cs.original_price, cs.bundle_price, cs.status, cs.notes,
    cs.assigned_at, cs.accepted_at, cs.started_at, cs.completed_at, cs.cancelled_at,
    cs.created_at, cs.updated_at,
    sp.full_name AS provider_name,
    sp.phone AS provider_phone,
    sp.type AS provider_type,
    sp.avatar_url AS provider_avatar_url,
    pr.rating_avg AS provider_rating_avg,
    COALESCE(pr.rating_count, 0)::int AS provider_rating_count,
    r.rating AS my_rating,
    r.comment AS my_rating_comment,
    room.id AS chat_room_id
  FROM case_services cs
  LEFT JOIN services s ON s.id = cs.service_id
  LEFT JOIN service_providers sp ON sp.id = cs.provider_id
  LEFT JOIN LATERAL (
    SELECT ROUND(AVG(rating)::numeric, 2) AS rating_avg, COUNT(*) AS rating_count
    FROM case_service_ratings
    WHERE provider_id = cs.provider_id
  ) pr ON cs.provider_id IS NOT NULL
  LEFT JOIN case_service_ratings r ON r.case_service_id = cs.id
  LEFT JOIN case_chat_rooms room ON room.case_service_id = cs.id
`;

// Columns shared by every case list (admin, patient, provider).
const CASE_LIST_COLUMNS = `
  c.id, c.status, c.patient_id, c.area_id, c.scheduled_for, c.created_at, c.updated_at,
  c.lead_provider_id, c.cancel_reason,
  (c.patient_id IS NULL) AS is_guest,
  COALESCE(p.full_name, c.guest_name) AS patient_name,
  a.name_ar AS area_name_ar,
  a.name_en AS area_name_en,
  lp.full_name AS lead_provider_name,
  inv.final_amount, inv.total_paid, inv.remaining_amount, inv.payment_status, inv.is_patient_visible,
  items.services_count, items.item_names, items.pending_assignment_count
`;

const CASE_LIST_JOINS = `
  FROM cases c
  LEFT JOIN patients p ON p.id = c.patient_id
  LEFT JOIN areas a ON a.id = c.area_id
  LEFT JOIN service_providers lp ON lp.id = c.lead_provider_id
  LEFT JOIN case_invoices inv ON inv.case_id = c.id
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) FILTER (WHERE cs.status <> 'CANCELLED')::int AS services_count,
      COUNT(*) FILTER (WHERE cs.status = 'PENDING')::int AS pending_assignment_count,
      ARRAY_AGG(cs.item_name ORDER BY cs.created_at) FILTER (WHERE cs.status <> 'CANCELLED') AS item_names
    FROM case_services cs
    WHERE cs.case_id = c.id
  ) items ON TRUE
`;

class CaseRepository extends BaseRepository {
  constructor(pool) {
    super(pool, 'cases');
  }

  // ---------------------------------------------------------------- cases

  async insertCase(data, client) {
    return this._queryOne(
      `INSERT INTO cases
        (patient_id, guest_name, guest_phone, guest_address, area_id, address,
         scheduled_for, notes, tracking_token_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, status, created_at`,
      [
        data.patient_id || null,
        data.guest_name || null,
        data.guest_phone || null,
        data.guest_address || null,
        data.area_id,
        data.address || null,
        data.scheduled_for || null,
        data.notes || null,
        data.tracking_token_hash || null,
      ],
      client
    );
  }

  async lockCase(caseId, client) {
    return this._queryOne('SELECT * FROM cases WHERE id = $1 FOR UPDATE', [caseId], client);
  }

  async findCaseById(caseId, client = null) {
    return this._queryOne(`${CASE_DETAIL_SELECT} WHERE c.id = $1`, [caseId], client);
  }

  async findCaseIdByTrackingHash(hash, client = null) {
    const row = await this._queryOne('SELECT id FROM cases WHERE tracking_token_hash = $1', [hash], client);
    return row?.id || null;
  }

  async updateCaseStatus(caseId, status, client) {
    return this._queryOne(
      'UPDATE cases SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *',
      [caseId, status],
      client
    );
  }

  async markCaseCancelled(caseId, { actorId, actorRole, reason }, client) {
    return this._queryOne(
      `UPDATE cases
       SET status = 'CANCELLED', cancelled_at = NOW(), cancelled_by = $2,
           cancelled_by_role = $3, cancel_reason = $4, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [caseId, actorId || null, actorRole, reason || null],
      client
    );
  }

  async markCaseClosed(caseId, adminId, notes, client) {
    return this._queryOne(
      `UPDATE cases
       SET status = 'CLOSED', closed_at = NOW(), closed_by = $2, admin_close_notes = $3, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [caseId, adminId, notes || null],
      client
    );
  }

  async setLeadProvider(caseId, providerId, client) {
    return this._queryOne(
      'UPDATE cases SET lead_provider_id = $2, updated_at = NOW() WHERE id = $1 RETURNING *',
      [caseId, providerId || null],
      client
    );
  }

  async claimGuestCase(caseId, patientId, client) {
    return this._queryOne(
      `UPDATE cases
       SET patient_id = $2, tracking_token_hash = NULL, updated_at = NOW()
       WHERE id = $1 AND patient_id IS NULL
       RETURNING *`,
      [caseId, patientId],
      client
    );
  }

  /**
   * @param {{ scope: 'ADMIN'|'PATIENT'|'PROVIDER', userId?: string }} viewer
   */
  async listCases(viewer, filters = {}) {
    const params = [];
    const where = [];
    const add = (value) => {
      params.push(value);
      return `$${params.length}`;
    };

    if (viewer.scope === 'PATIENT') {
      where.push(`c.patient_id = ${add(viewer.userId)}`);
    } else if (viewer.scope === 'PROVIDER') {
      const providerParam = add(viewer.userId);
      where.push(`(c.lead_provider_id = ${providerParam} OR EXISTS (
        SELECT 1 FROM case_services mine WHERE mine.case_id = c.id AND mine.provider_id = ${providerParam}
      ))`);
      if (filters.service_status) {
        const statusParam = add(filters.service_status);
        where.push(`EXISTS (
          SELECT 1 FROM case_services mine
          WHERE mine.case_id = c.id AND mine.provider_id = ${providerParam} AND mine.status::text = ${statusParam}
        )`);
      }
    }

    if (filters.status) where.push(`c.status::text = ANY(${add(filters.status)}::text[])`);
    if (viewer.scope === 'ADMIN') {
      if (filters.patient_id) where.push(`c.patient_id = ${add(filters.patient_id)}`);
      if (filters.area_id) where.push(`c.area_id = ${add(filters.area_id)}`);
      if (filters.unassigned) {
        where.push(`EXISTS (SELECT 1 FROM case_services u WHERE u.case_id = c.id AND u.status = 'PENDING')`);
      }
      if (filters.search) {
        const searchParam = add(`%${filters.search}%`);
        where.push(`(COALESCE(p.full_name, c.guest_name) ILIKE ${searchParam}
          OR COALESCE(p.phone, c.guest_phone) ILIKE ${searchParam}
          OR c.id::text ILIKE ${searchParam})`);
      }
    }
    if (filters.from) where.push(`c.created_at >= ${add(filters.from)}::timestamptz`);
    if (filters.to) where.push(`c.created_at < ${add(filters.to)}::timestamptz`);

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const phoneColumn = viewer.scope === 'PATIENT' ? '' : ', COALESCE(p.phone, c.guest_phone) AS patient_phone';
    const providerColumns = viewer.scope === 'PROVIDER'
      ? `, (SELECT COALESCE(json_agg(json_build_object(
            'id', mine.id, 'item_name', mine.item_name, 'status', mine.status
          ) ORDER BY mine.created_at), '[]'::json)
          FROM case_services mine
          WHERE mine.case_id = c.id AND mine.provider_id = $1) AS my_services`
      : '';

    const countParams = [...params];
    const limitParam = add(filters.limit);
    const offsetParam = add((filters.page - 1) * filters.limit);

    const [rows, count] = await Promise.all([
      this._query(
        `SELECT ${CASE_LIST_COLUMNS}${phoneColumn}${providerColumns}
         ${CASE_LIST_JOINS}
         ${whereSql}
         ORDER BY c.created_at DESC
         LIMIT ${limitParam} OFFSET ${offsetParam}`,
        params
      ),
      this._query(`SELECT COUNT(*)::int AS total FROM cases c LEFT JOIN patients p ON p.id = c.patient_id ${whereSql}`, countParams),
    ]);

    return { cases: rows.rows, total: count.rows[0]?.total || 0 };
  }

  async providerHasCaseAccess(caseId, providerId, client = null) {
    const row = await this._queryOne(
      `SELECT 1 FROM cases c
       WHERE c.id = $1 AND (
         c.lead_provider_id = $2
         OR EXISTS (SELECT 1 FROM case_services cs WHERE cs.case_id = c.id AND cs.provider_id = $2)
       )`,
      [caseId, providerId],
      client
    );
    return Boolean(row);
  }

  // ---------------------------------------------------------------- line items

  async insertCaseService(data, client) {
    return this._queryOne(
      `INSERT INTO case_services
        (case_id, item_type, service_id, package_id, item_name, original_price, bundle_price, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        data.case_id,
        data.item_type,
        data.service_id || null,
        data.package_id || null,
        data.item_name,
        data.original_price,
        data.bundle_price,
        data.notes || null,
      ],
      client
    );
  }

  async findServicesByCase(caseId, client = null) {
    const result = await this._query(
      `${CASE_SERVICE_SELECT} WHERE cs.case_id = $1 ORDER BY cs.created_at ASC, cs.id ASC`,
      [caseId],
      client
    );
    return result.rows;
  }

  async lockCaseService(caseId, serviceId, client) {
    return this._queryOne(
      `SELECT cs.*, ${SERVICE_KIND_SQL} AS service_kind
       FROM case_services cs
       LEFT JOIN services s ON s.id = cs.service_id
       WHERE cs.id = $1 AND cs.case_id = $2
       FOR UPDATE OF cs`,
      [serviceId, caseId],
      client
    );
  }

  /**
   * Writes a status change plus the timestamp that belongs to it.
   * @param {object} changes { status, provider_id?, clearProvider? }
   */
  async updateServiceStatus(serviceId, changes, client) {
    const timestampColumn = {
      ASSIGNED: 'assigned_at',
      ACCEPTED: 'accepted_at',
      IN_PROGRESS: 'started_at',
      COMPLETED: 'completed_at',
      CANCELLED: 'cancelled_at',
    }[changes.status];

    const sets = ['status = $2', 'updated_at = NOW()'];
    const params = [serviceId, changes.status];

    if (timestampColumn) sets.push(`${timestampColumn} = NOW()`);
    if (changes.status === 'ASSIGNED') sets.push('accepted_at = NULL', 'started_at = NULL');
    if (changes.status === 'PENDING') sets.push('assigned_at = NULL', 'accepted_at = NULL');
    if (Object.prototype.hasOwnProperty.call(changes, 'provider_id')) {
      params.push(changes.provider_id);
      sets.push(`provider_id = $${params.length}`);
    }

    return this._queryOne(
      `UPDATE case_services SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params,
      client
    );
  }

  async getServiceStatuses(caseId, client) {
    const result = await this._query(
      'SELECT id, status, provider_id FROM case_services WHERE case_id = $1',
      [caseId],
      client
    );
    return result.rows;
  }

  // ---------------------------------------------------------------- invoice

  async insertInvoice(caseId, client) {
    return this._queryOne(
      'INSERT INTO case_invoices (case_id) VALUES ($1) ON CONFLICT (case_id) DO NOTHING RETURNING *',
      [caseId],
      client
    );
  }

  async lockInvoice(caseId, client) {
    return this._queryOne('SELECT * FROM case_invoices WHERE case_id = $1 FOR UPDATE', [caseId], client);
  }

  async findInvoiceByCase(caseId, client = null) {
    return this._queryOne('SELECT * FROM case_invoices WHERE case_id = $1', [caseId], client);
  }

  async getInvoiceTotals(caseId, invoiceId, client) {
    return this._queryOne(
      `SELECT
         (SELECT COALESCE(SUM(original_price), 0) FROM case_services WHERE case_id = $1 AND status <> 'CANCELLED') AS original_amount,
         (SELECT COALESCE(SUM(bundle_price), 0) FROM case_services WHERE case_id = $1 AND status <> 'CANCELLED') AS items_amount,
         (SELECT COALESCE(SUM(CASE WHEN type = 'SURCHARGE' THEN amount ELSE -amount END), 0)
            FROM invoice_adjustments WHERE invoice_id = $2) AS adjustments_amount,
         (SELECT COALESCE(SUM(amount), 0) FROM case_payment_records
            WHERE invoice_id = $2 AND approval_status = 'APPROVED') AS total_paid`,
      [caseId, invoiceId],
      client
    );
  }

  async writeInvoiceTotals(invoiceId, totals, client) {
    return this._queryOne(
      `UPDATE case_invoices SET
         original_amount = $2,
         final_amount = $3,
         total_paid = $4,
         remaining_amount = $5,
         payment_status = $6::payment_status,
         approved_at = CASE WHEN $6 = 'PAID' THEN COALESCE(approved_at, NOW()) ELSE NULL END,
         approved_by = CASE WHEN $6 = 'PAID' THEN approved_by ELSE NULL END,
         payment_method = CASE WHEN $6 = 'PAID' THEN payment_method ELSE NULL END,
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        invoiceId,
        totals.original_amount,
        totals.final_amount,
        totals.total_paid,
        totals.remaining_amount,
        totals.payment_status,
      ],
      client
    );
  }

  // ---------------------------------------------------------------- lifecycle

  async addLifecycleEvent(data, client) {
    return this._queryOne(
      `INSERT INTO case_lifecycle_events (case_id, case_service_id, actor_id, actor_role, event_type, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        data.case_id,
        data.case_service_id || null,
        data.actor_id || null,
        data.actor_role,
        data.event_type,
        data.notes || null,
      ],
      client
    );
  }

  async listLifecycleEvents(caseId, client = null) {
    const result = await this._query(
      `SELECT id, case_id, case_service_id, actor_id, actor_role, event_type, notes, created_at
       FROM case_lifecycle_events
       WHERE case_id = $1
       ORDER BY created_at ASC`,
      [caseId],
      client
    );
    return result.rows;
  }

  // ---------------------------------------------------------------- appointments

  async insertAppointment(data, client) {
    return this._queryOne(
      `INSERT INTO case_appointments (case_service_id, scheduled_at, type, notes, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [data.case_service_id, data.scheduled_at, data.type, data.notes || null, data.created_by || null],
      client
    );
  }

  async findAppointmentsByCase(caseId, client = null) {
    const result = await this._query(
      `SELECT ca.*, cs.item_name AS service_name, cs.provider_id
       FROM case_appointments ca
       JOIN case_services cs ON cs.id = ca.case_service_id
       WHERE cs.case_id = $1
       ORDER BY ca.scheduled_at ASC`,
      [caseId],
      client
    );
    return result.rows;
  }

  // ---------------------------------------------------------------- provider files

  async insertProviderFile(data, client = null) {
    return this._queryOne(
      `INSERT INTO case_provider_files
        (case_service_id, file_url, file_type, is_sick_leave, uploaded_by, original_name, mime_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, case_service_id, file_type, is_sick_leave, uploaded_by, original_name, mime_type, size_bytes, created_at`,
      [
        data.case_service_id,
        data.file_url,
        data.file_type,
        Boolean(data.is_sick_leave),
        data.uploaded_by,
        data.original_name || null,
        data.mime_type || null,
        data.size_bytes || null,
      ],
      client
    );
  }

  /** File metadata only; the storage key never leaves the backend. */
  async findProviderFilesByCase(caseId, client = null) {
    const result = await this._query(
      `SELECT cpf.id, cpf.case_service_id, cpf.file_type, cpf.is_sick_leave, cpf.uploaded_by,
              cpf.original_name, cpf.mime_type, cpf.size_bytes, cpf.created_at,
              cs.item_name AS service_name, sp.full_name AS provider_name
       FROM case_provider_files cpf
       JOIN case_services cs ON cs.id = cpf.case_service_id
       LEFT JOIN service_providers sp ON sp.id = cpf.uploaded_by
       WHERE cs.case_id = $1
       ORDER BY cpf.created_at DESC`,
      [caseId],
      client
    );
    return result.rows;
  }

  async findProviderFile(caseId, fileId, client = null) {
    return this._queryOne(
      `SELECT cpf.*, cs.case_id, cs.provider_id AS service_provider_id
       FROM case_provider_files cpf
       JOIN case_services cs ON cs.id = cpf.case_service_id
       WHERE cpf.id = $1 AND cs.case_id = $2`,
      [fileId, caseId],
      client
    );
  }

  async deleteProviderFile(fileId, client = null) {
    return this._queryOne('DELETE FROM case_provider_files WHERE id = $1 RETURNING *', [fileId], client);
  }

  // ---------------------------------------------------------------- ratings

  async insertRating(data, client) {
    return this._queryOne(
      `INSERT INTO case_service_ratings (case_service_id, case_id, patient_id, provider_id, rating, comment)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (case_service_id) DO NOTHING
       RETURNING *`,
      [data.case_service_id, data.case_id, data.patient_id, data.provider_id, data.rating, data.comment || null],
      client
    );
  }

  async getProviderRatingSummary(providerId, client = null) {
    return this._queryOne(
      `SELECT COUNT(*)::int AS total_ratings, COALESCE(ROUND(AVG(rating)::numeric, 2), 0) AS average_rating
       FROM case_service_ratings WHERE provider_id = $1`,
      [providerId],
      client
    );
  }

  async listProviderRatings(providerId, { limit, offset }, client = null) {
    const result = await this._query(
      `SELECT r.id, r.case_id, r.case_service_id, r.rating, r.comment, r.created_at,
              cs.item_name AS service_name, p.full_name AS patient_name
       FROM case_service_ratings r
       JOIN case_services cs ON cs.id = r.case_service_id
       LEFT JOIN patients p ON p.id = r.patient_id
       WHERE r.provider_id = $1
       ORDER BY r.created_at DESC
       LIMIT $2 OFFSET $3`,
      [providerId, limit, offset],
      client
    );
    return result.rows;
  }

  // ---------------------------------------------------------------- assignment

  /**
   * Ranks providers for a line item: matching type, covering the case area, preferred type
   * (allowedTypes order, e.g. lab tech before nurse before doctor), online, least busy, best rated.
   */
  async findCandidateProviders({ areaId, allowedTypes, includeAll }, client = null) {
    const result = await this._query(
      `SELECT
         sp.id, sp.full_name, sp.phone, sp.type, sp.avatar_url, sp.is_available,
         (sp.type::text = ANY($2::text[])) AS type_match,
         array_position($2::text[], sp.type::text) AS type_rank,
         ($1::uuid IS NOT NULL AND EXISTS (
           SELECT 1 FROM provider_areas pa WHERE pa.provider_id = sp.id AND pa.area_id = $1
         )) AS covers_area,
         (SELECT COUNT(*)::int FROM case_services open_jobs
          WHERE open_jobs.provider_id = sp.id AND open_jobs.status::text = ANY($3::text[])) AS open_jobs,
         COALESCE(ratings.average_rating, 0) AS average_rating,
         COALESCE(ratings.total_ratings, 0)::int AS total_ratings
       FROM service_providers sp
       LEFT JOIN LATERAL (
         SELECT ROUND(AVG(rating)::numeric, 2) AS average_rating, COUNT(*) AS total_ratings
         FROM case_service_ratings WHERE provider_id = sp.id
       ) ratings ON TRUE
       WHERE sp.deleted_at IS NULL
         AND sp.is_active = TRUE
         AND ($4::boolean OR sp.type::text = ANY($2::text[]))
       ORDER BY type_match DESC, covers_area DESC, type_rank ASC NULLS LAST, sp.is_available DESC, open_jobs ASC,
                average_rating DESC, sp.full_name ASC
       LIMIT 50`,
      [areaId || null, allowedTypes, OPEN_SERVICE_STATUSES, Boolean(includeAll)],
      client
    );
    return result.rows;
  }

  async findAssignableProvider(providerId, client) {
    return this._queryOne(
      `SELECT id, full_name, type, is_active, is_available, deleted_at
       FROM service_providers WHERE id = $1`,
      [providerId],
      client
    );
  }

  // ---------------------------------------------------------------- close / report

  async createSnapshot(data, client) {
    return this._queryOne(
      `INSERT INTO case_snapshots
        (case_id, patient_data, services_data, providers_data, invoice_data, package_data, is_locked, locked_at)
       VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, NULL, TRUE, NOW())
       ON CONFLICT (case_id) DO UPDATE SET
         patient_data = EXCLUDED.patient_data,
         services_data = EXCLUDED.services_data,
         providers_data = EXCLUDED.providers_data,
         invoice_data = EXCLUDED.invoice_data,
         is_locked = TRUE,
         locked_at = NOW(),
         updated_at = NOW(),
         unlocked_by = NULL,
         unlock_reason = NULL
       WHERE case_snapshots.is_locked = FALSE
       RETURNING *`,
      [
        data.case_id,
        JSON.stringify(data.patient_data || null),
        JSON.stringify(data.services_data || []),
        JSON.stringify(data.providers_data || []),
        JSON.stringify(data.invoice_data || null),
      ],
      client
    );
  }

  async ensureMedicalReportRecord(caseId, client = null) {
    return this._queryOne(
      `INSERT INTO medical_reports (case_id, status) VALUES ($1, 'DRAFT')
       ON CONFLICT (case_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [caseId],
      client
    );
  }

  async setInvoiceVisible(caseId, client) {
    await this._query(
      'UPDATE case_invoices SET is_patient_visible = TRUE, updated_at = NOW() WHERE case_id = $1',
      [caseId],
      client
    );
  }

  async incrementPackageOrders(packageIds, client) {
    if (!packageIds.length) return;
    await this._query(
      'UPDATE packages SET times_ordered = COALESCE(times_ordered, 0) + 1 WHERE id = ANY($1::uuid[])',
      [packageIds],
      client
    );
  }
}

module.exports = CaseRepository;
