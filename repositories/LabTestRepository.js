const BaseRepository = require('./BaseRepository');
const LabRangeRepository = require('./LabRangeRepository');

function uniqueIds(ids = []) {
  return [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))];
}

class LabTestRepository extends BaseRepository {
  constructor(pool) {
    super(pool, 'lab_tests');
    this.rangeRepo = new LabRangeRepository(pool);
  }

  async enrichWithDisplayRange(tests) {
    if (!Array.isArray(tests) || !tests.length) return tests;

    const ids = uniqueIds(tests.map((test) => test?.id));
    const displayRanges = await Promise.all(
      ids.map(async (id) => [id, await this.rangeRepo.buildDisplayRange(id)])
    );
    const displayRangeById = new Map(displayRanges);

    return tests.map((test) => {
      if (!test?.id) {
        return {
          ...test,
          display_reference_range: test?.reference_range || null,
        };
      }

      return {
        ...test,
        display_reference_range: displayRangeById.get(test.id) || test.reference_range || null,
      };
    });
  }

  // --- Lab Category helper ---

  async getOrCreateLabCategoryId(db = null) {
    const knownNames = ['medical lab', 'lab tests', 'laboratory', 'lab'];
    const found = await this._queryOne(
      `SELECT id FROM service_categories
       WHERE LOWER(name) = ANY($1::text[])
       ORDER BY CASE LOWER(name) WHEN 'medical lab' THEN 0 WHEN 'lab tests' THEN 1
         WHEN 'laboratory' THEN 2 WHEN 'lab' THEN 3 ELSE 9 END
       LIMIT 1`,
      [knownNames], db
    );
    if (found) return found.id;

    const created = await this._queryOne(
      `INSERT INTO service_categories (name, description) VALUES ($1, $2) RETURNING id`,
      ['Medical Lab', 'Default category for lab tests'], db
    );
    return created.id;
  }

  // --- Lab Tests ---

  async listLabTests({ search, category_id, is_active, include_inactive, is_vip_exclusive } = {}, { limit, offset } = {}, db = null) {
    const where = [];
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      where.push(`(lt.name ILIKE $${params.length} OR lt.description ILIKE $${params.length})`);
    }
    if (category_id) { params.push(category_id); where.push(`lt.category_id = $${params.length}`); }
    if (typeof is_active !== 'undefined') {
      params.push(is_active);
      where.push(`lt.is_active = $${params.length}`);
    } else if (!include_inactive) {
      params.push(true);
      where.push(`lt.is_active = $${params.length}`);
    }
    if (typeof is_vip_exclusive !== 'undefined') { params.push(is_vip_exclusive); where.push(`lt.is_vip_exclusive = $${params.length}`); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countResult = await this._query(`SELECT COUNT(*)::int AS total FROM lab_tests lt ${whereSql}`, params, db);
    params.push(limit); params.push(offset);
    const dataResult = await this._query(
      `SELECT lt.*, COALESCE(c.name, 'Medical Lab') AS category_name,
              COALESCE(rr.ranges_count, 0)::int AS ranges_count
       FROM lab_tests lt
       LEFT JOIN service_categories c ON lt.category_id = c.id
       LEFT JOIN (
         SELECT lab_test_id, COUNT(*)::int AS ranges_count
         FROM lab_test_reference_ranges
         GROUP BY lab_test_id
       ) rr ON rr.lab_test_id = lt.id
       ${whereSql} ORDER BY lt.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params, db
    );
    const enriched = await this.enrichWithDisplayRange(dataResult.rows);
    return { data: enriched, total: countResult.rows[0].total };
  }

  async createLabTest(data, labCategoryId, db = null) {
    const { name, description, unit, reference_range, sample_type, cost, is_vip_exclusive } = data;
    return this._queryOne(
      `INSERT INTO lab_tests (name, description, unit, reference_range, sample_type, cost, category_id, is_vip_exclusive)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [name, description || null, unit || null, reference_range || null, sample_type || null, cost, labCategoryId, Boolean(is_vip_exclusive)],
      db
    );
  }

