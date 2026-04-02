-- =============================================
-- Migration 011: Request Workflow Foundation (Non-Breaking)
-- =============================================
-- Goals:
-- 1) Add workflow foundation for multi-provider requests
-- 2) Add request-scoped chat infrastructure
-- 3) Keep current APIs/data working without breaking existing flow
--
-- Notes:
-- - We DO NOT rename XRAY in this migration.
-- - We add forward-compatible values (e.g., RADIOLOGY) without forcing usage yet.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================
-- PART 1: Forward-Compatible Enum Extensions
-- =============================================

ALTER TYPE service_type ADD VALUE IF NOT EXISTS 'RADIOLOGY';
ALTER TYPE provider_type ADD VALUE IF NOT EXISTS 'RADIOLOGY_TECH';

-- =============================================
-- PART 2: Workflow Columns on service_requests
-- =============================================

ALTER TABLE service_requests
  ADD COLUMN IF NOT EXISTS workflow_stage VARCHAR(30) NOT NULL DEFAULT 'TRIAGE'
    CHECK (workflow_stage IN (
      'TRIAGE',
      'IN_PROGRESS',
      'WAITING_SUB_REPORTS',
      'DOCTOR_REVIEW',
      'COMPLETED',
      'PUBLISHED',
      'CANCELLED'
    )),
  ADD COLUMN IF NOT EXISTS lead_provider_id UUID REFERENCES service_providers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS final_report_confirmed_by UUID REFERENCES service_providers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS final_report_confirmed_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS workflow_updated_at TIMESTAMP DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_service_requests_workflow_stage
  ON service_requests(workflow_stage);
CREATE INDEX IF NOT EXISTS idx_service_requests_lead_provider
  ON service_requests(lead_provider_id);

-- =============================================
-- PART 3: Request Workflow Tasks
-- =============================================

CREATE TABLE IF NOT EXISTS request_workflow_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  provider_id UUID NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'ASSISTANT'
    CHECK (role IN ('LEAD_DOCTOR', 'ASSISTANT')),
  status VARCHAR(20) NOT NULL DEFAULT 'ASSIGNED'
    CHECK (status IN ('ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'SUBMITTED', 'COMPLETED', 'CANCELLED')),
  task_type VARCHAR(20) NOT NULL
    CHECK (task_type IN ('MEDICAL', 'LAB', 'XRAY', 'RADIOLOGY', 'NURSING', 'FINAL_REPORT')),
  notes TEXT,
  assigned_at TIMESTAMP DEFAULT NOW(),
  accepted_at TIMESTAMP,
  submitted_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(request_id, provider_id, task_type)
);

CREATE INDEX IF NOT EXISTS idx_workflow_tasks_request
  ON request_workflow_tasks(request_id);
CREATE INDEX IF NOT EXISTS idx_workflow_tasks_provider
  ON request_workflow_tasks(provider_id);
CREATE INDEX IF NOT EXISTS idx_workflow_tasks_status
  ON request_workflow_tasks(status);

-- =============================================
-- PART 4: Additional Orders
-- =============================================

CREATE TABLE IF NOT EXISTS request_additional_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  ordered_by UUID NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  order_type VARCHAR(20) NOT NULL
    CHECK (order_type IN ('LAB', 'XRAY', 'RADIOLOGY', 'NURSING', 'MEDICAL')),
  service_id UUID REFERENCES services(id) ON DELETE SET NULL,
  lab_test_id UUID REFERENCES lab_tests(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  priority VARCHAR(10) NOT NULL DEFAULT 'NORMAL'
    CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'ASSIGNED', 'COMPLETED', 'CANCELLED')),
  additional_cost NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (additional_cost >= 0),
  cost_approved_by UUID REFERENCES admins(id) ON DELETE SET NULL,
  cost_approved_at TIMESTAMP,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_additional_orders_request
  ON request_additional_orders(request_id);
CREATE INDEX IF NOT EXISTS idx_additional_orders_ordered_by
  ON request_additional_orders(ordered_by);
CREATE INDEX IF NOT EXISTS idx_additional_orders_status
  ON request_additional_orders(status);

-- =============================================
-- PART 5: Provider Reports
-- =============================================

CREATE TABLE IF NOT EXISTS request_provider_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  provider_id UUID NOT NULL REFERENCES service_providers(id) ON DELETE CASCADE,
  task_id UUID REFERENCES request_workflow_tasks(id) ON DELETE SET NULL,
  report_type VARCHAR(20) NOT NULL
    CHECK (report_type IN ('SUB_REPORT', 'FINAL_REPORT')),
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED')),
  symptoms_summary TEXT,
  procedures_performed TEXT,
  allergies_noted TEXT,
  findings TEXT,
  diagnosis TEXT,
  recommendations TEXT,
  treatment_plan TEXT,
  notes TEXT,
  reviewed_by UUID REFERENCES service_providers(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP,
  approved_by UUID REFERENCES admins(id) ON DELETE SET NULL,
  approved_at TIMESTAMP,
  rejection_reason TEXT,
  version INT NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(request_id, provider_id, report_type, version)
);

CREATE INDEX IF NOT EXISTS idx_provider_reports_request
  ON request_provider_reports(request_id);
CREATE INDEX IF NOT EXISTS idx_provider_reports_provider
  ON request_provider_reports(provider_id);
CREATE INDEX IF NOT EXISTS idx_provider_reports_type
  ON request_provider_reports(report_type);
CREATE INDEX IF NOT EXISTS idx_provider_reports_status
  ON request_provider_reports(status);

-- =============================================
-- PART 6: Lifecycle Events
-- =============================================

