const express = require('express');
const Joi = require('joi');
const { authenticate, guestOrAuthenticated, adminOnly, staffOnly } = require('../../middlewares/auth');
const { apiLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const validate = require('../../middlewares/validate');
// AUDIT-FIX: S2 — import magic bytes validator alongside upload middleware
const { uploadSingleImage, validateImageContents } = require('../../utils/upload');
const {
  createLabTestSchema,
  createPackageSchema,
  createLabPanelSchema,
  updateLabPanelSchema,
  createLabPackageSchema,
  updateLabPackageSchema,
  rateEntitySchema,
  paginationSchema,
} = require('../../utils/schemas');
const asyncHandler = require('../../utils/asyncHandler');
const pool = require('../../config/db'); // AUDIT-FIX: P3-STEP8-DIP - labtest routes remain the composition root for DB-backed dependencies.
const LabTestRepository = require('../../repositories/LabTestRepository'); // AUDIT-FIX: P3-STEP8-DIP - labtest routes wire the concrete lab-test repository explicitly.
const LabRangeRepository = require('../../repositories/LabRangeRepository'); // AUDIT-FIX: P3-STEP8-DIP - labtest routes wire the concrete lab-range repository explicitly.
const { createLabTestService } = require('./labtest.service'); // AUDIT-FIX: P3-STEP8-DIP - labtest routes compose the lab-test service explicitly.
const { configureLabRangeService } = require('./labrange.service'); // AUDIT-FIX: P3-STEP8-DIP - labrange service is configured at the composition root instead of self-owning its DB dependency.
const { createLabTestController } = require('./labtest.controller'); // AUDIT-FIX: P3-STEP8-DIP - labtest routes compose the lab-test controller explicitly.
const labRangeRepo = new LabRangeRepository(pool); // AUDIT-FIX: P3-STEP8-DIP - labtest routes own the concrete lab-range repository instance.
configureLabRangeService(labRangeRepo); // AUDIT-FIX: P3-STEP8-DIP - labrange service is explicitly bound to the route-level repository instance.
const labrangeRoutes = require('./labrange.routes'); // AUDIT-FIX: P3-STEP8-DIP - range routes load after labrange service composition is complete.

const labTestRepo = new LabTestRepository(pool);
const labtestService = createLabTestService(labTestRepo);
const labtestController = createLabTestController(labtestService);

const router = express.Router();
const labReferenceRangePattern = /^-?\d+(?:\.\d+)?\s*[-–]\s*-?\d+(?:\.\d+)?$/;
const labSampleTypeValues = ['serum', 'edta', 'plasma', 'citrate'];

const updateLabTestSchema = Joi.object({
  name: Joi.string().min(2).max(150).trim(),
  description: Joi.string().max(1000).trim().allow('', null),
  unit: Joi.string().max(50).trim(),
  reference_range: Joi.string().max(200).trim().pattern(labReferenceRangePattern),
  sample_type: Joi.string().valid(...labSampleTypeValues),
  cost: Joi.number().positive().precision(2),
  category_id: Joi.string().uuid({ version: 'uuidv4' }).allow(null),
  is_vip_exclusive: Joi.boolean(),
  is_active: Joi.boolean(),
}).min(1);

const packageWorkflowItemSchema = Joi.object({
  item_type: Joi.string().valid('service', 'test').required(),
  item_id: Joi.string().uuid({ version: 'uuidv4' }).required(),
});

function validatePackageContentUpdate(value, helpers) {
  const updatesPackageContents = Object.prototype.hasOwnProperty.call(value, 'test_ids')
    || Object.prototype.hasOwnProperty.call(value, 'service_ids')
    || Object.prototype.hasOwnProperty.call(value, 'workflow_items');

  if (!updatesPackageContents) {
    return value;
  }

  const workflowItems = Array.isArray(value.workflow_items) ? value.workflow_items : [];
  const testsCount = workflowItems.length
    ? workflowItems.filter((item) => item?.item_type === 'test').length
    : Array.isArray(value.test_ids) ? value.test_ids.length : 0;
  const servicesCount = workflowItems.length
    ? workflowItems.filter((item) => item?.item_type === 'service').length
    : Array.isArray(value.service_ids) ? value.service_ids.length : 0;
  if (testsCount + servicesCount < 1) {
    return helpers.message('At least one lab test or service is required');
  }

  return value;
}

const packageUpdateSchema = Joi.object({
  name: Joi.string().min(2).max(150).trim(),
  description: Joi.string().max(1000).trim().allow('', null),
  total_cost: Joi.number().positive().precision(2),
  category_id: Joi.string().uuid({ version: 'uuidv4' }).allow(null),
  is_vip_exclusive: Joi.boolean(),
  is_active: Joi.boolean(),
  workflow_items: Joi.array().items(packageWorkflowItemSchema),
  test_ids: Joi.array().items(Joi.string().uuid({ version: 'uuidv4' })),
  service_ids: Joi.array().items(Joi.string().uuid({ version: 'uuidv4' })),
}).min(1).custom(validatePackageContentUpdate, 'package contents validation');

const querySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(10),
  search: Joi.string().max(100).trim().allow('', null),
  category_id: Joi.string().uuid({ version: 'uuidv4' }),
  is_active: Joi.boolean(),
  include_inactive: Joi.boolean(),
  is_vip_exclusive: Joi.boolean(),
});
const ratingsQuerySchema = paginationSchema.fork(['limit'], (schema) => schema.default(20));

