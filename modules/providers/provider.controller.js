const bcrypt = require('bcryptjs');
const pool = require('../../config/db');
const ProviderRepository = require('../../repositories/ProviderRepository');
const AuthRepository = require('../../repositories/AuthRepository');
const caseService = require('../cases/case.service');
const { AppError } = require('../../middlewares/errorHandler');
const { audit } = require('../../utils/logger');
const { paginate, paginationMeta } = require('../../utils/pagination');
const { uploadPublicMedia, deletePublicMedia, toPublicMediaUrl } = require('../../utils/storage');

const providerRepo = new ProviderRepository(pool);
const authRepo = new AuthRepository(pool);

// Fields a provider may change on their own profile; everything else is admin-only.
const SELF_EDITABLE_FIELDS = ['full_name', 'phone', 'is_available'];

function present(provider) {
  if (!provider) return provider;
  return {
    ...provider,
    avatar_url: toPublicMediaUrl(provider.avatar_url),
    average_rating: Number(provider.average_rating || 0),
  };
}

function auditProvider(req, action, details) {
  audit(action, {
    userId: req.user.id,
    role: req.user.role,
    targetId: req.params.id,
    targetType: 'provider',
    ip: req.ip,
    details,
  });
}

async function assertAreasExist(areaIds) {
  if (areaIds.length && (await providerRepo.countKnownAreas(areaIds)) !== areaIds.length) {
    throw new AppError('One or more areas do not exist', 400, 'INVALID_AREA');
  }
}

async function loadProvider(id) {
  const provider = await providerRepo.getById(id);
  if (!provider) throw new AppError('Provider not found', 404, 'PROVIDER_NOT_FOUND');
  return provider;
}

async function createProvider(req, res) {
  const { area_ids: areaIds = [], password, ...profile } = req.body;
  if (await providerRepo.emailExistsGlobal(profile.email)) {
    return res.status(409).json({ message: 'Email already exists', code: 'EMAIL_EXISTS' });
  }
  await assertAreasExist(areaIds);

  const created = await providerRepo.withTransaction(async (client) => {
    const row = await providerRepo.createProvider({ ...profile, hashedPassword: await bcrypt.hash(password, 12) }, client);
    await providerRepo.replaceAreas(row.id, areaIds, client);
    return row;
  });

  audit('PROVIDER_CREATED', { userId: req.user.id, role: req.user.role, targetId: created.id, targetType: 'provider', ip: req.ip });
  return res.status(201).json(present(await providerRepo.getById(created.id)));
}

async function listProviders(req, res) {
  const { page, limit, offset } = paginate(req.query);
  const { data, total } = await providerRepo.list(req.query, { limit, offset });
  return res.json({ data: data.map(present), pagination: paginationMeta(total, page, limit) });
}

async function getProvider(req, res) {
  return res.json(present(await loadProvider(req.params.id)));
}

async function getMe(req, res) {
  return res.json(present(await loadProvider(req.user.id)));
}

async function updateProvider(req, res) {
  const isAdmin = req.user.role === 'ADMIN';
  const payload = { ...req.body };

  if (!isAdmin) {
    const forbidden = Object.keys(payload).filter((key) => !SELF_EDITABLE_FIELDS.includes(key));
    if (forbidden.length) {
      throw new AppError(`Only an admin can change: ${forbidden.join(', ')}`, 403, 'FORBIDDEN');
    }
  }

  await loadProvider(req.params.id);
  const { area_ids: areaIds, ...fields } = payload;
  if (areaIds) await assertAreasExist(areaIds);

  await providerRepo.withTransaction(async (client) => {
    if (Object.keys(fields).length) await providerRepo.updateProvider(req.params.id, fields, client);
    if (areaIds) await providerRepo.replaceAreas(req.params.id, areaIds, client);
  });

  // Disabling an account ends its sessions immediately.
  if (fields.is_active === false) await authRepo.revokeAllUserTokens(req.params.id, 'PROVIDER');

  auditProvider(req, 'PROVIDER_UPDATED', Object.keys(payload));
  return res.json(present(await providerRepo.getById(req.params.id)));
}

async function setAvailability(req, res) {
  await providerRepo.updateProvider(req.user.id, { is_available: req.body.is_available });
  return res.json(present(await loadProvider(req.user.id)));
}

async function deleteProvider(req, res) {
  await loadProvider(req.params.id);
  const openJobs = await providerRepo.countOpenJobs(req.params.id);
  if (openJobs > 0) {
    throw new AppError(
      `Provider still has ${openJobs} open job(s). Reassign them before deleting the account.`,
      409,
      'PROVIDER_HAS_OPEN_JOBS'
    );
  }

  const row = await providerRepo.softDelete(req.params.id);
  await authRepo.revokeAllUserTokens(req.params.id, 'PROVIDER');
  auditProvider(req, 'PROVIDER_DELETED');
  return res.json({ message: 'Provider deleted successfully', provider: row });
}

async function getProviderRatings(req, res) {
  await loadProvider(req.params.id);
  const { page, limit } = paginate(req.query);
  return res.json(await caseService.getProviderRatings(req.params.id, { page, limit }));
}

async function uploadAvatar(req, res) {
  if (!req.file) throw new AppError('Image file is required', 400, 'NO_FILE');
  const provider = await providerRepo.getAvatarInfo(req.params.id);
  if (!provider) throw new AppError('Provider not found', 404, 'PROVIDER_NOT_FOUND');

  const avatarUrl = await uploadPublicMedia(req.file.buffer, { folder: 'providers/avatars', mimeType: req.file.mimetype });
  if (!avatarUrl) throw new AppError('Media service not configured', 503, 'MEDIA_NOT_CONFIGURED');

  await providerRepo.updateAvatar(req.params.id, avatarUrl);
  if (provider.avatar_url) await deletePublicMedia(provider.avatar_url);
  auditProvider(req, 'PROVIDER_AVATAR_UPDATED');
  return res.json(present(await providerRepo.getById(req.params.id)));
}

module.exports = {
  createProvider,
  listProviders,
  getProvider,
  getMe,
  updateProvider,
  setAvailability,
  deleteProvider,
  getProviderRatings,
  uploadAvatar,
};
