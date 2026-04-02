-- AUDIT WARNING: This file contains an unsafe bulk UPDATE.
-- Use 021_historical_snapshots_SAFE.sql instead for production.
-- See CUREVIE_AUDIT_FINAL.md finding D5.
-- =============================================
-- Migration 021: Historical Snapshots + PDF Cache
-- =============================================

BEGIN;

ALTER TABLE service_requests
  ADD COLUMN IF NOT EXISTS patient_full_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS patient_phone_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS patient_email_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS patient_address_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS patient_gender_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS patient_date_of_birth_snapshot DATE,
  ADD COLUMN IF NOT EXISTS patient_age_snapshot INT,
  ADD COLUMN IF NOT EXISTS service_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS service_description_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS service_category_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS service_price_snapshot NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS package_components_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS assigned_provider_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS assigned_provider_phone_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS assigned_provider_type_snapshot VARCHAR(30),
  ADD COLUMN IF NOT EXISTS lead_provider_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS lead_provider_phone_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS lead_provider_type_snapshot VARCHAR(30);

ALTER TABLE request_provider_reports
  ADD COLUMN IF NOT EXISTS provider_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS provider_phone_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS provider_type_snapshot VARCHAR(30);

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS patient_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS patient_phone_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS patient_address_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS service_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS service_type_snapshot VARCHAR(30),
  ADD COLUMN IF NOT EXISTS service_description_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS service_category_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS provider_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS provider_type_snapshot VARCHAR(30),
  ADD COLUMN IF NOT EXISTS pdf_url TEXT,
  ADD COLUMN IF NOT EXISTS pdf_generated_at TIMESTAMPTZ;

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
WHERE sr.patient_id = p.id;

UPDATE service_requests
SET patient_full_name_snapshot = COALESCE(patient_full_name_snapshot, guest_name),
    patient_phone_snapshot = COALESCE(patient_phone_snapshot, guest_phone),
    patient_address_snapshot = COALESCE(patient_address_snapshot, guest_address),
    patient_gender_snapshot = COALESCE(patient_gender_snapshot, guest_gender),
    patient_age_snapshot = COALESCE(patient_age_snapshot, guest_age)
WHERE request_type = 'GUEST';

UPDATE service_requests sr
SET service_name_snapshot = COALESCE(sr.service_name_snapshot, svc.name),
    service_description_snapshot = COALESCE(sr.service_description_snapshot, svc.description),
    service_category_name_snapshot = COALESCE(sr.service_category_name_snapshot, svc_cat.name),
    service_price_snapshot = COALESCE(sr.service_price_snapshot, svc.price)
FROM services svc
LEFT JOIN service_categories svc_cat ON svc_cat.id = svc.category_id
WHERE sr.service_id = svc.id
  AND sr.service_type IN ('MEDICAL', 'XRAY', 'RADIOLOGY');

UPDATE service_requests sr
SET service_name_snapshot = COALESCE(sr.service_name_snapshot, lt.name),
    service_description_snapshot = COALESCE(sr.service_description_snapshot, lt.description),
    service_category_name_snapshot = COALESCE(sr.service_category_name_snapshot, lt_cat.name),
    service_price_snapshot = COALESCE(sr.service_price_snapshot, lt.cost)
FROM lab_tests lt
LEFT JOIN service_categories lt_cat ON lt_cat.id = lt.category_id
WHERE sr.lab_test_id = lt.id
  AND sr.service_type = 'LAB';

UPDATE service_requests sr
SET service_name_snapshot = COALESCE(sr.service_name_snapshot, pk.name),
    service_description_snapshot = COALESCE(sr.service_description_snapshot, pk.description),
    service_category_name_snapshot = COALESCE(sr.service_category_name_snapshot, pk_cat.name),
    service_price_snapshot = COALESCE(sr.service_price_snapshot, pk.total_cost)
FROM packages pk
LEFT JOIN service_categories pk_cat ON pk_cat.id = pk.category_id
WHERE sr.package_id = pk.id
  AND sr.service_type = 'PACKAGE';

UPDATE service_requests sr
SET assigned_provider_name_snapshot = COALESCE(sr.assigned_provider_name_snapshot, asp.full_name),
    assigned_provider_phone_snapshot = COALESCE(sr.assigned_provider_phone_snapshot, asp.phone),
    assigned_provider_type_snapshot = COALESCE(sr.assigned_provider_type_snapshot, asp.type::text)
