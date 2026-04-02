const BaseRepository = require('./BaseRepository');

class RequestRepository extends BaseRepository {
  // AUDIT-FIX: P3-DIP — request repository owns service_requests data access.
  constructor(db) {
    // AUDIT-FIX: P3-DIP — db is injected from the composition root.
    super(db, 'service_requests');
    // AUDIT-FIX: P3-DIP — preserve explicit executor reference for optional clients.
    this._db = db;
    // AUDIT-FIX: P3-DIP — cache schema probes used by lab result upserts.
    this._labResultColumnsSupportCache = null;
  }

  // AUDIT-FIX: P3-DIP — execute against an existing transaction client when provided.
  async _exec(sqlOrFn, params = [], client = null) {
    // AUDIT-FIX: P3-DIP — fall back to the injected pool outside transactions.
    const executor = client || this._db;

    // AUDIT-FIX: P3-SRP — support callback style for multi-step repository work.
    if (typeof sqlOrFn === 'function') {
      return sqlOrFn(executor);
    }

    // AUDIT-FIX: P3-DIP — normalize raw query execution behind one method.
    const result = await executor.query(sqlOrFn, params);
    // AUDIT-FIX: P3-DIP — repository callers consume rows consistently.
    return result.rows;
  }

  // AUDIT-FIX: P3-DIP — dedicated helper for single-row repository reads.
  async _execOne(sql, params = [], client = null) {
    // AUDIT-FIX: P3-DIP — keep null semantics consistent with the other repositories.
    const rows = await this._exec(sql, params, client);
    // AUDIT-FIX: P3-DIP — return null when no record matches.
    return rows[0] ?? null;
  }

  // AUDIT-FIX: P3-SRP — schema capability detection lives in the repository.
  async getLabResultColumnsSupport(client = null) {
    // AUDIT-FIX: P3-PERF — reuse one probe result across the process lifetime.
    if (!this._labResultColumnsSupportCache) {
      // AUDIT-FIX: P3-DIP — repository performs the information_schema lookup once.
      this._labResultColumnsSupportCache = (async () => {
        try {
          // AUDIT-FIX: P3-DIP — optional client support keeps metadata checks transaction-safe.
          const rows = await this._exec(
            `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'lab_test_results'
              AND column_name = ANY($1::text[])
            `,
            [['flag', 'matched_range_id', 'condition']],
            client
          );

          // AUDIT-FIX: P3-SRP — convert probe rows to a simple feature map.
          const found = new Set(rows.map((row) => row.column_name));
          // AUDIT-FIX: P3-SRP — repository returns booleans, not raw metadata rows.
          return {
            hasFlag: found.has('flag'),
            hasMatchedRangeId: found.has('matched_range_id'),
            hasCondition: found.has('condition'),
          };
        } catch (_) {
          // AUDIT-FIX: P3-RESILIENCE — preserve the current fail-soft behavior.
          return {
            hasFlag: false,
            hasMatchedRangeId: false,
            hasCondition: false,
          };
        }
      })();
    }

    // AUDIT-FIX: P3-PERF — return the cached schema support map.
    return this._labResultColumnsSupportCache;
  }

  // AUDIT-FIX: P3-SRP — centralize request price lookup across service types.
  async getServicePrice({ serviceType, serviceId, labTestId, labPanelId, labPackageId, packageId }, client = null) {
    // AUDIT-FIX: P3-DIP — medical and radiology services read from services.
    if (['MEDICAL', 'RADIOLOGY'].includes(serviceType)) {
      // AUDIT-FIX: P3-DIP — use the injected executor rather than pool directly.
      const row = await this._execOne(
        'SELECT price FROM services WHERE id = $1',
        [serviceId],
        client
      );
      // AUDIT-FIX: P3-SRP — repository returns a numeric-like price only.
      return row?.price || 0;
    }

    // AUDIT-FIX: P3-DIP — lab pricing comes from lab_tests.
    if (serviceType === 'LAB') {
      if (labTestId) {
        const row = await this._execOne(
          'SELECT cost FROM lab_tests WHERE id = $1',
          [labTestId],
          client
        );
        return row?.cost || 0;
      }

      if (labPanelId) {
        const row = await this._execOne(
          'SELECT price FROM lab_panels WHERE id = $1',
          [labPanelId],
          client
        );
        return row?.price || 0;
      }

      if (labPackageId) {
        const row = await this._execOne(
          'SELECT price FROM lab_packages WHERE id = $1',
          [labPackageId],
          client
        );
        return row?.price || 0;
      }

      // AUDIT-FIX: P3-DIP — keep the query behind the repository boundary.
      return 0;
    }

    // AUDIT-FIX: P3-DIP — package pricing comes from packages.
    if (serviceType === 'PACKAGE') {
      // AUDIT-FIX: P3-DIP — keep package price access repository-owned.
      const row = await this._execOne(
        'SELECT total_cost FROM packages WHERE id = $1',
        [packageId],
        client
      );
      // AUDIT-FIX: P3-SRP — return zero when the package record is missing.
      return row?.total_cost || 0;
    }

    // AUDIT-FIX: P3-SRP — unknown service types cost zero by default.
    return 0;
  }

  // AUDIT-FIX: P3-SRP — patient snapshot context lookup belongs in the repository.
  async getPatientContextByRequestId(requestId, client = null) {
    // AUDIT-FIX: P3-DIP — optional client keeps reads inside the caller transaction.
    return this._execOne(
      `
      SELECT
        p.id,
        p.gender,
        p.date_of_birth,
        sr.request_type,
        sr.guest_gender,
        sr.guest_age
      FROM service_requests sr
      LEFT JOIN patients p ON p.id = sr.patient_id
      WHERE sr.id = $1
      LIMIT 1
      `,
      [requestId],
      client
    );
  }

