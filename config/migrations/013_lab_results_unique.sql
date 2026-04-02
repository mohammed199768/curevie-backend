-- =========================================================
-- Migration 013: Unique constraint on lab_test_results
-- First removes duplicates (keeps latest), then adds constraint
-- =========================================================

BEGIN;

-- Delete duplicate rows, keeping only the latest (max id) per (request_id, lab_test_id)
DELETE FROM lab_test_results
WHERE id NOT IN (
  SELECT DISTINCT ON (request_id, lab_test_id) id
  FROM lab_test_results
  ORDER BY request_id, lab_test_id, created_at DESC NULLS LAST
);

-- Drop constraint if exists (idempotent)
ALTER TABLE lab_test_results
  DROP CONSTRAINT IF EXISTS uq_lab_results_request_test;

-- Add unique constraint
ALTER TABLE lab_test_results
  ADD CONSTRAINT uq_lab_results_request_test
  UNIQUE (request_id, lab_test_id);

COMMIT;
