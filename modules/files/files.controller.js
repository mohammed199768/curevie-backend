const path = require('path');
const db = require('../../config/db');
const { generateSignedUrl, isBunnyConfigured } = require('../../utils/bunny');
const { logger } = require('../../utils/logger');

async function getSecureUrl(req, res) {
  const { filePath, requestId } = req.query;
  const user = req.user;

  if (!filePath) {
    return res.status(400).json({ error: 'filePath is required' });
  }

  const normalizedPath = path.normalize(String(filePath || '')).replace(/\\/g, '/');
  if (normalizedPath.includes('..')) {
    return res.status(400).json({ error: 'Invalid filePath' });
  }

  const cleanPath = normalizedPath.replace(/^\/+/, '');
  if (!cleanPath) {
    return res.status(400).json({ error: 'Invalid filePath' });
  }

  const resolveAccessibleUrl = () => {
    if (cleanPath.startsWith('uploads/')) {
      return `/${cleanPath}`;
    }
    if (!isBunnyConfigured()) {
      return `/uploads/${cleanPath}`;
    }
    return generateSignedUrl(cleanPath);
  };

  if (user.role === 'ADMIN') {
    return res.json({ url: resolveAccessibleUrl() });
  }

  if (!requestId) {
    return res.status(400).json({ error: 'requestId is required' });
  }

  const { rows } = await db.query(
    'SELECT id, patient_id, assigned_provider_id, lead_provider_id FROM service_requests WHERE id = $1',
    [requestId]
  );

  if (!rows.length) {
    return res.status(404).json({ error: 'Request not found' });
  }

  const serviceRequest = rows[0];

  if (user.role === 'PATIENT') {
    if (serviceRequest.patient_id !== user.id) {
      logger.warn('Patient tried to access file from another request', {
        userId: user.id,
        requestId,
      });
      return res.status(403).json({ error: 'Access denied' });
    }
    return res.json({ url: resolveAccessibleUrl() });
  }

  if (user.role === 'PROVIDER') {
    // Check direct assignment first (no extra DB query needed)
    const isDirectlyAssigned =
      serviceRequest.assigned_provider_id === user.id ||
      serviceRequest.lead_provider_id === user.id;

    if (!isDirectlyAssigned) {
      // Fall back to checking workflow tasks
      const { rows: taskRows } = await db.query(
        'SELECT 1 FROM request_workflow_tasks WHERE request_id = $1 AND provider_id = $2 LIMIT 1',
        [requestId, user.id]
      );
      if (taskRows.length === 0) {
        logger.warn(`Provider ${user.id} attempted to access file for request ${requestId} without assignment`);
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    return res.json({ url: resolveAccessibleUrl() });
  }

  return res.status(403).json({ error: 'Access denied' });
}

module.exports = { getSecureUrl };