  // AUDIT-FIX: P3-SRP — reusable request list query with role-scoped filters.
  async findAll(
    { status, patientId, assignedProviderId, providerScopeId, search } = {},
    { limit, offset } = {},
    client = null
  ) {
    // AUDIT-FIX: P3-DIP — build the query once in the repository instead of the service.
    const params = [];
    // AUDIT-FIX: P3-SRP — keep request list filter assembly in one place.
    let whereSql = 'WHERE 1=1';

    // AUDIT-FIX: P3-SRP — status filtering stays declarative here.
    if (status) {
      params.push(status);
      whereSql += ` AND sr.status = $${params.length}`;
    }

    // AUDIT-FIX: P3-SRP — patient filter is optional and role-driven.
    if (patientId) {
      params.push(patientId);
      whereSql += ` AND sr.patient_id = $${params.length}`;
    }

    // AUDIT-FIX: P3-SRP — direct assignment filtering is centralized.
    if (assignedProviderId) {
      params.push(assignedProviderId);
      whereSql += ` AND sr.assigned_provider_id = $${params.length}`;
    }

    // AUDIT-FIX: P3-SRP — provider scope logic is reused by provider-facing queries.
    if (providerScopeId) {
      params.push(providerScopeId);
      whereSql += ` AND (
        sr.assigned_provider_id = $${params.length}
        OR sr.lead_provider_id = $${params.length}
        OR EXISTS (
          SELECT 1
          FROM request_workflow_tasks rwt
          WHERE rwt.request_id = sr.id
            AND rwt.provider_id = $${params.length}
            AND rwt.status <> 'CANCELLED'
        )
      )`;
    }

    // AUDIT-FIX: P3-SRP — text search is encapsulated with the join it needs.
    if (search) {
      params.push(`%${search}%`);
      whereSql += ` AND (
        COALESCE(sr.patient_full_name_snapshot, p.full_name, sr.guest_name) ILIKE $${params.length}
        OR COALESCE(sr.service_name_snapshot, '') ILIKE $${params.length}
      )`;
    }

    // AUDIT-FIX: P3-DIP — count and list run with the same predicate.
    const countRow = await this._execOne(
      `
      SELECT COUNT(*)::int AS total
      FROM service_requests sr
      LEFT JOIN patients p ON sr.patient_id = p.id
      ${whereSql}
      `,
      params,
      client
    );

    // AUDIT-FIX: P3-DIP — append pagination only after the shared filter params.
    const dataParams = [...params, limit, offset];
    // AUDIT-FIX: P3-SRP — presentational joins live in the repository, not the service.
    const data = await this._exec(
      `
      SELECT sr.*,
             COALESCE(sr.patient_full_name_snapshot, p.full_name, sr.guest_name) AS patient_name,
             COALESCE(sr.patient_phone_snapshot, p.phone, sr.guest_phone) AS patient_phone,
             COALESCE(sr.assigned_provider_name_snapshot, sp.full_name) AS provider_name,
             COALESCE(sr.assigned_provider_type_snapshot, sp.type::text) AS provider_type,
             i.original_amount, i.final_amount, i.payment_status
      FROM service_requests sr
      LEFT JOIN patients p ON sr.patient_id = p.id
      LEFT JOIN service_providers sp ON sr.assigned_provider_id = sp.id
      LEFT JOIN invoices i ON sr.id = i.request_id
      ${whereSql}
      ORDER BY sr.created_at DESC
      LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}
      `,
      dataParams,
      client
    );

    // AUDIT-FIX: P3-SRP — repository returns list data with the total count together.
    return {
      data,
      total: countRow?.total || 0,
    };
  }

  // AUDIT-FIX: P3-SRP — detailed request reads with joins are centralized here.
  async findById(id, { includeBilling = true } = {}, client = null) {
    // AUDIT-FIX: P3-DIP — optional billing join keeps one method flexible.
    const billingSelect = includeBilling
      ? `
        i.id AS invoice_id,
        i.original_amount,
        i.vip_discount_amount,
        i.coupon_id,
        i.coupon_discount_amount,
        i.coupon_code_snapshot, -- FEAT: COUPON — expose the persisted invoice coupon code in request detail responses.
        i.points_used,
        i.points_discount_amount,
        i.final_amount,
        i.total_paid,
        i.remaining_amount,
        i.payment_status,
        i.payment_status_detail,
        i.payment_method,
        i.paid_at
      `
      : `
        NULL::uuid AS invoice_id,
        NULL::numeric AS original_amount,
        NULL::numeric AS vip_discount_amount,
        NULL::uuid AS coupon_id,
        NULL::numeric AS coupon_discount_amount,
        NULL::text AS coupon_code_snapshot, -- FEAT: COUPON — preserve the request detail shape when billing is excluded.
        NULL::int AS points_used,
        NULL::numeric AS points_discount_amount,
        NULL::numeric AS final_amount,
        NULL::numeric AS total_paid,
        NULL::numeric AS remaining_amount,
        NULL::text AS payment_status,
        NULL::text AS payment_status_detail,
        NULL::text AS payment_method,
        NULL::timestamptz AS paid_at
      `;

    // AUDIT-FIX: P3-DIP — service consumers no longer need to assemble this join graph.
    return this._execOne(
      `
      SELECT
        sr.*,
        COALESCE(sr.patient_full_name_snapshot, p.full_name, sr.guest_name) AS patient_name,
        COALESCE(sr.patient_phone_snapshot, p.phone, sr.guest_phone) AS patient_phone,
        COALESCE(sr.patient_email_snapshot, p.email) AS patient_email,
        COALESCE(sr.patient_address_snapshot, p.address, sr.guest_address) AS patient_address,
        COALESCE(sr.patient_gender_snapshot, p.gender, sr.guest_gender) AS patient_gender,
        COALESCE(sr.patient_date_of_birth_snapshot, p.date_of_birth) AS patient_date_of_birth,
        p.is_vip,
        COALESCE(sr.assigned_provider_name_snapshot, sp.full_name) AS provider_name,
        COALESCE(sr.assigned_provider_type_snapshot, sp.type::text) AS provider_type,
        COALESCE(sr.service_name_snapshot, svc.name, lt.name, lp.name_en, lpk.name_en, pk.name) AS service_name,
        COALESCE(sr.service_price_snapshot, svc.price, lt.cost, lp.price, lpk.price, pk.total_cost) AS service_price,
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
        lp.name_en AS lab_panel_name,
        lpk.name_en AS lab_package_name,
        ${billingSelect}
      FROM service_requests sr
      LEFT JOIN patients p ON sr.patient_id = p.id
      LEFT JOIN service_providers sp ON sr.assigned_provider_id = sp.id
      LEFT JOIN services svc ON svc.id = sr.service_id
      LEFT JOIN lab_tests lt ON lt.id = sr.lab_test_id
      LEFT JOIN lab_panels lp ON lp.id = sr.lab_panel_id
      LEFT JOIN lab_packages lpk ON lpk.id = sr.lab_package_id
      LEFT JOIN packages pk ON pk.id = sr.package_id
      LEFT JOIN service_categories svc_cat ON svc.category_id = svc_cat.id
      LEFT JOIN service_categories lt_cat ON lt.category_id = lt_cat.id
      LEFT JOIN service_categories pk_cat ON pk.category_id = pk_cat.id
      LEFT JOIN invoices i ON sr.id = i.request_id
      WHERE sr.id = $1
      `,
      [id],
      client
    );
  }

