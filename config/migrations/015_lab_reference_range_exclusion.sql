-- =========================================================
-- Migration 015: Enforce lab reference range exclusivity
-- Prevent concurrent overlapping ranges for the same:
--   lab_test_id + gender + condition
-- using a GiST exclusion constraint.
-- =========================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
DECLARE
  overlap_count BIGINT;
  overlap_sample TEXT;
BEGIN
  SELECT COUNT(*)
  INTO overlap_count
  FROM (
    SELECT 1
    FROM lab_test_reference_ranges a
    JOIN lab_test_reference_ranges b
      ON a.lab_test_id = b.lab_test_id
     AND a.gender = b.gender
     AND a.condition IS NOT DISTINCT FROM b.condition
     AND a.id < b.id
     AND int4range(a.age_min, a.age_max, '[]') && int4range(b.age_min, b.age_max, '[]')
  ) overlaps;

  IF overlap_count > 0 THEN
    SELECT string_agg(
      format(
        'lab_test_id=%s gender=%s condition=%s ids=(%s,%s) ages=[%s,%s]/[%s,%s]',
        sample.lab_test_id,
        sample.gender,
        COALESCE(sample.condition, '<NULL>'),
        sample.left_id,
        sample.right_id,
        sample.left_age_min,
        sample.left_age_max,
        sample.right_age_min,
        sample.right_age_max
      ),
      '; '
    )
    INTO overlap_sample
    FROM (
      SELECT
        a.lab_test_id,
        a.gender,
        a.condition,
        a.id AS left_id,
        b.id AS right_id,
        a.age_min AS left_age_min,
        a.age_max AS left_age_max,
        b.age_min AS right_age_min,
        b.age_max AS right_age_max
      FROM lab_test_reference_ranges a
      JOIN lab_test_reference_ranges b
        ON a.lab_test_id = b.lab_test_id
       AND a.gender = b.gender
       AND a.condition IS NOT DISTINCT FROM b.condition
       AND a.id < b.id
       AND int4range(a.age_min, a.age_max, '[]') && int4range(b.age_min, b.age_max, '[]')
      ORDER BY a.lab_test_id, a.gender, a.condition NULLS FIRST, a.age_min, b.age_min
      LIMIT 5
    ) sample;

    RAISE EXCEPTION
      'Cannot add lab reference range exclusion constraint: found % overlapping pair(s). Sample: %',
      overlap_count,
      overlap_sample
      USING ERRCODE = '23514';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'excl_lab_reference_ranges_no_overlap'
      AND conrelid = 'lab_test_reference_ranges'::regclass
  ) THEN
    ALTER TABLE lab_test_reference_ranges
      ADD CONSTRAINT excl_lab_reference_ranges_no_overlap
      EXCLUDE USING gist (
        lab_test_id WITH =,
        gender WITH =,
        COALESCE(condition, '<NULL>') WITH =,
        int4range(age_min, age_max, '[]') WITH &&
      );
  END IF;
END $$;

COMMIT;
