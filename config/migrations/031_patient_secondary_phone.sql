-- Migration 031: Add secondary_phone to patients table
-- Safe: ADD COLUMN IF NOT EXISTS with nullable default

ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS secondary_phone VARCHAR(30) DEFAULT NULL;