  // AUDIT-FIX: P3-SRP — request creation insert lives in one repository method.
  async create(data, client = null) {
    // AUDIT-FIX: P3-DIP — service passes normalized values, repository handles the insert.
    return this._execOne(
      `
      INSERT INTO service_requests
        (request_type, patient_id, guest_name, guest_phone, guest_address,
         service_type, service_id, lab_test_id, lab_panel_id, lab_package_id, package_id, notes, requested_at,
         patient_full_name_snapshot, patient_phone_snapshot, patient_email_snapshot,
         patient_address_snapshot, patient_gender_snapshot, patient_date_of_birth_snapshot,
         patient_age_snapshot, service_name_snapshot, service_description_snapshot,
         service_category_name_snapshot, service_price_snapshot, package_components_snapshot,
         coupon_id, coupon_code, coupon_discount_amount)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
      RETURNING *
      `,
      [
        data.request_type,
        data.patient_id || null,
        data.guest_name,
        data.guest_phone,
        data.guest_address,
        data.service_type,
        data.service_id || null,
        data.lab_test_id || null,
        data.lab_panel_id || null,
        data.lab_package_id || null,
        data.package_id || null,
        data.notes,
        data.requested_at || null,
        data.patient_full_name_snapshot || null,
        data.patient_phone_snapshot || null,
        data.patient_email_snapshot || null,
        data.patient_address_snapshot || null,
        data.patient_gender_snapshot || null,
        data.patient_date_of_birth_snapshot || null,
        data.patient_age_snapshot ?? null,
        data.service_name_snapshot || null,
        data.service_description_snapshot || null,
        data.service_category_name_snapshot || null,
        data.service_price_snapshot ?? null,
        data.package_components_snapshot || null,
        data.coupon_id || null,
        data.coupon_code || null,
        data.coupon_discount_amount ?? 0,
      ],
      client
    );
  }

  // AUDIT-FIX: P3-SRP — refresh the request snapshot columns through one repository write.
  async attachSnapshot(id, snapshotPayload, client = null) {
    // AUDIT-FIX: P3-DIP — callers provide normalized snapshot data only.
    return this._execOne(
      `
      UPDATE service_requests
      SET patient_full_name_snapshot = $2,
          patient_phone_snapshot = $3,
          patient_email_snapshot = $4,
          patient_address_snapshot = $5,
          patient_gender_snapshot = $6,
          patient_date_of_birth_snapshot = $7,
          patient_age_snapshot = $8,
          service_name_snapshot = $9,
          service_description_snapshot = $10,
          service_category_name_snapshot = $11,
          service_price_snapshot = $12,
          package_components_snapshot = $13,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [
        id,
        snapshotPayload.patient_full_name_snapshot || null,
        snapshotPayload.patient_phone_snapshot || null,
        snapshotPayload.patient_email_snapshot || null,
        snapshotPayload.patient_address_snapshot || null,
        snapshotPayload.patient_gender_snapshot || null,
        snapshotPayload.patient_date_of_birth_snapshot || null,
        snapshotPayload.patient_age_snapshot ?? null,
        snapshotPayload.service_name_snapshot || null,
        snapshotPayload.service_description_snapshot || null,
        snapshotPayload.service_category_name_snapshot || null,
        snapshotPayload.service_price_snapshot ?? null,
        snapshotPayload.package_components_snapshot || null,
      ],
      client
    );
  }

  // AUDIT-FIX: P3-SRP — status transitions use one repository update method.
  async updateStatus(id, status, client = null) {
    // AUDIT-FIX: P3-DIP — service orchestration passes only the target state.
    return this._execOne(
      `
      UPDATE service_requests
      SET status = $2,
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [id, status],
      client
    );
  }

  // AUDIT-FIX: P3-SRP — provider assignment update is centralized.
  async assignProvider(id, providerId, client = null) {
    // AUDIT-FIX: P3-DIP — caller does not hand-build provider assignment SQL anymore.
    return this._execOne(
      `
      UPDATE service_requests
      SET assigned_provider_id = $2,
          status = 'ASSIGNED',
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [id, providerId],
      client
    );
  }

  // AUDIT-FIX: P3-SRP — lock-oriented status updates stay repository-owned.
  async lockCoreById(id, client = null) {
    // AUDIT-FIX: P3-DIP — callers can participate in an existing transaction.
    return this._execOne(
      `
      SELECT id, patient_id, status, service_type, assigned_provider_id, lead_provider_id,
             workflow_stage, final_report_confirmed_at, in_progress_at
      FROM service_requests
      WHERE id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [id],
      client
    );
  }

  // AUDIT-FIX: P3-SRP — read-only core request shape is reused by the workflow layer.
  async getCoreById(id, client = null) {
    // AUDIT-FIX: P3-DIP — repository exposes a minimal request shape for orchestration.
    return this._execOne(
      `
      SELECT id, patient_id, status, service_type, assigned_provider_id, lead_provider_id,
             workflow_stage, final_report_confirmed_at, in_progress_at
      FROM service_requests
      WHERE id = $1
      LIMIT 1
      `,
      [id],
      client
    );
  }

  // AUDIT-FIX: P3-SRP — lab result fetches are centralized for request details.
  async getLabResultsByRequestId(requestId, client = null) {
    // AUDIT-FIX: P3-DIP — request detail builders no longer embed this join.
    return this._exec(
      `
      SELECT ltr.*, lt.name AS test_name, lt.unit, lt.reference_range
      FROM lab_test_results ltr
      JOIN lab_tests lt ON ltr.lab_test_id = lt.id
      WHERE ltr.request_id = $1
      `,
      [requestId],
      client
    );
  }

