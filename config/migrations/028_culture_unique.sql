ALTER TABLE culture_results
  ADD CONSTRAINT culture_results_lab_result_id_unique
  UNIQUE (lab_result_id);
