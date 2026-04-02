const express = require('express');
const Joi = require('joi');
const { authenticate, adminOnly, staffOnly } = require('../../middlewares/auth');
const { apiLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../utils/asyncHandler');
const {
  createRangeSchema,
  updateRangeSchema,
  bulkImportRangesSchema,
  replaceOrdinalScaleSchema,
} = require('../../utils/schemas');
const labrangeController = require('./labrange.controller');

const router = express.Router({ mergeParams: true });

const resolveRangeQuerySchema = Joi.object({
  gender: Joi.string().valid('male', 'female', 'any').allow('', null),
  age: Joi.number().integer().min(0),
  fasting_state: Joi.string().valid('fasting', 'non_fasting').allow('', null),
  cycle_phase: Joi.string()
    .valid('follicular', 'ovulatory', 'luteal', 'postmenopausal').allow('', null),
  is_pregnant: Joi.boolean().allow(null),
});

router.get(
  '/:testId/ordinal-scale',
  authenticate,
  staffOnly,
  readLimiter,
  asyncHandler(labrangeController.getOrdinalScale)
);

router.put(
  '/:testId/ordinal-scale',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(replaceOrdinalScaleSchema),
  asyncHandler(labrangeController.replaceOrdinalScale)
);

router.delete(
  '/:testId/ordinal-scale',
  authenticate,
  adminOnly,
  apiLimiter,
  asyncHandler(labrangeController.deleteOrdinalScale)
);

router.get(
  '/:testId/ranges/resolve',
  authenticate,
  staffOnly,
  readLimiter,
  validate(resolveRangeQuerySchema, 'query'),
  asyncHandler(labrangeController.resolveRange)
);

router.get(
  '/:testId/ranges',
  authenticate,
  adminOnly,
  readLimiter,
  asyncHandler(labrangeController.listRangesForTest)
);

router.post(
  '/:testId/ranges',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(createRangeSchema),
  asyncHandler(labrangeController.createRange)
);

router.post(
  '/:testId/ranges/bulk',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(bulkImportRangesSchema),
  asyncHandler(labrangeController.createManyRanges)
);

router.put(
  '/ranges/:rangeId',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(updateRangeSchema),
  asyncHandler(labrangeController.updateRange)
);

router.delete(
  '/ranges/:rangeId',
  authenticate,
  adminOnly,
  apiLimiter,
  asyncHandler(labrangeController.deleteRange)
);

router.delete(
  '/:testId/ranges',
  authenticate,
  adminOnly,
  apiLimiter,
  asyncHandler(labrangeController.deleteAllRangesForTest)
);

module.exports = router;
