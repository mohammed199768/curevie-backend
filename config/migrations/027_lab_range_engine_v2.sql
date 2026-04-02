TRUNCATE TABLE lab_test_reference_ranges CASCADE;

ALTER TABLE lab_test_reference_ranges
  DROP COLUMN IF EXISTS condition,
  ADD COLUMN fasting_state VARCHAR(20) NULL
    CHECK (fasting_state IN ('fasting', 'non_fasting')),
  ADD COLUMN cycle_phase VARCHAR(20) NULL
    CHECK (cycle_phase IN ('follicular', 'ovulatory', 'luteal', 'postmenopausal')),
  ADD COLUMN is_pregnant BOOLEAN NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'lab_result_type'
  ) THEN
    CREATE TYPE lab_result_type AS ENUM
      ('NUMERIC', 'ORDINAL', 'CATEGORICAL', 'CULTURE');
  END IF;
END $$;

ALTER TABLE lab_tests
  ADD COLUMN IF NOT EXISTS result_type lab_result_type NOT NULL DEFAULT 'NUMERIC',
  ADD COLUMN IF NOT EXISTS requires_fasting BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS requires_gender BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS requires_age BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS requires_cycle_phase BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS requires_pregnancy BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS ordinal_scale_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_test_id UUID NOT NULL REFERENCES lab_tests(id) ON DELETE CASCADE,
  value_text VARCHAR(50) NOT NULL,
  numeric_rank INTEGER NOT NULL,
  is_normal_max BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lab_test_id, value_text),
  UNIQUE (lab_test_id, numeric_rank)
);

CREATE TABLE IF NOT EXISTS culture_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_result_id UUID NOT NULL REFERENCES lab_results(id) ON DELETE CASCADE,
  growth_status VARCHAR(20) NOT NULL
    CHECK (growth_status IN ('NO_GROWTH', 'GROWTH', 'CONTAMINATED', 'PENDING')),
  organism_name VARCHAR(200) NULL,
  colony_count VARCHAR(100) NULL,
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sensitivity_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  culture_result_id UUID NOT NULL REFERENCES culture_results(id) ON DELETE CASCADE,
  antibiotic_name VARCHAR(200) NOT NULL,
  mic_value VARCHAR(50) NULL,
  interpretation VARCHAR(1) NOT NULL CHECK (interpretation IN ('S', 'I', 'R')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'lab_test_reference_ranges'::regclass
      AND contype = 'x'
  LOOP
    EXECUTE 'ALTER TABLE lab_test_reference_ranges DROP CONSTRAINT ' || quote_ident(r.conname);
  END LOOP;
END $$;

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE lab_test_reference_ranges
  ADD CONSTRAINT lab_ranges_no_overlap EXCLUDE USING gist (
    lab_test_id WITH =,
    gender WITH =,
    int4range(COALESCE(age_min, 0), COALESCE(age_max, 999), '[]') WITH &&,
    COALESCE(fasting_state, '__any__') WITH =,
    COALESCE(cycle_phase, '__any__') WITH =,
    COALESCE(is_pregnant::text, '__any__') WITH =
  );

CREATE INDEX IF NOT EXISTS idx_lab_ranges_resolve
  ON lab_test_reference_ranges
  (lab_test_id, gender, fasting_state, cycle_phase, is_pregnant, age_min, age_max);
