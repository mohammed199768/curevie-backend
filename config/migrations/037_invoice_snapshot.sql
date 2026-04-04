-- Migration 037: Add coupon detail and payments snapshot columns to invoices
-- Applied manually on VPS on 2026-04-04
-- DO NOT re-run -- columns already exist on production DB

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS coupon_discount_type_snapshot  VARCHAR(20),
  ADD COLUMN IF NOT EXISTS coupon_discount_value_snapshot DECIMAL(10,3),
  ADD COLUMN IF NOT EXISTS payments_snapshot              JSONB;

-- Backfill coupon snapshots
UPDATE invoices i
SET
  coupon_discount_type_snapshot  = c.discount_type::text,
  coupon_discount_value_snapshot = c.discount_value
FROM coupons c
WHERE c.id = i.coupon_id
  AND i.coupon_id IS NOT NULL
  AND i.coupon_discount_type_snapshot IS NULL;

-- Backfill payments snapshot
UPDATE invoices i
SET payments_snapshot = (
  SELECT jsonb_agg(
    jsonb_build_object(
      'id',             p.id,
      'amount',         p.amount,
      'payment_method', p.payment_method,
      'payer_name',     p.payer_name,
      'notes',          p.notes,
      'created_at',     p.created_at
    )
    ORDER BY p.created_at ASC
  )
  FROM payments p
  WHERE p.invoice_id = i.id
)
WHERE i.payments_snapshot IS NULL;

-- Extend invoice snapshot immutability protection for the payments snapshot blob.
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
  IF OLD.payments_snapshot IS NOT NULL AND NEW.payments_snapshot IS DISTINCT FROM OLD.payments_snapshot THEN
    RAISE EXCEPTION 'payments_snapshot is immutable once set';
  END IF;
  IF OLD.invoice_snapshot_payload IS NOT NULL AND NEW.invoice_snapshot_payload IS DISTINCT FROM OLD.invoice_snapshot_payload THEN
    RAISE EXCEPTION 'invoice_snapshot_payload is immutable once set';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