  async getLabTestById(id, db = null) {
    const test = await this._queryOne(
      `SELECT lt.id, lt.name, lt.description, lt.unit, lt.reference_range, lt.sample_type,
              lt.cost, lt.category_id, lt.is_vip_exclusive, lt.is_active, lt.image_url,
              lt.created_at, lt.updated_at,
              COALESCE(c.name, 'Medical Lab') AS category_name, c.description AS category_description
       FROM lab_tests lt LEFT JOIN service_categories c ON lt.category_id = c.id
       WHERE lt.id = $1`,
      [id], db
    );
    if (!test) return null;
    const [enriched] = await this.enrichWithDisplayRange([test]);
    return enriched || test;
  }

  async updateLabTest(id, data, db = null) {
    return this.update(id, data,
      ['name', 'description', 'unit', 'reference_range', 'sample_type', 'cost', 'is_vip_exclusive', 'is_active'],
      db
    );
  }

  async getLabTestMediaInfo(id, db = null) {
    return this._queryOne('SELECT id, name, image_url FROM lab_tests WHERE id = $1', [id], db);
  }

  async updateLabTestImage(id, imageUrl, db = null) {
    return this._queryOne(
      'UPDATE lab_tests SET image_url = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [imageUrl, id], db
    );
  }

  // --- Packages ---

