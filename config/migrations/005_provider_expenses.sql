-- Provider expenses: a provider paid for something for the patient (e.g. a medication given at the
-- visit), uploads the receipt with the amount; an admin approves it and Curevie reimburses the
-- provider with their next payout. Patients never see these and are never charged for them.

CREATE TABLE IF NOT EXISTS provider_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,
  provider_id UUID NOT NULL REFERENCES service_providers(id) ON DELETE RESTRICT,
  amount NUMERIC(12,3) NOT NULL CHECK (amount > 0),
  description TEXT NOT NULL,
  receipt_file_key TEXT NOT NULL,
  receipt_file_name VARCHAR(255),
  receipt_mime VARCHAR(100),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'PAID')),
  review_reason TEXT,
  reviewed_by UUID REFERENCES admins(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  payout_id UUID REFERENCES provider_payouts(id) ON DELETE RESTRICT,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT provider_expenses_paid_chk CHECK ((status = 'PAID') = (payout_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_provider_expenses_provider_status ON provider_expenses(provider_id, status);
CREATE INDEX IF NOT EXISTS idx_provider_expenses_case ON provider_expenses(case_id);
CREATE INDEX IF NOT EXISTS idx_provider_expenses_status_created ON provider_expenses(status, created_at DESC);
