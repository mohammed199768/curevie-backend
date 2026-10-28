const express = require('express');
const Joi = require('joi');
const { authenticate, guestOrAuthenticated, adminOnly } = require('../../middlewares/auth');
const { apiLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const validate = require('../../middlewares/validate');
const { uploadImage } = require('../../utils/upload');
const { categorySchema, createServiceSchema, updateServiceSchema, paginationSchema } = require('../../utils/schemas');
const asyncHandler = require('../../utils/asyncHandler');
const controller = require('./service.controller');

const router = express.Router();

const idParams = Joi.object({ id: Joi.string().uuid().required() });
const serviceQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(10),
  search: Joi.string().max(100).trim().allow('', null),
  category_id: Joi.string().uuid(),
  is_active: Joi.boolean(),
  is_vip_exclusive: Joi.boolean(),
  service_kind: Joi.string().valid('MEDICAL', 'NURSING', 'RADIOLOGY', 'LAB'),
});

// Public catalog reads.
router.get('/categories', guestOrAuthenticated, readLimiter, validate(paginationSchema, 'query'), asyncHandler(controller.listCategories));
router.get('/counts', readLimiter, asyncHandler(controller.getPublicCounts));
router.get('/', guestOrAuthenticated, readLimiter, validate(serviceQuerySchema, 'query'), asyncHandler(controller.listServices));
router.get('/:id', guestOrAuthenticated, readLimiter, validate(idParams, 'params'), asyncHandler(controller.getServiceById));

// Admin catalog management.
router.post('/categories', authenticate, adminOnly, apiLimiter, validate(categorySchema), asyncHandler(controller.createCategory));
router.put(
  '/categories/:id',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(idParams, 'params'),
  validate(categorySchema),
  asyncHandler(controller.updateCategory)
);
router.delete('/categories/:id', authenticate, adminOnly, apiLimiter, validate(idParams, 'params'), asyncHandler(controller.deleteCategory));
router.post('/', authenticate, adminOnly, apiLimiter, validate(createServiceSchema), asyncHandler(controller.createService));
router.put(
  '/:id/image',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(idParams, 'params'),
  ...uploadImage,
  asyncHandler(controller.uploadServiceImage)
);
router.put(
  '/:id',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(idParams, 'params'),
  validate(updateServiceSchema),
  asyncHandler(controller.updateService)
);
router.delete('/:id', authenticate, adminOnly, apiLimiter, validate(idParams, 'params'), asyncHandler(controller.deactivateService));

module.exports = router;
