-- Phase 1: Performance indexes

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_revoked_expires
  ON refresh_tokens (user_id, revoked_at, expires_at);

CREATE INDEX IF NOT EXISTS idx_service_requests_created_type
  ON service_requests (created_at, service_type);

CREATE INDEX IF NOT EXISTS idx_invoices_status_created
  ON invoices (payment_status, created_at);

CREATE INDEX IF NOT EXISTS idx_patients_email_created
  ON patients (email, created_at);
