-- Migration 012: New lifecycle statuses (IN_PROGRESS, CLOSED) + provider payment collection + RADIOLOGY service type
-- Safe: uses ADD VALUE IF NOT EXISTS and ADD COLUMN IF NOT EXISTS
-- Run: psql -U postgres -d medical_platform -f config/migrations/012_lifecycle_payment.sql

-- 1. Add IN_PROGRESS to request_status enum
DO $$ BEGIN
  ALTER TYPE request_status ADD VALUE IF NOT EXISTS 'IN_PROGRESS';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2. Add CLOSED to request_status enum
DO $$ BEGIN
  ALTER TYPE request_status ADD VALUE IF NOT EXISTS 'CLOSED';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3. Add RADIOLOGY to service_type enum
DO $$ BEGIN
  ALTER TYPE service_type ADD VALUE IF NOT EXISTS 'RADIOLOGY';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 4. Add new columns to service_requests for lifecycle + payment collection
ALTER TABLE service_requests
  ADD COLUMN IF NOT EXISTS in_progress_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS collected_amount NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS collected_method VARCHAR(20),
  ADD COLUMN IF NOT EXISTS collected_notes TEXT,
  ADD COLUMN IF NOT EXISTS collected_at TIMESTAMP;

-- 5. Add CHECK constraint for collected_method (only if column was just created, safe to re-add)
DO $$ BEGIN
  ALTER TABLE service_requests
    ADD CONSTRAINT chk_collected_method CHECK (collected_method IS NULL OR collected_method IN ('CASH', 'TRANSFER'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 6. Index for faster provider-scoped list queries
CREATE INDEX IF NOT EXISTS idx_service_requests_status_provider
  ON service_requests(status, assigned_provider_id);
