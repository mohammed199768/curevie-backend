-- Lab partner: ordered catalog groups, admin ordering of services, partner accounts per kind,
-- the lab home-visit fee, and insurance lab requests.

-- ---------------------------------------------------------------------
-- Catalog groups (bilingual, ordered, scoped to a service kind)
-- ---------------------------------------------------------------------
ALTER TABLE service_categories ADD COLUMN IF NOT EXISTS name_ar VARCHAR(150);
ALTER TABLE service_categories ADD COLUMN IF NOT EXISTS name_en VARCHAR(150);
ALTER TABLE service_categories ADD COLUMN IF NOT EXISTS description_ar TEXT;
ALTER TABLE service_categories ADD COLUMN IF NOT EXISTS description_en TEXT;
ALTER TABLE service_categories ADD COLUMN IF NOT EXISTS slug VARCHAR(60);
ALTER TABLE service_categories ADD COLUMN IF NOT EXISTS service_kind VARCHAR(20);
ALTER TABLE service_categories ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0;
-- Specialised groups (genetics, drug levels) are reached through a separate entry, not the first screen.
ALTER TABLE service_categories ADD COLUMN IF NOT EXISTS is_specialized BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_categories_slug ON service_categories(slug) WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_service_categories_kind_order ON service_categories(service_kind, sort_order);

-- ---------------------------------------------------------------------
-- Services: admin order, most-requested flag, fasting, partner price-list name, system items
-- ---------------------------------------------------------------------
ALTER TABLE services ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0;
ALTER TABLE services ADD COLUMN IF NOT EXISTS is_popular BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE services ADD COLUMN IF NOT EXISTS requires_fasting BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE services ADD COLUMN IF NOT EXISTS source_name VARCHAR(250);
-- Internal items added by the server (never listed in the public catalog), e.g. 'lab_home_visit'.
ALTER TABLE services ADD COLUMN IF NOT EXISTS system_key VARCHAR(40);
CREATE UNIQUE INDEX IF NOT EXISTS idx_services_system_key ON services(system_key) WHERE system_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_services_source_name ON services(source_name) WHERE source_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_services_kind_category_order ON services(service_kind, category_id, sort_order);

INSERT INTO services (name, name_ar, name_en, description_ar, description_en, price, service_kind,
                      is_active, is_vip_exclusive, provider_share_type, provider_share_value, system_key)
SELECT 'زيارة منزلية لسحب العينات', 'زيارة منزلية لسحب العينات', 'Home sample collection',
       'رسوم زيارة المختبر للمنزل لسحب العينات، مرة واحدة لكل طلب.', 'Lab home visit to collect samples, once per order.',
       5, 'LAB', TRUE, FALSE, 'PERCENT', 100, 'lab_home_visit'
WHERE NOT EXISTS (SELECT 1 FROM services WHERE system_key = 'lab_home_visit');

INSERT INTO services (name, name_ar, name_en, description_ar, description_en, price, service_kind,
                      is_active, is_vip_exclusive, provider_share_type, provider_share_value, system_key)
SELECT 'فحوصات مختبر (تأمين)', 'فحوصات مختبر (تأمين)', 'Lab tests (insurance)',
       'فحوصات يحددها المختبر حسب تغطية التأمين.', 'Tests set by the lab according to the insurance cover.',
       0, 'LAB', TRUE, FALSE, 'PERCENT', 100, 'lab_insurance_tests'
WHERE NOT EXISTS (SELECT 1 FROM services WHERE system_key = 'lab_insurance_tests');

-- ---------------------------------------------------------------------
-- Settings: one partner account per kind, and the lab home-visit fee
-- ---------------------------------------------------------------------
INSERT INTO app_settings (key, value) VALUES
  ('routing.partners', '{"lab_provider_id": null, "radiology_provider_id": null}'::jsonb),
  ('lab.home_visit_fee', '{"amount": 5}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------
-- Insurance lab requests: the patient sends an insurance card, the lab prices what is covered
-- ---------------------------------------------------------------------
ALTER TABLE cases ADD COLUMN IF NOT EXISTS is_insurance BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS case_insurance_requests (
  case_id UUID PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
  card_file_key TEXT NOT NULL,
  card_file_name VARCHAR(255),
  card_mime VARCHAR(100),
  status VARCHAR(20) NOT NULL DEFAULT 'SUBMITTED'
    CHECK (status IN ('SUBMITTED', 'QUOTED', 'APPROVED', 'DECLINED', 'CANCELLED')),
  tests_description TEXT,
  patient_amount NUMERIC(12,3) CHECK (patient_amount >= 0),
  -- What the lab owes Curevie once the insurer pays the lab.
  lab_owes_amount NUMERIC(12,3) CHECK (lab_owes_amount >= 0),
  quote_notes TEXT,
  quoted_by UUID REFERENCES service_providers(id) ON DELETE SET NULL,
  quoted_at TIMESTAMPTZ,
  decided_at TIMESTAMPTZ,
  receivable_status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (receivable_status IN ('PENDING', 'RECEIVED', 'WAIVED')),
  receivable_updated_at TIMESTAMPTZ,
  receivable_updated_by UUID REFERENCES admins(id) ON DELETE SET NULL,
  receivable_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_case_insurance_status ON case_insurance_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_case_insurance_receivable ON case_insurance_requests(receivable_status);
