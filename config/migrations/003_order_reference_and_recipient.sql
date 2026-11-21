-- 6-digit order numbers, who each order is for, and provider gender / age groups for matching.

-- ---------------------------------------------------------------------
-- Order number: six random digits, unique, shown as #123456 and written in CliQ transfer notes
-- ---------------------------------------------------------------------
ALTER TABLE cases ADD COLUMN IF NOT EXISTS reference_number CHAR(6);

CREATE OR REPLACE FUNCTION curevie_new_case_reference() RETURNS CHAR(6)
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  candidate CHAR(6);
BEGIN
  -- Held until the calling transaction ends, so two orders can never draw the same number.
  PERFORM pg_advisory_xact_lock(hashtext('curevie_case_reference'));
  LOOP
    candidate := (100000 + floor(random() * 900000))::int::text;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM cases WHERE reference_number = candidate);
  END LOOP;
  RETURN candidate;
END
$$;

-- One statement per row, so each new number sees the ones assigned before it.
DO $$
DECLARE
  row RECORD;
BEGIN
  FOR row IN SELECT id FROM cases WHERE reference_number IS NULL ORDER BY created_at LOOP
    UPDATE cases SET reference_number = curevie_new_case_reference() WHERE id = row.id;
  END LOOP;
END
$$;

ALTER TABLE cases ALTER COLUMN reference_number SET DEFAULT curevie_new_case_reference();
ALTER TABLE cases ALTER COLUMN reference_number SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cases_reference_number ON cases(reference_number);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cases_reference_number_chk') THEN
    ALTER TABLE cases ADD CONSTRAINT cases_reference_number_chk CHECK (reference_number ~ '^[1-9][0-9]{5}$');
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- Care recipient of an order (NULL on orders placed before this migration)
-- ---------------------------------------------------------------------
ALTER TABLE cases ADD COLUMN IF NOT EXISTS recipient_gender VARCHAR(10);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS recipient_age_group VARCHAR(10);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cases_recipient_gender_chk') THEN
    ALTER TABLE cases ADD CONSTRAINT cases_recipient_gender_chk
      CHECK (recipient_gender IS NULL OR recipient_gender IN ('MALE', 'FEMALE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cases_recipient_age_group_chk') THEN
    ALTER TABLE cases ADD CONSTRAINT cases_recipient_age_group_chk
      CHECK (recipient_age_group IS NULL OR recipient_age_group IN ('CHILD', 'ADULT'));
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- Provider gender and the age groups they serve (used to rank candidates, never to block)
-- ---------------------------------------------------------------------
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS gender VARCHAR(10);
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS serves_children BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS serves_adults BOOLEAN NOT NULL DEFAULT TRUE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_providers_gender_chk') THEN
    ALTER TABLE service_providers ADD CONSTRAINT service_providers_gender_chk
      CHECK (gender IS NULL OR gender IN ('MALE', 'FEMALE'));
  END IF;
END
$$;
