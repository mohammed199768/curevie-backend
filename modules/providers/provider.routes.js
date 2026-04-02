const express = require('express');
const {
  authenticate,
  adminOnly,
  staffOnly,
  selfOrAdmin,
} = require('../../middlewares/auth');
const { apiLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const validate = require('../../middlewares/validate');
// AUDIT-FIX: S2 — import magic bytes validator alongside upload middleware
const { uploadSingleImage, validateImageContents } = require('../../utils/upload');
const {
  createProviderSchema,
  updateProviderSchema,
  paginationSchema,
  providerRatingsQuerySchema,
} = require('../../utils/schemas');
const asyncHandler = require('../../utils/asyncHandler');

// ── Composition Root ──────────────────────────────────────────────────────────
const pool = require('../../config/db');
const ProviderRepository = require('../../repositories/ProviderRepository');
const { createProviderService } = require('./provider.service');
const { createProviderController } = require('./provider.controller');

const providerRepo = new ProviderRepository(pool);
const providerService = createProviderService(providerRepo);
const providerController = createProviderController(providerService);
// ─────────────────────────────────────────────────────────────────────────────

const router = express.Router();

router.post(
  '/',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(createProviderSchema),
  asyncHandler(providerController.createProvider)
);

router.get(
  '/',
  authenticate,
  adminOnly,
  readLimiter,
  validate(paginationSchema, 'query'),
  asyncHandler(providerController.listProviders)
);

router.put(
  '/:id/avatar',
  authenticate,
  selfOrAdmin,
  apiLimiter,
  uploadSingleImage,
  // AUDIT-FIX: S2 — magic bytes check runs after multer, before controller
  validateImageContents,
  asyncHandler(providerController.uploadAvatar)
);

router.put(
  '/:id',
  authenticate,
  selfOrAdmin,
  apiLimiter,
  validate(updateProviderSchema),
  asyncHandler(providerController.updateProvider)
);

router.delete(
  '/:id',
  authenticate,
  adminOnly,
  apiLimiter,
  asyncHandler(providerController.deleteProvider)
);

router.get(
  '/:id/ratings',
  authenticate,
  staffOnly,
  readLimiter,
  validate(providerRatingsQuerySchema, 'query'),
  asyncHandler(providerController.getProviderRatings)
);

module.exports = router;
