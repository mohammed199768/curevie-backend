const { logger, audit } = require('../../utils/logger');
const { isBunnyConfigured, uploadToBunny, deleteFromBunny } = require('../../utils/bunny');
const { paginate, paginationMeta } = require('../../utils/pagination'); // AUDIT-FIX: DRY — reuse shared pagination helpers for provider list responses

function createProviderController(providerService) {
  async function createProvider(req, res) {
    if (await providerService.emailExists(req.body.email)) {
      return res.status(409).json({ message: 'Email already exists', code: 'EMAIL_EXISTS' });
    }

    const created = await providerService.createProvider(req.body);

    audit('PROVIDER_CREATED', {
      userId: req.user.id,
      role: req.user.role,
      targetId: created.id,
      targetType: 'provider',
      ip: req.ip,
    });

    return res.status(201).json(created);
  }

  async function listProviders(req, res) {
    const { page, limit, search, type, is_available } = req.query;
    const { page: currentPage, limit: currentLimit } = paginate(req.query); // AUDIT-FIX: DRY — normalize page/limit once for provider list responses
    const { data, total } = await providerService.listProviders({
      page, limit, search, type, is_available,
    });

    return res.json({
      data,
      pagination: paginationMeta(total, currentPage, currentLimit), // AUDIT-FIX: DRY — standardized list response shape via shared helper
    });
  }

  async function updateProvider(req, res) {
    const payload = { ...req.body };

    if (req.user.role !== 'ADMIN' && Object.prototype.hasOwnProperty.call(payload, 'type')) {
      delete payload.type;
    }

    const result = await providerService.updateProvider(req.params.id, payload);
    if (result.noUpdates) {
      return res.status(400).json({ message: 'No fields to update', code: 'NO_UPDATES' });
    }
    if (!result.row) {
      return res.status(404).json({ message: 'Provider not found', code: 'PROVIDER_NOT_FOUND' });
    }

    audit('PROVIDER_UPDATED', {
      userId: req.user.id,
      role: req.user.role,
      targetId: req.params.id,
      targetType: 'provider',
      ip: req.ip,
      details: payload,
    });

    return res.json(result.row);
  }

  async function deleteProvider(req, res) {
    const row = await providerService.deleteProvider(req.params.id);
    if (!row) {
      return res.status(404).json({ message: 'Provider not found', code: 'PROVIDER_NOT_FOUND' });
    }

    audit('PROVIDER_DELETED', {
      userId: req.user.id,
      role: req.user.role,
      targetId: req.params.id,
      targetType: 'provider',
      ip: req.ip,
    });

    return res.json({ message: 'Provider deleted successfully', provider: row });
  }

  async function getProviderRatings(req, res) {
    const { page, limit } = req.query;
    const { page: currentPage, limit: currentLimit, offset } = paginate(req.query); // AUDIT-FIX: DRY — shared page parsing and offset calculation for rating lists

    const provider = await providerService.getProviderById(req.params.id);
    if (!provider) {
      return res.status(404).json({ message: 'Provider not found', code: 'PROVIDER_NOT_FOUND' });
    }

    const [summary, total, data] = await Promise.all([
      providerService.getProviderRatingsSummary(req.params.id),
      providerService.getProviderRatingsCount(req.params.id),
      providerService.getProviderRatings(req.params.id, currentLimit, offset), // AUDIT-FIX: DRY — pass normalized limit from shared pagination helper
    ]);

    return res.json({
      provider, summary, data,
      pagination: paginationMeta(total, currentPage, currentLimit), // AUDIT-FIX: DRY — standardized list response shape via shared helper
    });
  }

  async function uploadAvatar(req, res) {
    if (!req.file) {
      return res.status(400).json({ message: 'Image file is required', code: 'NO_FILE' });
    }

    if (!isBunnyConfigured()) {
      return res.status(503).json({ message: 'Media service not configured', code: 'MEDIA_NOT_CONFIGURED' });
    }

    const provider = await providerService.getProviderAvatarInfo(req.params.id);
    if (!provider) {
      return res.status(404).json({ message: 'Provider not found', code: 'PROVIDER_NOT_FOUND' });
    }

    const avatarUrl = await uploadToBunny(req.file.buffer, req.file.originalname, 'providers/avatars');
    if (!avatarUrl) {
      return res.status(502).json({ message: 'Failed to upload media', code: 'MEDIA_UPLOAD_FAILED' });
    }

    const updated = await providerService.updateProviderAvatar(req.params.id, avatarUrl);

    if (provider.avatar_url) {
      try {
        const deleted = await deleteFromBunny(provider.avatar_url);
        if (deleted === false) {
          logger.warn('Failed to delete previous provider avatar from Bunny', {
            providerId: req.params.id,
            oldUrl: provider.avatar_url,
            newUrl: avatarUrl,
          });
        }
      } catch (err) {
        logger.warn('Failed to delete previous provider avatar from Bunny', {
          providerId: req.params.id,
          oldUrl: provider.avatar_url,
          newUrl: avatarUrl,
          error: err.message,
        });
      }
    }

    audit('PROVIDER_AVATAR_UPDATED', {
      userId: req.user.id,
      role: req.user.role,
      targetId: req.params.id,
      targetType: 'provider',
      ip: req.ip,
    });

    return res.json(updated);
  }

  return {
    createProvider,
    listProviders,
    updateProvider,
    deleteProvider,
    getProviderRatings,
    uploadAvatar,
  };
}

module.exports = { createProviderController };