  // AUDIT-FIX: P3-SRP — reevaluation reads for existing lab results are centralized.
  async getLabResultsForReevaluation(requestId, { includeCondition } = {}, client = null) {
    // AUDIT-FIX: P3-DIP — repository adapts the optional condition column internally.
    const conditionSelect = includeCondition ? 'condition' : 'NULL::text AS condition';
    return this._exec(
      `
      SELECT
        lab_test_id,
        result,
        is_normal,
        notes,
        entered_by,
        ${conditionSelect}
      FROM lab_test_results
      WHERE request_id = $1
      `,
      [requestId],
      client
    ); // AUDIT-FIX: P3-COMPAT - preserve the existing reevaluation row shape.
  }

  // AUDIT-FIX: P3-SRP — single lab-result reads for edit flows are centralized.
  async getExistingLabResult(resultId, requestId, { includeCondition } = {}, client = null) {
    // AUDIT-FIX: P3-DIP — repository adapts the optional condition column internally.
    const conditionSelect = includeCondition ? 'ltr.condition' : 'NULL::text AS condition';
    return this._execOne(
      `
      SELECT
        ltr.id,
        ltr.request_id,
        ltr.lab_test_id,
        ltr.result,
        ltr.is_normal,
        ltr.notes,
        ${conditionSelect}
      FROM lab_test_results ltr
      WHERE ltr.id = $1 AND ltr.request_id = $2
      LIMIT 1
      `,
      [resultId, requestId],
      client
    ); // AUDIT-FIX: P3-COMPAT - preserve the existing lab-result edit lookup shape.
  }

  // AUDIT-FIX: P3-SRP — package workflow components are read through one repository method.
  async getPackageWorkflowComponents(packageId, client = null) {
    // AUDIT-FIX: P3-DIP — use one executor for both package component queries.
    const executor = client || this._db;

    // AUDIT-FIX: P3-PERF — fetch tests and services concurrently.
    const [testsResult, servicesResult] = await Promise.all([
      executor.query(
        `
        SELECT lt.id, lt.name, lt.cost, lt.unit, lt.reference_range
        FROM package_tests pt
        JOIN lab_tests lt ON lt.id = pt.lab_test_id
        WHERE pt.package_id = $1
        ORDER BY lt.name ASC
        `,
        [packageId]
      ),
      executor.query(
        `
        SELECT s.id, s.name, s.price, s.description, c.name AS category_name
        FROM package_services ps
        JOIN services s ON s.id = ps.service_id
        LEFT JOIN service_categories c ON c.id = s.category_id
        WHERE ps.package_id = $1
        ORDER BY s.name ASC
        `,
        [packageId]
      ),
    ]);

    // AUDIT-FIX: P3-SRP — repository returns both component arrays in one object.
    return {
      tests: testsResult.rows,
      services: servicesResult.rows,
    };
  }

  // AUDIT-FIX: P3-SRP — request state checks for publishing are centralized.
  async getPublishableRequestState(requestId, client = null) {
    return this._execOne(
      `
      SELECT
        sr.status,
        sr.lead_provider_id,
        sr.final_report_confirmed_at,
        sp.type AS lead_provider_type
      FROM service_requests sr
      LEFT JOIN service_providers sp ON sp.id = sr.lead_provider_id
      WHERE sr.id = $1
      LIMIT 1
      `,
      [requestId],
      client
    ); // AUDIT-FIX: P3-COMPAT - preserve the current publish precondition lookup shape.
  }

  // AUDIT-FIX: P3-SRP — report status reads for requests are centralized.
  async getReportStatus(requestId, client = null) {
    return this._execOne(
      `
      SELECT mr.*, a.full_name AS reviewed_by_name
      FROM medical_reports mr
      LEFT JOIN admins a ON a.id = mr.reviewed_by
      WHERE mr.request_id = $1
      `,
      [requestId],
      client
    ); // AUDIT-FIX: P3-COMPAT - preserve the existing report status response shape.
  }

  // AUDIT-FIX: P3-SRP — medical report draft touch is reused by lab result writes.
  async touchMedicalReportDraft(requestId, client = null) {
    // AUDIT-FIX: P3-DIP — keep the upsert out of the service layer.
    await this._exec(
      `
      INSERT INTO medical_reports (request_id, status)
      VALUES ($1, 'DRAFT')
      ON CONFLICT (request_id)
      DO UPDATE SET
        status = 'DRAFT',
        reviewed_by = NULL,
        reviewed_at = NULL,
        published_at = NULL,
        updated_at = NOW()
      RETURNING request_id
      `,
      [requestId],
      client
    );
  }

  // AUDIT-FIX: P3-SRP — lab result upsert is a reusable repository primitive.
  async upsertLabResultRow(payload, client = null) {
    // AUDIT-FIX: P3-DIP — repository adapts to optional lab result columns internally.
    const support = await this.getLabResultColumnsSupport(client);

    // AUDIT-FIX: P3-DIP — use the extended write when the optional columns exist.
    if (support.hasFlag && support.hasMatchedRangeId && support.hasCondition) {
      return this._execOne(
        `
        INSERT INTO lab_test_results (
          request_id, lab_test_id, result, is_normal, notes, entered_by,
          flag, matched_range_id, condition
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (request_id, lab_test_id)
        DO UPDATE SET
          result = EXCLUDED.result,
          is_normal = EXCLUDED.is_normal,
          notes = EXCLUDED.notes,
          entered_by = EXCLUDED.entered_by,
          flag = EXCLUDED.flag,
          matched_range_id = EXCLUDED.matched_range_id,
          condition = EXCLUDED.condition
        RETURNING *
        `,
        [
          payload.requestId,
          payload.lab_test_id,
          payload.result,
          payload.is_normal,
          payload.notes,
          payload.entered_by,
          payload.flag,
          payload.matchedRangeId,
          payload.condition,
        ],
        client
      );
    }

    // AUDIT-FIX: P3-COMPAT — fall back to the legacy column set when needed.
    return this._execOne(
      `
      INSERT INTO lab_test_results (request_id, lab_test_id, result, is_normal, notes, entered_by)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (request_id, lab_test_id)
      DO UPDATE SET
        result = EXCLUDED.result,
        is_normal = EXCLUDED.is_normal,
        notes = EXCLUDED.notes,
        entered_by = EXCLUDED.entered_by
      RETURNING *
      `,
      [
        payload.requestId,
        payload.lab_test_id,
        payload.result,
        payload.is_normal,
        payload.notes,
        payload.entered_by,
      ],
      client
    );
  }

