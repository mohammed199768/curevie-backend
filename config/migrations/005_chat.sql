-- Phase 3: HTTP chat system

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  participant_id UUID NOT NULL,
  participant_role VARCHAR(20) NOT NULL CHECK (participant_role IN ('ADMIN', 'PROVIDER')),
  last_message_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(patient_id, participant_id, participant_role)
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL,
  sender_role VARCHAR(20) NOT NULL CHECK (sender_role IN ('ADMIN', 'PROVIDER', 'PATIENT')),
  body TEXT,
  media_url TEXT,
  media_type VARCHAR(20) CHECK (media_type IN ('image', 'video', 'file')),
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_patient ON conversations(patient_id);
CREATE INDEX IF NOT EXISTS idx_conversations_participant ON conversations(participant_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
