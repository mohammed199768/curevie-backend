BEGIN;

-- ================================================
-- STEP 1: DROP OLD TABLES
-- ================================================

DROP TABLE IF EXISTS request_chat_participants CASCADE;
DROP TABLE IF EXISTS request_chat_messages CASCADE;
DROP TABLE IF EXISTS request_chat_rooms CASCADE;
DROP TABLE IF EXISTS request_additional_orders CASCADE;
DROP TABLE IF EXISTS request_files CASCADE;
DROP TABLE IF EXISTS request_lifecycle_events CASCADE;
DROP TABLE IF EXISTS request_provider_reports CASCADE;
DROP TABLE IF EXISTS request_workflow_tasks CASCADE;
DROP TABLE IF EXISTS lab_test_results CASCADE;
DROP TABLE IF EXISTS medical_reports CASCADE;
DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS payment_records CASCADE;
DROP TABLE IF EXISTS invoices CASCADE;
DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS conversations CASCADE;
DROP TABLE IF EXISTS service_ratings CASCADE;
DROP TABLE IF EXISTS service_requests CASCADE;

-- ================================================
-- STEP 2: DROP OLD ENUMS
-- ================================================

DROP TYPE IF EXISTS request_status CASCADE;
DROP TYPE IF EXISTS request_type CASCADE;
DROP TYPE IF EXISTS service_type CASCADE;

-- ================================================
-- STEP 3: TRUNCATE KEPT TABLES
-- ================================================

TRUNCATE TABLE notifications RESTART IDENTITY CASCADE;
TRUNCATE TABLE patient_history RESTART IDENTITY CASCADE;
TRUNCATE TABLE points_log RESTART IDENTITY CASCADE;
TRUNCATE TABLE analytics_events RESTART IDENTITY CASCADE;
TRUNCATE TABLE contact_messages RESTART IDENTITY CASCADE;

-- ================================================
-- STEP 4: NEW ENUMS
-- ================================================

CREATE TYPE case_status AS ENUM (
  'PENDING',
  'ACCEPTED',
  'IN_PROGRESS',
  'COMPLETED',
  'CLOSED',
  'CANCELLED'
);

CREATE TYPE case_service_status AS ENUM (
  'PENDING',
  'ASSIGNED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED'
);

CREATE TYPE appointment_type AS ENUM (
  'INITIAL',
  'FOLLOW_UP'
);

CREATE TYPE file_type AS ENUM (
  'PDF',
  'IMAGE'
);

CREATE TYPE adjustment_type AS ENUM (
  'DISCOUNT',
  'SURCHARGE'
);

CREATE TYPE radiology_status AS ENUM (
  'PENDING',
  'ASSIGNED',
  'IN_PROGRESS',
  'COMPLETED',
  'CLOSED',
  'CANCELLED'
);

CREATE TYPE chat_sender_role AS ENUM (
  'PATIENT',
  'PROVIDER',
  'ADMIN'
);

CREATE TYPE lifecycle_actor AS ENUM (
  'PATIENT',
  'PROVIDER',
  'ADMIN',
  'SYSTEM'
);

-- ================================================
-- STEP 5: NEW TABLES
-- ================================================

