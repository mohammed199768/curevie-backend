/**
 * Identity and phone verification (mounted under /api/v1/verification).
 *
 *   POST /phone/request                  { phone } → code sent by WhatsApp/SMS (guest or patient)
 *   POST /phone/confirm                  { phone, code } → { verification_token, account_verified }
 *   POST /id-document                    multipart file: patient → saved on the account;
 *                                        guest → { id_document_token } for the order
 *   GET  /status                         patient: what is verified and what ordering requires
 *   GET  /id-documents/patients/:id      admin: a patient's ID document
 *   GET  /id-documents/cases/:id         admin: the ID a guest sent with an order
 *   GET  /cases/:id/messages             admin: messages sent for an order
 */
const express = require('express');
const Joi = require('joi');
const pool = require('../../config/db');
const { authenticate, guestOrAuthenticated, adminOnly, patientOnly } = require('../../middlewares/auth');
const { apiLimiter, readLimiter, guestRequestLimiter } = require('../../middlewares/rateLimiter');
const validate = require('../../middlewares/validate');
const { AppError } = require('../../middlewares/errorHandler');
const asyncHandler = require('../../utils/asyncHandler');
const { uploadCaseFile } = require('../../utils/upload');
const { readStoredFile, mimeTypeForKey, sendFile } = require('../../utils/storage');
const messaging = require('../../utils/messaging');
const verification = require('./verification.service');

const router = express.Router();
const uuidParams = Joi.object({ id: Joi.string().uuid().required() });
const phone = Joi.string().trim().pattern(/^[0-9+\-\s()]{7,20}$/).required();

// Only patients and guests verify; staff accounts have no reason to.
function patientsAndGuests(req, res, next) {
  if (req.user && req.user.role !== 'PATIENT') return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
  return next();
}

router.post(
  '/phone/request',
  guestOrAuthenticated,
  patientsAndGuests,
  guestRequestLimiter,
  validate(Joi.object({ phone })),
  asyncHandler(async (req, res) => res.json({ data: await verification.requestPhoneCode(req.body.phone, req.ip) }))
);

router.post(
  '/phone/confirm',
  guestOrAuthenticated,
  patientsAndGuests,
  apiLimiter,
  validate(Joi.object({ phone, code: Joi.string().trim().pattern(/^\d{6}$/).required() })),
  asyncHandler(async (req, res) => res.json({ data: await verification.confirmPhoneCode(req.body.phone, req.body.code, req.user) }))
);

router.post(
  '/id-document',
  guestOrAuthenticated,
  patientsAndGuests,
  apiLimiter,
  ...uploadCaseFile,
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError('A photo or PDF of the ID is required', 400, 'NO_FILE');
    return res.status(201).json({ data: await verification.saveIdDocument(req.user, req.file) });
  })
);

router.get('/status', authenticate, patientOnly, readLimiter, asyncHandler(async (req, res) => {
  const [rules, status] = await Promise.all([verification.requirements(), verification.patientStatus(req.user.id)]);
  return res.json({ data: { ...rules, ...status } });
}));

async function sendDocument(res, row, fallbackName) {
  if (!row?.key) throw new AppError('No ID document', 404, 'NOT_FOUND');
  const buffer = await readStoredFile(row.key).catch(() => {
    throw new AppError('File is not available', 404, 'FILE_NOT_FOUND');
  });
  return sendFile(res, buffer, {
    fileName: row.name || fallbackName,
    mimeType: row.mime || mimeTypeForKey(row.key),
    inline: true,
  });
}

router.get(
  '/id-documents/patients/:id',
  authenticate,
  adminOnly,
  readLimiter,
  validate(uuidParams, 'params'),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      'SELECT id_document_key AS key, id_document_name AS name, id_document_mime AS mime FROM patients WHERE id = $1',
      [req.params.id]
    );
    return sendDocument(res, rows[0], 'id-document');
  })
);

router.get(
  '/id-documents/cases/:id',
  authenticate,
  adminOnly,
  readLimiter,
  validate(uuidParams, 'params'),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT guest_id_document_key AS key, guest_id_document_name AS name, guest_id_document_mime AS mime
       FROM cases WHERE id = $1`,
      [req.params.id]
    );
    return sendDocument(res, rows[0], 'id-document');
  })
);

router.get(
  '/cases/:id/messages',
  authenticate,
  adminOnly,
  readLimiter,
  validate(uuidParams, 'params'),
  asyncHandler(async (req, res) => res.json({ data: await messaging.listForCase(req.params.id) }))
);

module.exports = router;
