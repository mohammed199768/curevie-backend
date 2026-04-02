-- ============================================================
-- 026b: Seed Lab Panels, Lab Packages, and Medical Packages
-- ============================================================

-- Core categories used by lab tests and seeded services.
INSERT INTO service_categories (name, description)
SELECT seed.name, seed.description
FROM (
  VALUES
    ('Medical Lab', 'Default category for laboratory diagnostics'),
    ('General Medicine', 'General medical consultations and home physician visits'),
    ('Home Care', 'Home nursing and coordinated care services'),
    ('Radiology', 'Home radiology and imaging services')
) AS seed(name, description)
WHERE NOT EXISTS (
  SELECT 1
  FROM service_categories existing
  WHERE LOWER(existing.name) = LOWER(seed.name)
);

-- Core services used by medical packages.
INSERT INTO services (name, description, price, category_id, is_vip_exclusive, is_active)
SELECT
  seed.name,
  seed.description,
  seed.price,
  (
    SELECT id
    FROM service_categories
    WHERE LOWER(name) = LOWER(seed.category_name)
    ORDER BY created_at ASC
    LIMIT 1
  ),
  FALSE,
  TRUE
FROM (
  VALUES
    ('General Consultation', 'Comprehensive physician home visit with assessment and treatment planning.', 35.00, 'General Medicine'),
    ('Home Nursing Visit', 'Professional nursing visit for injections, monitoring, and supportive home care.', 28.00, 'Home Care'),
    ('Radiology Scan', 'Mobile radiology imaging visit performed at the patient location.', 55.00, 'Radiology')
) AS seed(name, description, price, category_name)
WHERE NOT EXISTS (
  SELECT 1
  FROM services existing
  WHERE LOWER(existing.name) = LOWER(seed.name)
);

-- Ensure core lab tests exist.
INSERT INTO lab_tests (name, description, unit, reference_range, sample_type, cost, category_id, is_vip_exclusive, is_active)
SELECT
  seed.name,
  seed.description,
  seed.unit,
  seed.reference_range,
  seed.sample_type,
  seed.cost,
  (
    SELECT id
    FROM service_categories
    WHERE LOWER(name) = 'medical lab'
    ORDER BY created_at ASC
    LIMIT 1
  ),
  FALSE,
  TRUE
