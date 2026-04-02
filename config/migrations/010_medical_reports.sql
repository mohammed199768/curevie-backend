-- Medical report review system
CREATE TABLE IF NOT EXISTS medical_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,

  -- Status lifecycle: DRAFT -> PUBLISHED
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'PUBLISHED')),

  -- Who reviewed and published
  reviewed_by UUID REFERENCES admins(id),
  reviewed_at TIMESTAMP,
  published_at TIMESTAMP,

  -- Admin notes on the report (visible to admin only)
  admin_notes TEXT,

  -- Version tracking (each publish increments this)
  version INT NOT NULL DEFAULT 1,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  -- One report record per request
  UNIQUE(request_id)
);

CREATE INDEX IF NOT EXISTS idx_medical_reports_request ON medical_reports(request_id);
CREATE INDEX IF NOT EXISTS idx_medical_reports_status ON medical_reports(status);
