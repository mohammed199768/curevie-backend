const express = require('express');
const Joi = require('joi');
const { authenticate, adminOnly } = require('../../middlewares/auth');
const { apiLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const validate = require('../../middlewares/validate');
const { uploadImage } = require('../../utils/upload');
const {
  paginationSchema,
  patientMedicalSchema,
  patientProfileSchema,
  patientHistorySchema,
  vipSchema,
} = require('../../utils/schemas');
const asyncHandler = require('../../utils/asyncHandler');
const controller = require('./patient.controller');

const router = express.Router();
const idParams = Joi.object({ id: Joi.string().uuid().required() });
const { patientAccess } = controller;

router.use(authenticate);

router.get('/combined', adminOnly, readLimiter, validate(paginationSchema, 'query'), asyncHandler(controller.listCombinedPatients));
router.get('/', adminOnly, readLimiter, validate(paginationSchema, 'query'), asyncHandler(controller.listPatients));

router.get(
  '/:id',
  readLimiter,
  validate(idParams, 'params'),
  patientAccess({ allowProvider: true }),
  asyncHandler(controller.getPatient)
);
router.get(
  '/:id/history',
  readLimiter,
  validate(idParams, 'params'),
  validate(paginationSchema, 'query'),
  patientAccess({ allowSelf: false, allowProvider: true }),
  asyncHandler(controller.getPatientHistory)
);
router.post(
  '/:id/history',
  apiLimiter,
  validate(idParams, 'params'),
  validate(patientHistorySchema),
  patientAccess({ allowSelf: false, allowProvider: true, openOnly: true }),
  asyncHandler(controller.addHistory)
);
router.put(
  '/:id/medical',
  apiLimiter,
  validate(idParams, 'params'),
  validate(patientMedicalSchema),
  patientAccess({ allowProvider: true, openOnly: true }),
  asyncHandler(controller.updateMedical)
);
router.put(
  '/:id/profile',
  apiLimiter,
  validate(idParams, 'params'),
  validate(patientProfileSchema),
  patientAccess(),
  asyncHandler(controller.updateProfile)
);
router.put(
  '/:id/avatar',
  apiLimiter,
  validate(idParams, 'params'),
  patientAccess(),
  ...uploadImage,
  asyncHandler(controller.uploadAvatar)
);
router.put('/:id/vip', adminOnly, apiLimiter, validate(idParams, 'params'), validate(vipSchema), asyncHandler(controller.updateVip));
router.delete('/:id', adminOnly, apiLimiter, validate(idParams, 'params'), asyncHandler(controller.deletePatient));

module.exports = router;
