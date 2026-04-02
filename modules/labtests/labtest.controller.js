const cache = require('../../utils/cache');
const { logger, audit } = require('../../utils/logger');
const { isBunnyConfigured, uploadToBunny, deleteFromBunny } = require('../../utils/bunny');
const { paginate, paginationMeta } = require('../../utils/pagination'); // AUDIT-FIX: DRY — shared pagination helpers replace manual lab list metadata
const defaultLabtestService = require('./labtest.service'); // AUDIT-FIX: TEST — load default service when available for backward-compatible controller exports

const buildCacheKey = (prefix, query) => `${prefix}:${JSON.stringify(query || {})}`;

async function deleteOldMediaBestEffort(oldUrl, context) {
  if (!oldUrl) return;

  try {
    const deleted = await deleteFromBunny(oldUrl);
    if (deleted === false) {
      logger.warn('Failed to delete previous Bunny asset', context);
    }
  } catch (error) {
    logger.warn('Failed to delete previous Bunny asset', {
      ...context,
      error: error.message,
    });
  }
}

function createLabTestController(labtestService) {
  async function listLabTests(req, res) {
    const cacheKey = buildCacheKey('lab:list', {
      ...req.query,
      viewer_role: req.user?.role || 'GUEST',
    });
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    const { page, limit, search, category_id, is_active, include_inactive, is_vip_exclusive } = req.query;
    const { page: currentPage, limit: currentLimit } = paginate(req.query); // AUDIT-FIX: DRY — normalize lab test pagination via the shared helper
    const effectiveVipExclusive = req.user ? is_vip_exclusive : false;
    const effectiveIncludeInactive = req.user?.role === 'ADMIN' ? include_inactive : false;
    const { data, total } = await labtestService.listLabTests({
      page, limit, search, category_id, is_active, include_inactive: effectiveIncludeInactive,
      is_vip_exclusive: effectiveVipExclusive,
    });

    const response = {
      data,
      pagination: paginationMeta(total, currentPage, currentLimit), // AUDIT-FIX: DRY — standardized list response shape for lab tests
    };

    await cache.set(cacheKey, response, 300);
    return res.json(response);
  }

  async function createLabTest(req, res) {
    const created = await labtestService.createLabTest(req.body);

    audit('LAB_TEST_CREATED', {
      userId: req.user.id, role: req.user.role,
      targetId: created.id, targetType: 'lab_test', ip: req.ip,
    });

    await cache.del(['lab:list:*', 'lab:packages:*']);
    return res.status(201).json(created);
  }

  async function getLabTestById(req, res) {
    const labTest = await labtestService.getLabTestById(req.params.id);
    if (!labTest) {
      return res.status(404).json({ message: 'Lab test not found', code: 'LAB_TEST_NOT_FOUND' });
    }
    return res.json(labTest);
  }

  async function updateLabTest(req, res) {
    const result = await labtestService.updateLabTest(req.params.id, req.body);
    if (result.noUpdates) {
      return res.status(400).json({ message: 'No fields to update', code: 'NO_UPDATES' });
    }
    if (!result.row) {
      return res.status(404).json({ message: 'Lab test not found', code: 'LAB_TEST_NOT_FOUND' });
    }

    audit('LAB_TEST_UPDATED', {
      userId: req.user.id, role: req.user.role,
      targetId: req.params.id, targetType: 'lab_test', ip: req.ip, details: req.body,
    });

    await cache.del(['lab:list:*', 'lab:packages:*']);
    return res.json(result.row);
  }

  async function listPackages(req, res) {
    const cacheKey = buildCacheKey('lab:packages', {
      ...req.query,
      viewer_role: req.user?.role || 'GUEST',
    });
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    const { page, limit, search, category_id, is_active, include_inactive, is_vip_exclusive } = req.query;
    const { page: currentPage, limit: currentLimit } = paginate(req.query); // AUDIT-FIX: DRY — normalize package pagination via the shared helper
    const effectiveVipExclusive = req.user ? is_vip_exclusive : false;
    const effectiveIncludeInactive = req.user?.role === 'ADMIN' ? include_inactive : false;
    const { data, total } = await labtestService.listPackages({
      page, limit, search, category_id, is_active,
      include_inactive: effectiveIncludeInactive,
      is_vip_exclusive: effectiveVipExclusive,
    });

    const response = {
      data,
      pagination: paginationMeta(total, currentPage, currentLimit), // AUDIT-FIX: DRY — standardized list response shape for packages
    };

    await cache.set(cacheKey, response, 300);
    return res.json(response);
  }

  async function createPackage(req, res) {
    const { pkg, testsCount, servicesCount } = await labtestService.createPackage(req.body);

    audit('PACKAGE_CREATED', {
      userId: req.user.id, role: req.user.role,
      targetId: pkg.id, targetType: 'package', ip: req.ip,
      details: { tests: testsCount, services: servicesCount },
    });

    await cache.del('lab:packages:*');
    return res.status(201).json(pkg);
  }

  async function getPackageById(req, res) {
    const pkg = await labtestService.getPackageById(req.params.id);
    if (!pkg) {
      return res.status(404).json({ message: 'Package not found', code: 'PACKAGE_NOT_FOUND' });
    }
    return res.json(pkg);
  }

  async function updatePackage(req, res) {
    const result = await labtestService.updatePackage(req.params.id, req.body);
    if (result.notFound) {
      return res.status(404).json({ message: 'Package not found', code: 'PACKAGE_NOT_FOUND' });
    }

    audit('PACKAGE_UPDATED', {
      userId: req.user.id, role: req.user.role,
      targetId: req.params.id, targetType: 'package', ip: req.ip, details: req.body,
    });

    await cache.del('lab:packages:*');
    return res.json(result.pkg);
  }

  async function listLabPanels(req, res) {
    const cacheKey = buildCacheKey('lab:panels', {
      ...req.query,
      viewer_role: req.user?.role || 'GUEST',
    });
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    const { page, limit, search, is_active, is_vip_exclusive } = req.query;
    const { page: currentPage, limit: currentLimit } = paginate(req.query);
    const effectiveVipExclusive = req.user ? is_vip_exclusive : false;
    const { data, total } = await labtestService.listLabPanels({
      page,
      limit,
      search,
      is_active,
      is_vip_exclusive: effectiveVipExclusive,
    });

    const response = {
      data,
      pagination: paginationMeta(total, currentPage, currentLimit),
    };

    await cache.set(cacheKey, response, 300);
    return res.json(response);
  }

  async function createLabPanel(req, res) {
    const panel = await labtestService.createLabPanel(req.body);

    audit('LAB_PANEL_CREATED', {
      userId: req.user.id,
      role: req.user.role,
      targetId: panel.id,
      targetType: 'lab_panel',
      ip: req.ip,
    });

    await cache.del(['lab:panels:*', 'lab:lab-packages:*']);
    return res.status(201).json(panel);
  }

  async function getLabPanelById(req, res) {
    const panel = await labtestService.getLabPanelById(req.params.id);
    if (!panel) {
      return res.status(404).json({ message: 'Lab panel not found', code: 'LAB_PANEL_NOT_FOUND' });
    }
    return res.json(panel);
  }

  async function updateLabPanel(req, res) {
    const result = await labtestService.updateLabPanel(req.params.id, req.body);
    if (result.notFound) {
      return res.status(404).json({ message: 'Lab panel not found', code: 'LAB_PANEL_NOT_FOUND' });
    }

    audit('LAB_PANEL_UPDATED', {
      userId: req.user.id,
      role: req.user.role,
      targetId: req.params.id,
      targetType: 'lab_panel',
      ip: req.ip,
      details: req.body,
    });

    await cache.del(['lab:panels:*', 'lab:lab-packages:*']);
    return res.json(result.panel);
  }

  async function deactivateLabPanel(req, res) {
    const panel = await labtestService.deactivateLabPanel(req.params.id);
    if (!panel) {
      return res.status(404).json({ message: 'Lab panel not found', code: 'LAB_PANEL_NOT_FOUND' });
    }

    audit('LAB_PANEL_DEACTIVATED', {
      userId: req.user.id,
      role: req.user.role,
      targetId: req.params.id,
      targetType: 'lab_panel',
      ip: req.ip,
    });

    await cache.del(['lab:panels:*', 'lab:lab-packages:*']);
    return res.json(panel);
  }

  async function listLabPackages(req, res) {
    const cacheKey = buildCacheKey('lab:lab-packages', {
      ...req.query,
      viewer_role: req.user?.role || 'GUEST',
    });
    const cached = await cache.get(cacheKey);
    if (cached) return res.json(cached);

    const { page, limit, search, is_active, is_vip_exclusive } = req.query;
    const { page: currentPage, limit: currentLimit } = paginate(req.query);
    const effectiveVipExclusive = req.user ? is_vip_exclusive : false;
    const { data, total } = await labtestService.listLabPackages({
      page,
      limit,
      search,
      is_active,
      is_vip_exclusive: effectiveVipExclusive,
    });

    const response = {
      data,
      pagination: paginationMeta(total, currentPage, currentLimit),
    };

    await cache.set(cacheKey, response, 300);
    return res.json(response);
  }

  async function createLabPackage(req, res) {
    const pkg = await labtestService.createLabPackage(req.body);

    audit('LAB_PACKAGE_CREATED', {
      userId: req.user.id,
      role: req.user.role,
      targetId: pkg.id,
      targetType: 'lab_package',
      ip: req.ip,
    });

    await cache.del(['lab:lab-packages:*', 'lab:panels:*']);
    return res.status(201).json(pkg);
  }

  async function getLabPackageById(req, res) {
    const pkg = await labtestService.getLabPackageById(req.params.id);
    if (!pkg) {
      return res.status(404).json({ message: 'Lab package not found', code: 'LAB_PACKAGE_NOT_FOUND' });
    }
    return res.json(pkg);
  }

  async function updateLabPackage(req, res) {
    const result = await labtestService.updateLabPackage(req.params.id, req.body);
    if (result.notFound) {
      return res.status(404).json({ message: 'Lab package not found', code: 'LAB_PACKAGE_NOT_FOUND' });
    }

    audit('LAB_PACKAGE_UPDATED', {
      userId: req.user.id,
      role: req.user.role,
      targetId: req.params.id,
      targetType: 'lab_package',
      ip: req.ip,
      details: req.body,
    });

    await cache.del(['lab:lab-packages:*', 'lab:panels:*']);
    return res.json(result.pkg);
  }

  async function deactivateLabPackage(req, res) {
    const pkg = await labtestService.deactivateLabPackage(req.params.id);
    if (!pkg) {
      return res.status(404).json({ message: 'Lab package not found', code: 'LAB_PACKAGE_NOT_FOUND' });
    }

    audit('LAB_PACKAGE_DEACTIVATED', {
      userId: req.user.id,
      role: req.user.role,
      targetId: req.params.id,
      targetType: 'lab_package',
      ip: req.ip,
    });

    await cache.del(['lab:lab-packages:*', 'lab:panels:*']);
    return res.json(pkg);
  }

  async function uploadLabTestImage(req, res) {
    if (!req.file) {
      return res.status(400).json({ message: 'Image file is required', code: 'NO_FILE' });
    }
    if (!isBunnyConfigured()) {
      return res.status(503).json({ message: 'Media service not configured', code: 'MEDIA_NOT_CONFIGURED' });
    }

    const labTest = await labtestService.getLabTestMediaInfo(req.params.id);
    if (!labTest) {
      return res.status(404).json({ message: 'Lab test not found', code: 'LAB_TEST_NOT_FOUND' });
    }

    const imageUrl = await uploadToBunny(req.file.buffer, req.file.originalname, 'lab');
    if (!imageUrl) {
      return res.status(502).json({ message: 'Failed to upload media', code: 'MEDIA_UPLOAD_FAILED' });
    }

    const updated = await labtestService.updateLabTestImage(req.params.id, imageUrl);

    await deleteOldMediaBestEffort(labTest.image_url, {
      entityType: 'lab_test', entityId: req.params.id,
      oldUrl: labTest.image_url, newUrl: imageUrl,
    });

    audit('LAB_TEST_IMAGE_UPDATED', {
      userId: req.user.id, role: req.user.role,
      targetId: req.params.id, targetType: 'lab_test', ip: req.ip,
    });

    await cache.del(['lab:list:*', 'lab:packages:*']);
    return res.json(updated);
  }

  async function uploadPackageImage(req, res) {
    if (!req.file) {
      return res.status(400).json({ message: 'Image file is required', code: 'NO_FILE' });
    }
    if (!isBunnyConfigured()) {
      return res.status(503).json({ message: 'Media service not configured', code: 'MEDIA_NOT_CONFIGURED' });
    }

    const pkg = await labtestService.getPackageMediaInfo(req.params.id);
    if (!pkg) {
      return res.status(404).json({ message: 'Package not found', code: 'PACKAGE_NOT_FOUND' });
    }

    const imageUrl = await uploadToBunny(req.file.buffer, req.file.originalname, 'packages');
    if (!imageUrl) {
      return res.status(502).json({ message: 'Failed to upload media', code: 'MEDIA_UPLOAD_FAILED' });
    }

    const updated = await labtestService.updatePackageImage(req.params.id, imageUrl);

    await deleteOldMediaBestEffort(pkg.image_url, {
      entityType: 'package', entityId: req.params.id,
      oldUrl: pkg.image_url, newUrl: imageUrl,
    });

    audit('PACKAGE_IMAGE_UPDATED', {
      userId: req.user.id, role: req.user.role,
      targetId: req.params.id, targetType: 'package', ip: req.ip,
    });

    await cache.del('lab:packages:*');
    return res.json(updated);
  }

  async function rateLabTest(req, res) {
    if (req.user.role !== 'PATIENT') {
      return res.status(403).json({ message: 'Patient access required', code: 'FORBIDDEN' });
    }

    const labTest = await labtestService.getLabTestMediaInfo(req.params.id);
    if (!labTest) {
      return res.status(404).json({ message: 'Lab test not found', code: 'LAB_TEST_NOT_FOUND' });
    }

    const existing = await labtestService.getDirectLabTestRating(req.user.id, req.params.id);
    if (existing) {
      return res.status(409).json({ message: 'Lab test already rated', code: 'LAB_TEST_ALREADY_RATED' });
    }

    const rating = await labtestService.createDirectLabTestRating({
      patientId: req.user.id,
      labTestId: req.params.id,
      rating: req.body.rating,
      comment: req.body.comment,
    });

    return res.status(201).json(rating);
  }

  async function getLabTestRatings(req, res) {
    const labTest = await labtestService.getLabTestMediaInfo(req.params.id);
    if (!labTest) {
      return res.status(404).json({ message: 'Lab test not found', code: 'LAB_TEST_NOT_FOUND' });
    }

    const [summary, ratings] = await Promise.all([
      labtestService.getLabTestRatingsSummary(req.params.id),
      labtestService.listLabTestRatings(req.params.id, req.query),
    ]);

    return res.json({
      lab_test: labTest, summary,
      data: ratings.data,
      pagination: ratings.pagination, // AUDIT-FIX: DRY — reuse standardized pagination metadata from the lab test service
    });
  }

  async function ratePackage(req, res) {
    if (req.user.role !== 'PATIENT') {
      return res.status(403).json({ message: 'Patient access required', code: 'FORBIDDEN' });
    }

    const pkg = await labtestService.getPackageMediaInfo(req.params.id);
    if (!pkg) {
      return res.status(404).json({ message: 'Package not found', code: 'PACKAGE_NOT_FOUND' });
    }

    const existing = await labtestService.getDirectPackageRating(req.user.id, req.params.id);
    if (existing) {
      return res.status(409).json({ message: 'Package already rated', code: 'PACKAGE_ALREADY_RATED' });
    }

    const rating = await labtestService.createDirectPackageRating({
      patientId: req.user.id,
      packageId: req.params.id,
      rating: req.body.rating,
      comment: req.body.comment,
    });

    return res.status(201).json(rating);
  }

  async function getPackageRatings(req, res) {
    const pkg = await labtestService.getPackageMediaInfo(req.params.id);
    if (!pkg) {
      return res.status(404).json({ message: 'Package not found', code: 'PACKAGE_NOT_FOUND' });
    }

    const [summary, ratings] = await Promise.all([
      labtestService.getPackageRatingsSummary(req.params.id),
      labtestService.listPackageRatings(req.params.id, req.query),
    ]);

    return res.json({
      package: pkg, summary,
      data: ratings.data,
      pagination: ratings.pagination, // AUDIT-FIX: DRY — reuse standardized pagination metadata from the package rating service
    });
  }

  return {
    listLabTests, createLabTest, getLabTestById, updateLabTest,
    listPackages, createPackage, getPackageById, updatePackage,
    listLabPanels, createLabPanel, getLabPanelById, updateLabPanel, deactivateLabPanel,
    listLabPackages, createLabPackage, getLabPackageById, updateLabPackage, deactivateLabPackage,
    uploadLabTestImage, uploadPackageImage,
    rateLabTest, getLabTestRatings, ratePackage, getPackageRatings,
  };
}

const defaultLabTestController = typeof defaultLabtestService.getLabTestMediaInfo === 'function' // AUDIT-FIX: TEST — only build singleton exports when the service module exposes runtime methods
  ? createLabTestController(defaultLabtestService) // AUDIT-FIX: TEST — preserve direct controller method exports expected by the existing test suite
  : null; // AUDIT-FIX: TEST — keep factory-only behavior when only the service factory is available

module.exports = { // AUDIT-FIX: TEST — preserve factory export and restore direct method exports for compatibility
  createLabTestController, // AUDIT-FIX: TEST — routes still use the controller factory export
  ...(defaultLabTestController || {}), // AUDIT-FIX: TEST — restore uploadLabTestImage and related direct exports expected by tests
};
