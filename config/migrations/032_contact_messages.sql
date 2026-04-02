-- Migration 032: Guest contact messages
BEGIN;

CREATE TABLE IF NOT EXISTS contact_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(150) NOT NULL,
  email       VARCHAR(255) NOT NULL,
  phone       VARCHAR(30),
  message     TEXT NOT NULL,
  is_read     BOOLEAN DEFAULT FALSE,
  read_by     UUID REFERENCES admins(id),
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_messages_created ON contact_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_messages_unread ON contact_messages(is_read) WHERE is_read = FALSE;

COMMIT;