CREATE TABLE IF NOT EXISTS request_lifecycle_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  actor_id UUID,
  actor_role VARCHAR(20) NOT NULL
    CHECK (actor_role IN ('ADMIN', 'PROVIDER', 'PATIENT', 'SYSTEM')),
  actor_name VARCHAR(100),
  event_type VARCHAR(50) NOT NULL,
  description TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  workflow_stage_snapshot VARCHAR(30),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_events_request
  ON request_lifecycle_events(request_id);
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_created
  ON request_lifecycle_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lifecycle_events_type
  ON request_lifecycle_events(event_type);

-- =============================================
-- PART 7: Request-Scoped Chat
-- =============================================

CREATE TABLE IF NOT EXISTS request_chat_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  room_type VARCHAR(20) NOT NULL
    CHECK (room_type IN ('CARE_TEAM', 'PATIENT_CARE', 'DOCTOR_ADMIN', 'PROVIDER_PATIENT')),
  name VARCHAR(100),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(request_id, room_type)
);

CREATE TABLE IF NOT EXISTS request_chat_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES request_chat_rooms(id) ON DELETE CASCADE,
  participant_id UUID NOT NULL,
  participant_role VARCHAR(20) NOT NULL
    CHECK (participant_role IN ('ADMIN', 'PROVIDER', 'PATIENT')),
  joined_at TIMESTAMP DEFAULT NOW(),
  last_read_at TIMESTAMP,
  UNIQUE(room_id, participant_id, participant_role)
);

CREATE TABLE IF NOT EXISTS request_chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES request_chat_rooms(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL,
  sender_role VARCHAR(20) NOT NULL
    CHECK (sender_role IN ('ADMIN', 'PROVIDER', 'PATIENT', 'SYSTEM')),
  sender_name VARCHAR(100),
  message_type VARCHAR(20) NOT NULL DEFAULT 'TEXT'
    CHECK (message_type IN ('TEXT', 'IMAGE', 'FILE', 'SYSTEM')),
  content TEXT,
  file_url TEXT,
  file_name VARCHAR(255),
  file_size INT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_request_chat_rooms_request
  ON request_chat_rooms(request_id);
CREATE INDEX IF NOT EXISTS idx_request_chat_participants_room
  ON request_chat_participants(room_id);
CREATE INDEX IF NOT EXISTS idx_request_chat_messages_room
  ON request_chat_messages(room_id);
CREATE INDEX IF NOT EXISTS idx_request_chat_messages_created
  ON request_chat_messages(created_at DESC);

-- =============================================
-- PART 8: Invoice Extensions
-- =============================================

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS additional_orders_total NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS additional_orders_approved BOOLEAN NOT NULL DEFAULT FALSE;

-- =============================================
-- PART 9: Backfill Existing Data
-- =============================================

UPDATE service_requests
SET workflow_stage = CASE
  WHEN status = 'PENDING' THEN 'TRIAGE'
  WHEN status IN ('ASSIGNED', 'ACCEPTED') THEN 'IN_PROGRESS'
  WHEN status = 'COMPLETED' THEN 'COMPLETED'
  WHEN status = 'CANCELLED' THEN 'CANCELLED'
  ELSE 'TRIAGE'
END;

UPDATE service_requests
SET lead_provider_id = assigned_provider_id
WHERE assigned_provider_id IS NOT NULL
  AND lead_provider_id IS NULL;

INSERT INTO request_workflow_tasks (
  request_id,
  provider_id,
  role,
  status,
  task_type,
  notes
)
SELECT
  sr.id AS request_id,
  sr.assigned_provider_id AS provider_id,
  CASE WHEN sp.type = 'DOCTOR' THEN 'LEAD_DOCTOR' ELSE 'ASSISTANT' END AS role,
  CASE
    WHEN sr.status = 'COMPLETED' THEN 'COMPLETED'
    WHEN sr.status = 'CANCELLED' THEN 'CANCELLED'
    WHEN sr.status = 'ACCEPTED' THEN 'ACCEPTED'
    WHEN sr.status = 'ASSIGNED' THEN 'ASSIGNED'
    ELSE 'ASSIGNED'
  END AS status,
  CASE
    WHEN sr.service_type = 'LAB' THEN 'LAB'
    WHEN sr.service_type = 'XRAY' THEN 'XRAY'
    WHEN sr.service_type = 'RADIOLOGY' THEN 'RADIOLOGY'
    WHEN sr.service_type = 'MEDICAL' THEN 'MEDICAL'
    ELSE 'MEDICAL'
  END AS task_type,
  'Backfilled from assigned_provider_id' AS notes
FROM service_requests sr
JOIN service_providers sp ON sp.id = sr.assigned_provider_id
WHERE sr.assigned_provider_id IS NOT NULL
ON CONFLICT (request_id, provider_id, task_type) DO NOTHING;

INSERT INTO request_lifecycle_events (
  request_id,
  actor_id,
  actor_role,
  actor_name,
  event_type,
  description,
  metadata,
  workflow_stage_snapshot,
  created_at
)
SELECT
  sr.id AS request_id,
  NULL::uuid AS actor_id,
  'SYSTEM' AS actor_role,
  'System' AS actor_name,
  'MIGRATED_TO_WORKFLOW' AS event_type,
  'Request migrated to workflow foundation tables' AS description,
  jsonb_build_object('source', 'migration_011') AS metadata,
  sr.workflow_stage AS workflow_stage_snapshot,
  NOW() AS created_at
FROM service_requests sr
WHERE NOT EXISTS (
  SELECT 1
  FROM request_lifecycle_events rle
  WHERE rle.request_id = sr.id
    AND rle.event_type = 'MIGRATED_TO_WORKFLOW'
);
