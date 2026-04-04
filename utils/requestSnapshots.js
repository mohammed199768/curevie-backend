function calculateAgeYears(dateOfBirth) {
  if (!dateOfBirth) return null;
  const date = new Date(dateOfBirth);
  if (Number.isNaN(date.getTime())) return null;
  return Math.floor((Date.now() - date.getTime()) / (365.25 * 24 * 3600 * 1000));
}

function normalizeNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getPackageTaskTypeForService(serviceRow) {
  const haystack = `${serviceRow?.name || ''} ${serviceRow?.category_name || ''}`.toLowerCase();
  return /(xray|x-ray|radiology|scan|اشعة|أشعة)/i.test(haystack) ? 'RADIOLOGY' : 'MEDICAL';
}

function normalizePackageComponentsSnapshot(value) {
  if (!value) return null;

  const parsed = typeof value === 'string' ? (() => {
    try {
      return JSON.parse(value);
    } catch (_) {
      return null;
    }
  })() : value;

  if (!parsed || typeof parsed !== 'object') return null;

  const labTests = Array.isArray(parsed.lab_tests) ? parsed.lab_tests : [];
  const services = Array.isArray(parsed.services) ? parsed.services : [];

  return {
    lab_tests: labTests.map((test) => ({
      lab_test_id: test.lab_test_id || test.id || null,
      name: test.name || null,
      cost: test.cost ?? null,
      unit: test.unit || null,
      reference_range: test.reference_range || null,
    })),
    services: services.map((service) => ({
      service_id: service.service_id || service.id || null,
      name: service.name || null,
      price: service.price ?? null,
      description: service.description || null,
      category_name: service.category_name || null,
      service_kind: service.service_kind || getPackageTaskTypeForService(service),
    })),
  };
}

