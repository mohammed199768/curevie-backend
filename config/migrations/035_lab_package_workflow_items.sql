-- =============================================
-- Migration 035: Persist Lab Package Workflow Order
-- Run: psql -U postgres -d medical_platform -f config/migrations/035_lab_package_workflow_items.sql
-- =============================================

ALTER TABLE lab_packages
  ADD COLUMN IF NOT EXISTS workflow_items JSONB NOT NULL DEFAULT '[]'::jsonb;

WITH test_counts AS (
  SELECT package_id, COUNT(*)::int AS test_count
  FROM lab_package_tests
  GROUP BY package_id
),
ordered_items AS (
  SELECT
    lpt.package_id,
    ROW_NUMBER() OVER (PARTITION BY lpt.package_id ORDER BY lt.name ASC, lt.id ASC) AS display_order,
    jsonb_build_object('item_type', 'test', 'item_id', lt.id) AS item
  FROM lab_package_tests lpt
  JOIN lab_tests lt ON lt.id = lpt.lab_test_id

  UNION ALL

  SELECT
    lpp.package_id,
    COALESCE(tc.test_count, 0) + ROW_NUMBER() OVER (PARTITION BY lpp.package_id ORDER BY lp.name_en ASC, lp.id ASC) AS display_order,
    jsonb_build_object('item_type', 'panel', 'item_id', lp.id) AS item
  FROM lab_package_panels lpp
  JOIN lab_panels lp ON lp.id = lpp.panel_id
  LEFT JOIN test_counts tc ON tc.package_id = lpp.package_id
),
aggregated_items AS (
  SELECT package_id, jsonb_agg(item ORDER BY display_order) AS workflow_items
  FROM ordered_items
  GROUP BY package_id
)
UPDATE lab_packages lp
SET workflow_items = COALESCE(ai.workflow_items, '[]'::jsonb),
    updated_at = NOW()
FROM aggregated_items ai
WHERE lp.id = ai.package_id
  AND (lp.workflow_items IS NULL OR lp.workflow_items = '[]'::jsonb);

UPDATE lab_packages
SET workflow_items = '[]'::jsonb
WHERE workflow_items IS NULL;
