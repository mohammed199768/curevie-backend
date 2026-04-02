-- Phase 2: request files uploads

CREATE TABLE IF NOT EXISTS request_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  uploaded_by UUID NOT NULL,
  uploader_role VARCHAR(20) NOT NULL CHECK (uploader_role IN ('ADMIN', 'PROVIDER')),
  original_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  size_bytes INT NOT NULL CHECK (size_bytes > 0),
  file_path TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_request_files_request ON request_files(request_id);
CREATE INDEX IF NOT EXISTS idx_request_files_uploaded_by ON request_files(uploaded_by);