  // AUDIT-FIX: P3-SRP — provider rating list/count queries stay in the repository.
  async getProviderRatingsSummary(providerId, client = null) {
    // AUDIT-FIX: P3-DIP — repository owns the join between ratings and requests.
    return this._execOne(
      `
      SELECT
        COUNT(sr.id)::int AS total_ratings,
        COALESCE(ROUND(AVG(sr.rating)::numeric, 2), 0) AS average_rating
      FROM service_ratings sr
      JOIN service_requests req ON req.id = sr.request_id
      WHERE req.assigned_provider_id = $1
      `,
      [providerId],
      client
    );
  }

  // AUDIT-FIX: P3-SRP — provider rating count is reused by pagination responses.
  async getProviderRatingsCount(providerId, client = null) {
    // AUDIT-FIX: P3-DIP — keep count SQL outside the controller/service.
    const row = await this._execOne(
      `
      SELECT COUNT(sr.id)::int AS total
      FROM service_ratings sr
      JOIN service_requests req ON req.id = sr.request_id
      WHERE req.assigned_provider_id = $1
      `,
      [providerId],
      client
    );
    // AUDIT-FIX: P3-SRP — return only the numeric total.
    return row?.total || 0;
  }

  // AUDIT-FIX: P3-SRP — provider ratings list query is centralized.
  async getProviderRatings(providerId, limit, offset, client = null) {
    // AUDIT-FIX: P3-DIP — pagination is handled at the repository boundary.
    return this._exec(
      `
      SELECT
        sr.id,
        sr.request_id,
        sr.patient_id,
        sr.rating,
        sr.comment,
        sr.created_at,
        p.full_name AS patient_name
      FROM service_ratings sr
      JOIN service_requests req ON req.id = sr.request_id
      LEFT JOIN patients p ON p.id = sr.patient_id
      WHERE req.assigned_provider_id = $1
      ORDER BY sr.created_at DESC
      LIMIT $2 OFFSET $3
      `,
      [providerId, limit, offset],
      client
    );
  }

  // AUDIT-FIX: P3-SRP — request existence checks live in the repository.
  async existsById(id, client = null) {
    // AUDIT-FIX: P3-DIP — repository uses a cheap id-only existence lookup.
    const row = await this._execOne(
      'SELECT id FROM service_requests WHERE id = $1',
      [id],
      client
    );
    // AUDIT-FIX: P3-SRP — return a boolean to the caller.
    return Boolean(row);
  }

  async getRequestDeletionAssets(requestId, client = null) {
    const rows = await this._exec(
      `
      WITH asset_refs AS (
        SELECT file_path AS asset_ref
        FROM request_files
        WHERE request_id = $1

        UNION ALL

        SELECT image_url AS asset_ref
        FROM request_provider_reports
        WHERE request_id = $1

        UNION ALL

        SELECT pdf_report_url AS asset_ref
        FROM request_provider_reports
        WHERE request_id = $1

        UNION ALL

        SELECT mr.pdf_url AS asset_ref
        FROM medical_reports mr
        WHERE mr.request_id = $1

        UNION ALL

        SELECT i.pdf_url AS asset_ref
        FROM invoices i
        WHERE i.request_id = $1

        UNION ALL

        SELECT rcm.file_url AS asset_ref
        FROM request_chat_messages rcm
        JOIN request_chat_rooms rcr ON rcr.id = rcm.room_id
        WHERE rcr.request_id = $1
      )
      SELECT DISTINCT asset_ref
      FROM asset_refs
      WHERE asset_ref IS NOT NULL
        AND BTRIM(asset_ref) <> ''
      `,
      [requestId],
      client
    );

    return rows.map((row) => row.asset_ref).filter(Boolean);
  }

