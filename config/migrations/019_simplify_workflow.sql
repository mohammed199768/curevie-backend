-- Migration 019: Simplify workflow by deprecating ACCEPTED as an active request status.
-- Keep the enum values for backward compatibility with historical rows.

UPDATE service_requests
SET status = 'ASSIGNED',
    updated_at = NOW()
WHERE status = 'ACCEPTED';

UPDATE request_workflow_tasks
SET status = 'ASSIGNED',
    updated_at = NOW()
WHERE status = 'ACCEPTED';
