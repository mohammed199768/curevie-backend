-- =============================================
-- Migration 017: Mixed Package Services
-- =============================================

CREATE TABLE IF NOT EXISTS package_services (
  package_id UUID NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (package_id, service_id)
);

ALTER TABLE request_workflow_tasks
  ALTER COLUMN provider_id DROP NOT NULL;

ALTER TABLE request_workflow_tasks
  ADD COLUMN IF NOT EXISTS task_label VARCHAR(200);

CREATE INDEX IF NOT EXISTS idx_package_services_package
  ON package_services(package_id);

CREATE INDEX IF NOT EXISTS idx_package_services_service
  ON package_services(service_id);
