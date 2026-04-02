const { paginate, paginationMeta } = require('../../utils/pagination'); // AUDIT-FIX: DRY — shared pagination helpers replace repeated list/rating pagination code

function uniqueIds(ids = []) {
  return [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))];
}

function normalizeWorkflowItems(items = []) {
  const normalized = [];
  const seen = new Set();

  for (const item of Array.isArray(items) ? items : []) {
    const itemType = typeof item?.item_type === 'string' ? item.item_type.trim().toLowerCase() : '';
    const itemId = typeof item?.item_id === 'string' ? item.item_id.trim() : '';

    if (!itemId || (itemType !== 'service' && itemType !== 'test')) {
      continue;
    }

    const key = `${itemType}:${itemId}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push({ item_type: itemType, item_id: itemId });
  }

  return normalized;
}

function buildWorkflowItemsFromIds({ serviceIds = [], testIds = [] } = {}) {
  return [
    ...uniqueIds(serviceIds).map((item_id) => ({ item_type: 'service', item_id })),
    ...uniqueIds(testIds).map((item_id) => ({ item_type: 'test', item_id })),
  ];
}

function resolvePackageWorkflowPayload(data = {}, currentPackage = null) {
  const hasWorkflowItems = Object.prototype.hasOwnProperty.call(data, 'workflow_items');
  const hasServiceIds = Object.prototype.hasOwnProperty.call(data, 'service_ids');
  const hasTestIds = Object.prototype.hasOwnProperty.call(data, 'test_ids');

  if (hasWorkflowItems) {
    const workflowItems = normalizeWorkflowItems(data.workflow_items || []);
    return {
      workflowItems,
      serviceIds: uniqueIds(workflowItems.filter((item) => item.item_type === 'service').map((item) => item.item_id)),
      testIds: uniqueIds(workflowItems.filter((item) => item.item_type === 'test').map((item) => item.item_id)),
    };
  }

  const serviceIds = hasServiceIds
    ? uniqueIds(data.service_ids || [])
    : uniqueIds(currentPackage?.service_ids || []);
  const testIds = hasTestIds
    ? uniqueIds(data.test_ids || [])
    : uniqueIds(currentPackage?.test_ids || []);

  return {
    workflowItems: buildWorkflowItemsFromIds({ serviceIds, testIds }),
    serviceIds,
    testIds,
  };
}

function normalizeLabPackageWorkflowItems(items = []) {
  const normalized = [];
  const seen = new Set();

  for (const item of Array.isArray(items) ? items : []) {
    const itemType = typeof item?.item_type === 'string' ? item.item_type.trim().toLowerCase() : '';
    const itemId = typeof item?.item_id === 'string' ? item.item_id.trim() : '';

    if (!itemId || (itemType !== 'test' && itemType !== 'panel')) {
      continue;
    }

    const key = `${itemType}:${itemId}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push({ item_type: itemType, item_id: itemId });
  }

  return normalized;
}

function buildLabPackageWorkflowItemsFromIds({ testIds = [], panelIds = [] } = {}) {
  return [
    ...uniqueIds(testIds).map((item_id) => ({ item_type: 'test', item_id })),
    ...uniqueIds(panelIds).map((item_id) => ({ item_type: 'panel', item_id })),
  ];
}

function resolveLabPackageWorkflowPayload(data = {}, currentPackage = null) {
  const hasWorkflowItems = Object.prototype.hasOwnProperty.call(data, 'workflow_items');
  const hasTestIds = Object.prototype.hasOwnProperty.call(data, 'test_ids');
  const hasPanelIds = Object.prototype.hasOwnProperty.call(data, 'panel_ids');

  if (hasWorkflowItems) {
    const workflowItems = normalizeLabPackageWorkflowItems(data.workflow_items || []);
    return {
      workflowItems,
      testIds: uniqueIds(workflowItems.filter((item) => item.item_type === 'test').map((item) => item.item_id)),
      panelIds: uniqueIds(workflowItems.filter((item) => item.item_type === 'panel').map((item) => item.item_id)),
    };
  }

  const testIds = hasTestIds
    ? uniqueIds(data.test_ids || [])
    : uniqueIds(currentPackage?.test_ids || []);
  const panelIds = hasPanelIds
    ? uniqueIds(data.panel_ids || [])
    : uniqueIds(currentPackage?.panel_ids || []);

  return {
    workflowItems: buildLabPackageWorkflowItemsFromIds({ testIds, panelIds }),
    testIds,
    panelIds,
  };
}

