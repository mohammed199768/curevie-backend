-- =============================================
-- Migration 016: Generalize chat conversations subject
-- Supports patient-admin, patient-provider, and admin-provider conversations.
-- =============================================

BEGIN;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS subject_id UUID,
  ADD COLUMN IF NOT EXISTS subject_role VARCHAR(20);

UPDATE conversations
SET
  subject_id = COALESCE(subject_id, patient_id),
  subject_role = COALESCE(subject_role, 'PATIENT')
WHERE subject_id IS NULL
   OR subject_role IS NULL;

ALTER TABLE conversations
  ALTER COLUMN subject_id SET NOT NULL,
  ALTER COLUMN subject_role SET NOT NULL,
  ALTER COLUMN patient_id DROP NOT NULL;

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_patient_id_participant_id_participant_role_key;

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_subject_role_check;

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_subject_consistency;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_subject_role_check
  CHECK (subject_role IN ('PATIENT', 'PROVIDER'));

ALTER TABLE conversations
  ADD CONSTRAINT conversations_subject_consistency
  CHECK (
    (subject_role = 'PATIENT' AND patient_id IS NOT NULL AND patient_id = subject_id)
    OR (subject_role = 'PROVIDER' AND patient_id IS NULL)
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'conversations_subject_participant_unique'
      AND conrelid = 'conversations'::regclass
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_subject_participant_unique
      UNIQUE (subject_id, subject_role, participant_id, participant_role);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_conversations_subject
  ON conversations(subject_role, subject_id);

COMMIT;