FROM (
  VALUES
    ('WBC', 'White blood cell count', '10^3/uL', '4.0-11.0', 'edta', 3.00),
    ('RBC', 'Red blood cell count', '10^6/uL', '4.2-5.9', 'edta', 3.00),
    ('Hemoglobin', 'Hemoglobin concentration', 'g/dL', '12.0-17.5', 'edta', 3.00),
    ('Hematocrit', 'Packed cell volume', '%', '36-52', 'edta', 3.00),
    ('MCV', 'Mean corpuscular volume', 'fL', '80-100', 'edta', 2.50),
    ('MCH', 'Mean corpuscular hemoglobin', 'pg', '27-33', 'edta', 2.50),
    ('MCHC', 'Mean corpuscular hemoglobin concentration', 'g/dL', '32-36', 'edta', 2.50),
    ('Platelets', 'Platelet count', '10^3/uL', '150-450', 'edta', 3.00),
    ('Neutrophils %', 'Neutrophil percentage', '%', '40-75', 'edta', 2.50),
    ('Lymphocytes %', 'Lymphocyte percentage', '%', '20-45', 'edta', 2.50),
    ('Total Cholesterol', 'Serum total cholesterol', 'mg/dL', '<200', 'serum', 4.00),
    ('LDL', 'Low-density lipoprotein cholesterol', 'mg/dL', '<130', 'serum', 4.00),
    ('HDL', 'High-density lipoprotein cholesterol', 'mg/dL', '>40', 'serum', 4.00),
    ('Triglycerides', 'Serum triglycerides', 'mg/dL', '<150', 'serum', 4.00),
    ('VLDL', 'Very low-density lipoprotein', 'mg/dL', '5-40', 'serum', 3.50),
    ('Cholesterol/HDL Ratio', 'Total cholesterol to HDL ratio', 'ratio', '0-5', 'serum', 3.50),
    ('ALT', 'Alanine aminotransferase', 'U/L', '7-56', 'serum', 4.00),
    ('AST', 'Aspartate aminotransferase', 'U/L', '10-40', 'serum', 4.00),
    ('ALP', 'Alkaline phosphatase', 'U/L', '44-147', 'serum', 4.00),
    ('GGT', 'Gamma glutamyl transferase', 'U/L', '9-48', 'serum', 4.00),
    ('Total Bilirubin', 'Total bilirubin level', 'mg/dL', '0.2-1.2', 'serum', 4.00),
    ('Direct Bilirubin', 'Direct bilirubin level', 'mg/dL', '0.0-0.3', 'serum', 4.00),
    ('Total Protein', 'Total protein level', 'g/dL', '6.4-8.3', 'serum', 3.50),
    ('Albumin', 'Serum albumin', 'g/dL', '3.5-5.0', 'serum', 3.50),
    ('Creatinine', 'Serum creatinine', 'mg/dL', '0.6-1.3', 'serum', 4.00),
    ('BUN (Urea)', 'Blood urea nitrogen', 'mg/dL', '7-20', 'serum', 4.00),
    ('eGFR', 'Estimated glomerular filtration rate', 'mL/min/1.73m2', '>60', 'serum', 4.50),
    ('Uric Acid', 'Serum uric acid', 'mg/dL', '3.5-7.2', 'serum', 4.00),
    ('Sodium', 'Serum sodium', 'mmol/L', '135-145', 'serum', 3.50),
    ('Potassium', 'Serum potassium', 'mmol/L', '3.5-5.1', 'serum', 3.50),
    ('Chloride', 'Serum chloride', 'mmol/L', '98-107', 'serum', 3.50),
    ('TSH', 'Thyroid stimulating hormone', 'uIU/mL', '0.4-4.0', 'serum', 6.00),
    ('Free T3', 'Free triiodothyronine', 'pg/mL', '2.3-4.2', 'serum', 6.00),
    ('Free T4', 'Free thyroxine', 'ng/dL', '0.8-1.8', 'serum', 6.00),
    ('Fasting Blood Sugar', 'Fasting plasma glucose', 'mg/dL', '70-99', 'serum', 4.00),
    ('HbA1c', 'Glycated hemoglobin', '%', '4.0-5.6', 'edta', 7.00),
    ('Fasting Insulin', 'Fasting insulin level', 'uIU/mL', '2.6-24.9', 'serum', 7.00),
    ('Serum Iron', 'Serum iron level', 'ug/dL', '60-170', 'serum', 5.00),
    ('TIBC', 'Total iron binding capacity', 'ug/dL', '240-450', 'serum', 5.00),
    ('Ferritin', 'Ferritin level', 'ng/mL', '12-300', 'serum', 6.00),
    ('Transferrin Saturation', 'Transferrin saturation percentage', '%', '20-50', 'serum', 5.00),
    ('Troponin I', 'Cardiac troponin I', 'ng/mL', '0.00-0.04', 'serum', 9.00),
    ('CK-MB', 'Creatine kinase MB fraction', 'ng/mL', '0.0-5.0', 'serum', 8.00),
    ('LDH', 'Lactate dehydrogenase', 'U/L', '140-280', 'serum', 5.00),
    ('D-Dimer', 'D-dimer assay', 'ug/mL FEU', '0.0-0.5', 'plasma', 8.00),
    ('CRP', 'C-reactive protein', 'mg/L', '0-5', 'serum', 5.00),
    ('ESR', 'Erythrocyte sedimentation rate', 'mm/hr', '0-20', 'edta', 4.00),
    ('Fibrinogen', 'Plasma fibrinogen', 'mg/dL', '200-400', 'citrate', 6.00),
    ('Procalcitonin', 'Serum procalcitonin', 'ng/mL', '0.0-0.1', 'serum', 8.00),
    ('LH', 'Luteinizing hormone', 'mIU/mL', '1.9-12.5', 'serum', 6.00),
    ('FSH', 'Follicle-stimulating hormone', 'mIU/mL', '2.5-10.2', 'serum', 6.00),
    ('Estradiol', 'Serum estradiol', 'pg/mL', '15-350', 'serum', 7.00),
    ('Progesterone', 'Serum progesterone', 'ng/mL', '0.1-25', 'serum', 7.00),
    ('Prolactin', 'Serum prolactin', 'ng/mL', '4.8-23.3', 'serum', 6.00),
    ('DHEA-S', 'Dehydroepiandrosterone sulfate', 'ug/dL', '35-430', 'serum', 7.00),
    ('Testosterone', 'Total testosterone', 'ng/dL', '15-70', 'serum', 7.00),
    ('Urine Analysis', 'Routine urine analysis with microscopy', NULL, NULL, 'urine', 4.50)
) AS seed(name, description, unit, reference_range, sample_type, cost)
WHERE NOT EXISTS (
  SELECT 1
  FROM lab_tests existing
  WHERE LOWER(existing.name) = LOWER(seed.name)
);

