-- =============================================
-- Migration 022: Snapshot Locking + Audit Blobs
-- =============================================

BEGIN;

ALTER TABLE service_requests
  ADD COLUMN IF NOT EXISTS request_snapshot_payload JSONB;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS invoice_snapshot_payload JSONB;

UPDATE service_requests
SET request_snapshot_payload = jsonb_build_object(
  'version', 1,
  'captured_at', COALESCE(requested_at, created_at),
  'request', jsonb_build_object(
    'id', id,
    'request_type', request_type,
    'service_type', service_type,
    'service_id', service_id,
    'lab_test_id', lab_test_id,
    'package_id', package_id,
    'patient_id', patient_id,
    'guest_name', guest_name,
    'guest_phone', guest_phone,
    'guest_address', guest_address,
    'guest_gender', guest_gender,
    'guest_age', guest_age,
    'notes', notes,
    'requested_at', requested_at,
    'created_at', created_at
  ),
  'patient', jsonb_build_object(
    'full_name', patient_full_name_snapshot,
    'phone', patient_phone_snapshot,
    'email', patient_email_snapshot,
    'address', patient_address_snapshot,
    'gender', patient_gender_snapshot,
    'date_of_birth', patient_date_of_birth_snapshot,
    'age', patient_age_snapshot
  ),
  'service', jsonb_build_object(
    'name', service_name_snapshot,
    'description', service_description_snapshot,
    'category_name', service_category_name_snapshot,
    'price', service_price_snapshot,
    'package_components', package_components_snapshot
  ),
  'provider', jsonb_build_object(
    'assigned', jsonb_build_object(
      'id', assigned_provider_id,
      'full_name', assigned_provider_name_snapshot,
      'phone', assigned_provider_phone_snapshot,
      'type', assigned_provider_type_snapshot
    ),
    'lead', jsonb_build_object(
      'id', lead_provider_id,
      'full_name', lead_provider_name_snapshot,
      'phone', lead_provider_phone_snapshot,
      'type', lead_provider_type_snapshot
    )
  )
)
WHERE request_snapshot_payload IS NULL;

UPDATE invoices i
SET invoice_snapshot_payload = jsonb_build_object(
  'version', 1,
  'captured_at', COALESCE(i.approved_at, i.created_at),
  'invoice', jsonb_build_object(
    'id', i.id,
    'request_id', i.request_id,
    'patient_id', i.patient_id,
    'guest_name', i.guest_name,
    'coupon_id', i.coupon_id,
    'original_amount', i.original_amount,
    'vip_discount_amount', i.vip_discount_amount,
    'coupon_discount_amount', i.coupon_discount_amount,
    'points_used', i.points_used,
    'points_discount_amount', i.points_discount_amount,
    'final_amount', i.final_amount,
    'total_paid', i.total_paid,
    'remaining_amount', i.remaining_amount,
    'payment_status', i.payment_status,
    'payment_status_detail', i.payment_status_detail,
    'payment_method', i.payment_method,
    'approved_at', i.approved_at,
    'created_at', i.created_at
  ),
  'patient', jsonb_build_object(
    'name', i.patient_name_snapshot,
    'phone', i.patient_phone_snapshot,
    'address', i.patient_address_snapshot
  ),
  'service', jsonb_build_object(
    'name', i.service_name_snapshot,
    'type', i.service_type_snapshot,
    'description', i.service_description_snapshot,
    'category_name', i.service_category_name_snapshot
  ),
  'provider', jsonb_build_object(
    'name', i.provider_name_snapshot,
    'type', i.provider_type_snapshot
  )
)
WHERE i.invoice_snapshot_payload IS NULL;

