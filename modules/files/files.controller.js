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
    'SELECT id, patient_id FROM service_requests WHERE id = $1',
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
    const { rows: assignmentRows } = await db.query(
      'SELECT id FROM request_providers WHERE request_id = $1 AND provider_id = $2',
      [requestId, user.id]
    );

    if (!assignmentRows.length) {
      logger.warn('Provider tried to access file from unassigned request', {
        userId: user.id,
        requestId,
      });
      return res.status(403).json({ error: 'Access denied' });
    }

    return res.json({ url: resolveAccessibleUrl() });
  }

  return res.status(403).json({ error: 'Access denied' });
}

module.exports = { getSecureUrl };
