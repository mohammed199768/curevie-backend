-- =========================================================
-- Migration 014: Lab reference range hardening
-- Keeps legacy tables intact and adds safer constraints for
-- new writes without forcing a risky historical rewrite.
-- =========================================================

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'lab_test_reference_ranges'
      AND constraint_name = 'lab_test_reference_ranges_condition_check'
  ) THEN
    EXECUTE 'ALTER TABLE lab_test_reference_ranges DROP CONSTRAINT lab_test_reference_ranges_condition_check';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_name = 'lab_test_results'
      AND constraint_name = 'lab_test_results_flag_check'
  ) THEN
    EXECUTE 'ALTER TABLE lab_test_results DROP CONSTRAINT lab_test_results_flag_check';
  END IF;
END $$;

ALTER TABLE lab_test_reference_ranges
  ADD CONSTRAINT chk_lab_ranges_condition_valid
  CHECK (
    condition IS NULL
    OR condition IN ('pregnant', 'fasting', 'non_fasting', 'luteal', 'follicular', 'postmenopausal')
  ) NOT VALID;

ALTER TABLE lab_test_reference_ranges
  ADD CONSTRAINT chk_lab_ranges_age_order
  CHECK (age_min <= age_max) NOT VALID;

ALTER TABLE lab_test_reference_ranges
  ADD CONSTRAINT chk_lab_ranges_numeric_order
  CHECK (
    range_low IS NULL
    OR range_high IS NULL
    OR range_low <= range_high
  ) NOT VALID;

ALTER TABLE lab_test_reference_ranges
  ADD CONSTRAINT chk_lab_ranges_not_empty
  CHECK (
    range_low IS NOT NULL
    OR range_high IS NOT NULL
    OR NULLIF(BTRIM(COALESCE(range_text, '')), '') IS NOT NULL
  ) NOT VALID;

ALTER TABLE lab_test_results
  ADD CONSTRAINT chk_lab_results_flag_valid
  CHECK (
    flag IS NULL
    OR flag IN ('NORMAL', 'LOW', 'HIGH', 'ABNORMAL', 'NO_RANGE', 'PARSE_ERROR', 'EVALUATION_ERROR')
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_ranges_resolution_lookup
ON lab_test_reference_ranges (
  lab_test_id,
  gender,
  condition,
  age_min,
  age_max,
  priority DESC,
  updated_at DESC
);

COMMIT;