CREATE OR REPLACE FUNCTION prevent_service_request_snapshot_changes()
RETURNS trigger AS $$
BEGIN
  IF OLD.patient_full_name_snapshot IS NOT NULL AND NEW.patient_full_name_snapshot IS DISTINCT FROM OLD.patient_full_name_snapshot THEN
    RAISE EXCEPTION 'patient_full_name_snapshot is immutable once set';
  END IF;
  IF OLD.patient_phone_snapshot IS NOT NULL AND NEW.patient_phone_snapshot IS DISTINCT FROM OLD.patient_phone_snapshot THEN
    RAISE EXCEPTION 'patient_phone_snapshot is immutable once set';
  END IF;
  IF OLD.patient_email_snapshot IS NOT NULL AND NEW.patient_email_snapshot IS DISTINCT FROM OLD.patient_email_snapshot THEN
    RAISE EXCEPTION 'patient_email_snapshot is immutable once set';
  END IF;
  IF OLD.patient_address_snapshot IS NOT NULL AND NEW.patient_address_snapshot IS DISTINCT FROM OLD.patient_address_snapshot THEN
    RAISE EXCEPTION 'patient_address_snapshot is immutable once set';
  END IF;
  IF OLD.patient_gender_snapshot IS NOT NULL AND NEW.patient_gender_snapshot IS DISTINCT FROM OLD.patient_gender_snapshot THEN
    RAISE EXCEPTION 'patient_gender_snapshot is immutable once set';
  END IF;
  IF OLD.patient_date_of_birth_snapshot IS NOT NULL AND NEW.patient_date_of_birth_snapshot IS DISTINCT FROM OLD.patient_date_of_birth_snapshot THEN
    RAISE EXCEPTION 'patient_date_of_birth_snapshot is immutable once set';
  END IF;
  IF OLD.patient_age_snapshot IS NOT NULL AND NEW.patient_age_snapshot IS DISTINCT FROM OLD.patient_age_snapshot THEN
    RAISE EXCEPTION 'patient_age_snapshot is immutable once set';
  END IF;
  IF OLD.service_name_snapshot IS NOT NULL AND NEW.service_name_snapshot IS DISTINCT FROM OLD.service_name_snapshot THEN
    RAISE EXCEPTION 'service_name_snapshot is immutable once set';
  END IF;
  IF OLD.service_description_snapshot IS NOT NULL AND NEW.service_description_snapshot IS DISTINCT FROM OLD.service_description_snapshot THEN
    RAISE EXCEPTION 'service_description_snapshot is immutable once set';
  END IF;
  IF OLD.service_category_name_snapshot IS NOT NULL AND NEW.service_category_name_snapshot IS DISTINCT FROM OLD.service_category_name_snapshot THEN
    RAISE EXCEPTION 'service_category_name_snapshot is immutable once set';
  END IF;
  IF OLD.service_price_snapshot IS NOT NULL AND NEW.service_price_snapshot IS DISTINCT FROM OLD.service_price_snapshot THEN
    RAISE EXCEPTION 'service_price_snapshot is immutable once set';
  END IF;
  IF OLD.package_components_snapshot IS NOT NULL AND NEW.package_components_snapshot IS DISTINCT FROM OLD.package_components_snapshot THEN
    RAISE EXCEPTION 'package_components_snapshot is immutable once set';
  END IF;
  IF OLD.assigned_provider_name_snapshot IS NOT NULL AND NEW.assigned_provider_name_snapshot IS DISTINCT FROM OLD.assigned_provider_name_snapshot THEN
    RAISE EXCEPTION 'assigned_provider_name_snapshot is immutable once set';
  END IF;
  IF OLD.assigned_provider_phone_snapshot IS NOT NULL AND NEW.assigned_provider_phone_snapshot IS DISTINCT FROM OLD.assigned_provider_phone_snapshot THEN
    RAISE EXCEPTION 'assigned_provider_phone_snapshot is immutable once set';
  END IF;
  IF OLD.assigned_provider_type_snapshot IS NOT NULL AND NEW.assigned_provider_type_snapshot IS DISTINCT FROM OLD.assigned_provider_type_snapshot THEN
    RAISE EXCEPTION 'assigned_provider_type_snapshot is immutable once set';
  END IF;
  IF OLD.lead_provider_name_snapshot IS NOT NULL AND NEW.lead_provider_name_snapshot IS DISTINCT FROM OLD.lead_provider_name_snapshot THEN
    RAISE EXCEPTION 'lead_provider_name_snapshot is immutable once set';
  END IF;
  IF OLD.lead_provider_phone_snapshot IS NOT NULL AND NEW.lead_provider_phone_snapshot IS DISTINCT FROM OLD.lead_provider_phone_snapshot THEN
    RAISE EXCEPTION 'lead_provider_phone_snapshot is immutable once set';
  END IF;
  IF OLD.lead_provider_type_snapshot IS NOT NULL AND NEW.lead_provider_type_snapshot IS DISTINCT FROM OLD.lead_provider_type_snapshot THEN
    RAISE EXCEPTION 'lead_provider_type_snapshot is immutable once set';
  END IF;
  IF OLD.request_snapshot_payload IS NOT NULL AND NEW.request_snapshot_payload IS DISTINCT FROM OLD.request_snapshot_payload THEN
    RAISE EXCEPTION 'request_snapshot_payload is immutable once set';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_invoice_snapshot_changes()