  async getRequestDeletionContext(requestId, client = null) {
    return this._execOne(
      `
      SELECT
        sr.id,
        sr.patient_id,
        sr.status,
        sr.service_type,
        sr.package_id,
        sr.coupon_id,
        COALESCE((
          SELECT SUM(points)::int
          FROM points_log
          WHERE request_id = sr.id
        ), 0) AS points_net_effect
      FROM service_requests sr
      WHERE sr.id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [requestId],
      client
    );
  }

  async deletePointsLogsByRequestId(requestId, client = null) {
    await this._exec(
      'DELETE FROM points_log WHERE request_id = $1',
      [requestId],
      client
    );
  }

  async deleteInvoicesByRequestId(requestId, client = null) {
    await this._exec(
      'DELETE FROM invoices WHERE request_id = $1',
      [requestId],
      client
    );
  }

  // AUDIT-FIX: P3-SRP — file attachment inserts are centralized.
  async saveRequestFiles({ requestId, uploadedBy, uploaderRole, files }, client = null) {
    // AUDIT-FIX: P3-DIP — execute file inserts against the provided transaction when available.
    const executor = client || this._db;
    // AUDIT-FIX: P3-SRP — collect inserted rows for the HTTP response in one place.
    const insertedFiles = [];

    // AUDIT-FIX: P3-SRP — each uploaded file becomes one request_files row.
    for (const file of files) {
      // AUDIT-FIX: P3-COMPAT — normalize Windows paths the same way the current service does.
      const filePath = String(file.path || '').replace(/\\/g, '/');
      // AUDIT-FIX: P3-DIP — insert through the repository executor instead of the service.
      const result = await executor.query(
        `
        INSERT INTO request_files (
          request_id,
          uploaded_by,
          uploader_role,
          original_name,
          mime_type,
          size_bytes,
          file_path
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
        `,
        [
          requestId,
          uploadedBy,
          uploaderRole,
          file.originalname,
          file.mimetype,
          file.size,
          filePath,
        ]
      );
      // AUDIT-FIX: P3-SRP — preserve the existing response shape exactly.
      insertedFiles.push(result.rows[0]);
    }

    // AUDIT-FIX: P3-SRP — return all inserted request file rows together.
    return insertedFiles;
  }

  // AUDIT-FIX: P3-SRP — rating precondition reads are centralized.
  async getRequestForRating(id, client = null) {
    // AUDIT-FIX: P3-DIP — the service/controller no longer needs inline SQL here.
    return this._execOne(
      `
      SELECT id, patient_id, status
      FROM service_requests
      WHERE id = $1
      `,
      [id],
      client
    );
  }

  // AUDIT-FIX: P3-SRP — request rating existence check is centralized.
  async getRequestRating(id, client = null) {
    // AUDIT-FIX: P3-DIP — repository returns the existing rating row when present.
    return this._execOne(
      'SELECT id FROM service_ratings WHERE request_id = $1 LIMIT 1',
      [id],
      client
    );
  }

  // AUDIT-FIX: P3-SRP — request rating insert lives in the repository.
  async createRequestRating({ requestId, patientId, rating, comment }, client = null) {
    // AUDIT-FIX: P3-DIP — services submit data, repository owns the insert.
    return this._execOne(
      `
      INSERT INTO service_ratings (request_id, patient_id, rating, comment)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [requestId, patientId, rating, comment || null],
      client
    );
  }

  // AUDIT-FIX: P3-SRP — provider lookup for request-facing endpoints is centralized.
  async getProviderById(id, client = null) {
    // AUDIT-FIX: P3-DIP — use the repository for the provider identity read.
    return this._execOne(
      'SELECT id, full_name, type FROM service_providers WHERE id = $1',
      [id],
      client
    );
  }

  // AUDIT-FIX: P3-SRP — invoice lookup by request is reused by billing flows.
  async getInvoiceForRequest(requestId, client = null) {
    // AUDIT-FIX: P3-DIP — keep request billing access inside the repository.
    return this._execOne(
      `
      SELECT id, final_amount, total_paid, remaining_amount, payment_status, is_patient_visible
      FROM invoices
      WHERE request_id = $1
      LIMIT 1
      `,
      [requestId],
      client
    );
  }

  // AUDIT-FIX: P3-SRP — medical report record upsert is centralized.
  async ensureMedicalReportRecord(requestId, client = null) {
    // AUDIT-FIX: P3-DIP — repository owns the upsert into medical_reports.
    return this._execOne(
      `
      INSERT INTO medical_reports (request_id)
      VALUES ($1)
      ON CONFLICT (request_id) DO UPDATE SET updated_at = NOW()
      RETURNING *
      `,
      [requestId],
      client
    );
  }
  // AUDIT-FIX: P3-STEP7B-DIP - provider-report locking reads move behind the request repository.
  async getLatestProviderReportForUpdate(requestId, providerId, client = null) {
    return this._execOne(
      `
      SELECT *
      FROM request_provider_reports
      WHERE request_id = $1
        AND provider_id = $2
      ORDER BY updated_at DESC, version DESC
      LIMIT 1
      FOR UPDATE
      `,
      [requestId, providerId],
      client
    );
  }

  // AUDIT-FIX: P3-STEP7B-DIP - final-report locking reads move behind the request repository.
  async getLatestFinalProviderReportForUpdate(requestId, providerId, client = null) {
    return this._execOne(
      `
      SELECT *
      FROM request_provider_reports
      WHERE request_id = $1
        AND provider_id = $2
        AND report_type = 'FINAL_REPORT'
      ORDER BY version DESC, updated_at DESC
      LIMIT 1
      FOR UPDATE
      `,
      [requestId, providerId],
      client
    );
  }

  // AUDIT-FIX: P3-STEP7B-DIP - request-level final-report locking reads move behind the request repository.
  async getLatestFinalReportForUpdate(requestId, client = null) {
    return this._execOne(
      `
      SELECT *
      FROM request_provider_reports
      WHERE request_id = $1
        AND report_type = 'FINAL_REPORT'
      ORDER BY version DESC, updated_at DESC
      LIMIT 1
      FOR UPDATE
      `,
      [requestId],
      client
    );
  }

  // AUDIT-FIX: P3-STEP7B-DIP - close-request final-report selection moves behind the repository.
  async getFinalReportForClose(requestId, client = null) {
    return this._execOne(
      `
      SELECT *
      FROM request_provider_reports
      WHERE request_id = $1
        AND report_type = 'FINAL_REPORT'
      ORDER BY
        CASE
          WHEN status IN ('APPROVED', 'SUBMITTED', 'DRAFT') THEN 0
          ELSE 1
        END,
        version DESC,
        updated_at DESC
      LIMIT 1
      FOR UPDATE
      `,
      [requestId],
      client
    );
  }

  // AUDIT-FIX: P3-STEP7B-DIP - source-report selection for admin confirmation moves behind the repository.
  async getPreferredSourceReportForConfirmation(requestId, preferredProviderId, client = null) {
    return this._execOne(
      `
      SELECT *
      FROM request_provider_reports
      WHERE request_id = $1
      ORDER BY
        CASE
          WHEN $2::uuid IS NOT NULL AND provider_id = $2::uuid THEN 0
          ELSE 1
        END,
        CASE
          WHEN status IN ('SUBMITTED', 'APPROVED') THEN 0
          ELSE 1
        END,
        updated_at DESC,
        version DESC
      LIMIT 1
      FOR UPDATE
      `,
      [requestId, preferredProviderId],
      client
    );
  }

  // AUDIT-FIX: P3-STEP7B-DIP - source-report selection for request closure moves behind the repository.
  async getPreferredSourceReportForClose(requestId, preferredProviderId, client = null) {
    return this._execOne(
      `
      SELECT *
      FROM request_provider_reports
      WHERE request_id = $1
      ORDER BY
        CASE
          WHEN $2::uuid IS NOT NULL AND provider_id = $2::uuid THEN 0
          ELSE 1
        END,
        CASE
          WHEN status IN ('APPROVED', 'SUBMITTED', 'DRAFT') THEN 0
          ELSE 1
        END,
        updated_at DESC,
        version DESC
      LIMIT 1
      FOR UPDATE
      `,
      [requestId, preferredProviderId],
      client
    );
  }

  // AUDIT-FIX: P3-STEP7B-DIP - final-report cloning now goes through the repository.
  async cloneReportToFinalReport(sourceReport, fallbackServiceType, providerSnapshot = {}, client = null) {
    return this._execOne(
      `
      INSERT INTO request_provider_reports (
        request_id, provider_id, task_id, report_type, status,
        symptoms_summary, procedures_performed, allergies_noted,
        findings, diagnosis, recommendations, treatment_plan, notes,
        service_type, lab_notes, imaging_notes, image_url, pdf_report_url,
        procedures_done, patient_allergies, nurse_notes, version,
        provider_name_snapshot, provider_phone_snapshot, provider_type_snapshot
      )
      VALUES ($1,$2,NULL,'FINAL_REPORT',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,1,$20,$21,$22)
      RETURNING *
      `,
      [
        sourceReport.request_id,
        sourceReport.provider_id,
        sourceReport.status === 'APPROVED' ? 'APPROVED' : 'SUBMITTED',
        sourceReport.symptoms_summary || null,
        sourceReport.procedures_performed || null,
        sourceReport.allergies_noted || null,
        sourceReport.findings || null,
        sourceReport.diagnosis || null,
        sourceReport.recommendations || null,
        sourceReport.treatment_plan || null,
        sourceReport.notes || null,
        sourceReport.service_type || fallbackServiceType,
        sourceReport.lab_notes || null,
        sourceReport.imaging_notes || null,
        sourceReport.image_url || null,
        sourceReport.pdf_report_url || null,
        sourceReport.procedures_done || null,
        sourceReport.patient_allergies || null,
        sourceReport.nurse_notes || null,
        sourceReport.provider_name_snapshot || providerSnapshot.full_name || null,
        sourceReport.provider_phone_snapshot || providerSnapshot.phone || null,
        sourceReport.provider_type_snapshot || providerSnapshot.type || null,
      ],
      client
    );
  }

  // AUDIT-FIX: P3-STEP7B-DIP - draft-report submission updates move behind the repository.
  async submitDraftReport(reportId, { touchSubmittedAt = false } = {}, client = null) {
    const submittedAtSql = touchSubmittedAt
      ? "submitted_at = COALESCE(submitted_at, NOW()),"
      : '';
    return this._execOne(
      `
      UPDATE request_provider_reports
      SET status = 'SUBMITTED',
          ${submittedAtSql}
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [reportId],
      client
    );
  }

  // AUDIT-FIX: P3-STEP7B-DIP - lab-result existence checks move behind the repository.
  async countLabResultsByRequest(requestId, client = null) {
    const row = await this._execOne(
      'SELECT COUNT(*)::int AS count FROM lab_test_results WHERE request_id = $1',
      [requestId],
      client
    );
    return row?.count || 0;
  }

  // AUDIT-FIX: P3-STEP7B-DIP - request-start writes move behind the repository.
  async markRequestStarted(requestId, client = null) {
    return this._execOne(
      `
      UPDATE service_requests
      SET status = 'IN_PROGRESS',
          workflow_stage = 'IN_PROGRESS',
          in_progress_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [requestId],
      client
    );
  }

  // AUDIT-FIX: P3-STEP7B-DIP - provider task start updates move behind the repository.
  async markProviderTasksInProgress(requestId, providerId, client = null) {
    await this._exec(
      `
      UPDATE request_workflow_tasks
      SET status = 'IN_PROGRESS',
          accepted_at = COALESCE(accepted_at, NOW()),
          updated_at = NOW()
      WHERE request_id = $1
        AND provider_id = $2
        AND status IN ('ASSIGNED', 'ACCEPTED')
      `,
      [requestId, providerId],
      client
    );
  }

  // AUDIT-FIX: P3-STEP7B-DIP - provider task completion updates move behind the repository.
  async markProviderTasksCompleted(requestId, providerId, client = null) {
    await this._exec(
      `
      UPDATE request_workflow_tasks
      SET status = 'COMPLETED',
          submitted_at = COALESCE(submitted_at, NOW()),
          completed_at = COALESCE(completed_at, NOW()),
          updated_at = NOW()
      WHERE request_id = $1
        AND provider_id = $2
        AND status NOT IN ('COMPLETED', 'CANCELLED')
      `,
      [requestId, providerId],
      client
    );
  }

  // AUDIT-FIX: P3-STEP7B-DIP - incomplete-task counts move behind the repository.
  async countIncompleteOtherTasks(requestId, providerId, client = null) {
    const row = await this._execOne(
      `
      SELECT COUNT(*)::int AS count
      FROM request_workflow_tasks
      WHERE request_id = $1
        AND provider_id IS DISTINCT FROM $2
        AND status NOT IN ('SUBMITTED', 'COMPLETED', 'CANCELLED')
      `,
      [requestId, providerId],
      client
    );
    return row?.count || 0;
  }

  // AUDIT-FIX: P3-STEP7B-DIP - request completion writes move behind the repository.
  async markRequestCompleted(requestId, client = null) {
    return this._execOne(
      `
      UPDATE service_requests
      SET status = 'COMPLETED',
          completed_at = NOW(),
          workflow_stage = 'COMPLETED',
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [requestId],
      client
    );
  }

  // AUDIT-FIX: P3-STEP7B-DIP - payment-record listing moves behind the repository.
  async listPaymentRecordsByRequest(requestId, client = null) {
    return this._exec(
      `
      SELECT pr.*,
             a.full_name AS approved_by_name
      FROM payment_records pr
      LEFT JOIN admins a ON a.id = pr.approved_by
      WHERE pr.request_id = $1
      ORDER BY pr.created_at DESC
      `,
      [requestId],
      client
    );
  }

  // AUDIT-FIX: P3-STEP7B-DIP - payment-record inserts move behind the repository.
  async createPaymentRecord({ requestId, recordedBy, recorderRole, amount, method, notes }, client = null) {
    return this._execOne(
      `
      INSERT INTO payment_records (
        request_id,
        recorded_by,
        recorder_role,
        amount,
        method,
        notes
      )
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
      `,
      [requestId, recordedBy, recorderRole, amount, method, notes || null],
      client
    );
  }

  // AUDIT-FIX: P3-STEP7B-DIP - approval-flow payment-record locking reads move behind the repository.
  async getPaymentRecordForApproval(requestId, paymentId, client = null) {
    return this._execOne(
      `
      SELECT pr.*, sr.status AS request_status
      FROM payment_records pr
      JOIN service_requests sr ON sr.id = pr.request_id
      WHERE pr.request_id = $1
        AND pr.id = $2
      LIMIT 1
      FOR UPDATE
      `,
      [requestId, paymentId],
      client
    );
  }

  // AUDIT-FIX: P3-STEP7B-DIP - payment-record approval writes move behind the repository.
  async approvePaymentRecord(requestId, paymentId, approverId, client = null) {
    return this._execOne(
      `
      UPDATE payment_records
      SET approval_status = 'APPROVED',
          approved_by = $3,
          approved_at = NOW()
      WHERE request_id = $1
        AND id = $2
        AND approval_status = 'PENDING'
      RETURNING *
      `,
      [requestId, paymentId, approverId],
      client
    );
  }

  // AUDIT-FIX: P3-STEP7B-DIP - provider-report approval writes move behind the repository.
  async approveProviderReport(reportId, approverId, client = null) {
    return this._execOne(
      `
      UPDATE request_provider_reports
      SET status = 'APPROVED',
          approved_by = $2,
          approved_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [reportId, approverId],
      client
    );
  }

  // AUDIT-FIX: P3-STEP7B-DIP - provider-report existence checks move behind the repository.
  async hasAnyProviderReport(requestId, client = null) {
    const row = await this._execOne(
      `
      SELECT id
      FROM request_provider_reports
      WHERE request_id = $1
      LIMIT 1
      `,
      [requestId],
      client
    );
    return Boolean(row);
  }

  // AUDIT-FIX: P3-STEP7B-DIP - final-report confirmation request writes move behind the repository.
  async confirmFinalReportOnRequest(requestId, providerId, client = null) {
    return this._execOne(
      `
      UPDATE service_requests
      SET final_report_confirmed_by = COALESCE(final_report_confirmed_by, $2),
          final_report_confirmed_at = COALESCE(final_report_confirmed_at, NOW()),
          workflow_updated_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [requestId, providerId],
      client
    );
  }

  // AUDIT-FIX: P3-STEP7B-DIP - admin final-report confirmation writes move behind the repository.
  async confirmFinalReportAndCompleteWorkflow(requestId, providerId, client = null) {
    return this._execOne(
      `
      UPDATE service_requests
      SET final_report_confirmed_by = COALESCE(final_report_confirmed_by, $2),
          final_report_confirmed_at = COALESCE(final_report_confirmed_at, NOW()),
          workflow_stage = 'COMPLETED',
          workflow_updated_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [requestId, providerId],
      client
    );
  }

  // AUDIT-FIX: P3-STEP7B-DIP - request-close writes move behind the repository.
  async markRequestClosedByAdmin(requestId, adminId, adminCloseNotes, client = null) {
    return this._execOne(
      `
      UPDATE service_requests
      SET status = 'CLOSED',
          closed_at = NOW(),
          closed_by = $2,
          admin_close_notes = $3,
          workflow_stage = 'PUBLISHED',
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [requestId, adminId, adminCloseNotes || null],
      client
    );
  }

  // AUDIT-FIX: P3-STEP7B-DIP - provider-report approval writes move behind the repository.
  async approveProviderReportsForRequest(requestId, adminId, client = null) {
    await this._exec(
      `
      UPDATE request_provider_reports
      SET status = 'APPROVED',
          approved_by = $2,
          approved_at = NOW(),
          updated_at = NOW()
      WHERE request_id = $1
      `,
      [requestId, adminId],
      client
    );
  }

  // AUDIT-FIX: P3-STEP7B-DIP - medical-report publish writes move behind the repository.
  async publishMedicalReportForClose(requestId, adminId, adminNotes, pdfUrl, client = null) {
    return this._execOne(
      `
      UPDATE medical_reports
      SET status = 'PUBLISHED',
          reviewed_by = $2,
          reviewed_at = NOW(),
          published_at = NOW(),
          admin_notes = $3,
          pdf_url = COALESCE($4, pdf_url),
          updated_at = NOW()
      WHERE request_id = $1
      RETURNING *
      `,
      [requestId, adminId, adminNotes || null, pdfUrl || null],
      client
    );
  }

  async updateMedicalReportPdfUrl(requestId, pdfUrl, client = null) {
    return this._execOne(
      `
      UPDATE medical_reports
      SET pdf_url = $2,
          updated_at = NOW()
      WHERE request_id = $1
      RETURNING *
      `,
      [requestId, pdfUrl],
      client
    );
  }

  // AUDIT-FIX: P3-STEP7B-DIP - approved-payment counts move behind the repository.
  async countApprovedPaymentRecords(requestId, client = null) {
    const row = await this._execOne(
      `
      SELECT COUNT(*)::int AS count
      FROM payment_records
      WHERE request_id = $1
        AND approval_status = 'APPROVED'
      `,
      [requestId],
      client
    );
    return row?.count || 0;
  }

  // AUDIT-FIX: P3-STEP7B-DIP - invoice-visibility updates move behind the repository.
  async makeInvoiceVisibleForRequest(requestId, adminId, client = null) {
    return this._execOne(
      `
      UPDATE invoices
      SET is_patient_visible = TRUE,
          approved_by = $2,
          approved_at = NOW(),
          updated_at = NOW()
      WHERE request_id = $1
      RETURNING *
      `,
      [requestId, adminId],
      client
    );
  }

  // AUDIT-FIX: P3-STEP7B-DIP - billing-identity reads move behind the repository.
  async getRequestBillingIdentity(requestId, client = null) {
    return this._execOne(
      `
      SELECT
        patient_id,
        guest_name,
        coupon_id,
        coupon_code,
        coupon_discount_amount,
        service_price_snapshot
      FROM service_requests
      WHERE id = $1
      LIMIT 1
      `,
      [requestId],
      client
    );
  }

  // AUDIT-FIX: P3-STEP7B-DIP - zero-balance invoice creation moves behind the repository.
  async createPendingInvoiceForRequest(
    requestId,
    patientId,
    guestName,
    adminId,
    {
      originalAmount = 0,
      couponId = null,
      couponDiscountAmount = 0,
      couponCodeSnapshot = null,
    } = {},
    client = null
  ) {
    const finalAmount = Math.max(0, Number(originalAmount || 0) - Number(couponDiscountAmount || 0));

    return this._execOne(
      `
      INSERT INTO invoices (
        request_id,
        patient_id,
        guest_name,
        original_amount,
        vip_discount_amount,
        coupon_id,
        coupon_discount_amount,
        coupon_code_snapshot,
        points_used,
        points_discount_amount,
        final_amount,
        total_paid,
        remaining_amount,
        payment_status,
        payment_status_detail,
        approved_by,
        approved_at,
        is_patient_visible
      )
      VALUES (
        $1,$2,$3,$4,0,$5,$6,$7,0,0,$8,0,$8,'PENDING','UNPAID',$9,NOW(),TRUE
      )
      RETURNING *
      `,
      [
        requestId,
        patientId || null,
        guestName || null,
        Number(originalAmount || 0),
        couponId || null,
        Number(couponDiscountAmount || 0),
        couponCodeSnapshot || null,
        finalAmount,
        adminId,
      ],
      client
    );
  }
}

module.exports = RequestRepository;
