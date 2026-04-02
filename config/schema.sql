-- =============================================
-- MEDICAL PLATFORM - DATABASE SCHEMA
-- =============================================

-- ENUMS
CREATE TYPE provider_type AS ENUM ('DOCTOR', 'NURSE', 'LAB_TECH', 'XRAY_TECH');
CREATE TYPE request_type AS ENUM ('PATIENT', 'GUEST');
CREATE TYPE request_status AS ENUM ('PENDING', 'ACCEPTED', 'ASSIGNED', 'COMPLETED', 'CANCELLED');
CREATE TYPE service_type AS ENUM ('MEDICAL', 'XRAY', 'LAB', 'PACKAGE');
CREATE TYPE payment_status AS ENUM ('PENDING', 'PAID', 'CANCELLED');
CREATE TYPE payment_method AS ENUM ('CASH', 'CARD', 'INSURANCE');
CREATE TYPE discount_type AS ENUM ('PERCENTAGE', 'FIXED');
CREATE TYPE points_reason AS ENUM ('EARNED', 'REDEEMED', 'BONUS', 'ADJUSTED');

-- =============================================
-- ADMINS
-- =============================================
CREATE TABLE admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- SERVICE PROVIDERS
-- =============================================
CREATE TABLE service_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  phone VARCHAR(20),
  type provider_type NOT NULL,
  is_available BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- PATIENTS
-- =============================================
CREATE TABLE patients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  address TEXT,
  date_of_birth DATE,
  gender VARCHAR(10),
  -- Medical Info (optional, entered by doctor/admin)
  height DECIMAL(5,2),         -- cm
  weight DECIMAL(5,2),         -- kg
  allergies TEXT,
  -- VIP System
  is_vip BOOLEAN DEFAULT FALSE,
  vip_discount DECIMAL(5,2) DEFAULT 0,   -- percentage
  total_points INT DEFAULT 0,
  -- Meta
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- PATIENT HISTORY (Medical Records)
-- =============================================
CREATE TABLE patient_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  note TEXT NOT NULL,
  created_by_admin UUID REFERENCES admins(id),
  created_by_provider UUID REFERENCES service_providers(id),
  created_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- SERVICE CATEGORIES
-- =============================================
CREATE TABLE service_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- SERVICES (Medical & XRay)
-- =============================================
CREATE TABLE services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(150) NOT NULL,
  description TEXT,
  price DECIMAL(10,2) NOT NULL,
  category_id UUID REFERENCES service_categories(id),
  is_vip_exclusive BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- LAB TESTS
-- =============================================
CREATE TABLE lab_tests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(150) NOT NULL,
  description TEXT,
  unit VARCHAR(50),
  reference_range VARCHAR(100),
  sample_type VARCHAR(50),       -- blood, urine, etc.
  cost DECIMAL(10,2) NOT NULL,
  category_id UUID REFERENCES service_categories(id),
  is_vip_exclusive BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- PACKAGES
-- =============================================
CREATE TABLE packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(150) NOT NULL,
  description TEXT,
  total_cost DECIMAL(10,2) NOT NULL,
  workflow_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  times_ordered INT DEFAULT 0,
  category_id UUID REFERENCES service_categories(id),
  is_vip_exclusive BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Package <-> LabTest (Many to Many)
CREATE TABLE package_tests (
  package_id UUID REFERENCES packages(id) ON DELETE CASCADE,
  lab_test_id UUID REFERENCES lab_tests(id) ON DELETE CASCADE,
  PRIMARY KEY (package_id, lab_test_id)
);

-- Package <-> Service (Many to Many)
CREATE TABLE package_services (
  package_id UUID REFERENCES packages(id) ON DELETE CASCADE,
  service_id UUID REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (package_id, service_id)
);

-- =============================================
-- COUPONS
-- =============================================
CREATE TABLE coupons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(50) UNIQUE NOT NULL,
  discount_type discount_type NOT NULL,
  discount_value DECIMAL(10,2) NOT NULL,
  min_order_amount DECIMAL(10,2) DEFAULT 0,
  max_uses INT DEFAULT 1,
  used_count INT DEFAULT 0,
  expires_at TIMESTAMP,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- SERVICE REQUESTS
