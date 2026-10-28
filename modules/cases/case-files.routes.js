// Provider uploads (results, images, sick-leave documents) for a case line item.
// Files are private: they are stored under an opaque key and streamed after an access check.
const express = require('express');
const { authenticate, providerOnly } = require('../../middlewares/auth');
const { apiLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { AppError } = require('../../middlewares/errorHandler');
const { uploadCaseFile } = require('../../utils/upload');
const { savePrivateFile, readStoredFile, deleteStoredFile, mimeTypeForKey, sendFile } = require('../../utils/storage');
const { logger } = require('../../utils/logger');
const caseService = require('./case.service');
const { SERVICE_STATUS, FINAL_CASE_STATUSES, CASE_STATUS } = require('./case.constants');
const schemas = require('./case.schemas');

const router = express.Router();
const { caseRepo } = caseService;

router.post(
  '/:id/services/:serviceId/files',
  authenticate,
  providerOnly,
  apiLimiter,
  validate(schemas.caseServiceParams, 'params'),
  ...uploadCaseFile,
  validate(schemas.uploadFileFieldsSchema),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError('No file uploaded', 400, 'NO_FILE');

    const caseRow = await caseRepo.findCaseById(req.params.id);
    if (!caseRow) throw new AppError('Case not found', 404, 'NOT_FOUND');
    const services = await caseRepo.findServicesByCase(req.params.id);
    const service = services.find((s) => s.id === req.params.serviceId);

    if (!service || service.provider_id !== req.user.id) {
      throw new AppError('Service not found', 404, 'NOT_FOUND');
    }
    if (FINAL_CASE_STATUSES.includes(caseRow.status)) {
      throw new AppError(`The case is ${caseRow.status}`, 409, 'INVALID_CASE_STATUS');
    }
    if (![SERVICE_STATUS.IN_PROGRESS, SERVICE_STATUS.COMPLETED].includes(service.status)) {
      throw new AppError('Start the service before uploading files', 409, 'INVALID_SERVICE_STATUS');
    }

    const storageKey = await savePrivateFile(req.file.buffer, { folder: 'case-files', mimeType: req.file.mimetype });
    const file = await caseRepo.insertProviderFile({
      case_service_id: service.id,
      file_url: storageKey,
      file_type: req.file.mimetype === 'application/pdf' ? 'PDF' : 'IMAGE',
      is_sick_leave: req.body.is_sick_leave,
      uploaded_by: req.user.id,
      original_name: String(req.file.originalname || '').slice(0, 255),
      mime_type: req.file.mimetype,
      size_bytes: req.file.size,
    });

    await caseRepo.addLifecycleEvent({
      case_id: req.params.id,
      case_service_id: service.id,
      actor_id: req.user.id,
      actor_role: 'PROVIDER',
      event_type: 'FILE_UPLOADED',
      notes: file.original_name,
    });

    return res.status(201).json({ data: { ...file, download_path: `/cases/${req.params.id}/files/${file.id}` } });
  })
);

/** Returns the file row when the user may read it. */
async function loadReadableFile(req) {
  const caseRow = await caseService.loadAccessibleCase(req.params.id, req.user);
  const file = await caseRepo.findProviderFile(req.params.id, req.params.fileId);
  if (!file) throw new AppError('File not found', 404, 'NOT_FOUND');

  if (req.user.role === 'PATIENT' && caseRow.status !== CASE_STATUS.CLOSED) {
    throw new AppError('File not found', 404, 'NOT_FOUND');
  }
  if (req.user.role === 'PROVIDER'
    && caseRow.lead_provider_id !== req.user.id
    && file.service_provider_id !== req.user.id) {
    throw new AppError('File not found', 404, 'NOT_FOUND');
  }
  return { caseRow, file };
}

router.get(
  '/:id/files/:fileId',
  authenticate,
  readLimiter,
  validate(schemas.caseFileParams, 'params'),
  asyncHandler(async (req, res) => {
    const { file } = await loadReadableFile(req);
    let buffer;
    try {
      buffer = await readStoredFile(file.file_url);
    } catch (err) {
      logger.warn('CASE_FILE_READ_FAILED', { fileId: file.id, message: err.message });
      throw new AppError('File is not available', 404, 'FILE_NOT_FOUND');
    }
    return sendFile(res, buffer, {
      fileName: file.original_name || `file-${file.id.slice(0, 8)}`,
      mimeType: file.mime_type || mimeTypeForKey(file.file_url),
      inline: req.query.inline === 'true',
    });
  })
);

// Uploader can remove a mistaken upload while the case is still open; admins can always remove.
router.delete(
  '/:id/files/:fileId',
  authenticate,
  apiLimiter,
  validate(schemas.caseFileParams, 'params'),
  asyncHandler(async (req, res) => {
    const caseRow = await caseService.loadAccessibleCase(req.params.id, req.user);
    const file = await caseRepo.findProviderFile(req.params.id, req.params.fileId);
    if (!file) throw new AppError('File not found', 404, 'NOT_FOUND');

    const isUploader = req.user.role === 'PROVIDER' && file.uploaded_by === req.user.id;
    if (req.user.role !== 'ADMIN' && !(isUploader && !FINAL_CASE_STATUSES.includes(caseRow.status))) {
      throw new AppError('Access denied', 403, 'FORBIDDEN');
    }

    await caseRepo.deleteProviderFile(file.id);
    await deleteStoredFile(file.file_url);
    return res.json({ message: 'File deleted' });
  })
);

module.exports = router;
