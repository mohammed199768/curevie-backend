-- =====================================================================
-- 000_baseline.sql — Curevie consolidated schema (cases platform)
-- =====================================================================
-- This single file replaces the legacy migrations 001–042.
-- It is written to CONVERGE any database to the target schema:
--   * on an empty database it creates everything;
--   * on the existing production database (which ran the legacy chain plus
--     manual changes) it only adds what is missing, converts types, and drops
--     the tables of the retired "requests" system.
-- Every statement is idempotent: running it twice is a no-op.
-- The migration runner wraps this file in a single transaction.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------
-- Helpers (session-local, vanish when the connection closes)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.ensure_enum(type_name TEXT, labels TEXT[])
RETURNS VOID AS $$
DECLARE
  label TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = type_name) THEN
    EXECUTE format('CREATE TYPE %I AS ENUM (%s)', type_name,
      (SELECT string_agg(quote_literal(l), ', ') FROM unnest(labels) AS l));
  ELSE
    FOREACH label IN ARRAY labels LOOP
      EXECUTE format('ALTER TYPE %I ADD VALUE IF NOT EXISTS %L', type_name, label);
    END LOOP;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Adds a named constraint when no constraint with that name exists on the table.
CREATE OR REPLACE FUNCTION pg_temp.ensure_constraint(tbl TEXT, con_name TEXT, ddl TEXT)
RETURNS VOID AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = con_name AND conrelid = to_regclass(tbl)
  ) THEN
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', tbl, con_name, ddl);
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Makes sure the single-column FK tbl.col -> ref(id) exists with the wanted ON DELETE action.
-- action: 'RESTRICT' | 'CASCADE' | 'SET NULL'
CREATE OR REPLACE FUNCTION pg_temp.ensure_fk(tbl TEXT, col TEXT, ref TEXT, action TEXT)
RETURNS VOID AS $$
DECLARE
  wanted CHAR;
  r RECORD;
  ok BOOLEAN := FALSE;
BEGIN
  wanted := CASE action WHEN 'RESTRICT' THEN 'r' WHEN 'CASCADE' THEN 'c' WHEN 'SET NULL' THEN 'n' END;
  FOR r IN
    SELECT c.conname, c.confdeltype, c.confrelid
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f'
      AND c.conrelid = to_regclass(tbl)
      AND a.attname = col
      AND array_length(c.conkey, 1) = 1
  LOOP
    IF r.confdeltype = wanted AND r.confrelid = to_regclass(ref) THEN
      ok := TRUE;
    ELSE
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', tbl, r.conname);
    END IF;
  END LOOP;
  IF NOT ok THEN
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %s(id) ON DELETE %s',
      tbl, tbl || '_' || col || '_fkey', col, ref, action);
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- 1. Retire the legacy "requests" system and other dead features
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS
  request_chat_participants, request_chat_messages, request_chat_rooms,
  request_additional_orders, additional_orders, request_files,
  request_lifecycle_events, request_provider_reports, request_workflow_tasks,
  sensitivity_results, culture_results, lab_test_results, lab_results,
  payment_records, payments, invoices, messages, conversations,
  service_ratings, service_requests, radiology_requests,
  points_log, coupons
CASCADE;

DROP TYPE IF EXISTS request_status CASCADE;
DROP TYPE IF EXISTS request_type CASCADE;
DROP TYPE IF EXISTS service_type CASCADE;
DROP TYPE IF EXISTS radiology_status CASCADE;
DROP TYPE IF EXISTS discount_type CASCADE;
DROP TYPE IF EXISTS points_reason CASCADE;

