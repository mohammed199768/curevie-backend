-- AUDIT-FIX: D5 — batched version of migration 021
-- Replace the original bulk UPDATE with this safe version
-- Each batch: 500 rows, 100ms sleep between batches
-- Estimated time for 100k rows: ~30 minutes with zero table locks
--
-- NOTE: The ALTER TABLE statements from the original 021 must be run first.
-- This file only replaces the UPDATE statements.

-- Batch 1: Patient snapshots for registered patients
DO $$
DECLARE
  batch_size  INT := 500;
  offset_val  INT := 0;
  rows_updated INT;
BEGIN
  LOOP
    UPDATE service_requests sr
    SET patient_full_name_snapshot = COALESCE(sr.patient_full_name_snapshot, p.full_name, sr.guest_name),
        patient_phone_snapshot = COALESCE(sr.patient_phone_snapshot, p.phone, sr.guest_phone),
        patient_email_snapshot = COALESCE(sr.patient_email_snapshot, p.email),
        patient_address_snapshot = COALESCE(sr.patient_address_snapshot, p.address, sr.guest_address),
        patient_gender_snapshot = COALESCE(sr.patient_gender_snapshot, p.gender, sr.guest_gender),
        patient_date_of_birth_snapshot = COALESCE(sr.patient_date_of_birth_snapshot, p.date_of_birth),
        patient_age_snapshot = COALESCE(
          sr.patient_age_snapshot,
          sr.guest_age,
          CASE
            WHEN p.date_of_birth IS NOT NULL
            THEN EXTRACT(YEAR FROM age(CURRENT_DATE, p.date_of_birth))::int
            ELSE NULL
          END
        )
    FROM patients p
    WHERE sr.patient_id = p.id
      AND sr.id IN (
        SELECT id FROM service_requests
        WHERE patient_id IS NOT NULL
          AND patient_full_name_snapshot IS NULL
        ORDER BY id
        LIMIT batch_size OFFSET offset_val
      );

    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    EXIT WHEN rows_updated = 0;

    offset_val := offset_val + batch_size;
    RAISE NOTICE 'Patient snapshots: processed % rows (offset: %)', rows_updated, offset_val;
    PERFORM pg_sleep(0.1);
  END LOOP;

  RAISE NOTICE 'Patient snapshots complete. Total offset reached: %', offset_val;
END $$;

-- Batch 2: Guest patient snapshots
DO $$
DECLARE
  batch_size  INT := 500;
  offset_val  INT := 0;
  rows_updated INT;
BEGIN
  LOOP
    UPDATE service_requests
    SET patient_full_name_snapshot = COALESCE(patient_full_name_snapshot, guest_name),
        patient_phone_snapshot = COALESCE(patient_phone_snapshot, guest_phone),
        patient_address_snapshot = COALESCE(patient_address_snapshot, guest_address),
        patient_gender_snapshot = COALESCE(patient_gender_snapshot, guest_gender),
        patient_age_snapshot = COALESCE(patient_age_snapshot, guest_age)
    WHERE id IN (
      SELECT id FROM service_requests
      WHERE request_type = 'GUEST'
        AND patient_full_name_snapshot IS NULL
      ORDER BY id
      LIMIT batch_size OFFSET offset_val
    );

    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    EXIT WHEN rows_updated = 0;

    offset_val := offset_val + batch_size;
    RAISE NOTICE 'Guest snapshots: processed % rows (offset: %)', rows_updated, offset_val;
    PERFORM pg_sleep(0.1);
  END LOOP;
END $$;

-- Batch 3: Service snapshots (MEDICAL/XRAY/RADIOLOGY)
DO $$
DECLARE
  batch_size  INT := 500;
  offset_val  INT := 0;
  rows_updated INT;