-- =============================================
CREATE TABLE service_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Who is requesting
  request_type request_type NOT NULL,
  patient_id UUID REFERENCES patients(id),       -- if PATIENT
  guest_name VARCHAR(100),                        -- if GUEST
  guest_phone VARCHAR(20),                        -- if GUEST
  guest_address TEXT,                             -- if GUEST
  guest_gender VARCHAR(10),                       -- optional guest demographics
  guest_age INT,                                  -- optional guest age in years
  -- What service
  service_type service_type NOT NULL,
  service_id UUID REFERENCES services(id),
  lab_test_id UUID REFERENCES lab_tests(id),
  package_id UUID REFERENCES packages(id),
  -- Historical request snapshots
  patient_full_name_snapshot TEXT,
  patient_phone_snapshot TEXT,
  patient_email_snapshot TEXT,
  patient_address_snapshot TEXT,
  patient_gender_snapshot VARCHAR(10),
  patient_date_of_birth_snapshot DATE,
  patient_age_snapshot INT,
  service_name_snapshot TEXT,
  service_description_snapshot TEXT,
  service_category_name_snapshot TEXT,
  service_price_snapshot DECIMAL(10,2),
  package_components_snapshot JSONB,
  coupon_id UUID REFERENCES coupons(id),
  coupon_code VARCHAR(50),
  coupon_discount_amount DECIMAL(10,2) DEFAULT 0,
  -- Status & Assignment
  status request_status DEFAULT 'PENDING',
  assigned_provider_id UUID REFERENCES service_providers(id),
  assigned_provider_name_snapshot TEXT,
  assigned_provider_phone_snapshot VARCHAR(20),
  assigned_provider_type_snapshot VARCHAR(30),
  lead_provider_name_snapshot TEXT,
  lead_provider_phone_snapshot VARCHAR(20),
  lead_provider_type_snapshot VARCHAR(30),
  request_snapshot_payload JSONB,
  -- Notes
  notes TEXT,
  admin_notes TEXT,
  -- Scheduling
  requested_at TIMESTAMP,
  scheduled_at TIMESTAMP,
  completed_at TIMESTAMP,
  -- Meta
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- LAB TEST RESULTS
-- =============================================
CREATE TABLE lab_test_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  lab_test_id UUID NOT NULL REFERENCES lab_tests(id),
  result VARCHAR(255),
  is_normal BOOLEAN,
  notes TEXT,
  entered_by UUID REFERENCES service_providers(id),
  created_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- INVOICES
-- =============================================
CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID UNIQUE NOT NULL REFERENCES service_requests(id),
  -- Patient info
  patient_id UUID REFERENCES patients(id),
  guest_name VARCHAR(100),
  patient_name_snapshot TEXT,
  patient_phone_snapshot VARCHAR(20),
  patient_address_snapshot TEXT,
  service_name_snapshot TEXT,
  service_type_snapshot VARCHAR(30),
  service_description_snapshot TEXT,
  service_category_name_snapshot TEXT,
  provider_name_snapshot TEXT,
  provider_type_snapshot VARCHAR(30),
  invoice_snapshot_payload JSONB,
  -- Pricing breakdown
  original_amount DECIMAL(10,2) NOT NULL,
  vip_discount_amount DECIMAL(10,2) DEFAULT 0,
  coupon_id UUID REFERENCES coupons(id),
  coupon_discount_amount DECIMAL(10,2) DEFAULT 0,
  coupon_code_snapshot VARCHAR(50),
  points_used INT DEFAULT 0,
  points_discount_amount DECIMAL(10,2) DEFAULT 0,
  final_amount DECIMAL(10,2) NOT NULL,
  -- Payment
  payment_status payment_status DEFAULT 'PENDING',
  payment_method payment_method,
  paid_at TIMESTAMP,
  pdf_url TEXT,
  pdf_generated_at TIMESTAMPTZ,
  -- Meta
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- POINTS LOG
-- =============================================
CREATE TABLE points_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  points INT NOT NULL,           -- positive = earned, negative = redeemed
  reason points_reason NOT NULL,
  request_id UUID REFERENCES service_requests(id),
  note TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- =============================================
-- INDEXES
-- =============================================
CREATE INDEX idx_requests_patient ON service_requests(patient_id);
CREATE INDEX idx_requests_status ON service_requests(status);
CREATE INDEX idx_requests_provider ON service_requests(assigned_provider_id);
CREATE INDEX idx_patient_history ON patient_history(patient_id);
CREATE INDEX idx_invoices_request ON invoices(request_id);
CREATE INDEX idx_points_log_patient ON points_log(patient_id);
