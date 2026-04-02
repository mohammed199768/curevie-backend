-- =============================================
-- PHASE 4: PAYMENTS + NOTIFICATIONS
-- =============================================

-- نظام الدفعات الجزئية
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  patient_id UUID REFERENCES patients(id),
  
  -- من دفع؟
  payer_name VARCHAR(150),           -- للضيف
  
  -- تفاصيل الدفعة
  amount DECIMAL(10,2) NOT NULL CHECK (amount > 0),
  payment_method VARCHAR(20) NOT NULL CHECK (payment_method IN ('CASH', 'CLICK', 'CARD', 'INSURANCE', 'OTHER')),
  
  -- دفع لمقدم الخدمة؟
  paid_to_provider BOOLEAN DEFAULT FALSE,
  provider_id UUID REFERENCES service_providers(id),
  provider_amount DECIMAL(10,2),
  
  -- ملاحظات
  notes TEXT,
  reference_number VARCHAR(100),     -- رقم مرجعي للدفع الإلكتروني
  
  -- من سجّل الدفعة
  recorded_by UUID NOT NULL,
  recorded_by_role VARCHAR(20) NOT NULL,
  
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);
CREATE INDEX IF NOT EXISTS idx_payments_patient ON payments(patient_id);
CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at);

-- إضافة أعمدة للفاتورة لتتبع الدفع الجزئي
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS total_paid DECIMAL(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS remaining_amount DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS payment_status_detail VARCHAR(20) DEFAULT 'UNPAID'
    CHECK (payment_status_detail IN ('UNPAID', 'PARTIAL', 'PAID', 'OVERPAID'));

-- تحديث الـ remaining_amount الموجودة
UPDATE invoices SET
  remaining_amount = final_amount,
  payment_status_detail = CASE
    WHEN payment_status = 'PAID' THEN 'PAID'
    WHEN payment_status = 'CANCELLED' THEN 'UNPAID'
    ELSE 'UNPAID'
  END
WHERE remaining_amount IS NULL;

-- =============================================
-- NOTIFICATIONS
-- =============================================
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- المستلم
  user_id UUID NOT NULL,
  user_role VARCHAR(20) NOT NULL CHECK (user_role IN ('ADMIN', 'PROVIDER', 'PATIENT')),
  
  -- المحتوى
  type VARCHAR(50) NOT NULL,         -- REQUEST_CREATED, PAYMENT_RECEIVED, STATUS_CHANGED...
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  
  -- بيانات إضافية (JSON)
  data JSONB,
  
  -- الحالة
  is_read BOOLEAN DEFAULT FALSE,
  read_at TIMESTAMP,
  
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, user_role);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(user_id, is_read) WHERE is_read = FALSE;
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);
