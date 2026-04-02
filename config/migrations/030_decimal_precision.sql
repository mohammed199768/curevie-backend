-- Migration 030: Extend monetary columns to 3 decimal places (JOD)
-- Safe: ALTER COLUMN TYPE is non-destructive for widening precision.
-- Run: psql -U postgres -d medical_platform -f config/migrations/030_decimal_precision.sql

BEGIN;

-- invoices
ALTER TABLE invoices
  ALTER COLUMN original_amount        TYPE DECIMAL(10,3),
  ALTER COLUMN vip_discount_amount    TYPE DECIMAL(10,3),
  ALTER COLUMN coupon_discount_amount TYPE DECIMAL(10,3),
  ALTER COLUMN points_discount_amount TYPE DECIMAL(10,3),
  ALTER COLUMN final_amount           TYPE DECIMAL(10,3),
  ALTER COLUMN total_paid             TYPE DECIMAL(10,3),
  ALTER COLUMN remaining_amount       TYPE DECIMAL(10,3);

-- payments
ALTER TABLE payments
  ALTER COLUMN amount          TYPE DECIMAL(10,3),
  ALTER COLUMN provider_amount TYPE DECIMAL(10,3);

-- payment_records
ALTER TABLE payment_records
  ALTER COLUMN amount TYPE DECIMAL(10,3);

-- service_requests (collected fields from migration 012)
ALTER TABLE service_requests
  ALTER COLUMN collected_amount TYPE DECIMAL(10,3);

-- coupons
ALTER TABLE coupons
  ALTER COLUMN discount_value   TYPE DECIMAL(10,3),
  ALTER COLUMN min_order_amount TYPE DECIMAL(10,3);

COMMIT;
