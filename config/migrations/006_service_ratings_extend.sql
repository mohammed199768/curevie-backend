-- Phase 3: extend ratings for direct service/lab/package ratings

ALTER TABLE IF EXISTS service_ratings
  ADD COLUMN IF NOT EXISTS service_id UUID REFERENCES services(id);

ALTER TABLE IF EXISTS service_ratings
  ADD COLUMN IF NOT EXISTS lab_test_id UUID REFERENCES lab_tests(id);

ALTER TABLE IF EXISTS service_ratings
  ADD COLUMN IF NOT EXISTS package_id UUID REFERENCES packages(id);

ALTER TABLE IF EXISTS service_ratings
  ADD COLUMN IF NOT EXISTS rating_type VARCHAR(20) NOT NULL DEFAULT 'REQUEST'
  CHECK (rating_type IN ('REQUEST', 'SERVICE'));

ALTER TABLE IF EXISTS service_ratings
  ALTER COLUMN request_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ratings_patient_service
  ON service_ratings (patient_id, service_id)
  WHERE service_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ratings_patient_labtest
  ON service_ratings (patient_id, lab_test_id)
  WHERE lab_test_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ratings_patient_package
  ON service_ratings (patient_id, package_id)
  WHERE package_id IS NOT NULL;