-- Seed lab panels.
INSERT INTO lab_panels (name_en, name_ar, description_en, description_ar, price, sample_types, turnaround_hours, is_active, is_vip_exclusive)
SELECT seed.name_en, seed.name_ar, seed.description_en, seed.description_ar, seed.price, seed.sample_types, seed.turnaround_hours, TRUE, FALSE
FROM (
  VALUES
    ('CBC (Complete Blood Count)', 'ØµÙˆØ±Ø© Ø¯Ù… ÙƒØ§Ù…Ù„Ø©', 'Complete blood count panel for hematology screening.', 'Ø¨Ø§Ù‚Ø© ØµÙˆØ±Ø© Ø¯Ù… ÙƒØ§Ù…Ù„Ø© Ù„ØªÙ‚ÙŠÙŠÙ… Ù…ÙƒÙˆÙ†Ø§Øª Ø§Ù„Ø¯Ù… Ø§Ù„Ø£Ø³Ø§Ø³ÙŠØ©.', 15.00, 'edta', 8),
    ('Lipid Profile', 'Ø¯Ù‡ÙˆÙ† Ø§Ù„Ø¯Ù…', 'Comprehensive lipid profile for cardiovascular risk screening.', 'Ø¨Ø§Ù‚Ø© Ø¯Ù‡ÙˆÙ† Ø§Ù„Ø¯Ù… Ù„ØªÙ‚ÙŠÙŠÙ… Ù…Ø®Ø§Ø·Ø± Ø§Ù„Ù‚Ù„Ø¨ ÙˆØ§Ù„Ø´Ø±Ø§ÙŠÙŠÙ†.', 18.00, 'serum', 10),
    ('Liver Function Tests (LFT)', 'ÙˆØ¸Ø§Ø¦Ù Ø§Ù„ÙƒØ¨Ø¯', 'Core liver enzymes and protein markers.', 'Ø¨Ø§Ù‚Ø© ÙˆØ¸Ø§Ø¦Ù Ø§Ù„ÙƒØ¨Ø¯ Ù„Ù‚ÙŠØ§Ø³ Ø§Ù„Ø¥Ù†Ø²ÙŠÙ…Ø§Øª ÙˆØ§Ù„Ø¨Ø±ÙˆØªÙŠÙ†Ø§Øª Ø§Ù„Ù…Ø±ØªØ¨Ø·Ø© Ø¨Ø§Ù„ÙƒØ¨Ø¯.', 20.00, 'serum', 10),
    ('Kidney Function Tests (KFT)', 'ÙˆØ¸Ø§Ø¦Ù Ø§Ù„ÙƒÙ„Ù‰', 'Renal function and electrolyte markers.', 'Ø¨Ø§Ù‚Ø© ÙˆØ¸Ø§Ø¦Ù Ø§Ù„ÙƒÙ„Ù‰ ÙˆÙ…Ø¤Ø´Ø±Ø§Øª Ø§Ù„Ø£Ù…Ù„Ø§Ø­ Ø§Ù„Ù…Ø±ØªØ¨Ø·Ø© Ø¨Ù‡Ø§.', 18.00, 'serum', 10),
    ('Thyroid Profile (TFT)', 'ÙˆØ¸Ø§Ø¦Ù Ø§Ù„ØºØ¯Ø© Ø§Ù„Ø¯Ø±Ù‚ÙŠØ©', 'Thyroid hormone screening panel.', 'Ø¨Ø§Ù‚Ø© ØªÙ‚ÙŠÙŠÙ… Ù‡Ø±Ù…ÙˆÙ†Ø§Øª Ø§Ù„ØºØ¯Ø© Ø§Ù„Ø¯Ø±Ù‚ÙŠØ©.', 25.00, 'serum', 12),
    ('Diabetes Panel (HbA1c + FBS)', 'Ø¨Ø§Ù‚Ø© Ø§Ù„Ø³ÙƒØ±ÙŠ', 'Glucose control and insulin resistance markers.', 'Ø¨Ø§Ù‚Ø© ØªÙ‚ÙŠÙŠÙ… Ø§Ù„ØªØ­ÙƒÙ… Ø¨Ø§Ù„Ø³ÙƒØ±ÙŠ ÙˆÙ…Ù‚Ø§ÙˆÙ…Ø© Ø§Ù„Ø¥Ù†Ø³ÙˆÙ„ÙŠÙ†.', 20.00, 'serum,edta', 10),
    ('Iron Studies', 'Ø¯Ø±Ø§Ø³Ø© Ø§Ù„Ø­Ø¯ÙŠØ¯', 'Iron stores and transport assessment.', 'Ø¨Ø§Ù‚Ø© ØªÙ‚ÙŠÙŠÙ… Ù…Ø®Ø²ÙˆÙ† Ø§Ù„Ø­Ø¯ÙŠØ¯ ÙˆÙ†Ù‚Ù„Ù‡ ÙÙŠ Ø§Ù„Ø¬Ø³Ù….', 22.00, 'serum', 12),
    ('Cardiac Markers', 'Ù…Ø¤Ø´Ø±Ø§Øª Ø§Ù„Ù‚Ù„Ø¨', 'Laboratory cardiac injury and thrombosis markers.', 'Ø¨Ø§Ù‚Ø© Ù…Ø¤Ø´Ø±Ø§Øª Ø§Ù„Ù‚Ù„Ø¨ ÙˆØ§Ù„Ø¬Ù„Ø·Ø§Øª Ø§Ù„Ù…Ø®Ø¨Ø±ÙŠØ©.', 35.00, 'serum,plasma', 6),
    ('Inflammatory Markers', 'Ù…Ø¤Ø´Ø±Ø§Øª Ø§Ù„Ø§Ù„ØªÙ‡Ø§Ø¨', 'Inflammation and infection activity markers.', 'Ø¨Ø§Ù‚Ø© Ù…Ø¤Ø´Ø±Ø§Øª Ø§Ù„Ø§Ù„ØªÙ‡Ø§Ø¨ ÙˆØ§Ù„Ø¹Ø¯ÙˆÙ‰.', 18.00, 'serum,edta,citrate', 8),
    ('Hormone Panel (Female)', 'Ø¨Ø§Ù‚Ø© Ø§Ù„Ù‡Ø±Ù…ÙˆÙ†Ø§Øª Ù„Ù„Ù†Ø³Ø§Ø¡', 'Female reproductive hormone profile.', 'Ø¨Ø§Ù‚Ø© Ø§Ù„Ù‡Ø±Ù…ÙˆÙ†Ø§Øª Ø§Ù„Ø£Ù†Ø«ÙˆÙŠØ© ÙˆØªÙ‚ÙŠÙŠÙ… Ø§Ù„Ø®ØµÙˆØ¨Ø©.', 30.00, 'serum', 12)
) AS seed(name_en, name_ar, description_en, description_ar, price, sample_types, turnaround_hours)
WHERE NOT EXISTS (
  SELECT 1
  FROM lab_panels existing
  WHERE LOWER(existing.name_en) = LOWER(seed.name_en)
);