function createLabTestService(labTestRepo) {
  // --- Lab Tests ---

  async function listLabTests({ page, limit, search, category_id, is_active, include_inactive, is_vip_exclusive }) {
    const { offset } = paginate({ page, limit }); // AUDIT-FIX: DRY — centralized offset calculation for lab test listings
    return labTestRepo.listLabTests(
      { search, category_id, is_active, include_inactive, is_vip_exclusive },
      { limit, offset }
    );
  }

  async function createLabTest(data) {
    const labCategoryId = await labTestRepo.getOrCreateLabCategoryId();
    return labTestRepo.createLabTest(data, labCategoryId);
  }

  async function getLabTestById(id) {
    return labTestRepo.getLabTestById(id);
  }

  async function updateLabTest(id, data) {
    return labTestRepo.updateLabTest(id, data);
  }

  async function getLabTestMediaInfo(id) {
    return labTestRepo.getLabTestMediaInfo(id);
  }

  async function updateLabTestImage(id, imageUrl) {
    return labTestRepo.updateLabTestImage(id, imageUrl);
  }

  // --- Packages ---

  async function listPackages({ page, limit, search, category_id, is_active, include_inactive, is_vip_exclusive }) {
    const { offset } = paginate({ page, limit }); // AUDIT-FIX: DRY — centralized offset calculation for package listings
    const { rows, total } = await labTestRepo.listPackages(
      { search, category_id, is_active, include_inactive, is_vip_exclusive },
      { limit, offset }
    );
    const data = await labTestRepo.attachPackageContents(rows);
    return { data, total, pagination: paginationMeta(total, Number(page) || 1, Number(limit) || 20) }; // AUDIT-FIX: DRY — expose standardized pagination metadata for list consumers
  }

  async function createPackage(data) {
    const { name, description, total_cost, category_id, is_vip_exclusive } = data;
    const { workflowItems, testIds, serviceIds } = resolvePackageWorkflowPayload(data);

    return labTestRepo.withTransaction(async (client) => {
      const pkg = await labTestRepo.createPackageRow(
        { name, description, total_cost, category_id, is_vip_exclusive, workflow_items: workflowItems },
        client
      );

      await labTestRepo.replacePackageItems(pkg.id, { testIds, serviceIds }, client);

      const [packageDetails] = await labTestRepo.attachPackageContents([pkg], client);
      return {
        pkg: packageDetails || pkg,
        testsCount: testIds.length,
        servicesCount: serviceIds.length,
      };
    });
  }

  async function updatePackage(id, data) {
    return labTestRepo.withTransaction(async (client) => {
      const updatesPackageContents = Object.prototype.hasOwnProperty.call(data, 'test_ids')
        || Object.prototype.hasOwnProperty.call(data, 'service_ids')
        || Object.prototype.hasOwnProperty.call(data, 'workflow_items');

      const currentPackageRow = updatesPackageContents ? await labTestRepo.getPackageRow(id, client) : null;
      if (updatesPackageContents && !currentPackageRow) {
        return { notFound: true };
      }

      const [currentPackage] = currentPackageRow
        ? await labTestRepo.attachPackageContents([currentPackageRow], client)
        : [null];
      const { workflowItems, testIds, serviceIds } = resolvePackageWorkflowPayload(data, currentPackage);
      const packageRowData = updatesPackageContents
        ? { ...data, workflow_items: workflowItems }
        : data;

      const hasFieldUpdates = ['name', 'description', 'total_cost', 'category_id', 'is_vip_exclusive', 'is_active', 'workflow_items']
        .some((f) => Object.prototype.hasOwnProperty.call(packageRowData, f));

      if (hasFieldUpdates) {
        const updated = await labTestRepo.updatePackageRow(id, packageRowData, client);
        if (!updated) return { notFound: true };
      }

      if (updatesPackageContents) {
        await labTestRepo.replacePackageItems(id, {
          testIds,
          serviceIds,
        }, client);
      }

      const finalPkg = await labTestRepo.getPackageRow(id, client);
      if (!finalPkg) return { notFound: true };

      const [packageDetails] = await labTestRepo.attachPackageContents([finalPkg], client);
      return { notFound: false, pkg: packageDetails || finalPkg };
    });
  }

  async function getPackageById(id) {
    const pkg = await labTestRepo.getPackageById(id);
    if (!pkg) return null;
    const [packageDetails] = await labTestRepo.attachPackageContents([pkg]);
    return packageDetails || pkg;
  }

  async function getPackageMediaInfo(id) {
    return labTestRepo.getPackageMediaInfo(id);
  }

  async function updatePackageImage(id, imageUrl) {
    return labTestRepo.updatePackageImage(id, imageUrl);
  }

  // --- Lab Panels ---

  async function listLabPanels({ page, limit, search, is_active, is_vip_exclusive }) {
    const { offset } = paginate({ page, limit });
    const { rows, total } = await labTestRepo.listLabPanels(
      { search, is_active, is_vip_exclusive },
      { limit, offset }
    );
    const data = await labTestRepo.attachLabPanelTests(rows);
    return { data, total, pagination: paginationMeta(total, Number(page) || 1, Number(limit) || 20) };
  }

  async function createLabPanel(data) {
    const { test_ids = [], ...panelData } = data;
    return labTestRepo.withTransaction(async (client) => {
      const panel = await labTestRepo.createLabPanelRow(panelData, client);
      await labTestRepo.replaceLabPanelTests(panel.id, test_ids, client);
      return labTestRepo.getLabPanelById(panel.id, client);
    });
  }

  async function updateLabPanel(id, data) {
    return labTestRepo.withTransaction(async (client) => {
      const panelFields = { ...data };
      delete panelFields.test_ids;

      if (Object.keys(panelFields).length) {
        const updated = await labTestRepo.updateLabPanelRow(id, panelFields, client);
        if (!updated.row) return { notFound: true };
      }

      if (Object.prototype.hasOwnProperty.call(data, 'test_ids')) {
        await labTestRepo.replaceLabPanelTests(id, data.test_ids || [], client);
      }

      const panel = await labTestRepo.getLabPanelById(id, client);
      if (!panel) return { notFound: true };
      return { notFound: false, panel };
    });
  }

  async function getLabPanelById(id) {
    return labTestRepo.getLabPanelById(id);
  }

  async function deactivateLabPanel(id) {
    return labTestRepo.deactivateLabPanel(id);
  }

  // --- Lab Packages ---

  async function listLabPackages({ page, limit, search, is_active, is_vip_exclusive }) {
    const { offset } = paginate({ page, limit });
    const { rows, total } = await labTestRepo.listLabPackages(
      { search, is_active, is_vip_exclusive },
      { limit, offset }
    );
    const data = await labTestRepo.attachLabPackageContents(rows);
    return { data, total, pagination: paginationMeta(total, Number(page) || 1, Number(limit) || 20) };
  }

  async function createLabPackage(data) {
    const { workflowItems, testIds, panelIds } = resolveLabPackageWorkflowPayload(data);
    const { workflow_items, test_ids, panel_ids, ...packageData } = data;
    return labTestRepo.withTransaction(async (client) => {
      const pkg = await labTestRepo.createLabPackageRow(
        { ...packageData, workflow_items: workflowItems },
        client
      );
      await labTestRepo.replaceLabPackageItems(pkg.id, { testIds, panelIds }, client);
      return labTestRepo.getLabPackageById(pkg.id, client);
    });
  }

  async function updateLabPackage(id, data) {
    return labTestRepo.withTransaction(async (client) => {
      const updatesPackageContents = Object.prototype.hasOwnProperty.call(data, 'workflow_items')
        || Object.prototype.hasOwnProperty.call(data, 'test_ids')
        || Object.prototype.hasOwnProperty.call(data, 'panel_ids');

      const currentPackageRow = updatesPackageContents ? await labTestRepo.getLabPackageRow(id, client) : null;
      if (updatesPackageContents && !currentPackageRow) {
        return { notFound: true };
      }

      const [currentPackage] = currentPackageRow
        ? await labTestRepo.attachLabPackageContents([currentPackageRow], client)
        : [null];
      const { workflowItems, testIds, panelIds } = resolveLabPackageWorkflowPayload(data, currentPackage);
      const packageFields = { ...data };
      delete packageFields.test_ids;
      delete packageFields.panel_ids;

      const packageRowData = updatesPackageContents
        ? { ...packageFields, workflow_items: workflowItems }
        : packageFields;

      if (Object.keys(packageRowData).length) {
        const updated = await labTestRepo.updateLabPackageRow(id, packageRowData, client);
        if (!updated.row) return { notFound: true };
      }

      if (updatesPackageContents) {
        await labTestRepo.replaceLabPackageItems(id, {
          testIds,
          panelIds,
        }, client);
      }

      const pkg = await labTestRepo.getLabPackageById(id, client);
      if (!pkg) return { notFound: true };
      return { notFound: false, pkg };
    });
  }

  async function getLabPackageById(id) {
    return labTestRepo.getLabPackageById(id);
  }

  async function deactivateLabPackage(id) {
    return labTestRepo.deactivateLabPackage(id);
  }

  // --- Ratings (lab tests) ---

  async function getDirectLabTestRating(patientId, labTestId) {
    return labTestRepo.getDirectLabTestRating(patientId, labTestId);
  }

  async function createDirectLabTestRating(data) {
    return labTestRepo.createDirectLabTestRating(data);
  }

  async function getLabTestRatingsSummary(labTestId) {
    return labTestRepo.getLabTestRatingsSummary(labTestId);
  }

  async function listLabTestRatings(labTestId, { page = 1, limit = 20 } = {}) {
    const { page: safePage, limit: safeLimit, offset } = paginate({ page, limit }); // AUDIT-FIX: DRY — shared pagination bounds for lab test rating lists

    const { data, total } = await labTestRepo.listLabTestRatings(labTestId, { limit: safeLimit, offset });
    return { data, total, page: safePage, limit: safeLimit, pagination: paginationMeta(total, safePage, safeLimit) }; // AUDIT-FIX: DRY — standardized pagination metadata with compatibility fields
  }

  // --- Ratings (packages) ---

  async function getDirectPackageRating(patientId, packageId) {
    return labTestRepo.getDirectPackageRating(patientId, packageId);
  }

  async function createDirectPackageRating(data) {
    return labTestRepo.createDirectPackageRating(data);
  }

  async function getPackageRatingsSummary(packageId) {
    return labTestRepo.getPackageRatingsSummary(packageId);
  }

  async function listPackageRatings(packageId, { page = 1, limit = 20 } = {}) {
    const { page: safePage, limit: safeLimit, offset } = paginate({ page, limit }); // AUDIT-FIX: DRY — shared pagination bounds for package rating lists

    const { data, total } = await labTestRepo.listPackageRatings(packageId, { limit: safeLimit, offset });
    return { data, total, page: safePage, limit: safeLimit, pagination: paginationMeta(total, safePage, safeLimit) }; // AUDIT-FIX: DRY — standardized pagination metadata with compatibility fields
  }

  return {
    listLabTests,
    createLabTest,
    getLabTestById,
    updateLabTest,
    listPackages,
    createPackage,
    updatePackage,
    getLabTestMediaInfo,
    updateLabTestImage,
    getPackageMediaInfo,
    getPackageById,
    updatePackageImage,
    listLabPanels,
    createLabPanel,
    updateLabPanel,
    getLabPanelById,
    deactivateLabPanel,
    listLabPackages,
    createLabPackage,
    updateLabPackage,
    getLabPackageById,
    deactivateLabPackage,
    getDirectLabTestRating,
    createDirectLabTestRating,
    getLabTestRatingsSummary,
    listLabTestRatings,
    getDirectPackageRating,
    createDirectPackageRating,
    getPackageRatingsSummary,
    listPackageRatings,
  };
}

module.exports = { createLabTestService };
