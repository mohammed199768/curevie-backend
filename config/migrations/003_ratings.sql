-- Phase 2: service request ratings

CREATE TABLE IF NOT EXISTS service_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID UNIQUE NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_ratings_patient ON service_ratings(patient_id);
CREATE INDEX IF NOT EXISTS idx_service_ratings_created_at ON service_ratings(created_at);
