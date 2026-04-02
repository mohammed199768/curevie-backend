const { paginate, paginationMeta } = require('../../utils/pagination'); // AUDIT-FIX: DRY — shared pagination helpers replace repeated bounds/meta code

function createServiceService(serviceRepo) {
  async function listCategories({ page, limit, search }) {
    const { offset } = paginate({ page, limit }); // AUDIT-FIX: DRY — use centralized offset calculation for category lists
    return serviceRepo.listCategories({ search }, { limit, offset });
  }

  async function createCategory(data) {
    return serviceRepo.createCategory(data);
  }

  async function updateCategory(id, data) {
    return serviceRepo.updateCategory(id, data);
  }

  async function deleteCategory(id) {
    return serviceRepo.deleteCategory(id);
  }

  async function listServices({ page, limit, search, category_id, is_active, is_vip_exclusive, service_kind }) {
    const { offset } = paginate({ page, limit }); // AUDIT-FIX: DRY — use centralized offset calculation for service lists
    return serviceRepo.listServices(
      { search, category_id, is_active, is_vip_exclusive, service_kind },
      { limit, offset }
    );
  }

  async function createService(data) {
    return serviceRepo.createService(data);
  }

  async function getServiceById(id) {
    return serviceRepo.getServiceById(id);
  }

  async function updateService(id, body) {
    return serviceRepo.updateService(id, body);
  }

  async function deactivateService(id) {
    return serviceRepo.deactivateService(id);
  }

  async function getServiceMediaInfo(id) {
    return serviceRepo.getMediaInfo(id);
  }

  async function updateServiceImage(id, imageUrl) {
    return serviceRepo.updateImage(id, imageUrl);
  }

  async function getDirectServiceRating(patientId, serviceId) {
    return serviceRepo.getDirectRating(patientId, serviceId);
  }

  async function createDirectServiceRating(data) {
    return serviceRepo.createDirectRating(data);
  }

  async function getServiceRatingsSummary(serviceId) {
    return serviceRepo.getRatingsSummary(serviceId);
  }

  async function listServiceRatings(serviceId, { page = 1, limit = 20 } = {}) {
    const { page: safePage, limit: safeLimit, offset } = paginate({ page, limit }); // AUDIT-FIX: DRY — shared pagination bounds for ratings queries

    const { data, total } = await serviceRepo.listRatings(serviceId, { limit: safeLimit, offset });
    return { // AUDIT-FIX: DRY — standardized pagination metadata while preserving legacy top-level fields for callers
      data,
      total,
      page: safePage,
      limit: safeLimit,
      pagination: paginationMeta(total, safePage, safeLimit),
    };
  }

  return {
    listCategories,
    createCategory,
    updateCategory,
    deleteCategory,
    listServices,
    createService,
    getServiceById,
    updateService,
    deactivateService,
    getServiceMediaInfo,
    updateServiceImage,
    getDirectServiceRating,
    createDirectServiceRating,
    getServiceRatingsSummary,
    listServiceRatings,
  };
}

module.exports = { createServiceService };
