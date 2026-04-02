const express = require('express');
const {
  authenticate,
  adminOnly,
  staffOnly,
  selfOrAdmin,
  selfOrStaff,
} = require('../../middlewares/auth');
const { apiLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const validate = require('../../middlewares/validate');
// AUDIT-FIX: S2 — import magic bytes validator alongside upload middleware
const { uploadSingleImage, validateImageContents } = require('../../utils/upload');
const {
  paginationSchema,
  patientMedicalSchema,
  patientProfileSchema,
  patientHistorySchema,
  vipSchema,
} = require('../../utils/schemas');
const asyncHandler = require('../../utils/asyncHandler');

// ── Composition Root ──────────────────────────────────────────────────────────
const pool = require('../../config/db');
const PatientRepository = require('../../repositories/PatientRepository');
const { createPatientService } = require('./patient.service');
const { createPatientController } = require('./patient.controller');
const notifService = require('../notifications/notification.service');

const patientRepo = new PatientRepository(pool);
const patientService = createPatientService(patientRepo);
const patientController = createPatientController(patientService, notifService);
// ─────────────────────────────────────────────────────────────────────────────

const router = express.Router();
const historyQuerySchema = paginationSchema.fork(['limit'], (schema) => schema.default(20));
const pointsLogQuerySchema = paginationSchema.fork(['limit'], (schema) => schema.default(20));

router.get(
  '/',
  authenticate,
  staffOnly,
  readLimiter,
  validate(paginationSchema, 'query'),
  asyncHandler(patientController.listPatients)
);

router.get(
  '/:id',
  authenticate,
  selfOrStaff,
  readLimiter,
  asyncHandler(patientController.getPatient)
);

router.get(
  '/:id/history',
  authenticate,
  staffOnly,
  readLimiter,
  validate(historyQuerySchema, 'query'),
  asyncHandler(patientController.getPatientHistory)
);

router.get(
  '/:id/points-log',
  authenticate,
  selfOrStaff,
  readLimiter,
  validate(pointsLogQuerySchema, 'query'),
  asyncHandler(patientController.getPatientPointsLog)
);

router.put(
  '/:id/avatar',
  authenticate,
  selfOrAdmin,
  apiLimiter,
  uploadSingleImage,
  // AUDIT-FIX: S2 — magic bytes check runs after multer, before controller
  validateImageContents,
  asyncHandler(patientController.uploadAvatar)
);

router.put(
  '/:id/medical',
  authenticate,
  selfOrStaff,
  apiLimiter,
  validate(patientMedicalSchema),
  asyncHandler(patientController.updateMedical)
);

router.put(
  '/:id/profile',
  authenticate,
  selfOrStaff,
  apiLimiter,
  validate(patientProfileSchema),
  asyncHandler(patientController.updateProfile)
);

router.post(
  '/:id/history',
  authenticate,
  staffOnly,
  apiLimiter,
  validate(patientHistorySchema),
  asyncHandler(patientController.addHistory)
);

router.put(
  '/:id/vip',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(vipSchema),
  asyncHandler(patientController.updateVip)
);

router.delete(
  '/:id',
  authenticate,
  adminOnly,
  apiLimiter,
  asyncHandler(patientController.deletePatient)
);

module.exports = router;
