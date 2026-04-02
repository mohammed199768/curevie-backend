-- ============================================================
-- 026: Eliminate XRAY, add Lab Panels and Lab Packages
-- ============================================================

-- PART 1: XRAY elimination (data cleanup)
UPDATE service_requests
SET service_type = 'RADIOLOGY'
WHERE service_type = 'XRAY';

DELETE FROM services
WHERE service_kind = 'XRAY';

DELETE FROM service_providers
WHERE type = 'XRAY_TECH';

UPDATE request_workflow_tasks
SET task_type = 'RADIOLOGY'
WHERE task_type = 'XRAY';

UPDATE additional_orders
SET order_type = 'RADIOLOGY'
WHERE order_type = 'XRAY';

ALTER TABLE request_workflow_tasks
DROP CONSTRAINT IF EXISTS request_workflow_tasks_task_type_check;

ALTER TABLE request_workflow_tasks
ADD CONSTRAINT request_workflow_tasks_task_type_check
CHECK (task_type IN ('MEDICAL', 'LAB', 'RADIOLOGY', 'NURSING', 'FINAL_REPORT'));

ALTER TABLE additional_orders
DROP CONSTRAINT IF EXISTS additional_orders_order_type_check;

ALTER TABLE additional_orders
ADD CONSTRAINT additional_orders_order_type_check
CHECK (order_type IN ('LAB', 'RADIOLOGY', 'NURSING', 'MEDICAL'));

-- PART 2: Clear old mixed packages (testing data)
DELETE FROM package_tests;
DELETE FROM package_services;
DELETE FROM packages;

-- PART 3: New lab catalog tables
CREATE TABLE IF NOT EXISTS lab_panels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name_en VARCHAR(200) NOT NULL,
  name_ar VARCHAR(200) NOT NULL,
  description_en TEXT,
  description_ar TEXT,
  price DECIMAL(10,2) NOT NULL,
  sample_types TEXT,
  turnaround_hours INT,
  is_active BOOLEAN DEFAULT TRUE,
  is_vip_exclusive BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lab_panel_tests (
  panel_id UUID NOT NULL REFERENCES lab_panels(id) ON DELETE CASCADE,
  lab_test_id UUID NOT NULL REFERENCES lab_tests(id) ON DELETE CASCADE,
  display_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (panel_id, lab_test_id)
);

CREATE TABLE IF NOT EXISTS lab_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name_en VARCHAR(200) NOT NULL,
  name_ar VARCHAR(200) NOT NULL,
  description_en TEXT,
  description_ar TEXT,
  price DECIMAL(10,2) NOT NULL,
  is_active BOOLEAN DEFAULT TRUE,
  is_vip_exclusive BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lab_package_tests (
  package_id UUID NOT NULL REFERENCES lab_packages(id) ON DELETE CASCADE,
  lab_test_id UUID NOT NULL REFERENCES lab_tests(id) ON DELETE CASCADE,
  PRIMARY KEY (package_id, lab_test_id)
);

CREATE TABLE IF NOT EXISTS lab_package_panels (
  package_id UUID NOT NULL REFERENCES lab_packages(id) ON DELETE CASCADE,
  panel_id UUID NOT NULL REFERENCES lab_panels(id) ON DELETE CASCADE,
  PRIMARY KEY (package_id, panel_id)
);

-- PART 4: Add lab_panel_id and lab_package_id to service_requests
ALTER TABLE service_requests
ADD COLUMN IF NOT EXISTS lab_panel_id UUID REFERENCES lab_panels(id);

ALTER TABLE service_requests
ADD COLUMN IF NOT EXISTS lab_package_id UUID REFERENCES lab_packages(id);

-- PART 5: Indexes
CREATE INDEX IF NOT EXISTS idx_lab_panel_tests_panel ON lab_panel_tests(panel_id);
CREATE INDEX IF NOT EXISTS idx_lab_panel_tests_test ON lab_panel_tests(lab_test_id);
CREATE INDEX IF NOT EXISTS idx_lab_package_tests_pkg ON lab_package_tests(package_id);
CREATE INDEX IF NOT EXISTS idx_lab_package_panels_pkg ON lab_package_panels(package_id);
CREATE INDEX IF NOT EXISTS idx_service_requests_lab_panel ON service_requests(lab_panel_id);
CREATE INDEX IF NOT EXISTS idx_service_requests_lab_package ON service_requests(lab_package_id);
