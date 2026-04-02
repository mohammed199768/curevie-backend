-- =============================================
-- Smart Reference Ranges
-- =============================================

CREATE TABLE IF NOT EXISTS lab_test_reference_ranges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_test_id UUID NOT NULL REFERENCES lab_tests(id) ON DELETE CASCADE,

  -- Patient conditions
  gender VARCHAR(10) CHECK (gender IN ('male', 'female', 'any')) DEFAULT 'any',
  age_min INTEGER DEFAULT 0,
  age_max INTEGER DEFAULT 999,
  condition VARCHAR(50) DEFAULT NULL
    CHECK (condition IN ('pregnant', 'fasting', 'non_fasting', 'luteal', 'follicular', 'postmenopausal', NULL)),

  -- Range values
  range_low DECIMAL(12,4),
  range_high DECIMAL(12,4),
  range_text TEXT,
  unit VARCHAR(50),

  -- Metadata
  notes TEXT,
  priority INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ranges_lab_test ON lab_test_reference_ranges(lab_test_id);
CREATE INDEX IF NOT EXISTS idx_ranges_gender ON lab_test_reference_ranges(gender);
CREATE INDEX IF NOT EXISTS idx_ranges_age ON lab_test_reference_ranges(age_min, age_max);

ALTER TABLE lab_test_results
  ADD COLUMN IF NOT EXISTS flag VARCHAR(20)
    CHECK (flag IN ('NORMAL', 'LOW', 'HIGH', 'ABNORMAL', 'NO_RANGE', 'PARSE_ERROR'));

ALTER TABLE lab_test_results
  ADD COLUMN IF NOT EXISTS matched_range_id UUID
    REFERENCES lab_test_reference_ranges(id) ON DELETE SET NULL;

ALTER TABLE lab_test_results
  ADD COLUMN IF NOT EXISTS condition VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_lab_results_flag ON lab_test_results(flag);
CREATE INDEX IF NOT EXISTS idx_lab_results_matched_range ON lab_test_results(matched_range_id);