RETURNS trigger AS $$
BEGIN
  IF OLD.patient_name_snapshot IS NOT NULL AND NEW.patient_name_snapshot IS DISTINCT FROM OLD.patient_name_snapshot THEN
    RAISE EXCEPTION 'patient_name_snapshot is immutable once set';
  END IF;
  IF OLD.patient_phone_snapshot IS NOT NULL AND NEW.patient_phone_snapshot IS DISTINCT FROM OLD.patient_phone_snapshot THEN
    RAISE EXCEPTION 'patient_phone_snapshot is immutable once set';
  END IF;
  IF OLD.patient_address_snapshot IS NOT NULL AND NEW.patient_address_snapshot IS DISTINCT FROM OLD.patient_address_snapshot THEN
    RAISE EXCEPTION 'patient_address_snapshot is immutable once set';
  END IF;
  IF OLD.service_name_snapshot IS NOT NULL AND NEW.service_name_snapshot IS DISTINCT FROM OLD.service_name_snapshot THEN
    RAISE EXCEPTION 'service_name_snapshot is immutable once set';
  END IF;
  IF OLD.service_type_snapshot IS NOT NULL AND NEW.service_type_snapshot IS DISTINCT FROM OLD.service_type_snapshot THEN
    RAISE EXCEPTION 'service_type_snapshot is immutable once set';
  END IF;
  IF OLD.service_description_snapshot IS NOT NULL AND NEW.service_description_snapshot IS DISTINCT FROM OLD.service_description_snapshot THEN
    RAISE EXCEPTION 'service_description_snapshot is immutable once set';
  END IF;
  IF OLD.service_category_name_snapshot IS NOT NULL AND NEW.service_category_name_snapshot IS DISTINCT FROM OLD.service_category_name_snapshot THEN
    RAISE EXCEPTION 'service_category_name_snapshot is immutable once set';
  END IF;
  IF OLD.provider_name_snapshot IS NOT NULL AND NEW.provider_name_snapshot IS DISTINCT FROM OLD.provider_name_snapshot THEN
    RAISE EXCEPTION 'provider_name_snapshot is immutable once set';
  END IF;
  IF OLD.provider_type_snapshot IS NOT NULL AND NEW.provider_type_snapshot IS DISTINCT FROM OLD.provider_type_snapshot THEN
    RAISE EXCEPTION 'provider_type_snapshot is immutable once set';
  END IF;
  IF OLD.invoice_snapshot_payload IS NOT NULL AND NEW.invoice_snapshot_payload IS DISTINCT FROM OLD.invoice_snapshot_payload THEN
    RAISE EXCEPTION 'invoice_snapshot_payload is immutable once set';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_provider_report_snapshot_changes()
RETURNS trigger AS $$
BEGIN
  IF OLD.provider_name_snapshot IS NOT NULL AND NEW.provider_name_snapshot IS DISTINCT FROM OLD.provider_name_snapshot THEN
    RAISE EXCEPTION 'provider_name_snapshot is immutable once set';
  END IF;
  IF OLD.provider_phone_snapshot IS NOT NULL AND NEW.provider_phone_snapshot IS DISTINCT FROM OLD.provider_phone_snapshot THEN
    RAISE EXCEPTION 'provider_phone_snapshot is immutable once set';
  END IF;
  IF OLD.provider_type_snapshot IS NOT NULL AND NEW.provider_type_snapshot IS DISTINCT FROM OLD.provider_type_snapshot THEN
    RAISE EXCEPTION 'provider_type_snapshot is immutable once set';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_service_requests_snapshot_lock ON service_requests;
CREATE TRIGGER trg_service_requests_snapshot_lock
BEFORE UPDATE ON service_requests
FOR EACH ROW
EXECUTE FUNCTION prevent_service_request_snapshot_changes();

DROP TRIGGER IF EXISTS trg_invoices_snapshot_lock ON invoices;
CREATE TRIGGER trg_invoices_snapshot_lock
BEFORE UPDATE ON invoices
FOR EACH ROW
EXECUTE FUNCTION prevent_invoice_snapshot_changes();

DROP TRIGGER IF EXISTS trg_provider_reports_snapshot_lock ON request_provider_reports;
CREATE TRIGGER trg_provider_reports_snapshot_lock
BEFORE UPDATE ON request_provider_reports
FOR EACH ROW
EXECUTE FUNCTION prevent_provider_report_snapshot_changes();

COMMIT;
