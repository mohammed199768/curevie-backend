-- Migration 036: Add snapshot columns to lab_test_results
-- Applied manually on VPS on 2026-04-04
-- DO NOT re-run — columns already exist on production DB

ALTER TABLE lab_test_results
  ADD COLUMN IF NOT EXISTS test_name_snapshot       TEXT,
  ADD COLUMN IF NOT EXISTS unit_snapshot            VARCHAR(50),
  ADD COLUMN IF NOT EXISTS reference_range_snapshot TEXT;

UPDATE lab_test_results ltr
SET
  test_name_snapshot       = lt.name,
  unit_snapshot            = lt.unit,
  reference_range_snapshot = lt.reference_range
FROM lab_tests lt
WHERE lt.id = ltr.lab_test_id
  AND ltr.test_name_snapshot IS NULL;