-- Cases (central entity)
CREATE TABLE cases (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id          UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  package_id          UUID REFERENCES packages(id) ON DELETE SET NULL,
  lead_provider_id    UUID REFERENCES service_providers(id) ON DELETE SET NULL,
  status              case_status NOT NULL DEFAULT 'PENDING',
  notes               TEXT,
  closed_at           TIMESTAMP,
  closed_by           UUID REFERENCES admins(id) ON DELETE SET NULL,
  admin_close_notes   TEXT,
  created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Services inside a case
CREATE TABLE case_services (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id        UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  service_id     UUID NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  provider_id    UUID REFERENCES service_providers(id) ON DELETE SET NULL,
  original_price DECIMAL(10,3) NOT NULL DEFAULT 0,
  bundle_price   DECIMAL(10,3) NOT NULL DEFAULT 0,
  status         case_service_status NOT NULL DEFAULT 'PENDING',
  notes          TEXT,
  completed_at   TIMESTAMP,
  created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Appointments per service (initial + follow-ups)
CREATE TABLE case_appointments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_service_id UUID NOT NULL REFERENCES case_services(id) ON DELETE CASCADE,
  scheduled_at    TIMESTAMP NOT NULL,
  type            appointment_type NOT NULL DEFAULT 'INITIAL',
  notes           TEXT,
  created_by      UUID REFERENCES admins(id) ON DELETE SET NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Files uploaded by providers per service
CREATE TABLE case_provider_files (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_service_id UUID NOT NULL REFERENCES case_services(id) ON DELETE CASCADE,
  file_url        TEXT NOT NULL,
  file_type       file_type NOT NULL,
  is_sick_leave   BOOLEAN NOT NULL DEFAULT FALSE,
  uploaded_by     UUID NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Chat rooms: one per case_service (patient <-> provider)
CREATE TABLE case_chat_rooms (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_service_id UUID NOT NULL REFERENCES case_services(id) ON DELETE CASCADE,
  patient_id      UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  provider_id     UUID NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (case_service_id)
);

-- Chat messages (WebSocket backed)
CREATE TABLE case_chat_messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id      UUID NOT NULL REFERENCES case_chat_rooms(id) ON DELETE CASCADE,
  sender_id    UUID NOT NULL,
  sender_role  chat_sender_role NOT NULL,
  content      TEXT,
  file_url     TEXT,
  is_read      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Invoice per case
CREATE TABLE case_invoices (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id             UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  original_amount     DECIMAL(10,3) NOT NULL DEFAULT 0,
  final_amount        DECIMAL(10,3) NOT NULL DEFAULT 0,
  total_paid          DECIMAL(10,3) NOT NULL DEFAULT 0,
  remaining_amount    DECIMAL(10,3) NOT NULL DEFAULT 0,
  payment_status      payment_status NOT NULL DEFAULT 'PENDING',
  payment_method      payment_method,
  is_patient_visible  BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by         UUID REFERENCES admins(id) ON DELETE SET NULL,
  approved_at         TIMESTAMP,
  created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (case_id)
);

-- Invoice adjustments (discounts / surcharges with reason)
CREATE TABLE invoice_adjustments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  UUID NOT NULL REFERENCES case_invoices(id) ON DELETE CASCADE,
  amount      DECIMAL(10,3) NOT NULL,
  type        adjustment_type NOT NULL,
  reason      TEXT NOT NULL,
  created_by  UUID REFERENCES admins(id) ON DELETE SET NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Payment records (field collection by lead provider)
CREATE TABLE case_payment_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id         UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  recorded_by     UUID NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  amount          DECIMAL(10,3) NOT NULL,
  method          payment_method NOT NULL,
  notes           TEXT,
  approval_status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (approval_status IN ('PENDING','APPROVED','REJECTED')),
  approved_by     UUID REFERENCES admins(id) ON DELETE SET NULL,
  approved_at     TIMESTAMP,
  created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Medical report per case
CREATE TABLE medical_reports (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id                   UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  status                    VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','PUBLISHED')),
  pdf_url                   TEXT,
  sick_leave_pdf_url        TEXT,
  pdf_generation_attempts   INTEGER NOT NULL DEFAULT 0,
  pdf_last_failed_at        TIMESTAMP,
  published_at              TIMESTAMP,
  published_by              UUID REFERENCES admins(id) ON DELETE SET NULL,
  created_at                TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (case_id)
);

-- Case snapshot (write-once, admin can unlock)
CREATE TABLE case_snapshots (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id        UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  patient_data   JSONB,
  services_data  JSONB,
  providers_data JSONB,
  invoice_data   JSONB,
  package_data   JSONB,
  is_locked      BOOLEAN NOT NULL DEFAULT FALSE,
  locked_at      TIMESTAMP,
  unlocked_by    UUID REFERENCES admins(id) ON DELETE SET NULL,
  unlock_reason  TEXT,
  created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (case_id)
);

-- Radiology requests (standalone, outside cases)
CREATE TABLE radiology_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id   UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  service_id   UUID NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  provider_id  UUID REFERENCES service_providers(id) ON DELETE SET NULL,
  status       radiology_status NOT NULL DEFAULT 'PENDING',
  scheduled_at TIMESTAMP,
  notes        TEXT,
  file_url     TEXT,
  created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Lifecycle events for cases
CREATE TABLE case_lifecycle_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  actor_id    UUID,
  actor_role  lifecycle_actor NOT NULL,
  event_type  VARCHAR(60) NOT NULL,
  notes       TEXT,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ================================================
-- STEP 6: INDEXES
-- ================================================

CREATE INDEX idx_cases_patient        ON cases(patient_id);
CREATE INDEX idx_cases_status         ON cases(status);
CREATE INDEX idx_case_services_case   ON case_services(case_id);
CREATE INDEX idx_case_services_provider ON case_services(provider_id);
CREATE INDEX idx_case_appointments_service ON case_appointments(case_service_id);
CREATE INDEX idx_case_files_service   ON case_provider_files(case_service_id);
CREATE INDEX idx_case_chat_rooms_service ON case_chat_rooms(case_service_id);
CREATE INDEX idx_case_chat_messages_room ON case_chat_messages(room_id);
CREATE INDEX idx_case_chat_messages_created ON case_chat_messages(created_at);
CREATE INDEX idx_case_payment_records_case ON case_payment_records(case_id);
CREATE INDEX idx_invoice_adjustments_invoice ON invoice_adjustments(invoice_id);
CREATE INDEX idx_medical_reports_case ON medical_reports(case_id);
CREATE INDEX idx_radiology_patient    ON radiology_requests(patient_id);
CREATE INDEX idx_lifecycle_case       ON case_lifecycle_events(case_id);

-- ================================================
-- STEP 7: SNAPSHOT LOCK TRIGGER (write-once)
-- ================================================

CREATE OR REPLACE FUNCTION lock_case_snapshot()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.is_locked = TRUE AND NEW.unlocked_by IS NULL THEN
    RAISE EXCEPTION 'Case snapshot is locked and cannot be modified';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_lock_case_snapshot
  BEFORE UPDATE ON case_snapshots
  FOR EACH ROW
  EXECUTE FUNCTION lock_case_snapshot();

-- ================================================
-- STEP 8: LOG MIGRATION
-- ================================================

INSERT INTO migrations_log (filename, applied_at)
VALUES ('039_new_case_system.sql', NOW());

COMMIT;