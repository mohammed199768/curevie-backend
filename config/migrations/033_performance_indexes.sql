CREATE INDEX IF NOT EXISTS idx_payments_provider_id
  ON payments(provider_id)
  WHERE paid_to_provider = TRUE;

CREATE INDEX IF NOT EXISTS idx_points_log_request_id
  ON points_log(request_id);

CREATE INDEX IF NOT EXISTS idx_points_log_created_at
  ON points_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_patients_created_at
  ON patients(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_patient_history_created_at
  ON patient_history(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_patients_full_name_lower
  ON patients(LOWER(full_name));
