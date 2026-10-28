// Packages: fixed-price bundles of services (medical, nursing, radiology and lab tests).
const express = require('express');
const Joi = require('joi');
const pool = require('../../config/db');
const PackageRepository = require('../../repositories/PackageRepository');
const { authenticate, guestOrAuthenticated, adminOnly } = require('../../middlewares/auth');
const { apiLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../utils/asyncHandler');
const cache = require('../../utils/cache');
const { AppError } = require('../../middlewares/errorHandler');
const { audit } = require('../../utils/logger');
const { paginate, paginationMeta } = require('../../utils/pagination');
const { uploadImage } = require('../../utils/upload');
const { uploadPublicMedia, deletePublicMedia, toPublicMediaUrl } = require('../../utils/storage');
const { createPackageSchema, updatePackageSchema } = require('../../utils/schemas');

const router = express.Router();
const packageRepo = new PackageRepository(pool);

const CACHE_PREFIX = 'packages:';
const idParams = Joi.object({ id: Joi.string().uuid().required() });
const listQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  search: Joi.string().trim().max(100).allow(''),
  category_id: Joi.string().uuid(),
  is_active: Joi.boolean(),
  is_vip_exclusive: Joi.boolean(),
});

function present(pkg) {
  if (!pkg) return pkg;
  return {
    ...pkg,
    image_url: toPublicMediaUrl(pkg.image_url),
    // What the patient saves compared to ordering the services one by one.
    savings: Math.max(0, Number(pkg.items_total) - Number(pkg.total_cost)).toFixed(3),
  };
}

async function assertServicesExist(serviceIds) {
  if (serviceIds && (await packageRepo.countKnownServices(serviceIds)) !== serviceIds.length) {
    throw new AppError('One or more services do not exist', 400, 'INVALID_SERVICE');
  }
}

function auditPackage(req, action, targetId) {
  audit(action, { userId: req.user.id, role: req.user.role, targetId, targetType: 'package', ip: req.ip });
}

router.get(
  '/',
  guestOrAuthenticated,
  readLimiter,
  validate(listQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const isAdmin = req.user?.role === 'ADMIN';
    const filters = {
      search: req.query.search,
      category_id: req.query.category_id,
      is_active: isAdmin ? req.query.is_active : true,
      is_vip_exclusive: req.user ? req.query.is_vip_exclusive : false,
    };
    const cacheKey = `${CACHE_PREFIX}${JSON.stringify({ ...req.query, ...filters, isAdmin })}`;
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    const { page, limit, offset } = paginate(req.query);
    const { data, total } = await packageRepo.list(filters, { limit, offset });
    const response = { data: data.map(present), pagination: paginationMeta(total, page, limit) };
    await cache.set(cacheKey, response, 300);
    return res.json(response);
  })
);

router.get(
  '/:id',
  guestOrAuthenticated,
  readLimiter,
  validate(idParams, 'params'),
  asyncHandler(async (req, res) => {
    const pkg = await packageRepo.getById(req.params.id);
    if (!pkg || (!pkg.is_active && req.user?.role !== 'ADMIN')) {
      throw new AppError('Package not found', 404, 'PACKAGE_NOT_FOUND');
    }
    return res.json(present(pkg));
  })
);

router.post(
  '/',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(createPackageSchema),
  asyncHandler(async (req, res) => {
    const { service_ids: serviceIds, ...fields } = req.body;
    await assertServicesExist(serviceIds);

    const created = await packageRepo.withTransaction(async (client) => {
      const row = await packageRepo.create(fields, client);
      await packageRepo.replaceServices(row.id, serviceIds, client);
      return row;
    });

    auditPackage(req, 'PACKAGE_CREATED', created.id);
    await cache.del(`${CACHE_PREFIX}*`);
    return res.status(201).json(present(await packageRepo.getById(created.id)));
  })
);

router.put(
  '/:id',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(idParams, 'params'),
  validate(updatePackageSchema),
  asyncHandler(async (req, res) => {
    if (!(await packageRepo.getById(req.params.id))) throw new AppError('Package not found', 404, 'PACKAGE_NOT_FOUND');
    const { service_ids: serviceIds, ...fields } = req.body;
    await assertServicesExist(serviceIds);

    await packageRepo.withTransaction(async (client) => {
      if (Object.keys(fields).length) await packageRepo.updateFields(req.params.id, fields, client);
      if (serviceIds) await packageRepo.replaceServices(req.params.id, serviceIds, client);
    });

    auditPackage(req, 'PACKAGE_UPDATED', req.params.id);
    await cache.del(`${CACHE_PREFIX}*`);
    return res.json(present(await packageRepo.getById(req.params.id)));
  })
);

router.put(
  '/:id/image',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(idParams, 'params'),
  ...uploadImage,
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError('Image file is required', 400, 'NO_FILE');
    const pkg = await packageRepo.getMediaInfo(req.params.id);
    if (!pkg) throw new AppError('Package not found', 404, 'PACKAGE_NOT_FOUND');

    const imageUrl = await uploadPublicMedia(req.file.buffer, { folder: 'packages', mimeType: req.file.mimetype });
    if (!imageUrl) throw new AppError('Media service not configured', 503, 'MEDIA_NOT_CONFIGURED');

    await packageRepo.updateImage(req.params.id, imageUrl);
    if (pkg.image_url) await deletePublicMedia(pkg.image_url);
    auditPackage(req, 'PACKAGE_IMAGE_UPDATED', req.params.id);
    await cache.del(`${CACHE_PREFIX}*`);
    return res.json(present(await packageRepo.getById(req.params.id)));
  })
);

// Packages already ordered must stay readable, so "delete" only deactivates.
router.delete(
  '/:id',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(idParams, 'params'),
  asyncHandler(async (req, res) => {
    const row = await packageRepo.deactivate(req.params.id);
    if (!row) throw new AppError('Package not found', 404, 'PACKAGE_NOT_FOUND');
    auditPackage(req, 'PACKAGE_DEACTIVATED', req.params.id);
    await cache.del(`${CACHE_PREFIX}*`);
    return res.json({ message: 'Package deactivated' });
  })
);

module.exports = router;