BEGIN
  LOOP
    UPDATE service_requests sr
    SET service_name_snapshot = COALESCE(sr.service_name_snapshot, svc.name),
        service_description_snapshot = COALESCE(sr.service_description_snapshot, svc.description),
        service_category_name_snapshot = COALESCE(sr.service_category_name_snapshot, svc_cat.name),
        service_price_snapshot = COALESCE(sr.service_price_snapshot, svc.price)
    FROM services svc
    LEFT JOIN service_categories svc_cat ON svc_cat.id = svc.category_id
    WHERE sr.service_id = svc.id
      AND sr.service_type IN ('MEDICAL', 'XRAY', 'RADIOLOGY')
      AND sr.id IN (
        SELECT id FROM service_requests
        WHERE service_id IS NOT NULL
          AND service_type IN ('MEDICAL', 'XRAY', 'RADIOLOGY')
          AND service_name_snapshot IS NULL
        ORDER BY id
        LIMIT batch_size OFFSET offset_val
      );

    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    EXIT WHEN rows_updated = 0;

    offset_val := offset_val + batch_size;
    RAISE NOTICE 'Service snapshots: processed % rows (offset: %)', rows_updated, offset_val;
    PERFORM pg_sleep(0.1);
  END LOOP;
END $$;

-- Batch 4: LAB test snapshots
DO $$
DECLARE
  batch_size  INT := 500;
  offset_val  INT := 0;
  rows_updated INT;
BEGIN
  LOOP
    UPDATE service_requests sr
    SET service_name_snapshot = COALESCE(sr.service_name_snapshot, lt.name),
        service_description_snapshot = COALESCE(sr.service_description_snapshot, lt.description),
        service_category_name_snapshot = COALESCE(sr.service_category_name_snapshot, lt_cat.name),
        service_price_snapshot = COALESCE(sr.service_price_snapshot, lt.cost)
    FROM lab_tests lt
    LEFT JOIN service_categories lt_cat ON lt_cat.id = lt.category_id
    WHERE sr.lab_test_id = lt.id
      AND sr.service_type = 'LAB'
      AND sr.id IN (
        SELECT id FROM service_requests
        WHERE lab_test_id IS NOT NULL
          AND service_type = 'LAB'
          AND service_name_snapshot IS NULL
        ORDER BY id
        LIMIT batch_size OFFSET offset_val
      );

    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    EXIT WHEN rows_updated = 0;

    offset_val := offset_val + batch_size;
    RAISE NOTICE 'Lab test snapshots: processed % rows (offset: %)', rows_updated, offset_val;
    PERFORM pg_sleep(0.1);
  END LOOP;
END $$;

-- Batch 5: Package snapshots
DO $$
DECLARE
  batch_size  INT := 500;
  offset_val  INT := 0;
  rows_updated INT;
BEGIN
  LOOP
    UPDATE service_requests sr
    SET service_name_snapshot = COALESCE(sr.service_name_snapshot, pk.name),
        service_description_snapshot = COALESCE(sr.service_description_snapshot, pk.description),
        service_category_name_snapshot = COALESCE(sr.service_category_name_snapshot, pk_cat.name),
        service_price_snapshot = COALESCE(sr.service_price_snapshot, pk.total_cost)
    FROM packages pk
    LEFT JOIN service_categories pk_cat ON pk_cat.id = pk.category_id
    WHERE sr.package_id = pk.id
      AND sr.service_type = 'PACKAGE'
      AND sr.id IN (
        SELECT id FROM service_requests
        WHERE package_id IS NOT NULL
          AND service_type = 'PACKAGE'
          AND service_name_snapshot IS NULL
        ORDER BY id
        LIMIT batch_size OFFSET offset_val
      );

    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    EXIT WHEN rows_updated = 0;

    offset_val := offset_val + batch_size;
    RAISE NOTICE 'Package snapshots: processed % rows (offset: %)', rows_updated, offset_val;
    PERFORM pg_sleep(0.1);
  END LOOP;
END $$;

-- Batch 6: Provider snapshots (assigned)
DO $$
DECLARE
  batch_size  INT := 500;
  offset_val  INT := 0;
  rows_updated INT;
