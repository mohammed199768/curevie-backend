-- =============================================
-- Migration 034: Persist Package Workflow Order
-- Run: psql -U postgres -d medical_platform -f config/migrations/034_package_workflow_items.sql
-- =============================================

ALTER TABLE packages
  ADD COLUMN IF NOT EXISTS workflow_items JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS package_tests (
  package_id UUID REFERENCES packages(id) ON DELETE CASCADE,
  lab_test_id UUID REFERENCES lab_tests(id) ON DELETE CASCADE,
  PRIMARY KEY (package_id, lab_test_id)
);

CREATE TABLE IF NOT EXISTS package_services (
  package_id UUID REFERENCES packages(id) ON DELETE CASCADE,
  service_id UUID REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (package_id, service_id)
);

CREATE INDEX IF NOT EXISTS idx_package_services_package
  ON package_services(package_id);

CREATE INDEX IF NOT EXISTS idx_package_services_service
  ON package_services(service_id);

WITH service_counts AS (
  SELECT package_id, COUNT(*)::int AS service_count
  FROM package_services
  GROUP BY package_id
),
ordered_items AS (
  SELECT
    ps.package_id,
    ROW_NUMBER() OVER (PARTITION BY ps.package_id ORDER BY s.name ASC, s.id ASC) AS display_order,
    jsonb_build_object('item_type', 'service', 'item_id', s.id) AS item
  FROM package_services ps
  JOIN services s ON s.id = ps.service_id

  UNION ALL

  SELECT
    pt.package_id,
    COALESCE(sc.service_count, 0) + ROW_NUMBER() OVER (PARTITION BY pt.package_id ORDER BY lt.name ASC, lt.id ASC) AS display_order,
    jsonb_build_object('item_type', 'test', 'item_id', lt.id) AS item
  FROM package_tests pt
  JOIN lab_tests lt ON lt.id = pt.lab_test_id
  LEFT JOIN service_counts sc ON sc.package_id = pt.package_id
),
aggregated_items AS (
  SELECT package_id, jsonb_agg(item ORDER BY display_order) AS workflow_items
  FROM ordered_items
  GROUP BY package_id
)
UPDATE packages p
SET workflow_items = COALESCE(ai.workflow_items, '[]'::jsonb),
    updated_at = NOW()
FROM aggregated_items ai
WHERE p.id = ai.package_id
  AND (p.workflow_items IS NULL OR p.workflow_items = '[]'::jsonb);

UPDATE packages
SET workflow_items = '[]'::jsonb
WHERE workflow_items IS NULL;
