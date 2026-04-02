-- Audit Fix: P3 — Missing indexes identified in March 2026 audit
-- AUDIT-FIX: P3

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_invoices_patient_id
  ON invoices(patient_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lab_results_request_id
  ON lab_test_results(request_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_providers_email
  ON service_providers(email);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_subject_id
  ON conversations(subject_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_patient_history_admin
  ON patient_history(created_by_admin);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_patient_history_provider
  ON patient_history(created_by_provider);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_requests_requested_at
  ON service_requests(requested_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_requests_scheduled_at
  ON service_requests(scheduled_at);