FROM service_providers asp
WHERE sr.assigned_provider_id = asp.id;

UPDATE service_requests sr
SET lead_provider_name_snapshot = COALESCE(sr.lead_provider_name_snapshot, lsp.full_name),
    lead_provider_phone_snapshot = COALESCE(sr.lead_provider_phone_snapshot, lsp.phone),
    lead_provider_type_snapshot = COALESCE(sr.lead_provider_type_snapshot, lsp.type::text)
FROM service_providers lsp
WHERE sr.lead_provider_id = lsp.id;

UPDATE service_requests sr
SET package_components_snapshot = jsonb_build_object(
  'lab_tests',
  COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'lab_test_id', lt.id,
        'name', lt.name,
        'cost', lt.cost,
        'unit', lt.unit,
        'reference_range', lt.reference_range
      )
      ORDER BY lt.name ASC
    )
    FROM package_tests pt
    JOIN lab_tests lt ON lt.id = pt.lab_test_id
    WHERE pt.package_id = sr.package_id
  ), '[]'::jsonb),
  'services',
  COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'service_id', s.id,
        'name', s.name,
        'price', s.price,
        'description', s.description,
        'category_name', sc.name,
        'service_kind',
          CASE
            WHEN LOWER(COALESCE(s.name, '') || ' ' || COALESCE(sc.name, '')) ~ '(xray|x-ray|radiology|scan)'
            THEN 'XRAY'
            ELSE 'MEDICAL'
          END
      )
      ORDER BY s.name ASC
    )
    FROM package_services ps
    JOIN services s ON s.id = ps.service_id
    LEFT JOIN service_categories sc ON sc.id = s.category_id
    WHERE ps.package_id = sr.package_id
  ), '[]'::jsonb)
)
WHERE sr.package_id IS NOT NULL
  AND sr.package_components_snapshot IS NULL;

UPDATE request_provider_reports rpr
SET provider_name_snapshot = COALESCE(rpr.provider_name_snapshot, sp.full_name),
    provider_phone_snapshot = COALESCE(rpr.provider_phone_snapshot, sp.phone),
    provider_type_snapshot = COALESCE(rpr.provider_type_snapshot, sp.type::text)
FROM service_providers sp
WHERE rpr.provider_id = sp.id;

UPDATE invoices i
SET patient_name_snapshot = COALESCE(i.patient_name_snapshot, sr.patient_full_name_snapshot, p.full_name, sr.guest_name, i.guest_name),
    patient_phone_snapshot = COALESCE(i.patient_phone_snapshot, sr.patient_phone_snapshot, p.phone, sr.guest_phone),
    patient_address_snapshot = COALESCE(i.patient_address_snapshot, sr.patient_address_snapshot, p.address, sr.guest_address),
    service_name_snapshot = COALESCE(i.service_name_snapshot, sr.service_name_snapshot, svc.name, lt.name, pk.name),
    service_type_snapshot = COALESCE(i.service_type_snapshot, sr.service_type::text),
    service_description_snapshot = COALESCE(i.service_description_snapshot, sr.service_description_snapshot, svc.description, lt.description, pk.description),
    service_category_name_snapshot = COALESCE(i.service_category_name_snapshot, sr.service_category_name_snapshot, svc_cat.name, lt_cat.name, pk_cat.name),
    provider_name_snapshot = COALESCE(i.provider_name_snapshot, sr.assigned_provider_name_snapshot, sr.lead_provider_name_snapshot, asp.full_name, lsp.full_name),
    provider_type_snapshot = COALESCE(i.provider_type_snapshot, sr.assigned_provider_type_snapshot, sr.lead_provider_type_snapshot, asp.type::text, lsp.type::text)
FROM service_requests sr
LEFT JOIN patients p ON p.id = sr.patient_id
LEFT JOIN services svc ON svc.id = sr.service_id
LEFT JOIN service_categories svc_cat ON svc_cat.id = svc.category_id
LEFT JOIN lab_tests lt ON lt.id = sr.lab_test_id
LEFT JOIN service_categories lt_cat ON lt_cat.id = lt.category_id
LEFT JOIN packages pk ON pk.id = sr.package_id
LEFT JOIN service_categories pk_cat ON pk_cat.id = pk.category_id
LEFT JOIN service_providers asp ON asp.id = sr.assigned_provider_id
LEFT JOIN service_providers lsp ON lsp.id = sr.lead_provider_id
WHERE i.request_id = sr.id;

COMMIT;
