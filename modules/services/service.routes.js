const express = require('express');
const Joi = require('joi');
const { authenticate, guestOrAuthenticated, adminOnly, staffOnly } = require('../../middlewares/auth');
const { apiLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const validate = require('../../middlewares/validate');
// AUDIT-FIX: S2 — import magic bytes validator alongside upload middleware
const { uploadSingleImage, validateImageContents } = require('../../utils/upload');
const {
  categorySchema,
  createServiceSchema,
  updateServiceSchema,
  paginationSchema,
  rateEntitySchema,
} = require('../../utils/schemas');
const asyncHandler = require('../../utils/asyncHandler');

// ── Composition Root ──────────────────────────────────────────────────────────
const pool = require('../../config/db');
const ServiceRepository = require('../../repositories/ServiceRepository');
const { createServiceService } = require('./service.service');
const { createServiceController } = require('./service.controller');

const serviceRepo = new ServiceRepository(pool);
const serviceService = createServiceService(serviceRepo);
const serviceController = createServiceController(serviceService);
// ─────────────────────────────────────────────────────────────────────────────

const router = express.Router();

const categoryQuerySchema = paginationSchema;
const serviceQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(10),
  search: Joi.string().max(100).trim().allow('', null),
  category_id: Joi.string().uuid({ version: 'uuidv4' }),
  is_active: Joi.boolean(),
  is_vip_exclusive: Joi.boolean(),
  service_kind: Joi.string().valid('MEDICAL', 'RADIOLOGY'),
});
const ratingsQuerySchema = paginationSchema.fork(['limit'], (schema) => schema.default(20));

router.get(
  '/categories',
  authenticate,
  readLimiter,
  validate(categoryQuerySchema, 'query'),
  asyncHandler(serviceController.listCategories)
);

router.post(
  '/categories',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(categorySchema),
  asyncHandler(serviceController.createCategory)
);

router.put(
  '/categories/:id',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(categorySchema),
  asyncHandler(serviceController.updateCategory)
);

router.delete(
  '/categories/:id',
  authenticate,
  adminOnly,
  apiLimiter,
  asyncHandler(serviceController.deleteCategory)
);

router.get(
  '/',
  guestOrAuthenticated,
  readLimiter,
  validate(serviceQuerySchema, 'query'),
  asyncHandler(serviceController.listServices)
);

router.post(
  '/',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(createServiceSchema),
  asyncHandler(serviceController.createService)
);

router.post(
  '/:id/rate',
  authenticate,
  apiLimiter,
  validate(rateEntitySchema),
  asyncHandler(serviceController.rateService)
);

router.get(
  '/:id/ratings',
  authenticate,
  staffOnly,
  readLimiter,
  validate(ratingsQuerySchema, 'query'),
  asyncHandler(serviceController.getServiceRatings)
);

router.get(
  '/:id',
  authenticate,
  staffOnly,
  readLimiter,
  asyncHandler(serviceController.getServiceById)
);

router.put(
  '/:id/image',
  authenticate,
  adminOnly,
  apiLimiter,
  uploadSingleImage,
  // AUDIT-FIX: S2 — magic bytes check runs after multer, before controller
  validateImageContents,
  asyncHandler(serviceController.uploadServiceImage)
);

router.put(
  '/:id',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(updateServiceSchema),
  asyncHandler(serviceController.updateService)
);

router.delete(
  '/:id',
  authenticate,
  adminOnly,
  apiLimiter,
  asyncHandler(serviceController.deactivateService)
);

module.exports = router;