BEGIN
  LOOP
    UPDATE service_requests sr
    SET assigned_provider_name_snapshot = COALESCE(sr.assigned_provider_name_snapshot, asp.full_name),
        assigned_provider_phone_snapshot = COALESCE(sr.assigned_provider_phone_snapshot, asp.phone),
        assigned_provider_type_snapshot = COALESCE(sr.assigned_provider_type_snapshot, asp.type::text)
    FROM service_providers asp
    WHERE sr.assigned_provider_id = asp.id
      AND sr.id IN (
        SELECT id FROM service_requests
        WHERE assigned_provider_id IS NOT NULL
          AND assigned_provider_name_snapshot IS NULL
        ORDER BY id
        LIMIT batch_size OFFSET offset_val
      );

    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    EXIT WHEN rows_updated = 0;

    offset_val := offset_val + batch_size;
    RAISE NOTICE 'Assigned provider snapshots: processed % rows (offset: %)', rows_updated, offset_val;
    PERFORM pg_sleep(0.1);
  END LOOP;
END $$;

-- Batch 7: Provider snapshots (lead)
DO $$
DECLARE
  batch_size  INT := 500;
  offset_val  INT := 0;
  rows_updated INT;
BEGIN
  LOOP
    UPDATE service_requests sr
    SET lead_provider_name_snapshot = COALESCE(sr.lead_provider_name_snapshot, lsp.full_name),
        lead_provider_phone_snapshot = COALESCE(sr.lead_provider_phone_snapshot, lsp.phone),
        lead_provider_type_snapshot = COALESCE(sr.lead_provider_type_snapshot, lsp.type::text)
    FROM service_providers lsp
    WHERE sr.lead_provider_id = lsp.id
      AND sr.id IN (
        SELECT id FROM service_requests
        WHERE lead_provider_id IS NOT NULL
          AND lead_provider_name_snapshot IS NULL
        ORDER BY id
        LIMIT batch_size OFFSET offset_val
      );

    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    EXIT WHEN rows_updated = 0;

    offset_val := offset_val + batch_size;
    RAISE NOTICE 'Lead provider snapshots: processed % rows (offset: %)', rows_updated, offset_val;
    PERFORM pg_sleep(0.1);
  END LOOP;
END $$;

-- Batch 8: Invoice snapshots
DO $$
DECLARE
  batch_size  INT := 500;
  offset_val  INT := 0;
  rows_updated INT;
BEGIN
  LOOP
    UPDATE invoices i
    SET patient_name_snapshot = COALESCE(i.patient_name_snapshot, sr.patient_full_name_snapshot, p.full_name, sr.guest_name, i.guest_name),
        patient_phone_snapshot = COALESCE(i.patient_phone_snapshot, sr.patient_phone_snapshot, p.phone, sr.guest_phone),
        patient_address_snapshot = COALESCE(i.patient_address_snapshot, sr.patient_address_snapshot, p.address, sr.guest_address),
        service_name_snapshot = COALESCE(i.service_name_snapshot, sr.service_name_snapshot),
        service_type_snapshot = COALESCE(i.service_type_snapshot, sr.service_type::text),
        service_description_snapshot = COALESCE(i.service_description_snapshot, sr.service_description_snapshot),
        service_category_name_snapshot = COALESCE(i.service_category_name_snapshot, sr.service_category_name_snapshot),
        provider_name_snapshot = COALESCE(i.provider_name_snapshot, sr.assigned_provider_name_snapshot, sr.lead_provider_name_snapshot),
        provider_type_snapshot = COALESCE(i.provider_type_snapshot, sr.assigned_provider_type_snapshot, sr.lead_provider_type_snapshot)
    FROM service_requests sr
    LEFT JOIN patients p ON p.id = sr.patient_id
    WHERE i.request_id = sr.id
      AND i.id IN (
        SELECT id FROM invoices
        WHERE patient_name_snapshot IS NULL
        ORDER BY id
        LIMIT batch_size OFFSET offset_val
      );

    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    EXIT WHEN rows_updated = 0;

    offset_val := offset_val + batch_size;
    RAISE NOTICE 'Invoice snapshots: processed % rows (offset: %)', rows_updated, offset_val;
    PERFORM pg_sleep(0.1);
  END LOOP;

  RAISE NOTICE 'Migration complete. Total offset reached: %', offset_val;
END $$;
