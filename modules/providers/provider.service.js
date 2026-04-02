const bcrypt = require('bcryptjs');
const { paginate } = require('../../utils/pagination'); // AUDIT-FIX: DRY — centralized pagination helper replaces duplicated offset math

function createProviderService(providerRepo) {
  async function emailExists(email) {
    return providerRepo.emailExistsGlobal(email);
  }

  async function createProvider(data) {
    const { full_name, email, password, phone, type } = data;
    const hashedPassword = await bcrypt.hash(password, 12);
    return providerRepo.createProvider({ full_name, email, hashedPassword, phone, type });
  }

  async function listProviders({ page, limit, search, type, is_available }) {
    const { offset } = paginate({ page, limit }); // AUDIT-FIX: DRY — use shared pagination utility for consistent offsets
    return providerRepo.list({ search, type, is_available }, { limit, offset });
  }

  async function updateProvider(id, data) {
    return providerRepo.updateProvider(id, data);
  }

  async function deleteProvider(id) {
    return providerRepo.deleteProvider(id);
  }

  async function getProviderById(id) {
    return providerRepo.getById(id);
  }

  async function getProviderRatingsSummary(providerId) {
    return providerRepo.getRatingsSummary(providerId);
  }

  async function getProviderRatingsCount(providerId) {
    return providerRepo.getRatingsCount(providerId);
  }

  async function getProviderRatings(providerId, limit, offset) {
    return providerRepo.getRatings(providerId, limit, offset);
  }

  async function getProviderAvatarInfo(id) {
    return providerRepo.getAvatarInfo(id);
  }

  async function updateProviderAvatar(id, avatarUrl) {
    return providerRepo.updateAvatar(id, avatarUrl);
  }

  return {
    emailExists,
    createProvider,
    listProviders,
    updateProvider,
    deleteProvider,
    getProviderById,
    getProviderRatingsSummary,
    getProviderRatingsCount,
    getProviderRatings,
    getProviderAvatarInfo,
    updateProviderAvatar,
  };
}

module.exports = { createProviderService };