-- Seed panel memberships.
INSERT INTO lab_panel_tests (panel_id, lab_test_id, display_order)
SELECT
  panel_ref.id,
  test_ref.id,
  seed.display_order
FROM (
  VALUES
    ('CBC (Complete Blood Count)', 'WBC', 1), ('CBC (Complete Blood Count)', 'RBC', 2), ('CBC (Complete Blood Count)', 'Hemoglobin', 3), ('CBC (Complete Blood Count)', 'Hematocrit', 4), ('CBC (Complete Blood Count)', 'MCV', 5), ('CBC (Complete Blood Count)', 'MCH', 6), ('CBC (Complete Blood Count)', 'MCHC', 7), ('CBC (Complete Blood Count)', 'Platelets', 8), ('CBC (Complete Blood Count)', 'Neutrophils %', 9), ('CBC (Complete Blood Count)', 'Lymphocytes %', 10),
    ('Lipid Profile', 'Total Cholesterol', 1), ('Lipid Profile', 'LDL', 2), ('Lipid Profile', 'HDL', 3), ('Lipid Profile', 'Triglycerides', 4), ('Lipid Profile', 'VLDL', 5), ('Lipid Profile', 'Cholesterol/HDL Ratio', 6),
    ('Liver Function Tests (LFT)', 'ALT', 1), ('Liver Function Tests (LFT)', 'AST', 2), ('Liver Function Tests (LFT)', 'ALP', 3), ('Liver Function Tests (LFT)', 'GGT', 4), ('Liver Function Tests (LFT)', 'Total Bilirubin', 5), ('Liver Function Tests (LFT)', 'Direct Bilirubin', 6), ('Liver Function Tests (LFT)', 'Total Protein', 7), ('Liver Function Tests (LFT)', 'Albumin', 8),
    ('Kidney Function Tests (KFT)', 'Creatinine', 1), ('Kidney Function Tests (KFT)', 'BUN (Urea)', 2), ('Kidney Function Tests (KFT)', 'eGFR', 3), ('Kidney Function Tests (KFT)', 'Uric Acid', 4), ('Kidney Function Tests (KFT)', 'Sodium', 5), ('Kidney Function Tests (KFT)', 'Potassium', 6), ('Kidney Function Tests (KFT)', 'Chloride', 7),
    ('Thyroid Profile (TFT)', 'TSH', 1), ('Thyroid Profile (TFT)', 'Free T3', 2), ('Thyroid Profile (TFT)', 'Free T4', 3),
    ('Diabetes Panel (HbA1c + FBS)', 'Fasting Blood Sugar', 1), ('Diabetes Panel (HbA1c + FBS)', 'HbA1c', 2), ('Diabetes Panel (HbA1c + FBS)', 'Fasting Insulin', 3),
    ('Iron Studies', 'Serum Iron', 1), ('Iron Studies', 'TIBC', 2), ('Iron Studies', 'Ferritin', 3), ('Iron Studies', 'Transferrin Saturation', 4),
    ('Cardiac Markers', 'Troponin I', 1), ('Cardiac Markers', 'CK-MB', 2), ('Cardiac Markers', 'LDH', 3), ('Cardiac Markers', 'D-Dimer', 4),
    ('Inflammatory Markers', 'CRP', 1), ('Inflammatory Markers', 'ESR', 2), ('Inflammatory Markers', 'Fibrinogen', 3), ('Inflammatory Markers', 'Procalcitonin', 4),
    ('Hormone Panel (Female)', 'LH', 1), ('Hormone Panel (Female)', 'FSH', 2), ('Hormone Panel (Female)', 'Estradiol', 3), ('Hormone Panel (Female)', 'Progesterone', 4), ('Hormone Panel (Female)', 'Prolactin', 5), ('Hormone Panel (Female)', 'DHEA-S', 6), ('Hormone Panel (Female)', 'Testosterone', 7)
) AS seed(panel_name, test_name, display_order)
JOIN LATERAL (
  SELECT id FROM lab_panels WHERE LOWER(name_en) = LOWER(seed.panel_name) ORDER BY created_at ASC LIMIT 1
) AS panel_ref ON TRUE
JOIN LATERAL (
  SELECT id FROM lab_tests WHERE LOWER(name) = LOWER(seed.test_name) ORDER BY created_at ASC LIMIT 1
) AS test_ref ON TRUE
WHERE NOT EXISTS (
  SELECT 1
  FROM lab_panel_tests existing
  WHERE existing.panel_id = panel_ref.id
    AND existing.lab_test_id = test_ref.id
);

