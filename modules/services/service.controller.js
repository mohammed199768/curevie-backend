const cache = require('../../utils/cache');
const { logger, audit } = require('../../utils/logger');
const { isBunnyConfigured, uploadToBunny, deleteFromBunny } = require('../../utils/bunny');
const { paginate, paginationMeta } = require('../../utils/pagination'); // AUDIT-FIX: DRY — shared pagination helpers replace manual list response metadata

const buildCacheKey = (prefix, query) => `${prefix}:${JSON.stringify(query || {})}`;

function createServiceController(serviceService) {
  async function listCategories(req, res) {
    const cacheKey = buildCacheKey('services:categories', req.query);
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    const { page, limit, search } = req.query;
    const { page: currentPage, limit: currentLimit } = paginate(req.query); // AUDIT-FIX: DRY — normalize category pagination through the shared helper
    const { data, total } = await serviceService.listCategories({ page, limit, search });

    const response = {
      data,
      pagination: paginationMeta(total, currentPage, currentLimit), // AUDIT-FIX: DRY — standardized list response shape for categories
    };

    await cache.set(cacheKey, response, 600);
    return res.json(response);
  }

  async function createCategory(req, res) {
    const created = await serviceService.createCategory(req.body);

    audit('SERVICE_CATEGORY_CREATED', {
      userId: req.user.id, role: req.user.role,
      targetId: created.id, targetType: 'service_category', ip: req.ip,
    });

    await cache.del('services:categories:*');
    return res.status(201).json(created);
  }

  async function updateCategory(req, res) {
    const result = await serviceService.updateCategory(req.params.id, req.body);
    if (result.noUpdates) {
      return res.status(400).json({ message: 'No fields to update', code: 'NO_UPDATES' });
    }
    if (!result.row) {
      return res.status(404).json({ message: 'Category not found', code: 'CATEGORY_NOT_FOUND' });
    }

    audit('SERVICE_CATEGORY_UPDATED', {
      userId: req.user.id, role: req.user.role,
      targetId: req.params.id, targetType: 'service_category', ip: req.ip, details: req.body,
    });

    await cache.del('services:categories:*');
    return res.json(result.row);
  }

  async function deleteCategory(req, res) {
    let deleted;
    try {
      deleted = await serviceService.deleteCategory(req.params.id);
    } catch (err) {
      if (err.code === '23503') {
        return res.status(409).json({
          message: 'Cannot delete category with linked services',
          code: 'CATEGORY_IN_USE',
        });
      }
      throw err;
    }

    if (!deleted) {
      return res.status(404).json({ message: 'Category not found', code: 'CATEGORY_NOT_FOUND' });
    }

    audit('SERVICE_CATEGORY_DELETED', {
      userId: req.user.id, role: req.user.role,
      targetId: req.params.id, targetType: 'service_category', ip: req.ip,
    });

    await cache.del('services:categories:*');
    return res.json({ message: 'Category deleted successfully', category: deleted });
  }

  async function listServices(req, res) {
    const cacheKey = buildCacheKey('services:list', {
      ...req.query,
      viewer_role: req.user?.role || 'GUEST',
    });
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    const { page, limit, search, category_id, is_active, is_vip_exclusive, service_kind } = req.query;
    const { page: currentPage, limit: currentLimit } = paginate(req.query); // AUDIT-FIX: DRY — normalize service pagination through the shared helper
    const effectiveVipExclusive = req.user ? is_vip_exclusive : false;
    const { data, total } = await serviceService.listServices({
      page, limit, search, category_id, is_active,
      is_vip_exclusive: effectiveVipExclusive, service_kind,
    });

    const response = {
      data,
      pagination: paginationMeta(total, currentPage, currentLimit), // AUDIT-FIX: DRY — standardized list response shape for services
    };

    await cache.set(cacheKey, response, 300);
    return res.json(response);
  }

  async function createService(req, res) {
    const created = await serviceService.createService(req.body);

    audit('SERVICE_CREATED', {
      userId: req.user.id, role: req.user.role,
      targetId: created.id, targetType: 'service', ip: req.ip,
    });

    await cache.del('services:list:*');
    return res.status(201).json(created);
  }

  async function getServiceById(req, res) {
    const service = await serviceService.getServiceById(req.params.id);
    if (!service) {
      return res.status(404).json({ message: 'Service not found', code: 'SERVICE_NOT_FOUND' });
    }
    return res.json(service);
  }

  async function updateService(req, res) {
    const result = await serviceService.updateService(req.params.id, req.body);
    if (result.noUpdates) {
      return res.status(400).json({ message: 'No fields to update', code: 'NO_UPDATES' });
    }
    if (!result.row) {
      return res.status(404).json({ message: 'Service not found', code: 'SERVICE_NOT_FOUND' });
    }

    audit('SERVICE_UPDATED', {
      userId: req.user.id, role: req.user.role,
      targetId: req.params.id, targetType: 'service', ip: req.ip, details: req.body,
    });

    await cache.del('services:list:*');
    return res.json(result.row);
  }

  async function deactivateService(req, res) {
    const row = await serviceService.deactivateService(req.params.id);
    if (!row) {
      return res.status(404).json({ message: 'Service not found', code: 'SERVICE_NOT_FOUND' });
    }

    audit('SERVICE_DEACTIVATED', {
      userId: req.user.id, role: req.user.role,
      targetId: req.params.id, targetType: 'service', ip: req.ip,
    });

    await cache.del('services:list:*');
    return res.json({ message: 'Service deactivated successfully', service: row });
  }

  async function uploadServiceImage(req, res) {
    if (!req.file) {
      return res.status(400).json({ message: 'Image file is required', code: 'NO_FILE' });
    }
    if (!isBunnyConfigured()) {
      return res.status(503).json({ message: 'Media service not configured', code: 'MEDIA_NOT_CONFIGURED' });
    }

    const service = await serviceService.getServiceMediaInfo(req.params.id);
    if (!service) {
      return res.status(404).json({ message: 'Service not found', code: 'SERVICE_NOT_FOUND' });
    }

    const imageUrl = await uploadToBunny(req.file.buffer, req.file.originalname, 'services');
    if (!imageUrl) {
      return res.status(502).json({ message: 'Failed to upload media', code: 'MEDIA_UPLOAD_FAILED' });
    }

    const updated = await serviceService.updateServiceImage(req.params.id, imageUrl);

    if (service.image_url) {
      try {
        const deleted = await deleteFromBunny(service.image_url);
        if (deleted === false) {
          logger.warn('Failed to delete previous service image from Bunny', {
            serviceId: req.params.id, oldUrl: service.image_url, newUrl: imageUrl,
          });
        }
      } catch (err) {
        logger.warn('Failed to delete previous service image from Bunny', {
          serviceId: req.params.id, oldUrl: service.image_url, newUrl: imageUrl, error: err.message,
        });
      }
    }

    audit('SERVICE_IMAGE_UPDATED', {
      userId: req.user.id, role: req.user.role,
      targetId: req.params.id, targetType: 'service', ip: req.ip,
    });

    await cache.del('services:list:*');
    return res.json(updated);
  }

  async function rateService(req, res) {
    if (req.user.role !== 'PATIENT') {
      return res.status(403).json({ message: 'Patient access required', code: 'FORBIDDEN' });
    }

    const service = await serviceService.getServiceMediaInfo(req.params.id);
    if (!service) {
      return res.status(404).json({ message: 'Service not found', code: 'SERVICE_NOT_FOUND' });
    }

    const existing = await serviceService.getDirectServiceRating(req.user.id, req.params.id);
    if (existing) {
      return res.status(409).json({ message: 'Service already rated', code: 'SERVICE_ALREADY_RATED' });
    }

    const rating = await serviceService.createDirectServiceRating({
      patientId: req.user.id,
      serviceId: req.params.id,
      rating: req.body.rating,
      comment: req.body.comment,
    });

    return res.status(201).json(rating);
  }

  async function getServiceRatings(req, res) {
    const service = await serviceService.getServiceMediaInfo(req.params.id);
    if (!service) {
      return res.status(404).json({ message: 'Service not found', code: 'SERVICE_NOT_FOUND' });
    }

    const [summary, ratings] = await Promise.all([
      serviceService.getServiceRatingsSummary(req.params.id),
      serviceService.listServiceRatings(req.params.id, req.query),
    ]);

    return res.json({
      service, summary,
      data: ratings.data,
      pagination: ratings.pagination, // AUDIT-FIX: DRY — reuse standardized pagination metadata from the shared service helper
    });
  }

  return {
    listCategories, createCategory, updateCategory, deleteCategory,
    listServices, createService, getServiceById, updateService,
    deactivateService, uploadServiceImage, rateService, getServiceRatings,
  };
}

module.exports = { createServiceController };