router.use('/', labrangeRoutes);

router.get(
  '/',
  guestOrAuthenticated,
  readLimiter,
  validate(querySchema, 'query'),
  asyncHandler(labtestController.listLabTests)
);

router.post(
  '/',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(createLabTestSchema),
  asyncHandler(labtestController.createLabTest)
);

router.put(
  '/:id',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(updateLabTestSchema),
  asyncHandler(labtestController.updateLabTest)
);

router.put(
  '/:id/image',
  authenticate,
  adminOnly,
  apiLimiter,
  uploadSingleImage,
  // AUDIT-FIX: S2 — magic bytes check runs after multer, before controller
  validateImageContents,
  asyncHandler(labtestController.uploadLabTestImage)
);

router.post(
  '/:id/rate',
  authenticate,
  apiLimiter,
  validate(rateEntitySchema),
  asyncHandler(labtestController.rateLabTest)
);

router.get(
  '/:id/ratings',
  authenticate,
  staffOnly,
  readLimiter,
  validate(ratingsQuerySchema, 'query'),
  asyncHandler(labtestController.getLabTestRatings)
);

router.get(
  '/packages',
  guestOrAuthenticated,
  readLimiter,
  validate(querySchema, 'query'),
  asyncHandler(labtestController.listPackages)
);

router.post(
  '/packages',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(createPackageSchema),
  asyncHandler(labtestController.createPackage)
);

router.put(
  '/packages/:id',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(packageUpdateSchema),
  asyncHandler(labtestController.updatePackage)
);

router.put(
  '/packages/:id/image',
  authenticate,
  adminOnly,
  apiLimiter,
  uploadSingleImage,
  // AUDIT-FIX: S2 — magic bytes check runs after multer, before controller
  validateImageContents,
  asyncHandler(labtestController.uploadPackageImage)
);

router.post(
  '/packages/:id/rate',
  authenticate,
  apiLimiter,
  validate(rateEntitySchema),
  asyncHandler(labtestController.ratePackage)
);

router.get(
  '/packages/:id/ratings',
  authenticate,
  staffOnly,
  readLimiter,
  validate(ratingsQuerySchema, 'query'),
  asyncHandler(labtestController.getPackageRatings)
);

router.get(
  '/panels',
  guestOrAuthenticated,
  readLimiter,
  validate(querySchema, 'query'),
  asyncHandler(labtestController.listLabPanels)
);

router.post(
  '/panels',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(createLabPanelSchema),
  asyncHandler(labtestController.createLabPanel)
);

router.get(
  '/panels/:id',
  guestOrAuthenticated,
  readLimiter,
  asyncHandler(labtestController.getLabPanelById)
);

router.put(
  '/panels/:id',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(updateLabPanelSchema),
  asyncHandler(labtestController.updateLabPanel)
);

router.delete(
  '/panels/:id',
  authenticate,
  adminOnly,
  apiLimiter,
  asyncHandler(labtestController.deactivateLabPanel)
);

router.get(
  '/lab-packages',
  guestOrAuthenticated,
  readLimiter,
  validate(querySchema, 'query'),
  asyncHandler(labtestController.listLabPackages)
);

router.post(
  '/lab-packages',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(createLabPackageSchema),
  asyncHandler(labtestController.createLabPackage)
);

router.get(
  '/lab-packages/:id',
  guestOrAuthenticated,
  readLimiter,
  asyncHandler(labtestController.getLabPackageById)
);

router.put(
  '/lab-packages/:id',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(updateLabPackageSchema),
  asyncHandler(labtestController.updateLabPackage)
);

router.delete(
  '/lab-packages/:id',
  authenticate,
  adminOnly,
  apiLimiter,
  asyncHandler(labtestController.deactivateLabPackage)
);

router.get(
  '/packages/:id',
  authenticate,
  staffOnly,
  readLimiter,
  asyncHandler(labtestController.getPackageById)
);

router.get(
  '/:id',
  authenticate,
  staffOnly,
  readLimiter,
  asyncHandler(labtestController.getLabTestById)
);

module.exports = router;