-- Seed lab packages.
INSERT INTO lab_packages (name_en, name_ar, description_en, description_ar, price, is_active, is_vip_exclusive)
SELECT seed.name_en, seed.name_ar, seed.description_en, seed.description_ar, seed.price, TRUE, FALSE
FROM (
  VALUES
    ('Basic Health Check', 'Ø§Ù„ÙØ­Øµ Ø§Ù„ØµØ­ÙŠ Ø§Ù„Ø£Ø³Ø§Ø³ÙŠ', 'Balanced starter package for routine screening.', 'Ø­Ø²Ù…Ø© Ø£Ø³Ø§Ø³ÙŠØ© Ù„Ù„ÙØ­Øµ Ø§Ù„Ø¯ÙˆØ±ÙŠ Ø§Ù„Ø¹Ø§Ù….', 45.00),
    ('Comprehensive Metabolic Panel', 'Ø§Ù„Ø­Ø²Ù…Ø© Ø§Ù„Ø£ÙŠØ¶ÙŠØ© Ø§Ù„Ø´Ø§Ù…Ù„Ø©', 'Extended metabolic and endocrine screening package.', 'Ø­Ø²Ù…Ø© Ù…ÙˆØ³Ø¹Ø© Ù„ÙØ­Øµ Ø§Ù„Ù…Ø¤Ø´Ø±Ø§Øª Ø§Ù„Ø£ÙŠØ¶ÙŠØ© ÙˆØ§Ù„Ù‡Ø±Ù…ÙˆÙ†ÙŠØ©.', 75.00),
    ('Cardiac Risk Assessment', 'ØªÙ‚ÙŠÙŠÙ… Ù…Ø®Ø§Ø·Ø± Ø§Ù„Ù‚Ù„Ø¨', 'Focused package for cardiovascular risk evaluation.', 'Ø­Ø²Ù…Ø© Ù…Ø±ÙƒØ²Ø© Ù„ØªÙ‚ÙŠÙŠÙ… Ù…Ø®Ø§Ø·Ø± Ø§Ù„Ù‚Ù„Ø¨ ÙˆØ§Ù„Ø´Ø±Ø§ÙŠÙŠÙ†.', 60.00),
    ('Women''s Health Package', 'Ø­Ø²Ù…Ø© ØµØ­Ø© Ø§Ù„Ù…Ø±Ø£Ø©', 'Comprehensive women''s health laboratory package.', 'Ø­Ø²Ù…Ø© Ù…Ø®Ø¨Ø±ÙŠØ© Ø´Ø§Ù…Ù„Ø© Ù„ØµØ­Ø© Ø§Ù„Ù…Ø±Ø£Ø©.', 85.00)
) AS seed(name_en, name_ar, description_en, description_ar, price)
WHERE NOT EXISTS (
  SELECT 1
  FROM lab_packages existing
  WHERE LOWER(existing.name_en) = LOWER(seed.name_en)
);

