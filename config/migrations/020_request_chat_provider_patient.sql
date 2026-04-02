-- Migration 020: Allow the PROVIDER_PATIENT request chat room type.

ALTER TABLE IF EXISTS request_chat_rooms
  DROP CONSTRAINT IF EXISTS request_chat_rooms_room_type_check;

ALTER TABLE IF EXISTS request_chat_rooms
  ADD CONSTRAINT request_chat_rooms_room_type_check
  CHECK (room_type IN ('CARE_TEAM', 'PATIENT_CARE', 'DOCTOR_ADMIN', 'PROVIDER_PATIENT'));
