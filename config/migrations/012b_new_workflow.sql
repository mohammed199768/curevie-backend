-- ============================================================
-- Migration 012: New Workflow - Payment Records + Report Fields
-- Run: psql -U postgres -d medical_platform -f config/migrations/012_new_workflow.sql
-- ============================================================

BEGIN;
COMMIT;

-- Note: ALTER TYPE may not run inside a transaction on some PostgreSQL versions.
ALTER TYPE request_status ADD VALUE IF NOT EXISTS 'IN_PROGRESS' AFTER 'ASSIGNED';
ALTER TYPE request_status ADD VALUE IF NOT EXISTS 'CLOSED' AFTER 'COMPLETED';

BEGIN;

-- 1. New columns on service_requests
ALTER TABLE service_requests
  ADD COLUMN IF NOT EXISTS in_progress_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at_new TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_by UUID REFERENCES admins(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS admin_close_notes TEXT,
  ADD COLUMN IF NOT EXISTS collected_amount NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS collection_method TEXT,
  ADD COLUMN IF NOT EXISTS collected_method TEXT,
  ADD COLUMN IF NOT EXISTS collected_notes TEXT,
  ADD COLUMN IF NOT EXISTS collected_at TIMESTAMPTZ;

-- 2. New columns on invoices
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES admins(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_patient_visible BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. payment_records table
CREATE TABLE IF NOT EXISTS payment_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  recorded_by UUID,
  recorder_role TEXT CHECK (recorder_role IN ('ADMIN', 'PROVIDER')),
  amount NUMERIC(10,2) NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('CASH', 'CARD', 'TRANSFER', 'OTHER')),
  notes TEXT,
  approval_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (approval_status IN ('PENDING', 'APPROVED', 'REJECTED')),
  approved_by UUID REFERENCES admins(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_records_request_id
  ON payment_records(request_id);
CREATE INDEX IF NOT EXISTS idx_payment_records_status
  ON payment_records(approval_status);

-- 4. Specialized provider report fields
ALTER TABLE request_provider_reports
  ADD COLUMN IF NOT EXISTS service_subtype TEXT,
  ADD COLUMN IF NOT EXISTS service_type TEXT,
  ADD COLUMN IF NOT EXISTS symptoms_summary TEXT,
  ADD COLUMN IF NOT EXISTS diagnosis TEXT,
  ADD COLUMN IF NOT EXISTS treatment_plan TEXT,
  ADD COLUMN IF NOT EXISTS recommendations TEXT,
  ADD COLUMN IF NOT EXISTS allergies_noted TEXT,
  ADD COLUMN IF NOT EXISTS lab_notes TEXT,
  ADD COLUMN IF NOT EXISTS imaging_notes TEXT,
  ADD COLUMN IF NOT EXISTS image_url TEXT,
  ADD COLUMN IF NOT EXISTS procedures_done TEXT,
  ADD COLUMN IF NOT EXISTS patient_allergies TEXT,
  ADD COLUMN IF NOT EXISTS nurse_notes TEXT,
  ADD COLUMN IF NOT EXISTS pdf_report_url TEXT;

-- 5. Stored PDF URL for published report downloads
ALTER TABLE medical_reports
  ADD COLUMN IF NOT EXISTS pdf_url TEXT;

COMMIT;