INSERT INTO lab_package_panels (package_id, panel_id)
SELECT package_ref.id, panel_ref.id
FROM (
  VALUES
    ('Basic Health Check', 'CBC (Complete Blood Count)'),
    ('Basic Health Check', 'Lipid Profile'),
    ('Comprehensive Metabolic Panel', 'CBC (Complete Blood Count)'),
    ('Comprehensive Metabolic Panel', 'Liver Function Tests (LFT)'),
    ('Comprehensive Metabolic Panel', 'Kidney Function Tests (KFT)'),
    ('Comprehensive Metabolic Panel', 'Lipid Profile'),
    ('Comprehensive Metabolic Panel', 'Diabetes Panel (HbA1c + FBS)'),
    ('Comprehensive Metabolic Panel', 'Thyroid Profile (TFT)'),
    ('Cardiac Risk Assessment', 'Lipid Profile'),
    ('Cardiac Risk Assessment', 'Cardiac Markers'),
    ('Women''s Health Package', 'CBC (Complete Blood Count)'),
    ('Women''s Health Package', 'Hormone Panel (Female)'),
    ('Women''s Health Package', 'Thyroid Profile (TFT)'),
    ('Women''s Health Package', 'Iron Studies')
) AS seed(package_name, panel_name)
JOIN LATERAL (
  SELECT id FROM lab_packages WHERE LOWER(name_en) = LOWER(seed.package_name) ORDER BY created_at ASC LIMIT 1
) AS package_ref ON TRUE
JOIN LATERAL (
  SELECT id FROM lab_panels WHERE LOWER(name_en) = LOWER(seed.panel_name) ORDER BY created_at ASC LIMIT 1
) AS panel_ref ON TRUE
WHERE NOT EXISTS (
  SELECT 1
  FROM lab_package_panels existing
  WHERE existing.package_id = package_ref.id
    AND existing.panel_id = panel_ref.id
);

