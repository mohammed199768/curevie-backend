BEGIN;

-- ============================================================
-- MIGRATION 042: Payment System Foundation Fix
-- Applied after: 039_new_case_system.sql, 040_cases_guest_support.sql
-- Purpose:
--   1. Add PARTIAL to payment_status enum (required for installment payments)
--   2. Fix case_payment_records.recorded_by FK (was service_providers — blocks admin recording)
--   3. Add recorded_by_role column (ADMIN | PROVIDER)
--   4. Add invoice_id FK on case_payment_records (links payments to invoice for rollup)
--   5. Add finalized_at / finalized_by on case_invoices (tracks admin invoice review)
-- ============================================================

-- ------------------------------------------------------------
-- FIX 1: Add PARTIAL value to payment_status enum
-- Required by: POST /cases/:id/invoice/payments when amount < final_amount
-- ------------------------------------------------------------
ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'PARTIAL';

-- ------------------------------------------------------------
-- FIX 2: Drop the wrong FK on case_payment_records.recorded_by
-- Original FK: recorded_by → service_providers(id)
-- Problem: Admin UUIDs live in admins table, not service_providers
-- Solution: Drop FK, keep column as untyped UUID (polymorphic).
--           recorded_by_role column tells us which table to resolve against.
-- ------------------------------------------------------------
ALTER TABLE case_payment_records
  DROP CONSTRAINT IF EXISTS case_payment_records_recorded_by_fkey;

-- ------------------------------------------------------------
-- FIX 3: Add recorded_by_role column
-- Values: 'ADMIN' | 'PROVIDER'
-- All payments in the manual admin system will be 'ADMIN'
-- ------------------------------------------------------------
ALTER TABLE case_payment_records
  ADD COLUMN IF NOT EXISTS recorded_by_role VARCHAR(20) NOT NULL DEFAULT 'ADMIN'
    CHECK (recorded_by_role IN ('ADMIN', 'PROVIDER'));

-- ------------------------------------------------------------
-- FIX 4: Add invoice_id FK on case_payment_records
-- Links individual payment records to the specific invoice they apply to.
-- Required for: accurate SUM() rollup on DELETE payment, multi-case-invoice edge cases.
-- NULL allowed for existing rows (0 rows exist, so no backfill needed).
-- ------------------------------------------------------------
ALTER TABLE case_payment_records
  ADD COLUMN IF NOT EXISTS invoice_id UUID
    REFERENCES case_invoices(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_case_payment_records_invoice
  ON case_payment_records(invoice_id);

-- ------------------------------------------------------------
-- FIX 5: Add finalization columns to case_invoices
-- finalized_at: timestamp admin explicitly reviewed and locked the invoice amounts
-- finalized_by: which admin finalized
-- Separate from approved_at (which = when invoice became fully PAID)
-- ------------------------------------------------------------
ALTER TABLE case_invoices
  ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS finalized_by UUID
    REFERENCES admins(id) ON DELETE SET NULL;

-- ------------------------------------------------------------
-- LOG
-- ------------------------------------------------------------
INSERT INTO migrations_log (filename, applied_at)
VALUES ('042_payment_system_fix.sql', NOW());

COMMIT;
