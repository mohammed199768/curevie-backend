const express = require('express');
const Joi = require('joi');
const { authenticate, adminOnly, providerOnly, selfOrAdmin } = require('../../middlewares/auth');
const { apiLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const validate = require('../../middlewares/validate');
const { uploadImage } = require('../../utils/upload');
const {
  createProviderSchema,
  updateProviderSchema,
  providerAvailabilitySchema,
  providerListQuerySchema,
  providerRatingsQuerySchema,
} = require('../../utils/schemas');
const asyncHandler = require('../../utils/asyncHandler');
const controller = require('./provider.controller');

const router = express.Router();
const idParams = Joi.object({ id: Joi.string().uuid().required() });

router.use(authenticate);

router.post('/', adminOnly, apiLimiter, validate(createProviderSchema), asyncHandler(controller.createProvider));
router.get('/', adminOnly, readLimiter, validate(providerListQuerySchema, 'query'), asyncHandler(controller.listProviders));

router.get('/me', providerOnly, readLimiter, asyncHandler(controller.getMe));
router.put(
  '/me/availability',
  providerOnly,
  apiLimiter,
  validate(providerAvailabilitySchema),
  asyncHandler(controller.setAvailability)
);

router.get('/:id', readLimiter, validate(idParams, 'params'), selfOrAdmin, asyncHandler(controller.getProvider));
router.put(
  '/:id',
  apiLimiter,
  validate(idParams, 'params'),
  selfOrAdmin,
  validate(updateProviderSchema),
  asyncHandler(controller.updateProvider)
);
router.put(
  '/:id/avatar',
  apiLimiter,
  validate(idParams, 'params'),
  selfOrAdmin,
  ...uploadImage,
  asyncHandler(controller.uploadAvatar)
);
router.delete('/:id', adminOnly, apiLimiter, validate(idParams, 'params'), asyncHandler(controller.deleteProvider));
router.get(
  '/:id/ratings',
  readLimiter,
  validate(idParams, 'params'),
  selfOrAdmin,
  validate(providerRatingsQuerySchema, 'query'),
  asyncHandler(controller.getProviderRatings)
);

module.exports = router;
