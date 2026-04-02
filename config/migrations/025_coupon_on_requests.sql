ALTER TABLE service_requests
  ADD COLUMN IF NOT EXISTS coupon_id UUID REFERENCES coupons(id),
  ADD COLUMN IF NOT EXISTS coupon_code VARCHAR(50),
  ADD COLUMN IF NOT EXISTS coupon_discount_amount DECIMAL(10,2) DEFAULT 0;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS coupon_code_snapshot VARCHAR(50);