INSERT INTO lab_package_tests (package_id, lab_test_id)
SELECT package_ref.id, test_ref.id
FROM (
  VALUES
    ('Basic Health Check', 'Fasting Blood Sugar'),
    ('Basic Health Check', 'Urine Analysis'),
    ('Cardiac Risk Assessment', 'CRP'),
    ('Cardiac Risk Assessment', 'HbA1c'),
    ('Women''s Health Package', 'Urine Analysis')
) AS seed(package_name, test_name)
JOIN LATERAL (
  SELECT id FROM lab_packages WHERE LOWER(name_en) = LOWER(seed.package_name) ORDER BY created_at ASC LIMIT 1
) AS package_ref ON TRUE
JOIN LATERAL (
  SELECT id FROM lab_tests WHERE LOWER(name) = LOWER(seed.test_name) ORDER BY created_at ASC LIMIT 1
) AS test_ref ON TRUE
WHERE NOT EXISTS (
  SELECT 1
  FROM lab_package_tests existing
  WHERE existing.package_id = package_ref.id
    AND existing.lab_test_id = test_ref.id
);

-- Seed medical packages in the existing packages table.
INSERT INTO packages (name, description, total_cost, category_id, is_vip_exclusive, is_active)
SELECT
  seed.name,
  seed.description,
  seed.total_cost,
  (
    SELECT id
    FROM service_categories
    WHERE LOWER(name) = LOWER(seed.category_name)
    ORDER BY created_at ASC
    LIMIT 1
  ),
  FALSE,
  TRUE
