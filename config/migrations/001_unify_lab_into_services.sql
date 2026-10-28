-- =====================================================================
-- 001_unify_lab_into_services.sql
-- The separate lab catalog (tests, panels, lab packages, reference ranges)
-- is folded into the general catalog:
--   * lab tests and lab panels  -> services with service_kind = 'LAB'
--   * lab packages              -> packages (bundles of services)
--   * comprehensive packages    -> keep, their lab tests now point to the new services
--   * reference ranges / ordinal scales are dropped (results are uploaded as files)
-- Rows keep their ids, so existing order lines are remapped without lookups.
-- =====================================================================

-- 1. Catalog shape --------------------------------------------------------
ALTER TABLE services DROP CONSTRAINT IF EXISTS services_service_kind_check;
ALTER TABLE services ADD CONSTRAINT services_service_kind_check
  CHECK (service_kind IN ('MEDICAL', 'NURSING', 'RADIOLOGY', 'LAB'));

ALTER TABLE packages ADD COLUMN IF NOT EXISTS name_ar VARCHAR(200);
ALTER TABLE packages ADD COLUMN IF NOT EXISTS name_en VARCHAR(200);
ALTER TABLE packages ADD COLUMN IF NOT EXISTS description_ar TEXT;
ALTER TABLE packages ADD COLUMN IF NOT EXISTS description_en TEXT;
ALTER TABLE package_services ADD COLUMN IF NOT EXISTS display_order INT NOT NULL DEFAULT 0;

-- 2. Move lab items into services / packages ------------------------------
DO $$
BEGIN
  IF to_regclass('lab_tests') IS NOT NULL THEN
    INSERT INTO services (id, name, description, price, service_kind, category_id, is_vip_exclusive,
                          is_active, image_url, created_at, updated_at)
    SELECT lt.id, lt.name, lt.description, lt.cost, 'LAB', lt.category_id, COALESCE(lt.is_vip_exclusive, FALSE),
           COALESCE(lt.is_active, TRUE), lt.image_url, lt.created_at, lt.updated_at
    FROM lab_tests lt
    ON CONFLICT (id) DO NOTHING;
  END IF;

  IF to_regclass('lab_panels') IS NOT NULL THEN
    -- A panel becomes one orderable service; its test list is kept in the description.
    INSERT INTO services (id, name, name_ar, name_en, description, description_ar, description_en, price,
                          service_kind, is_vip_exclusive, is_active, created_at, updated_at)
    SELECT lp.id,
           COALESCE(NULLIF(lp.name, ''), NULLIF(lp.name_ar, ''), lp.name_en),
           lp.name_ar, lp.name_en,
           COALESCE(lp.description_ar, lp.description_en, tests.list),
           COALESCE(lp.description_ar, tests.list),
           COALESCE(lp.description_en, tests.list),
           lp.price, 'LAB', COALESCE(lp.is_vip_exclusive, FALSE), COALESCE(lp.is_active, TRUE),
           lp.created_at, lp.updated_at
    FROM lab_panels lp
    LEFT JOIN LATERAL (
      SELECT string_agg(lt.name, '، ' ORDER BY lpt.display_order, lt.name) AS list
      FROM lab_panel_tests lpt JOIN lab_tests lt ON lt.id = lpt.lab_test_id
      WHERE lpt.panel_id = lp.id
    ) tests ON TRUE
    ON CONFLICT (id) DO NOTHING;
  END IF;

  IF to_regclass('lab_packages') IS NOT NULL THEN
    INSERT INTO packages (id, name, name_ar, name_en, description, description_ar, description_en, total_cost,
                          workflow_items, is_vip_exclusive, is_active, created_at, updated_at)
    SELECT lp.id,
           COALESCE(NULLIF(lp.name, ''), NULLIF(lp.name_ar, ''), lp.name_en),
           lp.name_ar, lp.name_en,
           COALESCE(lp.description_ar, lp.description_en),
           lp.description_ar, lp.description_en,
           lp.price, COALESCE(lp.workflow_items, '[]'::jsonb),
           COALESCE(lp.is_vip_exclusive, FALSE), COALESCE(lp.is_active, TRUE), lp.created_at, lp.updated_at
    FROM lab_packages lp
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO package_services (package_id, service_id)
    SELECT package_id, lab_test_id FROM lab_package_tests
    ON CONFLICT DO NOTHING;
    INSERT INTO package_services (package_id, service_id)
    SELECT package_id, panel_id FROM lab_package_panels
    ON CONFLICT DO NOTHING;
  END IF;

  IF to_regclass('package_tests') IS NOT NULL THEN
    INSERT INTO package_services (package_id, service_id)
    SELECT package_id, lab_test_id FROM package_tests
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

-- Keep the item order admins had defined in workflow_items.
UPDATE package_services ps
SET display_order = w.ord
FROM packages p, jsonb_array_elements(COALESCE(p.workflow_items, '[]'::jsonb)) WITH ORDINALITY AS w(item, ord)
WHERE p.id = ps.package_id AND w.item->>'item_id' = ps.service_id::text;

-- 3. Remap order lines ----------------------------------------------------
ALTER TABLE case_services DROP CONSTRAINT IF EXISTS case_services_item_check;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'case_services' AND column_name = 'lab_test_id'
  ) THEN
    UPDATE case_services SET item_type = 'SERVICE', service_id = lab_test_id, lab_test_id = NULL
      WHERE item_type = 'LAB_TEST';
    UPDATE case_services SET item_type = 'SERVICE', service_id = lab_panel_id, lab_panel_id = NULL
      WHERE item_type = 'LAB_PANEL';
    UPDATE case_services SET item_type = 'PACKAGE', package_id = lab_package_id, lab_package_id = NULL
      WHERE item_type = 'LAB_PACKAGE';
  END IF;
END $$;

ALTER TABLE case_services DROP COLUMN IF EXISTS lab_test_id;
ALTER TABLE case_services DROP COLUMN IF EXISTS lab_panel_id;
ALTER TABLE case_services DROP COLUMN IF EXISTS lab_package_id;
ALTER TABLE case_services ADD CONSTRAINT case_services_item_check CHECK (
  (item_type = 'SERVICE' AND service_id IS NOT NULL AND package_id IS NULL)
  OR (item_type = 'PACKAGE' AND package_id IS NOT NULL AND service_id IS NULL)
);

-- 4. Drop the old lab catalog ---------------------------------------------
DROP TABLE IF EXISTS
  package_tests, lab_package_panels, lab_package_tests, lab_packages,
  lab_panel_tests, lab_panels, ordinal_scale_items, lab_test_reference_ranges, lab_tests
CASCADE;
DROP TYPE IF EXISTS lab_result_type CASCADE;
ALTER TABLE packages DROP COLUMN IF EXISTS workflow_items;

CREATE INDEX IF NOT EXISTS idx_package_services_package ON package_services(package_id, display_order);