async function getPackageComponentsSnapshot(db, packageId) {
  if (!packageId) {
    return {
      lab_tests: [],
      services: [],
    };
  }

  const [testsResult, servicesResult] = await Promise.all([
    db.query(
      `
      SELECT lt.id, lt.name, lt.cost, lt.unit, lt.reference_range
      FROM package_tests pt
      JOIN lab_tests lt ON lt.id = pt.lab_test_id
      WHERE pt.package_id = $1
      ORDER BY lt.name ASC
      `,
      [packageId]
    ),
    db.query(
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

  return {
    lab_tests: testsResult.rows.map((row) => ({
      lab_test_id: row.id,
      name: row.name,
      cost: row.cost,
      unit: row.unit || null,
      reference_range: row.reference_range || null,
    })),
    services: servicesResult.rows.map((row) => ({
      service_id: row.id,
      name: row.name,
      price: row.price,
      description: row.description || null,
      category_name: row.category_name || null,
      service_kind: getPackageTaskTypeForService(row),
    })),
  };
}

async function getPatientSnapshot(db, {
  request_type,
  patient_id,
  guest_name,
  guest_phone,
  guest_address,
  guest_gender,
  guest_age,
}) {
  if (request_type === 'PATIENT' && patient_id) {
    const patientResult = await db.query(
      `
      SELECT full_name, phone, email, address, gender, date_of_birth
      FROM patients
      WHERE id = $1
      LIMIT 1
      `,
      [patient_id]
    );
    const patient = patientResult.rows[0];
    if (patient) {
      return {
        full_name: patient.full_name || null,
        phone: patient.phone || null,
        email: patient.email || null,
        address: patient.address || null,
        gender: patient.gender || null,
        date_of_birth: patient.date_of_birth || null,
        age: calculateAgeYears(patient.date_of_birth),
      };
    }
  }

  return {
    full_name: guest_name || null,
    phone: guest_phone || null,
    email: null,
    address: guest_address || null,
    gender: guest_gender || null,
    date_of_birth: null,
    age: guest_age ?? null,
  };
}

async function getServiceSnapshot(db, {
  service_type,
  service_id,
  lab_test_id,
  lab_panel_id,
  lab_package_id,
  package_id,
}) {
  if (['MEDICAL', 'RADIOLOGY'].includes(service_type) && service_id) {
    const result = await db.query(
      `
      SELECT s.name, s.description, s.price, c.name AS category_name
      FROM services s
      LEFT JOIN service_categories c ON c.id = s.category_id
      WHERE s.id = $1
      LIMIT 1
      `,
      [service_id]
    );
    const row = result.rows[0] || {};
    return {
      name: row.name || null,
      description: row.description || null,
      category_name: row.category_name || null,
      price: row.price ?? 0,
      package_components: null,
    };
  }

  if (service_type === 'LAB' && lab_test_id) {
    const result = await db.query(
      `
      SELECT lt.name, lt.description, lt.cost, c.name AS category_name
      FROM lab_tests lt
      LEFT JOIN service_categories c ON c.id = lt.category_id
      WHERE lt.id = $1
      LIMIT 1
      `,
      [lab_test_id]
    );
    const row = result.rows[0] || {};
    return {
      name: row.name || null,
      description: row.description || null,
      category_name: row.category_name || null,
      price: row.cost ?? 0,
      package_components: null,
    };
  }

  if (service_type === 'LAB' && lab_panel_id) {
    const result = await db.query(
      `
      SELECT name_en AS name, description_en AS description, price
      FROM lab_panels
      WHERE id = $1
      LIMIT 1
      `,
      [lab_panel_id]
    );
    const row = result.rows[0] || {};
    return {
      name: row.name || null,
      description: row.description || null,
      category_name: 'Lab Panel',
      price: row.price ?? 0,
      package_components: null,
    };
  }

  if (service_type === 'LAB' && lab_package_id) {
    const result = await db.query(
      `
      SELECT name_en AS name, description_en AS description, price
      FROM lab_packages
      WHERE id = $1
      LIMIT 1
      `,
      [lab_package_id]
    );
    const row = result.rows[0] || {};
    return {
      name: row.name || null,
      description: row.description || null,
      category_name: 'Lab Package',
      price: row.price ?? 0,
      package_components: null,
    };
  }

  if (service_type === 'PACKAGE' && package_id) {
    const [packageResult, packageComponents] = await Promise.all([
      db.query(
        `
        SELECT pk.name, pk.description, pk.total_cost, c.name AS category_name
        FROM packages pk
        LEFT JOIN service_categories c ON c.id = pk.category_id
        WHERE pk.id = $1
        LIMIT 1
        `,
        [package_id]
      ),
      getPackageComponentsSnapshot(db, package_id),
    ]);

    const row = packageResult.rows[0] || {};
    return {
      name: row.name || null,
      description: row.description || null,
      category_name: row.category_name || null,
      price: row.total_cost ?? 0,
      package_components: packageComponents,
    };
  }

  return {
    name: null,
    description: null,
    category_name: null,
    price: 0,
    package_components: null,
  };
}

async function buildRequestSnapshot(db, payload) {
  const [patient, service] = await Promise.all([
    getPatientSnapshot(db, payload),
    getServiceSnapshot(db, payload),
  ]);

  return {
    patient,
    service,
    package_components: service.package_components,
  };
}

async function getProviderSnapshotById(db, providerId) {
  if (!providerId) {
    return {
      full_name: null,
      phone: null,
      type: null,
    };
  }

  const result = await db.query(
    `
    SELECT full_name, phone, type
    FROM service_providers
    WHERE id = $1
    LIMIT 1
    `,
    [providerId]
  );

  return result.rows[0] || {
    full_name: null,
    phone: null,
    type: null,
  };
}

function buildRequestSnapshotPayloadFromRow(requestRow = {}) {
  return {
    version: 1,
    captured_at: requestRow.requested_at || requestRow.created_at || new Date().toISOString(),
    request: {
      id: requestRow.id || null,
      request_type: requestRow.request_type || null,
      service_type: requestRow.service_type || null,
      service_id: requestRow.service_id || null,
      lab_test_id: requestRow.lab_test_id || null,
      lab_panel_id: requestRow.lab_panel_id || null,
      lab_package_id: requestRow.lab_package_id || null,
      package_id: requestRow.package_id || null,
      patient_id: requestRow.patient_id || null,
      guest_name: requestRow.guest_name || null,
      guest_phone: requestRow.guest_phone || null,
      guest_address: requestRow.guest_address || null,
      guest_gender: requestRow.guest_gender || null,
      guest_age: requestRow.guest_age ?? null,
      notes: requestRow.notes || null,
      coupon_code: requestRow.coupon_code || null,
      coupon_id: requestRow.coupon_id || null,
      coupon_discount_amount: normalizeNullableNumber(requestRow.coupon_discount_amount) ?? 0,
      requested_at: requestRow.requested_at || null,
      created_at: requestRow.created_at || null,
    },
    patient: {
      full_name: requestRow.patient_full_name_snapshot || null,
      phone: requestRow.patient_phone_snapshot || null,
      email: requestRow.patient_email_snapshot || null,
      address: requestRow.patient_address_snapshot || null,
      gender: requestRow.patient_gender_snapshot || null,
      date_of_birth: requestRow.patient_date_of_birth_snapshot || null,
      age: requestRow.patient_age_snapshot ?? null,
    },
    service: {
      name: requestRow.service_name_snapshot || null,
      description: requestRow.service_description_snapshot || null,
      category_name: requestRow.service_category_name_snapshot || null,
      price: normalizeNullableNumber(requestRow.service_price_snapshot),
      package_components: normalizePackageComponentsSnapshot(requestRow.package_components_snapshot),
    },
    provider: {
      assigned: {
        id: requestRow.assigned_provider_id || null,
        full_name: requestRow.assigned_provider_name_snapshot || null,
        phone: requestRow.assigned_provider_phone_snapshot || null,
        type: requestRow.assigned_provider_type_snapshot || null,
      },
      lead: {
        id: requestRow.lead_provider_id || null,
        full_name: requestRow.lead_provider_name_snapshot || null,
        phone: requestRow.lead_provider_phone_snapshot || null,
        type: requestRow.lead_provider_type_snapshot || null,
      },
    },
  };
}

function buildInvoiceSnapshotPayloadFromRow(invoiceRow = {}) {
  return {
    version: 1,
    captured_at: invoiceRow.approved_at || invoiceRow.created_at || new Date().toISOString(),
    invoice: {
      id: invoiceRow.id || null,
      request_id: invoiceRow.request_id || null,
      patient_id: invoiceRow.patient_id || null,
      guest_name: invoiceRow.guest_name || null,
      coupon_id: invoiceRow.coupon_id || null,
      coupon_code_snapshot: invoiceRow.coupon_code_snapshot || null,
      coupon_discount_type_snapshot: invoiceRow.coupon_discount_type_snapshot || null,
      coupon_discount_value_snapshot: normalizeNullableNumber(invoiceRow.coupon_discount_value_snapshot),
      original_amount: normalizeNullableNumber(invoiceRow.original_amount),
      vip_discount_amount: normalizeNullableNumber(invoiceRow.vip_discount_amount),
      coupon_discount_amount: normalizeNullableNumber(invoiceRow.coupon_discount_amount),
      points_used: normalizeNullableNumber(invoiceRow.points_used),
      points_discount_amount: normalizeNullableNumber(invoiceRow.points_discount_amount),
      final_amount: normalizeNullableNumber(invoiceRow.final_amount),
      total_paid: normalizeNullableNumber(invoiceRow.total_paid),
      remaining_amount: normalizeNullableNumber(invoiceRow.remaining_amount),
      payment_status: invoiceRow.payment_status || null,
      payment_status_detail: invoiceRow.payment_status_detail || null,
      payment_method: invoiceRow.payment_method || null,
      approved_at: invoiceRow.approved_at || null,
      created_at: invoiceRow.created_at || null,
    },
    patient: {
      name: invoiceRow.patient_name_snapshot || null,
      phone: invoiceRow.patient_phone_snapshot || null,
      address: invoiceRow.patient_address_snapshot || null,
    },
    service: {
      name: invoiceRow.service_name_snapshot || null,
      type: invoiceRow.service_type_snapshot || null,
      description: invoiceRow.service_description_snapshot || null,
      category_name: invoiceRow.service_category_name_snapshot || null,
    },
    provider: {
      name: invoiceRow.provider_name_snapshot || null,
      type: invoiceRow.provider_type_snapshot || null,
    },
  };
}

async function syncRequestSnapshotPayload(db, requestId) {
  if (!requestId) return null;

  // AUDIT-FIX: D1 — transaction-aware snapshot
  const isPool = typeof db.connect === 'function';
  const client = isPool ? await db.connect() : db;

  try {
    if (isPool) await client.query('BEGIN');

    const requestResult = await client.query(
      `
      SELECT
        id,
        request_type,
        patient_id,
        guest_name,
        guest_phone,
        guest_address,
        guest_gender,
        guest_age,
        service_type,
        service_id,
        lab_test_id,
        lab_panel_id,
        lab_package_id,
        package_id,
        notes,
        coupon_code,
        coupon_id,
        coupon_discount_amount,
        requested_at,
        created_at,
        assigned_provider_id,
        assigned_provider_name_snapshot,
        assigned_provider_phone_snapshot,
        assigned_provider_type_snapshot,
        lead_provider_id,
        lead_provider_name_snapshot,
        lead_provider_phone_snapshot,
        lead_provider_type_snapshot,
        patient_full_name_snapshot,
        patient_phone_snapshot,
        patient_email_snapshot,
        patient_address_snapshot,
        patient_gender_snapshot,
        patient_date_of_birth_snapshot,
        patient_age_snapshot,
        service_name_snapshot,
        service_description_snapshot,
        service_category_name_snapshot,
        service_price_snapshot,
        package_components_snapshot,
        request_snapshot_payload
      FROM service_requests
      WHERE id = $1
      LIMIT 1
      `,
      [requestId]
    );

    const requestRow = requestResult.rows[0];
    if (!requestRow) {
      if (isPool) await client.query('ROLLBACK');
      return null;
    }

    const payload = buildRequestSnapshotPayloadFromRow(requestRow);
    const updateResult = await client.query(
      `
      UPDATE service_requests
      SET request_snapshot_payload = COALESCE(request_snapshot_payload, $2::jsonb)
      WHERE id = $1
      RETURNING *
      `,
      [requestId, JSON.stringify(payload)]
    );

    if (isPool) await client.query('COMMIT');
    return updateResult.rows[0] || requestRow;
  } catch (err) {
    if (isPool) await client.query('ROLLBACK');
    throw err;
  } finally {
    if (isPool) client.release();
  }
}

async function syncRequestProviderSnapshots(db, requestId) {
  const requestResult = await db.query(
    `
    SELECT id, assigned_provider_id, lead_provider_id
    FROM service_requests
    WHERE id = $1
    LIMIT 1
    `,
    [requestId]
  );
  const request = requestResult.rows[0];
  if (!request) return null;

  const [assignedProvider, leadProvider] = await Promise.all([
    getProviderSnapshotById(db, request.assigned_provider_id),
    getProviderSnapshotById(db, request.lead_provider_id),
  ]);

  const updateResult = await db.query(
    `
    UPDATE service_requests
    SET assigned_provider_name_snapshot = COALESCE(assigned_provider_name_snapshot, $2),
        assigned_provider_phone_snapshot = COALESCE(assigned_provider_phone_snapshot, $3),
        assigned_provider_type_snapshot = COALESCE(assigned_provider_type_snapshot, $4),
        lead_provider_name_snapshot = COALESCE(lead_provider_name_snapshot, $5),
        lead_provider_phone_snapshot = COALESCE(lead_provider_phone_snapshot, $6),
        lead_provider_type_snapshot = COALESCE(lead_provider_type_snapshot, $7)
    WHERE id = $1
    RETURNING *
    `,
    [
      requestId,
      assignedProvider.full_name || null,
      assignedProvider.phone || null,
      assignedProvider.type || null,
      leadProvider.full_name || null,
      leadProvider.phone || null,
      leadProvider.type || null,
    ]
  );

  return updateResult.rows[0] || null;
}

async function syncInvoiceSnapshots(db, invoiceId, requestId) {
  if (!invoiceId || !requestId) return null;

  const result = await db.query(
    `
    UPDATE invoices i
    SET patient_name_snapshot = COALESCE(i.patient_name_snapshot, sr.patient_full_name_snapshot, sr.guest_name),
        patient_phone_snapshot = COALESCE(i.patient_phone_snapshot, sr.patient_phone_snapshot, sr.guest_phone),
        patient_address_snapshot = COALESCE(i.patient_address_snapshot, sr.patient_address_snapshot, sr.guest_address),
        service_name_snapshot = COALESCE(i.service_name_snapshot, sr.service_name_snapshot),
        service_type_snapshot = COALESCE(i.service_type_snapshot, sr.service_type::text),
        service_description_snapshot = COALESCE(i.service_description_snapshot, sr.service_description_snapshot),
        service_category_name_snapshot = COALESCE(i.service_category_name_snapshot, sr.service_category_name_snapshot),
        provider_name_snapshot = COALESCE(i.provider_name_snapshot, sr.assigned_provider_name_snapshot, sr.lead_provider_name_snapshot),
        provider_type_snapshot = COALESCE(i.provider_type_snapshot, sr.assigned_provider_type_snapshot, sr.lead_provider_type_snapshot)
    FROM service_requests sr
    WHERE i.id = $1
      AND sr.id = $2
    RETURNING i.*
    `,
    [invoiceId, requestId]
  );

  let invoiceRow = result.rows[0] || null;
  if (!invoiceRow) return null;

  if (invoiceRow.coupon_id) {
    await db.query(
      `
      UPDATE invoices
      SET
        coupon_discount_type_snapshot = COALESCE(
          coupon_discount_type_snapshot,
          (SELECT discount_type::text FROM coupons WHERE id = $2)
        ),
        coupon_discount_value_snapshot = COALESCE(
          coupon_discount_value_snapshot,
          (SELECT discount_value FROM coupons WHERE id = $2)
        )
      WHERE id = $1
        AND (
          coupon_discount_type_snapshot IS NULL
          OR coupon_discount_value_snapshot IS NULL
        )
      `,
      [invoiceRow.id, invoiceRow.coupon_id]
    );
  }

  await db.query(
    `
    UPDATE invoices
    SET payments_snapshot = COALESCE(
      payments_snapshot,
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', p.id,
            'amount', p.amount,
            'payment_method', p.payment_method,
            'payer_name', p.payer_name,
            'notes', p.notes,
            'created_at', p.created_at
          )
          ORDER BY p.created_at ASC
        )
        FROM payments p
        WHERE p.invoice_id = $1
      )
    )
    WHERE id = $1
      AND payments_snapshot IS NULL
    `,
    [invoiceRow.id]
  );

  const refreshedResult = await db.query(
    `
    SELECT *
    FROM invoices
    WHERE id = $1
    LIMIT 1
    `,
    [invoiceRow.id]
  );
  invoiceRow = refreshedResult.rows[0] || invoiceRow;

  const payload = buildInvoiceSnapshotPayloadFromRow(invoiceRow);
  const payloadResult = await db.query(
    `
    UPDATE invoices
    SET invoice_snapshot_payload = COALESCE(invoice_snapshot_payload, $2::jsonb)
    WHERE id = $1
    RETURNING *
    `,
    [invoiceId, JSON.stringify(payload)]
  );

  return payloadResult.rows[0] || invoiceRow;
}

module.exports = {
  calculateAgeYears,
  getPackageTaskTypeForService,
  normalizePackageComponentsSnapshot,
  getPackageComponentsSnapshot,
  getProviderSnapshotById,
  buildRequestSnapshot,
  buildRequestSnapshotPayloadFromRow,
  buildInvoiceSnapshotPayloadFromRow,
  syncRequestSnapshotPayload,
  syncRequestProviderSnapshots,
  syncInvoiceSnapshots,
};