FROM (
  VALUES
    ('Home Doctor Visit', 'Ø²ÙŠØ§Ø±Ø© Ø·Ø¨ÙŠØ¨ Ù…Ù†Ø²Ù„ÙŠØ© ØªØ´Ù…Ù„ Ø§Ù„ØªÙ‚ÙŠÙŠÙ… Ø§Ù„Ø³Ø±ÙŠØ±ÙŠ ÙˆÙˆØ¶Ø¹ Ø®Ø·Ø© Ø¹Ù„Ø§Ø¬ Ø£ÙˆÙ„ÙŠØ©.', 35.00, 'General Medicine'),
    ('Comprehensive Home Care', 'Ø±Ø¹Ø§ÙŠØ© Ù…Ù†Ø²Ù„ÙŠØ© Ø´Ø§Ù…Ù„Ø© ØªØ´Ù…Ù„ Ø·Ø¨ÙŠØ¨Ù‹Ø§ ÙˆØ®Ø¯Ù…Ø© Ø£Ø´Ø¹Ø© Ù…Ù†Ø²Ù„ÙŠØ© Ù…Ø¹ ÙØ­ÙˆØµØ§Øª Ø£Ø³Ø§Ø³ÙŠØ©.', 120.00, 'Home Care'),
    ('Elderly Care Package', 'Ø­Ø²Ù…Ø© Ø±Ø¹Ø§ÙŠØ© Ù…Ù†Ø²Ù„ÙŠØ© Ù„ÙƒØ¨Ø§Ø± Ø§Ù„Ø³Ù† ØªØ´Ù…Ù„ Ø²ÙŠØ§Ø±Ø© Ø·Ø¨ÙŠØ© ÙˆØªÙ…Ø±ÙŠØ¶ÙŠØ© Ù…Ø¹ Ù…ØªØ§Ø¨Ø¹Ø© ÙˆØ¸Ø§Ø¦Ù Ø§Ù„ÙƒÙ„Ù‰.', 95.00, 'Home Care')
) AS seed(name, description, total_cost, category_name)
WHERE NOT EXISTS (
  SELECT 1
  FROM packages existing
  WHERE LOWER(existing.name) = LOWER(seed.name)
);

INSERT INTO package_services (package_id, service_id)
SELECT package_ref.id, service_ref.id
FROM (
  VALUES
    ('Home Doctor Visit', 'General Consultation'),
    ('Comprehensive Home Care', 'General Consultation'),
    ('Comprehensive Home Care', 'Radiology Scan'),
    ('Elderly Care Package', 'General Consultation'),
    ('Elderly Care Package', 'Home Nursing Visit')
) AS seed(package_name, service_name)
JOIN LATERAL (
  SELECT id FROM packages WHERE LOWER(name) = LOWER(seed.package_name) ORDER BY created_at ASC LIMIT 1
) AS package_ref ON TRUE
JOIN LATERAL (
  SELECT id FROM services WHERE LOWER(name) = LOWER(seed.service_name) ORDER BY created_at ASC LIMIT 1
) AS service_ref ON TRUE
WHERE NOT EXISTS (
  SELECT 1
  FROM package_services existing
  WHERE existing.package_id = package_ref.id
    AND existing.service_id = service_ref.id
);

-- Medical packages still store lab components as individual tests,
-- so the seeded panel contents are expanded into package_tests.
INSERT INTO package_tests (package_id, lab_test_id)
SELECT package_ref.id, test_ref.id
FROM (
  VALUES
    ('Comprehensive Home Care', 'WBC'), ('Comprehensive Home Care', 'RBC'), ('Comprehensive Home Care', 'Hemoglobin'), ('Comprehensive Home Care', 'Hematocrit'), ('Comprehensive Home Care', 'MCV'), ('Comprehensive Home Care', 'MCH'), ('Comprehensive Home Care', 'MCHC'), ('Comprehensive Home Care', 'Platelets'), ('Comprehensive Home Care', 'Neutrophils %'), ('Comprehensive Home Care', 'Lymphocytes %'),
    ('Elderly Care Package', 'Creatinine'), ('Elderly Care Package', 'BUN (Urea)'), ('Elderly Care Package', 'eGFR'), ('Elderly Care Package', 'Uric Acid'), ('Elderly Care Package', 'Sodium'), ('Elderly Care Package', 'Potassium'), ('Elderly Care Package', 'Chloride')
) AS seed(package_name, test_name)
JOIN LATERAL (
  SELECT id FROM packages WHERE LOWER(name) = LOWER(seed.package_name) ORDER BY created_at ASC LIMIT 1
) AS package_ref ON TRUE
JOIN LATERAL (
  SELECT id FROM lab_tests WHERE LOWER(name) = LOWER(seed.test_name) ORDER BY created_at ASC LIMIT 1
) AS test_ref ON TRUE
WHERE NOT EXISTS (
  SELECT 1
  FROM package_tests existing
  WHERE existing.package_id = package_ref.id
    AND existing.lab_test_id = test_ref.id
);

