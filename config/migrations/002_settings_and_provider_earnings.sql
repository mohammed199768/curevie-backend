-- Admin-editable settings, provider shares on the catalog, and the provider earnings ledger.

-- ---------------------------------------------------------------------
-- Settings (one JSON document per key, validated by the API)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  key        VARCHAR(80) PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by UUID REFERENCES admins(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO app_settings (key, value) VALUES
  ('payments.cliq', '{"enabled": true, "alias": "", "beneficiary_name": "", "bank_name": "", "note": ""}'::jsonb),
  ('earnings.default_share', '{"type": "PERCENT", "value": 70}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------
-- Provider share per catalog item (NULL = use earnings.default_share)
-- ---------------------------------------------------------------------
ALTER TABLE services ADD COLUMN IF NOT EXISTS provider_share_type VARCHAR(10);
ALTER TABLE services ADD COLUMN IF NOT EXISTS provider_share_value NUMERIC(12,3);
ALTER TABLE packages ADD COLUMN IF NOT EXISTS provider_share_type VARCHAR(10);
ALTER TABLE packages ADD COLUMN IF NOT EXISTS provider_share_value NUMERIC(12,3);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'services_provider_share_chk') THEN
    ALTER TABLE services ADD CONSTRAINT services_provider_share_chk CHECK (
      (provider_share_type IS NULL AND provider_share_value IS NULL)
      OR (provider_share_type = 'PERCENT' AND provider_share_value BETWEEN 0 AND 100)
      OR (provider_share_type = 'FIXED' AND provider_share_value >= 0));
  END IF;
END
$$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'packages_provider_share_chk') THEN
    ALTER TABLE packages ADD CONSTRAINT packages_provider_share_chk CHECK (
      (provider_share_type IS NULL AND provider_share_value IS NULL)
      OR (provider_share_type = 'PERCENT' AND provider_share_value BETWEEN 0 AND 100)
      OR (provider_share_type = 'FIXED' AND provider_share_value >= 0));
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- Payouts: money Curevie handed to a provider for a set of earnings
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_payouts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES service_providers(id) ON DELETE RESTRICT,
  amount      NUMERIC(12,3) NOT NULL CHECK (amount > 0),
  method      VARCHAR(20) NOT NULL CHECK (method IN ('CASH', 'BANK_TRANSFER', 'CLICK', 'OTHER')),
  reference   VARCHAR(120),
  notes       TEXT,
  created_by  UUID REFERENCES admins(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_provider_payouts_provider ON provider_payouts (provider_id, created_at DESC);

-- ---------------------------------------------------------------------
-- Earnings: one row per completed line item, locked at completion
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_earnings (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id       UUID NOT NULL REFERENCES service_providers(id) ON DELETE RESTRICT,
  case_id           UUID NOT NULL REFERENCES cases(id) ON DELETE RESTRICT,
  case_service_id   UUID NOT NULL UNIQUE REFERENCES case_services(id) ON DELETE RESTRICT,
  item_name         VARCHAR(200) NOT NULL,
  base_amount       NUMERIC(12,3) NOT NULL CHECK (base_amount >= 0),
  share_type        VARCHAR(10) NOT NULL CHECK (share_type IN ('PERCENT', 'FIXED')),
  share_value       NUMERIC(12,3) NOT NULL CHECK (share_value >= 0),
  share_source      VARCHAR(10) NOT NULL CHECK (share_source IN ('ITEM', 'DEFAULT')),
  amount            NUMERIC(12,3) NOT NULL CHECK (amount >= 0),
  calculated_amount NUMERIC(12,3) NOT NULL CHECK (calculated_amount >= 0),
  adjustment_reason TEXT,
  adjusted_by       UUID REFERENCES admins(id) ON DELETE SET NULL,
  adjusted_at       TIMESTAMPTZ,
  status            VARCHAR(10) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID')),
  payout_id         UUID REFERENCES provider_payouts(id) ON DELETE RESTRICT,
  paid_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((status = 'PAID') = (payout_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_provider_earnings_provider ON provider_earnings (provider_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_earnings_case ON provider_earnings (case_id);