  async listPackages({ search, category_id, is_active, include_inactive, is_vip_exclusive } = {}, { limit, offset } = {}, db = null) {
    const where = [];
    const params = [];

    if (search) { params.push(`%${search}%`); where.push(`(p.name ILIKE $${params.length} OR p.description ILIKE $${params.length})`); }
    if (category_id) { params.push(category_id); where.push(`p.category_id = $${params.length}`); }
    if (typeof is_active !== 'undefined') {
      params.push(is_active);
      where.push(`p.is_active = $${params.length}`);
    } else if (!include_inactive) {
      params.push(true);
      where.push(`p.is_active = $${params.length}`);
    }
    if (typeof is_vip_exclusive !== 'undefined') { params.push(is_vip_exclusive); where.push(`p.is_vip_exclusive = $${params.length}`); }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countResult = await this._query(`SELECT COUNT(*)::int AS total FROM packages p ${whereSql}`, params, db);
    params.push(limit); params.push(offset);
    const packagesResult = await this._query(
      `SELECT p.*, c.name AS category_name
       FROM packages p LEFT JOIN service_categories c ON p.category_id = c.id
       ${whereSql} ORDER BY p.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params, db
    );
    return { rows: packagesResult.rows, total: countResult.rows[0].total };
  }

  async createPackageRow(data, db = null) {
    const { name, description, total_cost, category_id, is_vip_exclusive, workflow_items = [] } = data;
    return this._queryOne(
      `INSERT INTO packages (name, description, total_cost, category_id, is_vip_exclusive, workflow_items)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING *`,
      [name, description || null, total_cost, category_id || null, Boolean(is_vip_exclusive), JSON.stringify(workflow_items || [])],
      db
    );
  }

  async updatePackageRow(id, data, db = null) {
    const allowedFields = ['name', 'description', 'total_cost', 'category_id', 'is_vip_exclusive', 'is_active', 'workflow_items'];
    const sets = [];
    const values = [];
    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(data, field)) {
        values.push(field === 'workflow_items' ? JSON.stringify(data[field] || []) : data[field]);
        sets.push(field === 'workflow_items' ? `${field} = $${values.length}::jsonb` : `${field} = $${values.length}`);
      }
    }
    if (!sets.length) return null;
    values.push(id);
    return this._queryOne(
      `UPDATE packages SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${values.length} RETURNING *`,
      values, db
    );
  }

  async getPackageRow(id, db = null) {
    return this._queryOne('SELECT * FROM packages WHERE id = $1', [id], db);
  }

  async getPackageById(id, db = null) {
    return this._queryOne(
      `SELECT p.id, p.name, p.description, p.total_cost, p.category_id,
              p.is_vip_exclusive, p.is_active, p.times_ordered, p.image_url, p.workflow_items,
              p.created_at, p.updated_at,
              c.name AS category_name, c.description AS category_description
       FROM packages p LEFT JOIN service_categories c ON p.category_id = c.id
       WHERE p.id = $1`,
      [id], db
    );
  }

  async getPackageMediaInfo(id, db = null) {
    return this._queryOne('SELECT id, name, image_url FROM packages WHERE id = $1', [id], db);
  }

  async updatePackageImage(id, imageUrl, db = null) {
    return this._queryOne(
      'UPDATE packages SET image_url = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [imageUrl, id], db
    );
  }

  async replacePackageItems(packageId, { testIds, serviceIds }, db = null) {
    const executor = db || this.pool;
    if (testIds !== undefined) {
      const ids = uniqueIds(testIds);
      await executor.query('DELETE FROM package_tests WHERE package_id = $1', [packageId]);
      if (ids.length) {
        const values = ids.map((_, i) => `($1, $${i + 2})`).join(', ');
        await executor.query(`INSERT INTO package_tests (package_id, lab_test_id) VALUES ${values}`, [packageId, ...ids]);
      }
    }
    if (serviceIds !== undefined) {
      const ids = uniqueIds(serviceIds);
      await executor.query('DELETE FROM package_services WHERE package_id = $1', [packageId]);
      if (ids.length) {
        const values = ids.map((_, i) => `($1, $${i + 2})`).join(', ');
        await executor.query(`INSERT INTO package_services (package_id, service_id) VALUES ${values}`, [packageId, ...ids]);
      }
    }
  }

  async getPackageContentsByIds(packageIds, db = null) {
    const normalized = uniqueIds(packageIds);
    if (!normalized.length) return { testsByPackage: {}, servicesByPackage: {}, testIdsByPackage: {}, serviceIdsByPackage: {} };

    const executor = db || this.pool;
    const [testsResult, servicesResult] = await Promise.all([
      executor.query(
        `SELECT pt.package_id, lt.id, lt.name, lt.cost, lt.unit, lt.reference_range
         FROM package_tests pt JOIN lab_tests lt ON pt.lab_test_id = lt.id
         WHERE pt.package_id = ANY($1::uuid[]) ORDER BY lt.name ASC`,
        [normalized]
      ),
      executor.query(
        `SELECT ps.package_id, s.id, s.name, s.price, s.description, s.category_id,
                c.name AS category_name,
                CASE WHEN LOWER(COALESCE(s.name, '') || ' ' || COALESCE(c.name, '')) ~ '(xray|x-ray|radiology|scan|اشعة|أشعة)'
                  THEN 'RADIOLOGY' ELSE 'MEDICAL' END AS service_kind
         FROM package_services ps JOIN services s ON ps.service_id = s.id
         LEFT JOIN service_categories c ON s.category_id = c.id
         WHERE ps.package_id = ANY($1::uuid[]) ORDER BY s.name ASC`,
        [normalized]
      ),
    ]);

    const mappedTests = testsResult.rows.map((row) => ({
      package_id: row.package_id,
      id: row.id,
      name: row.name,
      cost: row.cost,
      unit: row.unit,
      reference_range: row.reference_range,
    }));
    const enrichedTests = await this.enrichWithDisplayRange(mappedTests);

    const testsByPackage = {}, testIdsByPackage = {};
    enrichedTests.forEach((row) => {
      if (!testsByPackage[row.package_id]) { testsByPackage[row.package_id] = []; testIdsByPackage[row.package_id] = []; }
      const { package_id, ...test } = row;
      testsByPackage[package_id].push(test);
      testIdsByPackage[package_id].push(row.id);
    });

    const servicesByPackage = {}, serviceIdsByPackage = {};
    servicesResult.rows.forEach((row) => {
      if (!servicesByPackage[row.package_id]) { servicesByPackage[row.package_id] = []; serviceIdsByPackage[row.package_id] = []; }
      servicesByPackage[row.package_id].push({ id: row.id, name: row.name, price: row.price, description: row.description, category_id: row.category_id, category_name: row.category_name, service_kind: row.service_kind });
      serviceIdsByPackage[row.package_id].push(row.id);
    });

    return { testsByPackage, servicesByPackage, testIdsByPackage, serviceIdsByPackage };
  }

  async attachPackageContents(packages, db = null) {
    const rows = Array.isArray(packages) ? packages : [];
    if (!rows.length) return [];
    const ids = rows.map((pkg) => pkg.id);
    const { testsByPackage, servicesByPackage, testIdsByPackage, serviceIdsByPackage } = await this.getPackageContentsByIds(ids, db);
    return rows.map((pkg) => ({
      ...pkg,
      test_ids: testIdsByPackage[pkg.id] || [],
      service_ids: serviceIdsByPackage[pkg.id] || [],
      tests: testsByPackage[pkg.id] || [],
      services: servicesByPackage[pkg.id] || [],
    }));
  }

  // --- Lab Panels ---

  async listLabPanels({ search, is_active, is_vip_exclusive } = {}, { limit, offset } = {}, db = null) {
    const where = [];
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      where.push(`(
        lp.name_en ILIKE $${params.length}
        OR lp.name_ar ILIKE $${params.length}
        OR COALESCE(lp.description_en, '') ILIKE $${params.length}
        OR COALESCE(lp.description_ar, '') ILIKE $${params.length}
      )`);
    }
    if (typeof is_active !== 'undefined') {
      params.push(is_active);
      where.push(`lp.is_active = $${params.length}`);
    } else {
      params.push(true);
      where.push(`lp.is_active = $${params.length}`);
    }
    if (typeof is_vip_exclusive !== 'undefined') {
      params.push(is_vip_exclusive);
      where.push(`lp.is_vip_exclusive = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countResult = await this._query(`SELECT COUNT(*)::int AS total FROM lab_panels lp ${whereSql}`, params, db);
    params.push(limit);
    params.push(offset);
    const result = await this._query(
      `
      SELECT
        lp.*,
        COUNT(lpt.lab_test_id)::int AS tests_count
      FROM lab_panels lp
      LEFT JOIN lab_panel_tests lpt ON lpt.panel_id = lp.id
      ${whereSql}
      GROUP BY lp.id
      ORDER BY lp.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params,
      db
    );
    return { rows: result.rows, total: countResult.rows[0]?.total || 0 };
  }

  async createLabPanelRow(data, db = null) {
    const {
      name_en,
      name_ar,
      description_en,
      description_ar,
      price,
      sample_types,
      turnaround_hours,
      is_active,
      is_vip_exclusive,
    } = data;
    return this._queryOne(
      `
      INSERT INTO lab_panels (
        name, name_en, name_ar, description_en, description_ar, price,
        sample_types, turnaround_hours, is_active, is_vip_exclusive
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
      `,
      [
        name_en,
        name_en,
        name_ar,
        description_en || null,
        description_ar || null,
        price,
        sample_types || null,
        turnaround_hours ?? null,
        typeof is_active === 'boolean' ? is_active : true,
        Boolean(is_vip_exclusive),
      ],
      db
    );
  }

  async updateLabPanelRow(id, data, client = null) {
    const ALLOWED = [
      'name_en', 'name_ar', 'description_en', 'description_ar',
      'price', 'sample_types', 'turnaround_hours',
      'is_active', 'is_vip_exclusive',
    ];
    const sets = [];
    const values = [];
    for (const field of ALLOWED) {
      if (Object.prototype.hasOwnProperty.call(data, field)) {
        values.push(data[field] === '' ? null : data[field]);
        sets.push(`${field} = $${values.length}`);
      }
    }
    if (!sets.length) return { noUpdates: true };
    values.push(id);
    const db = client || this.pool;
    const row = await db.query(
      `UPDATE lab_panels SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${values.length} RETURNING *`,
      values
    );
    return { noUpdates: false, row: row.rows[0] || null };
  }

  async getLabPanelRow(id, db = null) {
    return this._queryOne('SELECT * FROM lab_panels WHERE id = $1', [id], db);
  }

  async replaceLabPanelTests(panelId, testIds, db = null) {
    const executor = db || this.pool;
    const ids = uniqueIds(testIds);
    await executor.query('DELETE FROM lab_panel_tests WHERE panel_id = $1', [panelId]);
    if (!ids.length) return;

    const values = ids.map((_, index) => `($1, $${index + 2}, ${index})`).join(', ');
    await executor.query(
      `INSERT INTO lab_panel_tests (panel_id, lab_test_id, display_order) VALUES ${values}`,
      [panelId, ...ids]
    );
  }

  async getPanelTestsByIds(panelIds, db = null) {
    const normalized = uniqueIds(panelIds);
    if (!normalized.length) return { testsByPanel: {}, testIdsByPanel: {} };

    const result = await this._query(
      `
      SELECT
        lpt.panel_id,
        lpt.display_order,
        lt.id,
        lt.name,
        lt.description,
        lt.cost,
        lt.unit,
        lt.reference_range,
        lt.sample_type,
        lt.is_active,
        lt.is_vip_exclusive
      FROM lab_panel_tests lpt
      JOIN lab_tests lt ON lt.id = lpt.lab_test_id
      WHERE lpt.panel_id = ANY($1::uuid[])
      ORDER BY lpt.display_order ASC, lt.name ASC
      `,
      [normalized],
      db
    );

    const mappedTests = result.rows.map((row) => ({
      panel_id: row.panel_id,
      id: row.id,
      name: row.name,
      description: row.description || null,
      cost: row.cost,
      unit: row.unit || null,
      reference_range: row.reference_range || null,
      sample_type: row.sample_type || null,
      is_active: row.is_active,
      is_vip_exclusive: row.is_vip_exclusive,
      display_order: row.display_order,
    }));
    const enrichedTests = await this.enrichWithDisplayRange(mappedTests);

    const testsByPanel = {};
    const testIdsByPanel = {};
    enrichedTests.forEach((row) => {
      if (!testsByPanel[row.panel_id]) {
        testsByPanel[row.panel_id] = [];
        testIdsByPanel[row.panel_id] = [];
      }
      const { panel_id, ...test } = row;
      testsByPanel[panel_id].push(test);
      testIdsByPanel[row.panel_id].push(row.id);
    });

    return { testsByPanel, testIdsByPanel };
  }

  async attachLabPanelTests(panels, db = null) {
    const rows = Array.isArray(panels) ? panels : [];
    if (!rows.length) return [];

    const { testsByPanel, testIdsByPanel } = await this.getPanelTestsByIds(rows.map((panel) => panel.id), db);
    return rows.map((panel) => ({
      ...panel,
      test_ids: testIdsByPanel[panel.id] || [],
      tests: testsByPanel[panel.id] || [],
    }));
  }

  async getLabPanelById(id, db = null) {
    const panel = await this._queryOne(
      `
      SELECT
        lp.*,
        COUNT(lpt.lab_test_id)::int AS tests_count
      FROM lab_panels lp
      LEFT JOIN lab_panel_tests lpt ON lpt.panel_id = lp.id
      WHERE lp.id = $1
      GROUP BY lp.id
      `,
      [id],
      db
    );

    if (!panel) return null;
    const [panelWithTests] = await this.attachLabPanelTests([panel], db);
    return panelWithTests || panel;
  }

  async deactivateLabPanel(id, db = null) {
    return this._queryOne(
      'UPDATE lab_panels SET is_active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING *',
      [id],
      db
    );
  }

  // --- Lab Packages ---

  async listLabPackages({ search, is_active, is_vip_exclusive } = {}, { limit, offset } = {}, db = null) {
    const where = [];
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      where.push(`(
        lp.name_en ILIKE $${params.length}
        OR lp.name_ar ILIKE $${params.length}
        OR COALESCE(lp.description_en, '') ILIKE $${params.length}
        OR COALESCE(lp.description_ar, '') ILIKE $${params.length}
      )`);
    }
    if (typeof is_active !== 'undefined') {
      params.push(is_active);
      where.push(`lp.is_active = $${params.length}`);
    } else {
      params.push(true);
      where.push(`lp.is_active = $${params.length}`);
    }
    if (typeof is_vip_exclusive !== 'undefined') {
      params.push(is_vip_exclusive);
      where.push(`lp.is_vip_exclusive = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countResult = await this._query(`SELECT COUNT(*)::int AS total FROM lab_packages lp ${whereSql}`, params, db);
    params.push(limit);
    params.push(offset);
    const result = await this._query(
      `
      SELECT
        lp.*,
        COUNT(DISTINCT lpt.lab_test_id)::int AS tests_count,
        COUNT(DISTINCT lpp.panel_id)::int AS panels_count
      FROM lab_packages lp
      LEFT JOIN lab_package_tests lpt ON lpt.package_id = lp.id
      LEFT JOIN lab_package_panels lpp ON lpp.package_id = lp.id
      ${whereSql}
      GROUP BY lp.id
      ORDER BY lp.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params,
      db
    );
    return { rows: result.rows, total: countResult.rows[0]?.total || 0 };
  }

  async createLabPackageRow(data, db = null) {
    const {
      name_en,
      name_ar,
      description_en,
      description_ar,
      price,
      is_active,
      is_vip_exclusive,
      workflow_items = [],
    } = data;
    return this._queryOne(
      `
      INSERT INTO lab_packages (
        name_en, name_ar, description_en, description_ar, price, is_active, is_vip_exclusive, workflow_items
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
      RETURNING *
      `,
      [
        name_en,
        name_ar,
        description_en || null,
        description_ar || null,
        price,
        typeof is_active === 'boolean' ? is_active : true,
        Boolean(is_vip_exclusive),
        JSON.stringify(workflow_items || []),
      ],
      db
    );
  }

  async updateLabPackageRow(id, data, db = null) {
    const allowedFields = [
      'name_en',
      'name_ar',
      'description_en',
      'description_ar',
      'price',
      'is_active',
      'is_vip_exclusive',
      'workflow_items',
    ];
    const sets = [];
    const values = [];

    for (const field of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(data, field)) {
        values.push(field === 'workflow_items' ? JSON.stringify(data[field] || []) : data[field]);
        sets.push(field === 'workflow_items' ? `${field} = $${values.length}::jsonb` : `${field} = $${values.length}`);
      }
    }

    if (!sets.length) {
      return { row: await this.getLabPackageRow(id, db) };
    }

    values.push(id);
    const executor = db || this.pool;
    const row = await executor.query(
      `UPDATE lab_packages SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${values.length} RETURNING *`,
      values
    );

    return { row: row.rows[0] || null };
  }

  async getLabPackageRow(id, db = null) {
    return this._queryOne('SELECT * FROM lab_packages WHERE id = $1', [id], db);
  }

  async replaceLabPackageItems(packageId, { testIds, panelIds }, db = null) {
    const executor = db || this.pool;

    if (testIds !== undefined) {
      const ids = uniqueIds(testIds);
      await executor.query('DELETE FROM lab_package_tests WHERE package_id = $1', [packageId]);
      if (ids.length) {
        const values = ids.map((_, index) => `($1, $${index + 2})`).join(', ');
        await executor.query(
          `INSERT INTO lab_package_tests (package_id, lab_test_id) VALUES ${values}`,
          [packageId, ...ids]
        );
      }
    }

    if (panelIds !== undefined) {
      const ids = uniqueIds(panelIds);
      await executor.query('DELETE FROM lab_package_panels WHERE package_id = $1', [packageId]);
      if (ids.length) {
        const values = ids.map((_, index) => `($1, $${index + 2})`).join(', ');
        await executor.query(
          `INSERT INTO lab_package_panels (package_id, panel_id) VALUES ${values}`,
          [packageId, ...ids]
        );
      }
    }
  }

  async getLabPackageContentsByIds(packageIds, db = null) {
    const normalized = uniqueIds(packageIds);
    if (!normalized.length) {
      return {
        testsByPackage: {},
        testIdsByPackage: {},
        panelsByPackage: {},
        panelIdsByPackage: {},
      };
    }

    const executor = db || this.pool;
    const [testsResult, panelsResult] = await Promise.all([
      executor.query(
        `
        SELECT
          lpt.package_id,
          lt.id,
          lt.name,
          lt.description,
          lt.cost,
          lt.unit,
          lt.reference_range,
          lt.sample_type,
          lt.is_active,
          lt.is_vip_exclusive
        FROM lab_package_tests lpt
        JOIN lab_tests lt ON lt.id = lpt.lab_test_id
        WHERE lpt.package_id = ANY($1::uuid[])
        ORDER BY lt.name ASC
        `,
        [normalized]
      ),
      executor.query(
        `
        SELECT
          lpp.package_id,
          lp.id,
          lp.name_en,
          lp.name_ar,
          lp.description_en,
          lp.description_ar,
          lp.price,
          lp.sample_types,
          lp.turnaround_hours,
          lp.is_active,
          lp.is_vip_exclusive
        FROM lab_package_panels lpp
        JOIN lab_panels lp ON lp.id = lpp.panel_id
        WHERE lpp.package_id = ANY($1::uuid[])
        ORDER BY lp.name_en ASC
        `,
        [normalized]
      ),
    ]);

    const mappedTests = testsResult.rows.map((row) => ({
      package_id: row.package_id,
      id: row.id,
      name: row.name,
      description: row.description || null,
      cost: row.cost,
      unit: row.unit || null,
      reference_range: row.reference_range || null,
      sample_type: row.sample_type || null,
      is_active: row.is_active,
      is_vip_exclusive: row.is_vip_exclusive,
    }));
    const enrichedTests = await this.enrichWithDisplayRange(mappedTests);

    const testsByPackage = {};
    const testIdsByPackage = {};
    enrichedTests.forEach((row) => {
      if (!testsByPackage[row.package_id]) {
        testsByPackage[row.package_id] = [];
        testIdsByPackage[row.package_id] = [];
      }
      const { package_id, ...test } = row;
      testsByPackage[package_id].push(test);
      testIdsByPackage[row.package_id].push(row.id);
    });

    const panelIds = panelsResult.rows.map((row) => row.id);
    const { testsByPanel, testIdsByPanel } = await this.getPanelTestsByIds(panelIds, db);
    const panelsByPackage = {};
    const panelIdsByPackage = {};
    panelsResult.rows.forEach((row) => {
      if (!panelsByPackage[row.package_id]) {
        panelsByPackage[row.package_id] = [];
        panelIdsByPackage[row.package_id] = [];
      }
      panelsByPackage[row.package_id].push({
        id: row.id,
        name_en: row.name_en,
        name_ar: row.name_ar,
        description_en: row.description_en || null,
        description_ar: row.description_ar || null,
        price: row.price,
        sample_types: row.sample_types || null,
        turnaround_hours: row.turnaround_hours ?? null,
        is_active: row.is_active,
        is_vip_exclusive: row.is_vip_exclusive,
        test_ids: testIdsByPanel[row.id] || [],
        tests: testsByPanel[row.id] || [],
      });
      panelIdsByPackage[row.package_id].push(row.id);
    });

    return { testsByPackage, testIdsByPackage, panelsByPackage, panelIdsByPackage };
  }

  async attachLabPackageContents(packages, db = null) {
    const rows = Array.isArray(packages) ? packages : [];
    if (!rows.length) return [];

    const {
      testsByPackage,
      testIdsByPackage,
      panelsByPackage,
      panelIdsByPackage,
    } = await this.getLabPackageContentsByIds(rows.map((pkg) => pkg.id), db);

    return rows.map((pkg) => ({
      ...pkg,
      test_ids: testIdsByPackage[pkg.id] || [],
      panel_ids: panelIdsByPackage[pkg.id] || [],
      tests: testsByPackage[pkg.id] || [],
      panels: panelsByPackage[pkg.id] || [],
    }));
  }

  async getLabPackageById(id, db = null) {
    const pkg = await this._queryOne(
      `
      SELECT
        lp.*,
        COUNT(DISTINCT lpt.lab_test_id)::int AS tests_count,
        COUNT(DISTINCT lpp.panel_id)::int AS panels_count
      FROM lab_packages lp
      LEFT JOIN lab_package_tests lpt ON lpt.package_id = lp.id
      LEFT JOIN lab_package_panels lpp ON lpp.package_id = lp.id
      WHERE lp.id = $1
      GROUP BY lp.id
      `,
      [id],
      db
    );

    if (!pkg) return null;
    const [pkgWithContents] = await this.attachLabPackageContents([pkg], db);
    if (!pkgWithContents) return pkg;

    const directTestIds = new Set((pkgWithContents.tests || []).map((test) => test.id));
    for (const panel of (pkgWithContents.panels || [])) {
      if (Array.isArray(panel.tests)) {
        panel.tests = panel.tests.filter((test) => !directTestIds.has(test.id));
      }
    }

    return pkgWithContents;
  }

  async deactivateLabPackage(id, db = null) {
    return this._queryOne(
      'UPDATE lab_packages SET is_active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING *',
      [id],
      db
    );
  }

  // --- Ratings (lab tests) ---

  async getDirectLabTestRating(patientId, labTestId, db = null) {
    return this._queryOne('SELECT id FROM service_ratings WHERE patient_id = $1 AND lab_test_id = $2 LIMIT 1', [patientId, labTestId], db);
  }

  async createDirectLabTestRating({ patientId, labTestId, rating, comment }, db = null) {
    return this._queryOne(
      `INSERT INTO service_ratings (patient_id, lab_test_id, rating, comment, rating_type)
       VALUES ($1, $2, $3, $4, 'SERVICE') RETURNING *`,
      [patientId, labTestId, rating, comment || null], db
    );
  }

  async getLabTestRatingsSummary(labTestId, db = null) {
    return this._queryOne(
      `SELECT COUNT(id)::int AS total_ratings, COALESCE(ROUND(AVG(rating)::numeric, 2), 0) AS average_rating
       FROM service_ratings WHERE lab_test_id = $1 AND rating_type = 'SERVICE'`,
      [labTestId], db
    );
  }

  async listLabTestRatings(labTestId, { limit, offset } = {}, db = null) {
    const [countResult, result] = await Promise.all([
      this._query('SELECT COUNT(*)::int AS total FROM service_ratings WHERE lab_test_id = $1 AND rating_type = \'SERVICE\'', [labTestId], db),
      this._query(
        `SELECT sr.id, sr.patient_id, sr.rating, sr.comment, sr.created_at, p.full_name AS patient_name
         FROM service_ratings sr LEFT JOIN patients p ON p.id = sr.patient_id
         WHERE sr.lab_test_id = $1 AND sr.rating_type = 'SERVICE'
         ORDER BY sr.created_at DESC LIMIT $2 OFFSET $3`,
        [labTestId, limit, offset], db
      ),
    ]);
    return { data: result.rows, total: countResult.rows[0]?.total || 0 };
  }

  // --- Ratings (packages) ---

  async getDirectPackageRating(patientId, packageId, db = null) {
    return this._queryOne('SELECT id FROM service_ratings WHERE patient_id = $1 AND package_id = $2 LIMIT 1', [patientId, packageId], db);
  }

  async createDirectPackageRating({ patientId, packageId, rating, comment }, db = null) {
    return this._queryOne(
      `INSERT INTO service_ratings (patient_id, package_id, rating, comment, rating_type)
       VALUES ($1, $2, $3, $4, 'SERVICE') RETURNING *`,
      [patientId, packageId, rating, comment || null], db
    );
  }

  async getPackageRatingsSummary(packageId, db = null) {
    return this._queryOne(
      `SELECT COUNT(id)::int AS total_ratings, COALESCE(ROUND(AVG(rating)::numeric, 2), 0) AS average_rating
       FROM service_ratings WHERE package_id = $1 AND rating_type = 'SERVICE'`,
      [packageId], db
    );
  }

  async listPackageRatings(packageId, { limit, offset } = {}, db = null) {
    const [countResult, result] = await Promise.all([
      this._query('SELECT COUNT(*)::int AS total FROM service_ratings WHERE package_id = $1 AND rating_type = \'SERVICE\'', [packageId], db),
      this._query(
        `SELECT sr.id, sr.patient_id, sr.rating, sr.comment, sr.created_at, p.full_name AS patient_name
         FROM service_ratings sr LEFT JOIN patients p ON p.id = sr.patient_id
         WHERE sr.package_id = $1 AND sr.rating_type = 'SERVICE'
         ORDER BY sr.created_at DESC LIMIT $2 OFFSET $3`,
        [packageId, limit, offset], db
      ),
    ]);
    return { data: result.rows, total: countResult.rows[0]?.total || 0 };
  }
}

module.exports = LabTestRepository;
