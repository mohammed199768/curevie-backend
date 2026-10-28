const pool = require('../../config/db');
const ServiceRepository = require('../../repositories/ServiceRepository');
const cache = require('../../utils/cache');
const { audit } = require('../../utils/logger');
const { AppError } = require('../../middlewares/errorHandler');
const { paginate, paginationMeta } = require('../../utils/pagination');
const { uploadPublicMedia, deletePublicMedia, toPublicMediaUrl } = require('../../utils/storage');

const serviceRepo = new ServiceRepository(pool);

const buildCacheKey = (prefix, query) => `${prefix}:${JSON.stringify(query || {})}`;

function presentService(service) {
  return service ? { ...service, image_url: toPublicMediaUrl(service.image_url) } : service;
}

function auditCatalog(req, action, targetType, targetId, details) {
  audit(action, { userId: req.user.id, role: req.user.role, targetId, targetType, ip: req.ip, details });
}

async function listCategories(req, res) {
  const cacheKey = buildCacheKey('services:categories', req.query);
  const cached = await cache.get(cacheKey);
  if (cached) return res.json(cached);

  const { page, limit, offset } = paginate(req.query);
  const { data, total } = await serviceRepo.listCategories({ search: req.query.search }, { limit, offset });
  const response = { data, pagination: paginationMeta(total, page, limit) };

  await cache.set(cacheKey, response, 600);
  return res.json(response);
}

async function createCategory(req, res) {
  const created = await serviceRepo.createCategory(req.body);
  auditCatalog(req, 'SERVICE_CATEGORY_CREATED', 'service_category', created.id);
  await cache.del('services:*');
  return res.status(201).json(created);
}

async function updateCategory(req, res) {
  const result = await serviceRepo.updateCategory(req.params.id, req.body);
  if (result.noUpdates) return res.status(400).json({ message: 'No fields to update', code: 'NO_UPDATES' });
  if (!result.row) throw new AppError('Category not found', 404, 'CATEGORY_NOT_FOUND');
  auditCatalog(req, 'SERVICE_CATEGORY_UPDATED', 'service_category', req.params.id, req.body);
  await cache.del('services:*');
  return res.json(result.row);
}

async function deleteCategory(req, res) {
  const deleted = await serviceRepo.deleteCategory(req.params.id);
  if (!deleted) throw new AppError('Category not found', 404, 'CATEGORY_NOT_FOUND');
  auditCatalog(req, 'SERVICE_CATEGORY_DELETED', 'service_category', req.params.id);
  await cache.del('services:*');
  return res.json({ message: 'Category deleted successfully', category: deleted });
}

// Short TTL: package changes do not clear the services:* keys.
async function getPublicCounts(req, res) {
  const cacheKey = 'services:counts';
  const cached = await cache.get(cacheKey);
  if (cached) return res.json(cached);

  const response = { data: await serviceRepo.countPublicCatalog() };
  await cache.set(cacheKey, response, 120);
  return res.json(response);
}

async function listServices(req, res) {
  const isAdmin = req.user?.role === 'ADMIN';
  // The public catalog only ever shows active services; VIP-only items are shown to logged-in users.
  const filters = {
    search: req.query.search,
    category_id: req.query.category_id,
    service_kind: req.query.service_kind,
    is_active: isAdmin ? req.query.is_active : true,
    is_vip_exclusive: req.user ? req.query.is_vip_exclusive : false,
  };

  const cacheKey = buildCacheKey('services:list', { ...req.query, ...filters, admin: isAdmin });
  const cached = await cache.get(cacheKey);
  if (cached) return res.json(cached);

  const { page, limit, offset } = paginate(req.query);
  const { data, total } = await serviceRepo.listServices(filters, { limit, offset });
  const response = { data: data.map(presentService), pagination: paginationMeta(total, page, limit) };

  await cache.set(cacheKey, response, 300);
  return res.json(response);
}

async function getServiceById(req, res) {
  const service = await serviceRepo.getServiceById(req.params.id);
  if (!service || (!service.is_active && req.user?.role !== 'ADMIN')) {
    throw new AppError('Service not found', 404, 'SERVICE_NOT_FOUND');
  }
  return res.json(presentService(service));
}

async function createService(req, res) {
  const created = await serviceRepo.createService(req.body);
  auditCatalog(req, 'SERVICE_CREATED', 'service', created.id);
  await cache.del('services:*');
  return res.status(201).json(presentService(created));
}

async function updateService(req, res) {
  const result = await serviceRepo.updateService(req.params.id, req.body);
  if (result.noUpdates) return res.status(400).json({ message: 'No fields to update', code: 'NO_UPDATES' });
  if (!result.row) throw new AppError('Service not found', 404, 'SERVICE_NOT_FOUND');
  auditCatalog(req, 'SERVICE_UPDATED', 'service', req.params.id, req.body);
  await cache.del('services:*');
  return res.json(presentService(result.row));
}

async function deactivateService(req, res) {
  const row = await serviceRepo.deactivateService(req.params.id);
  if (!row) throw new AppError('Service not found', 404, 'SERVICE_NOT_FOUND');
  auditCatalog(req, 'SERVICE_DEACTIVATED', 'service', req.params.id);
  await cache.del('services:*');
  return res.json({ message: 'Service deactivated successfully', service: presentService(row) });
}

async function uploadServiceImage(req, res) {
  if (!req.file) throw new AppError('Image file is required', 400, 'NO_FILE');
  const service = await serviceRepo.getMediaInfo(req.params.id);
  if (!service) throw new AppError('Service not found', 404, 'SERVICE_NOT_FOUND');

  const imageUrl = await uploadPublicMedia(req.file.buffer, { folder: 'services', mimeType: req.file.mimetype });

  const updated = await serviceRepo.updateImage(req.params.id, imageUrl);
  if (service.image_url) await deletePublicMedia(service.image_url);
  auditCatalog(req, 'SERVICE_IMAGE_UPDATED', 'service', req.params.id);
  await cache.del('services:*');
  return res.json(presentService(updated));
}

module.exports = {
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  listServices,
  getPublicCounts,
  getServiceById,
  createService,
  updateService,
  deactivateService,
  uploadServiceImage,
};
