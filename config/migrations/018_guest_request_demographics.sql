BEGIN;

ALTER TABLE service_requests
  ADD COLUMN IF NOT EXISTS guest_gender VARCHAR(10),
  ADD COLUMN IF NOT EXISTS guest_age INT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_service_requests_guest_gender'
  ) THEN
    ALTER TABLE service_requests
      ADD CONSTRAINT chk_service_requests_guest_gender
      CHECK (guest_gender IS NULL OR guest_gender IN ('male', 'female', 'other'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_service_requests_guest_age'
  ) THEN
    ALTER TABLE service_requests
      ADD CONSTRAINT chk_service_requests_guest_age
      CHECK (guest_age IS NULL OR (guest_age >= 0 AND guest_age <= 130));
  END IF;
END $$;

COMMIT;
