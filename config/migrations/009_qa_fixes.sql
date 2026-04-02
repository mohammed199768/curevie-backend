-- =============================================
-- Migration 009: QA Audit Fixes
-- =============================================
-- NOTE: ALTER TYPE ... ADD VALUE should run outside an explicit BEGIN/COMMIT
-- block on older PostgreSQL versions.

-- 1) Extend payment_method enum to match payments route values
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'CLICK';
ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'OTHER';

-- 2) Ensure CANCELLED exists in payment_status enum
ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'CANCELLED';

-- 3) Add missing indexes identified in QA audit
CREATE INDEX IF NOT EXISTS idx_requests_service ON service_requests(service_id);
CREATE INDEX IF NOT EXISTS idx_requests_lab_test ON service_requests(lab_test_id);
CREATE INDEX IF NOT EXISTS idx_requests_package ON service_requests(package_id);
CREATE INDEX IF NOT EXISTS idx_invoices_coupon ON invoices(coupon_id);
CREATE INDEX IF NOT EXISTS idx_coupons_code ON coupons(code);
CREATE INDEX IF NOT EXISTS idx_patient_history_patient ON patient_history(patient_id);

-- 4) Unique index to support bulk range upsert de-duplication
CREATE UNIQUE INDEX IF NOT EXISTS idx_ranges_unique_combo
ON lab_test_reference_ranges (
  lab_test_id,
  gender,
  age_min,
  age_max,
  COALESCE(condition, ''),
  COALESCE(range_low::text, ''),
  COALESCE(range_high::text, ''),
  COALESCE(range_text, ''),
  COALESCE(unit, '')
);
