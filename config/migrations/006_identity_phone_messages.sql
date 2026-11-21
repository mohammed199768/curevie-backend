-- Identity document and phone verification before ordering, and the log of messages sent
-- (phone code, order tracking link).

-- ---------------------------------------------------------------------
-- Registered patients: verified once, reused for every later order
-- ---------------------------------------------------------------------
ALTER TABLE patients ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;
-- The number that was verified; changing the profile phone needs a new verification.
ALTER TABLE patients ADD COLUMN IF NOT EXISTS phone_verified_number VARCHAR(20);
ALTER TABLE patients ADD COLUMN IF NOT EXISTS id_document_key TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS id_document_name VARCHAR(255);
ALTER TABLE patients ADD COLUMN IF NOT EXISTS id_document_mime VARCHAR(100);
ALTER TABLE patients ADD COLUMN IF NOT EXISTS id_document_uploaded_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------
-- Guests: verified on every order
-- ---------------------------------------------------------------------
ALTER TABLE cases ADD COLUMN IF NOT EXISTS guest_phone_verified_at TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS guest_id_document_key TEXT;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS guest_id_document_name VARCHAR(255);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS guest_id_document_mime VARCHAR(100);

-- A guest uploads the ID before the order exists; the order then claims the upload by its token.
CREATE TABLE IF NOT EXISTS id_document_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_key TEXT NOT NULL,
  file_name VARCHAR(255),
  file_mime VARCHAR(100),
  case_id UUID REFERENCES cases(id) ON DELETE SET NULL,
  used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- One-time phone codes (only a hash is stored)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS phone_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone VARCHAR(20) NOT NULL,
  code_hash CHAR(64) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  ip VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_phone_verifications_phone ON phone_verifications(phone, created_at DESC);

-- ---------------------------------------------------------------------
-- Every message the platform sends (or would send, with the "log" driver)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbound_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind VARCHAR(30) NOT NULL CHECK (kind IN ('PHONE_CODE', 'ORDER_TRACKING')),
  channel VARCHAR(20) NOT NULL CHECK (channel IN ('WHATSAPP', 'SMS', 'LOG')),
  recipient VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('SENT', 'FAILED', 'LOGGED')),
  provider_message_id VARCHAR(200),
  error TEXT,
  case_id UUID REFERENCES cases(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_outbound_messages_case ON outbound_messages(case_id, created_at DESC);

-- ---------------------------------------------------------------------
-- What ordering requires. The phone check stays off until a message provider is configured,
-- otherwise nobody could receive a code and ordering would stop.
-- ---------------------------------------------------------------------
INSERT INTO app_settings (key, value) VALUES
  ('verification', '{"require_id": true, "require_phone": false}'::jsonb)
ON CONFLICT (key) DO NOTHING;