-- ---------------------------------------------------------------------
-- 2. Enums
-- ---------------------------------------------------------------------
SELECT pg_temp.ensure_enum('provider_type', ARRAY['DOCTOR', 'NURSE', 'LAB_TECH', 'RADIOLOGY_TECH']);
SELECT pg_temp.ensure_enum('payment_status', ARRAY['PENDING', 'PARTIAL', 'PAID', 'CANCELLED']);
SELECT pg_temp.ensure_enum('payment_method', ARRAY['CASH', 'CARD', 'INSURANCE', 'CLICK', 'OTHER']);
SELECT pg_temp.ensure_enum('case_status', ARRAY['PENDING', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED', 'CANCELLED']);
SELECT pg_temp.ensure_enum('case_service_status', ARRAY['PENDING', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']);
SELECT pg_temp.ensure_enum('appointment_type', ARRAY['INITIAL', 'FOLLOW_UP']);
SELECT pg_temp.ensure_enum('file_type', ARRAY['PDF', 'IMAGE']);
SELECT pg_temp.ensure_enum('adjustment_type', ARRAY['DISCOUNT', 'SURCHARGE']);
SELECT pg_temp.ensure_enum('chat_sender_role', ARRAY['PATIENT', 'PROVIDER', 'ADMIN']);
SELECT pg_temp.ensure_enum('lifecycle_actor', ARRAY['PATIENT', 'PROVIDER', 'ADMIN', 'SYSTEM', 'GUEST']);
SELECT pg_temp.ensure_enum('lab_result_type', ARRAY['NUMERIC', 'ORDINAL', 'CATEGORICAL', 'CULTURE']);

-- ---------------------------------------------------------------------
-- 3. People
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admins (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name  VARCHAR(100) NOT NULL,
  email      VARCHAR(150) UNIQUE NOT NULL,
  password   VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS areas (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       VARCHAR(80) UNIQUE NOT NULL,
  name_ar    VARCHAR(120) NOT NULL,
  name_en    VARCHAR(120) NOT NULL,
  city       VARCHAR(80) NOT NULL DEFAULT 'Amman',
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS service_providers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name    VARCHAR(100) NOT NULL,
  email        VARCHAR(150) UNIQUE NOT NULL,
  password     VARCHAR(255) NOT NULL,
  phone        VARCHAR(20),
  type         provider_type NOT NULL,
  is_available BOOLEAN DEFAULT TRUE,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE service_providers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
-- is_active = account enabled by the admin; is_available = provider's own online/offline toggle.
-- Before this split the single is_available flag gated login, so the new flag inherits it once.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'service_providers' AND column_name = 'is_active'
  ) THEN
    ALTER TABLE service_providers ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE;
    UPDATE service_providers SET is_active = COALESCE(is_available, TRUE);
  END IF;
END $$;
UPDATE service_providers SET is_available = TRUE WHERE is_available IS NULL;
ALTER TABLE service_providers ALTER COLUMN is_available SET DEFAULT TRUE;
ALTER TABLE service_providers ALTER COLUMN is_available SET NOT NULL;

CREATE TABLE IF NOT EXISTS provider_areas (
  provider_id UUID NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  area_id     UUID NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider_id, area_id)
);

CREATE TABLE IF NOT EXISTS patients (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name     VARCHAR(100) NOT NULL,
  email         VARCHAR(150) UNIQUE NOT NULL,
  password      VARCHAR(255) NOT NULL,
  phone         VARCHAR(20) NOT NULL,
  address       TEXT,
  date_of_birth DATE,
  gender        VARCHAR(10),
  height        DECIMAL(5,2),
  weight        DECIMAL(5,2),
  allergies     TEXT,
  is_vip        BOOLEAN DEFAULT FALSE,
  vip_discount  DECIMAL(5,2) DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE patients ADD COLUMN IF NOT EXISTS secondary_phone VARCHAR(30);
ALTER TABLE patients ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS area_id UUID;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE patients DROP COLUMN IF EXISTS total_points;
SELECT pg_temp.ensure_fk('patients', 'area_id', 'areas', 'SET NULL');

CREATE TABLE IF NOT EXISTS patient_history (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id          UUID NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  note                TEXT NOT NULL,
  created_by_admin    UUID REFERENCES admins(id) ON DELETE SET NULL,
  created_by_provider UUID REFERENCES service_providers(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
SELECT pg_temp.ensure_fk('patient_history', 'patient_id', 'patients', 'RESTRICT');
SELECT pg_temp.ensure_fk('patient_history', 'created_by_admin', 'admins', 'SET NULL');
SELECT pg_temp.ensure_fk('patient_history', 'created_by_provider', 'service_providers', 'SET NULL');

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL,
  role       VARCHAR(20) NOT NULL CHECK (role IN ('ADMIN', 'PROVIDER', 'PATIENT')),
  token_hash CHAR(64) UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
-- Refresh tokens are stored as SHA-256 hashes; convert legacy plain-text rows once.
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS token_hash CHAR(64);
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'refresh_tokens' AND column_name = 'token'
  ) THEN
    UPDATE refresh_tokens SET token_hash = encode(digest(token, 'sha256'), 'hex') WHERE token_hash IS NULL;
    ALTER TABLE refresh_tokens DROP COLUMN token;
  END IF;
END $$;
DELETE FROM refresh_tokens WHERE token_hash IS NULL;
ALTER TABLE refresh_tokens ALTER COLUMN token_hash SET NOT NULL;
SELECT pg_temp.ensure_constraint('refresh_tokens', 'refresh_tokens_token_hash_key', 'UNIQUE (token_hash)');
DELETE FROM refresh_tokens WHERE expires_at < NOW() - INTERVAL '7 days';

-- ---------------------------------------------------------------------
-- 4. Catalog: services, packages, lab
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS services (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR(150) NOT NULL,
  description      TEXT,
  price            NUMERIC(12,3) NOT NULL,
  category_id      UUID REFERENCES service_categories(id) ON DELETE SET NULL,
  is_vip_exclusive BOOLEAN DEFAULT FALSE,
  is_active        BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE services ADD COLUMN IF NOT EXISTS name_ar VARCHAR(200);
ALTER TABLE services ADD COLUMN IF NOT EXISTS name_en VARCHAR(200);
ALTER TABLE services ADD COLUMN IF NOT EXISTS description_ar TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS description_en TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS image_url TEXT;
-- service_kind replaces the old regex-on-name guessing.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'services' AND column_name = 'service_kind'
  ) THEN
    ALTER TABLE services ADD COLUMN service_kind VARCHAR(20) NOT NULL DEFAULT 'MEDICAL';
    UPDATE services s SET service_kind = CASE
      WHEN k.label ~ '(xray|x-ray|radiology|scan|ultrasound|sonar|اشعة|أشعة|تصوير)' THEN 'RADIOLOGY'
      WHEN k.label ~ '(nurs|تمريض|ممرض)' THEN 'NURSING'
      ELSE 'MEDICAL'
    END
    FROM (
      SELECT s2.id, LOWER(COALESCE(s2.name, '') || ' ' || COALESCE(c.name, '')) AS label
      FROM services s2
      LEFT JOIN service_categories c ON c.id = s2.category_id
    ) k
    WHERE k.id = s.id;
  END IF;
END $$;
SELECT pg_temp.ensure_constraint('services', 'services_service_kind_check',
  $c$CHECK (service_kind IN ('MEDICAL', 'NURSING', 'RADIOLOGY'))$c$);
SELECT pg_temp.ensure_fk('services', 'category_id', 'service_categories', 'SET NULL');

CREATE TABLE IF NOT EXISTS lab_tests (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR(150) NOT NULL,
  description      TEXT,
  unit             VARCHAR(50),
  reference_range  VARCHAR(100),
  sample_type      VARCHAR(50),
  cost             NUMERIC(12,3) NOT NULL,
  category_id      UUID REFERENCES service_categories(id) ON DELETE SET NULL,
  is_vip_exclusive BOOLEAN DEFAULT FALSE,
  is_active        BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE lab_tests ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE lab_tests ADD COLUMN IF NOT EXISTS result_type lab_result_type NOT NULL DEFAULT 'NUMERIC';
ALTER TABLE lab_tests ADD COLUMN IF NOT EXISTS requires_fasting BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE lab_tests ADD COLUMN IF NOT EXISTS requires_gender BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE lab_tests ADD COLUMN IF NOT EXISTS requires_age BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE lab_tests ADD COLUMN IF NOT EXISTS requires_cycle_phase BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE lab_tests ADD COLUMN IF NOT EXISTS requires_pregnancy BOOLEAN NOT NULL DEFAULT FALSE;
SELECT pg_temp.ensure_fk('lab_tests', 'category_id', 'service_categories', 'SET NULL');

CREATE TABLE IF NOT EXISTS lab_test_reference_ranges (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_test_id   UUID NOT NULL REFERENCES lab_tests(id) ON DELETE CASCADE,
  gender        VARCHAR(10) DEFAULT 'any' CHECK (gender IN ('male', 'female', 'any')),
  age_min       INTEGER DEFAULT 0,
  age_max       INTEGER DEFAULT 999,
  fasting_state VARCHAR(20) CHECK (fasting_state IN ('fasting', 'non_fasting')),
  cycle_phase   VARCHAR(20) CHECK (cycle_phase IN ('follicular', 'ovulatory', 'luteal', 'postmenopausal')),
  is_pregnant   BOOLEAN,
  range_low     DECIMAL(12,4),
  range_high    DECIMAL(12,4),
  range_text    TEXT,
  unit          VARCHAR(50),
  notes         TEXT,
  priority      INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE lab_test_reference_ranges ADD COLUMN IF NOT EXISTS fasting_state VARCHAR(20);
ALTER TABLE lab_test_reference_ranges ADD COLUMN IF NOT EXISTS cycle_phase VARCHAR(20);
ALTER TABLE lab_test_reference_ranges ADD COLUMN IF NOT EXISTS is_pregnant BOOLEAN;
SELECT pg_temp.ensure_constraint('lab_test_reference_ranges', 'chk_lab_ranges_age_order', 'CHECK (age_min <= age_max)');
SELECT pg_temp.ensure_constraint('lab_test_reference_ranges', 'chk_lab_ranges_numeric_order',
  'CHECK (range_low IS NULL OR range_high IS NULL OR range_low <= range_high)');
-- The no-overlap rule is added only when no exclusion constraint exists yet (fresh installs).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'lab_test_reference_ranges'::regclass AND contype = 'x'
  ) THEN
    ALTER TABLE lab_test_reference_ranges
      ADD CONSTRAINT lab_ranges_no_overlap EXCLUDE USING gist (
        lab_test_id WITH =,
        gender WITH =,
        int4range(COALESCE(age_min, 0), COALESCE(age_max, 999), '[]') WITH &&,
        COALESCE(fasting_state, '__any__') WITH =,
        COALESCE(cycle_phase, '__any__') WITH =,
        COALESCE(is_pregnant::text, '__any__') WITH =
      );
  END IF;
END $$;
ALTER TABLE lab_test_reference_ranges DROP COLUMN IF EXISTS condition;

CREATE TABLE IF NOT EXISTS ordinal_scale_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_test_id   UUID NOT NULL REFERENCES lab_tests(id) ON DELETE CASCADE,
  value_text    VARCHAR(50) NOT NULL,
  numeric_rank  INTEGER NOT NULL,
  is_normal_max BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lab_test_id, value_text),
  UNIQUE (lab_test_id, numeric_rank)
);

CREATE TABLE IF NOT EXISTS lab_panels (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR(200),
  name_en          VARCHAR(200) NOT NULL,
  name_ar          VARCHAR(200) NOT NULL,
  description_en   TEXT,
  description_ar   TEXT,
  price            NUMERIC(12,3) NOT NULL,
  sample_types     TEXT,
  turnaround_hours INT,
  is_active        BOOLEAN DEFAULT TRUE,
  is_vip_exclusive BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE lab_panels ADD COLUMN IF NOT EXISTS name VARCHAR(200);

CREATE TABLE IF NOT EXISTS lab_panel_tests (
  panel_id      UUID NOT NULL REFERENCES lab_panels(id) ON DELETE CASCADE,
  lab_test_id   UUID NOT NULL REFERENCES lab_tests(id) ON DELETE CASCADE,
  display_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (panel_id, lab_test_id)
);
ALTER TABLE lab_panel_tests ADD COLUMN IF NOT EXISTS display_order INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS lab_packages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR(200),
  name_en          VARCHAR(200) NOT NULL,
  name_ar          VARCHAR(200) NOT NULL,
  description_en   TEXT,
  description_ar   TEXT,
  price            NUMERIC(12,3) NOT NULL,
  workflow_items   JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active        BOOLEAN DEFAULT TRUE,
  is_vip_exclusive BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE lab_packages ADD COLUMN IF NOT EXISTS name VARCHAR(200);
ALTER TABLE lab_packages ADD COLUMN IF NOT EXISTS workflow_items JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS lab_package_tests (
  package_id  UUID NOT NULL REFERENCES lab_packages(id) ON DELETE CASCADE,
  lab_test_id UUID NOT NULL REFERENCES lab_tests(id) ON DELETE CASCADE,
  PRIMARY KEY (package_id, lab_test_id)
);

CREATE TABLE IF NOT EXISTS lab_package_panels (
  package_id UUID NOT NULL REFERENCES lab_packages(id) ON DELETE CASCADE,
  panel_id   UUID NOT NULL REFERENCES lab_panels(id) ON DELETE CASCADE,
  PRIMARY KEY (package_id, panel_id)
);

-- Some production rows were written with a duplicate "test_id" column next to lab_test_id.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['lab_panel_tests', 'lab_package_tests'] LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'test_id'
    ) THEN
      EXECUTE format('UPDATE %I SET lab_test_id = test_id WHERE lab_test_id IS NULL AND test_id IS NOT NULL', t);
      EXECUTE format('ALTER TABLE %I DROP COLUMN test_id CASCADE', t);
    END IF;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS packages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR(150) NOT NULL,
  description      TEXT,
  total_cost       NUMERIC(12,3) NOT NULL,
  workflow_items   JSONB NOT NULL DEFAULT '[]'::jsonb,
  times_ordered    INT DEFAULT 0,
  category_id      UUID REFERENCES service_categories(id) ON DELETE SET NULL,
  is_vip_exclusive BOOLEAN DEFAULT FALSE,
  is_active        BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE packages ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE packages ADD COLUMN IF NOT EXISTS workflow_items JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE packages ADD COLUMN IF NOT EXISTS times_ordered INT DEFAULT 0;
SELECT pg_temp.ensure_fk('packages', 'category_id', 'service_categories', 'SET NULL');

CREATE TABLE IF NOT EXISTS package_tests (
  package_id  UUID NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  lab_test_id UUID NOT NULL REFERENCES lab_tests(id) ON DELETE CASCADE,
  PRIMARY KEY (package_id, lab_test_id)
);

CREATE TABLE IF NOT EXISTS package_services (
  package_id UUID NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (package_id, service_id)
);

-- ---------------------------------------------------------------------
-- 5. Cases (the order lifecycle)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cases (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id          UUID REFERENCES patients(id) ON DELETE RESTRICT,
  guest_name          VARCHAR(100),
  guest_phone         VARCHAR(30),
  guest_address       TEXT,
  area_id             UUID REFERENCES areas(id) ON DELETE SET NULL,
  address             TEXT,
  scheduled_for       TIMESTAMPTZ,
  tracking_token_hash CHAR(64) UNIQUE,
  lead_provider_id    UUID REFERENCES service_providers(id) ON DELETE SET NULL,
  status              case_status NOT NULL DEFAULT 'PENDING',
  notes               TEXT,
  cancelled_at        TIMESTAMPTZ,
  cancelled_by        UUID,
  cancelled_by_role   VARCHAR(20),
  cancel_reason       TEXT,
  closed_at           TIMESTAMPTZ,
  closed_by           UUID REFERENCES admins(id) ON DELETE SET NULL,
  admin_close_notes   TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS guest_name VARCHAR(100);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS guest_phone VARCHAR(30);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS guest_address TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS area_id UUID;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS tracking_token_hash CHAR(64);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS cancelled_by UUID;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS cancelled_by_role VARCHAR(20);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE cases ALTER COLUMN patient_id DROP NOT NULL;
UPDATE cases SET address = COALESCE(address, guest_address) WHERE address IS NULL AND guest_address IS NOT NULL;
SELECT pg_temp.ensure_fk('cases', 'patient_id', 'patients', 'RESTRICT');
SELECT pg_temp.ensure_fk('cases', 'area_id', 'areas', 'SET NULL');
SELECT pg_temp.ensure_fk('cases', 'lead_provider_id', 'service_providers', 'SET NULL');
SELECT pg_temp.ensure_fk('cases', 'closed_by', 'admins', 'SET NULL');
SELECT pg_temp.ensure_constraint('cases', 'cases_tracking_token_hash_key', 'UNIQUE (tracking_token_hash)');
SELECT pg_temp.ensure_constraint('cases', 'cases_owner_check',
  'CHECK (patient_id IS NOT NULL OR (guest_name IS NOT NULL AND guest_phone IS NOT NULL)) NOT VALID');
-- Packages are now ordered as line items; the old case-level package column is removed once empty.
DO $$
DECLARE
  in_use BOOLEAN;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cases' AND column_name = 'package_id'
  ) THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM cases WHERE package_id IS NOT NULL)' INTO in_use;
    IF NOT in_use THEN
      ALTER TABLE cases DROP COLUMN package_id;
    END IF;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS case_services (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id        UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  item_type      VARCHAR(20) NOT NULL DEFAULT 'SERVICE',
  service_id     UUID REFERENCES services(id) ON DELETE RESTRICT,
  lab_test_id    UUID REFERENCES lab_tests(id) ON DELETE RESTRICT,
  lab_panel_id   UUID REFERENCES lab_panels(id) ON DELETE RESTRICT,
  lab_package_id UUID REFERENCES lab_packages(id) ON DELETE RESTRICT,
  package_id     UUID REFERENCES packages(id) ON DELETE RESTRICT,
  item_name      VARCHAR(200),
  provider_id    UUID REFERENCES service_providers(id) ON DELETE RESTRICT,
  original_price NUMERIC(12,3) NOT NULL DEFAULT 0,
  bundle_price   NUMERIC(12,3) NOT NULL DEFAULT 0,
  status         case_service_status NOT NULL DEFAULT 'PENDING',
  notes          TEXT,
  assigned_at    TIMESTAMPTZ,
  accepted_at    TIMESTAMPTZ,
  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  cancelled_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE case_services ADD COLUMN IF NOT EXISTS item_type VARCHAR(20) NOT NULL DEFAULT 'SERVICE';
ALTER TABLE case_services ADD COLUMN IF NOT EXISTS lab_test_id UUID;
ALTER TABLE case_services ADD COLUMN IF NOT EXISTS lab_panel_id UUID;
ALTER TABLE case_services ADD COLUMN IF NOT EXISTS lab_package_id UUID;
ALTER TABLE case_services ADD COLUMN IF NOT EXISTS package_id UUID;
ALTER TABLE case_services ADD COLUMN IF NOT EXISTS item_name VARCHAR(200);
ALTER TABLE case_services ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;
ALTER TABLE case_services ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
ALTER TABLE case_services ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE case_services ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE case_services ALTER COLUMN service_id DROP NOT NULL;
UPDATE case_services cs SET item_name = s.name
FROM services s
WHERE cs.item_name IS NULL AND s.id = cs.service_id;
SELECT pg_temp.ensure_fk('case_services', 'service_id', 'services', 'RESTRICT');
SELECT pg_temp.ensure_fk('case_services', 'lab_test_id', 'lab_tests', 'RESTRICT');
SELECT pg_temp.ensure_fk('case_services', 'lab_panel_id', 'lab_panels', 'RESTRICT');
SELECT pg_temp.ensure_fk('case_services', 'lab_package_id', 'lab_packages', 'RESTRICT');
SELECT pg_temp.ensure_fk('case_services', 'package_id', 'packages', 'RESTRICT');
SELECT pg_temp.ensure_fk('case_services', 'provider_id', 'service_providers', 'RESTRICT');
SELECT pg_temp.ensure_constraint('case_services', 'case_services_item_check', $c$CHECK (
  (item_type = 'SERVICE'     AND service_id     IS NOT NULL AND lab_test_id IS NULL AND lab_panel_id IS NULL AND lab_package_id IS NULL AND package_id IS NULL)
  OR (item_type = 'LAB_TEST'    AND lab_test_id    IS NOT NULL AND service_id IS NULL AND lab_panel_id IS NULL AND lab_package_id IS NULL AND package_id IS NULL)
  OR (item_type = 'LAB_PANEL'   AND lab_panel_id   IS NOT NULL AND service_id IS NULL AND lab_test_id IS NULL AND lab_package_id IS NULL AND package_id IS NULL)
  OR (item_type = 'LAB_PACKAGE' AND lab_package_id IS NOT NULL AND service_id IS NULL AND lab_test_id IS NULL AND lab_panel_id IS NULL AND package_id IS NULL)
  OR (item_type = 'PACKAGE'     AND package_id     IS NOT NULL AND service_id IS NULL AND lab_test_id IS NULL AND lab_panel_id IS NULL AND lab_package_id IS NULL)
)$c$);
SELECT pg_temp.ensure_constraint('case_services', 'case_services_price_check',
  'CHECK (original_price >= 0 AND bundle_price >= 0)');

CREATE TABLE IF NOT EXISTS case_service_ratings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_service_id UUID NOT NULL UNIQUE REFERENCES case_services(id) ON DELETE CASCADE,
  case_id         UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  patient_id      UUID NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  provider_id     UUID NOT NULL REFERENCES service_providers(id) ON DELETE RESTRICT,
  rating          SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS case_appointments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_service_id UUID NOT NULL REFERENCES case_services(id) ON DELETE CASCADE,
  scheduled_at    TIMESTAMPTZ NOT NULL,
  type            appointment_type NOT NULL DEFAULT 'INITIAL',
  notes           TEXT,
  created_by      UUID REFERENCES admins(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS case_provider_files (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_service_id UUID NOT NULL REFERENCES case_services(id) ON DELETE CASCADE,
  file_url        TEXT NOT NULL,
  file_type       file_type NOT NULL,
  is_sick_leave   BOOLEAN NOT NULL DEFAULT FALSE,
  uploaded_by     UUID NOT NULL REFERENCES service_providers(id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE case_provider_files ADD COLUMN IF NOT EXISTS original_name VARCHAR(255);
ALTER TABLE case_provider_files ADD COLUMN IF NOT EXISTS mime_type VARCHAR(100);
ALTER TABLE case_provider_files ADD COLUMN IF NOT EXISTS size_bytes INTEGER;
SELECT pg_temp.ensure_fk('case_provider_files', 'uploaded_by', 'service_providers', 'RESTRICT');

CREATE TABLE IF NOT EXISTS case_chat_rooms (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_service_id UUID NOT NULL UNIQUE REFERENCES case_services(id) ON DELETE CASCADE,
  patient_id      UUID NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  provider_id     UUID NOT NULL REFERENCES service_providers(id) ON DELETE RESTRICT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
SELECT pg_temp.ensure_fk('case_chat_rooms', 'patient_id', 'patients', 'RESTRICT');
SELECT pg_temp.ensure_fk('case_chat_rooms', 'provider_id', 'service_providers', 'RESTRICT');

CREATE TABLE IF NOT EXISTS case_chat_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id     UUID NOT NULL REFERENCES case_chat_rooms(id) ON DELETE CASCADE,
  sender_id   UUID NOT NULL,
  sender_role chat_sender_role NOT NULL,
  content     TEXT,
  file_url    TEXT,
  is_read     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE case_chat_messages ADD COLUMN IF NOT EXISTS file_name VARCHAR(255);
ALTER TABLE case_chat_messages ADD COLUMN IF NOT EXISTS file_mime VARCHAR(100);

CREATE TABLE IF NOT EXISTS case_invoices (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id            UUID NOT NULL UNIQUE REFERENCES cases(id) ON DELETE CASCADE,
  original_amount    NUMERIC(12,3) NOT NULL DEFAULT 0,
  final_amount       NUMERIC(12,3) NOT NULL DEFAULT 0,
  total_paid         NUMERIC(12,3) NOT NULL DEFAULT 0,
  remaining_amount   NUMERIC(12,3) NOT NULL DEFAULT 0,
  payment_status     payment_status NOT NULL DEFAULT 'PENDING',
  payment_method     payment_method,
  is_patient_visible BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by        UUID REFERENCES admins(id) ON DELETE SET NULL,
  approved_at        TIMESTAMPTZ,
  finalized_at       TIMESTAMPTZ,
  finalized_by       UUID REFERENCES admins(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE case_invoices ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ;
ALTER TABLE case_invoices ADD COLUMN IF NOT EXISTS finalized_by UUID;
SELECT pg_temp.ensure_fk('case_invoices', 'finalized_by', 'admins', 'SET NULL');

CREATE TABLE IF NOT EXISTS invoice_adjustments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES case_invoices(id) ON DELETE CASCADE,
  amount     NUMERIC(12,3) NOT NULL CHECK (amount > 0),
  type       adjustment_type NOT NULL,
  reason     TEXT NOT NULL,
  created_by UUID REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS case_payment_records (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id          UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  invoice_id       UUID REFERENCES case_invoices(id) ON DELETE CASCADE,
  recorded_by      UUID NOT NULL,
  recorded_by_role VARCHAR(20) NOT NULL DEFAULT 'ADMIN' CHECK (recorded_by_role IN ('ADMIN', 'PROVIDER')),
  amount           NUMERIC(12,3) NOT NULL CHECK (amount > 0),
  method           payment_method NOT NULL,
  notes            TEXT,
  approval_status  VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (approval_status IN ('PENDING', 'APPROVED', 'REJECTED')),
  approved_by      UUID REFERENCES admins(id) ON DELETE SET NULL,
  approved_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- recorded_by is polymorphic (admin or provider); the legacy FK to service_providers blocked admins.
ALTER TABLE case_payment_records DROP CONSTRAINT IF EXISTS case_payment_records_recorded_by_fkey;
ALTER TABLE case_payment_records ADD COLUMN IF NOT EXISTS recorded_by_role VARCHAR(20) NOT NULL DEFAULT 'ADMIN';
ALTER TABLE case_payment_records ADD COLUMN IF NOT EXISTS invoice_id UUID;
SELECT pg_temp.ensure_fk('case_payment_records', 'invoice_id', 'case_invoices', 'CASCADE');
UPDATE case_payment_records p SET invoice_id = i.id
FROM case_invoices i
WHERE p.invoice_id IS NULL AND i.case_id = p.case_id;
UPDATE case_payment_records p SET recorded_by_role = 'PROVIDER'
WHERE p.recorded_by_role = 'ADMIN'
  AND NOT EXISTS (SELECT 1 FROM admins a WHERE a.id = p.recorded_by)
  AND EXISTS (SELECT 1 FROM service_providers sp WHERE sp.id = p.recorded_by);

CREATE TABLE IF NOT EXISTS medical_reports (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                 UUID NOT NULL UNIQUE REFERENCES cases(id) ON DELETE CASCADE,
  status                  VARCHAR(20) NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED')),
  pdf_url                 TEXT,
  sick_leave_pdf_url      TEXT,
  pdf_generation_attempts INTEGER NOT NULL DEFAULT 0,
  pdf_last_failed_at      TIMESTAMPTZ,
  published_at            TIMESTAMPTZ,
  published_by            UUID REFERENCES admins(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS case_snapshots (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id        UUID NOT NULL UNIQUE REFERENCES cases(id) ON DELETE CASCADE,
  patient_data   JSONB,
  services_data  JSONB,
  providers_data JSONB,
  invoice_data   JSONB,
  package_data   JSONB,
  is_locked      BOOLEAN NOT NULL DEFAULT FALSE,
  locked_at      TIMESTAMPTZ,
  unlocked_by    UUID REFERENCES admins(id) ON DELETE SET NULL,
  unlock_reason  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION lock_case_snapshot()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.is_locked = TRUE AND NEW.unlocked_by IS NULL THEN
    RAISE EXCEPTION 'Case snapshot is locked and cannot be modified';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_lock_case_snapshot ON case_snapshots;
CREATE TRIGGER trg_lock_case_snapshot
  BEFORE UPDATE ON case_snapshots
  FOR EACH ROW EXECUTE FUNCTION lock_case_snapshot();

CREATE TABLE IF NOT EXISTS case_lifecycle_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id    UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  actor_id   UUID,
  actor_role lifecycle_actor NOT NULL,
  event_type VARCHAR(60) NOT NULL,
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE case_lifecycle_events ADD COLUMN IF NOT EXISTS case_service_id UUID;

-- ---------------------------------------------------------------------
-- 6. Notifications, analytics, contact
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL,
  user_role  VARCHAR(20) NOT NULL CHECK (user_role IN ('ADMIN', 'PROVIDER', 'PATIENT')),
  type       VARCHAR(50) NOT NULL,
  title      VARCHAR(200) NOT NULL,
  body       TEXT NOT NULL,
  data       JSONB,
  is_read    BOOLEAN DEFAULT FALSE,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS analytics_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   VARCHAR(60) NOT NULL,
  pathname     VARCHAR(500),
  locale       VARCHAR(10),
  service_slug VARCHAR(100),
  service_kind VARCHAR(50),
  channel      VARCHAR(50),
  referrer     VARCHAR(500),
  utm_source   VARCHAR(200),
  utm_medium   VARCHAR(200),
  utm_campaign VARCHAR(200),
  user_agent   VARCHAR(500),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contact_messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       VARCHAR(150) NOT NULL,
  email      VARCHAR(255) NOT NULL,
  phone      VARCHAR(30),
  message    TEXT NOT NULL,
  is_read    BOOLEAN DEFAULT FALSE,
  read_by    UUID REFERENCES admins(id) ON DELETE SET NULL,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- 7. Type normalisation for existing databases
-- ---------------------------------------------------------------------
-- Every naive timestamp becomes TIMESTAMPTZ. Values were written by NOW() on UTC servers.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.data_type = 'timestamp without time zone'
  LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE TIMESTAMPTZ USING %I AT TIME ZONE ''UTC''',
      r.table_name, r.column_name, r.column_name);
  END LOOP;
END $$;

-- Money is stored with JOD precision (3 decimals) everywhere.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('services', 'price'), ('lab_tests', 'cost'), ('lab_panels', 'price'),
      ('lab_packages', 'price'), ('packages', 'total_cost'),
      ('case_services', 'original_price'), ('case_services', 'bundle_price'),
      ('case_invoices', 'original_amount'), ('case_invoices', 'final_amount'),
      ('case_invoices', 'total_paid'), ('case_invoices', 'remaining_amount'),
      ('invoice_adjustments', 'amount'), ('case_payment_records', 'amount')
    ) AS m(tbl, col)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = r.tbl AND column_name = r.col
        AND data_type = 'numeric' AND numeric_precision = 12 AND numeric_scale = 3
    ) THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE NUMERIC(12,3)', r.tbl, r.col);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------
-- 8. Indexes
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id, role);
CREATE INDEX IF NOT EXISTS idx_patients_created_at ON patients(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_patients_phone ON patients(phone);
CREATE INDEX IF NOT EXISTS idx_patient_history_patient ON patient_history(patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_providers_type ON service_providers(type) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_provider_areas_area ON provider_areas(area_id);
CREATE INDEX IF NOT EXISTS idx_services_kind ON services(service_kind) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_lab_ranges_resolve ON lab_test_reference_ranges
  (lab_test_id, gender, fasting_state, cycle_phase, is_pregnant, age_min, age_max);
CREATE INDEX IF NOT EXISTS idx_lab_panel_tests_test ON lab_panel_tests(lab_test_id);
CREATE INDEX IF NOT EXISTS idx_lab_package_tests_test ON lab_package_tests(lab_test_id);
CREATE INDEX IF NOT EXISTS idx_package_services_service ON package_services(service_id);
CREATE INDEX IF NOT EXISTS idx_cases_patient ON cases(patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cases_created_at ON cases(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cases_lead_provider ON cases(lead_provider_id);
CREATE INDEX IF NOT EXISTS idx_cases_area ON cases(area_id);
CREATE INDEX IF NOT EXISTS idx_case_services_case ON case_services(case_id);
CREATE INDEX IF NOT EXISTS idx_case_services_provider ON case_services(provider_id, status);
CREATE INDEX IF NOT EXISTS idx_case_service_ratings_provider ON case_service_ratings(provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_case_appointments_service ON case_appointments(case_service_id);
CREATE INDEX IF NOT EXISTS idx_case_files_service ON case_provider_files(case_service_id);
CREATE INDEX IF NOT EXISTS idx_case_chat_rooms_patient ON case_chat_rooms(patient_id);
CREATE INDEX IF NOT EXISTS idx_case_chat_rooms_provider ON case_chat_rooms(provider_id);
CREATE INDEX IF NOT EXISTS idx_case_chat_messages_room ON case_chat_messages(room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_case_chat_messages_unread ON case_chat_messages(room_id) WHERE is_read = FALSE;
CREATE INDEX IF NOT EXISTS idx_case_payment_records_invoice ON case_payment_records(invoice_id);
CREATE INDEX IF NOT EXISTS idx_case_payment_records_case ON case_payment_records(case_id, created_at);
CREATE INDEX IF NOT EXISTS idx_invoice_adjustments_invoice ON invoice_adjustments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_case_invoices_status ON case_invoices(payment_status);
CREATE INDEX IF NOT EXISTS idx_lifecycle_case ON case_lifecycle_events(case_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, user_role, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, user_role) WHERE is_read = FALSE;
CREATE INDEX IF NOT EXISTS idx_analytics_events_type ON analytics_events(event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at ON analytics_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_messages_created ON contact_messages(created_at DESC);

-- ---------------------------------------------------------------------
-- 9. Reference data: service areas (Amman districts)
-- ---------------------------------------------------------------------
INSERT INTO areas (slug, name_ar, name_en, sort_order) VALUES
  ('abdoun', 'عبدون', 'Abdoun', 1),
  ('abu_nsair', 'أبو نصير', 'Abu Nsair', 2),
  ('gandaweel', 'الجاندويل', 'Gandaweel', 3),
  ('ain_al_basha', 'عين الباشا', 'Ain Al Basha', 4),
  ('abdali', 'العبدلي', 'Abdali', 5),
  ('tariq', 'طارق', 'Tariq', 6),
  ('rabia', 'الرابية', 'Al Rabia', 7),
  ('rusaifeh', 'الرصيفة', 'Al Rusaifeh', 8),
  ('shmeisani', 'شميساني', 'Shmeisani', 9),
  ('sweileh', 'صويلح', 'Sweileh', 10),
  ('tla_ali', 'تلاع العلي', 'Tla'' Al Ali', 11),
  ('um_uthaina', 'أم أذينة', 'Um Uthaina', 12),
  ('wadi_seer', 'وادي السير', 'Wadi Al Seer', 13),
  ('marka', 'ماركا', 'Marka', 14),
  ('zarqa', 'الزرقاء', 'Al Zarqa', 15),
  ('juwaida', 'الجويدة', 'Al Juwaida', 16),
  ('seventh_circle', 'الدوار السابع', '7th Circle', 17),
  ('eighth_circle', 'الدوار الثامن', '8th Circle', 18),
  ('khalda', 'خلدا', 'Khalda', 19),
  ('marj_hamam', 'مرج الحمام', 'Marj Al Hamam', 20),
  ('naour', 'ناعور', 'Naour', 21),
  ('jubaiha', 'الجبيهة', 'Al Jubaiha', 22),
  ('gardens', 'الجاردنز', 'The Gardens', 23),
  ('seventh', 'السابع', 'Al Sabe''', 24),
  ('muqabaleen', 'المقابلين', 'Al Muqabaleen', 25),
  ('hashmi_shamali', 'الهاشمي الشمالي', 'Hashmi Shamali', 26),
  ('hashmi_janubi', 'الهاشمي الجنوبي', 'Hashmi Janubi', 27),
  ('nuzhah', 'النزهة', 'Al Nuzhah', 28),
  ('bayader', 'البيادر', 'Al Bayader', 29),
  ('abu_alanda', 'أبو علندا', 'Abu Alanda', 30),
  ('qweismeh', 'القويسمة', 'Al Qweismeh', 31),
  ('tanib', 'الطنيب', 'Al Tanib', 32),
  ('muwaqqar', 'الموقر', 'Al Muwaqqar', 33),
  ('ashrafieh', 'الأشرفية', 'Al Ashrafieh', 34),
  ('jabal_hussein', 'جبل الحسين', 'Jabal Al Hussein', 35),
  ('jabal_amman', 'جبل عمان', 'Jabal Amman', 36),
  ('luweibdeh', 'جبل اللويبدة', 'Jabal Al Luweibdeh', 37),
  ('downtown', 'الوسط', 'Downtown', 38),
  ('sports_city', 'المدينة الرياضية', 'Sports City', 39)
ON CONFLICT (slug) DO NOTHING;
