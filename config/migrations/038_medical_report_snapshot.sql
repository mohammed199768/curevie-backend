-- Migration 038: Add report_snapshot to medical_reports
-- Applied manually on VPS
-- DO NOT re-run - column already exists on production DB

ALTER TABLE medical_reports
  ADD COLUMN IF NOT EXISTS report_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS snapshot_updated_by UUID REFERENCES admins(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS snapshot_updated_at TIMESTAMP;
