-- AUDIT-FIX: D3 — date_of_birth and gender must not be null
-- These fields are required by the lab evaluation engine (resolveRange)
-- Run this only after ensuring all existing patients have these values populated

-- Step 1: Check how many patients are missing these values
-- SELECT COUNT(*) FROM patients WHERE date_of_birth IS NULL OR gender IS NULL;
-- If count > 0, decide on default values before running Step 2.

-- Step 2: Add NOT NULL constraints (uncomment after verifying Step 1)
-- ALTER TABLE patients
--   ALTER COLUMN date_of_birth SET NOT NULL,
--   ALTER COLUMN gender SET NOT NULL;
