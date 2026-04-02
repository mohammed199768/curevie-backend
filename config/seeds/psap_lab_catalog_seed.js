require('dotenv').config();
const pool = require('../db');

const PSAP_DOCUMENT = {
  title: 'REFERENCE VALUES FOR COMMON LABORATORY TESTS',
  source: 'Pharmacotherapy Self-Assessment Program (PSAP)',
  footnote:
    'Values given in this table are commonly accepted reference ranges compiled from several sources. Patient-specific goals may differ depending on age, sex, clinical condition, and the laboratory methodology used to perform the assay.',
  references: [
    'AMA Manual of Style (SI conversion calculator), last accessed 11/21/2018',
    'Lee M, ed. Basic Skills in Interpreting Laboratory Data, 6th ed. Bethesda, MD: American Society of Health-System Pharmacists, 2017',
    'DiPiro JT, Talbert RL, Yee GC, et al., eds. Pharmacotherapy: A Pathophysiologic Approach, 10th ed. New York: McGraw-Hill, 2017',
  ],
};

const SECTION_CONFIG = {
  serum_chemistries: {
    label: 'Serum Chemistries',
    sampleType: 'Blood',
  },
  hematology_coagulation: {
    label: 'Hematology and Coagulation',
    sampleType: 'Blood',
  },
  serum_lipids: {
    label: 'Serum Lipids',
    sampleType: 'Blood',
  },
  blood_gases: {
    label: 'Blood Gases',
    sampleType: 'Blood',
  },
  urinalysis: {
    label: 'Urinalysis',
    sampleType: 'Urine',
  },
};

const RANGE_GROUPS = {
  adults: {
    gender: 'any',
    ageMin: 18,
    ageMax: 999,
    label: 'Adults',
  },
  children: {
    gender: 'any',
    ageMin: 0,
    ageMax: 17,
    label: 'Children',
  },
  'young children': {
    gender: 'any',
    ageMin: 0,
    ageMax: 17,
    label: 'Young children',
    note: 'PSAP specifies "young children"; mapped to pediatric ages because the current engine supports only age bands.',
  },
  men: {
    gender: 'male',
    ageMin: 18,
    ageMax: 999,
    label: 'Men',
  },
  women: {
    gender: 'female',
    ageMin: 18,
    ageMax: 999,
    label: 'Women',
  },
};

const COST_ALIASES = {
  'alanine aminotransferase alt': ['alt sgpt', 'alt'],
  'aspartate aminotransferase ast': ['ast sgot', 'ast'],
  'bilirubin direct': ['direct bilirubin'],
  'bilirubin total': ['total bilirubin'],
  'blood urea nitrogen bun': ['bun'],
  'calcium total serum': ['calcium'],
  'creatinine serum scr': ['creatinine'],
  'glucose serum': ['fasting glucose', 'random glucose'],
  'hemoglobin a1c percent of total hemoglobin': ['hba1c', 'hemoglobin a1c'],
  'cholesterol total tc desirable': ['total cholesterol'],
  'high density lipoprotein hdl cholesterol desirable': ['hdl'],
  'low density lipoprotein ldl cholesterol': ['ldl'],
  'triglycerides tg': ['triglycerides'],
  'uric acid serum': ['uric acid'],
  'hematocrit hct': ['hematocrit'],
  'hemoglobin hgb': ['hemoglobin'],
  'platelet count plt': ['platelets'],
  'red blood cell count rbc': ['rbc'],
  'white blood cell count wbc': ['wbc'],
};

const SOURCE_DATA = {
  serum_chemistries: [
    { test: 'Alanine aminotransferase (ALT)', range: '10-40 U/L' },
    {
      test: 'Albumin',
      range: [
        { group: 'adults', value: '3.5-5 g/dL' },
        { group: 'young children', value: '3.4-4.2 g/dL' },
      ],
    },
    {
      test: 'Alkaline phosphatase (ALP)',
      range: [
        { group: 'adults', value: '30-120 IU/L' },
        { group: 'children', value: '150-420 IU/L' },
      ],
      note: 'Varies with age',
    },
    { test: 'Ammonia', range: '15-45 mcg/dL' },
    { test: 'Amylase', range: '27-131 U/L' },
    { test: 'Aspartate aminotransferase (AST)', range: '10-30 U/L' },
    { test: 'Bilirubin, direct', range: '0.1-0.3 mg/dL' },
    { test: 'Bilirubin, total', range: '0.3-1.2 mg/dL' },
    {
      test: 'Blood urea nitrogen (BUN)',
      range: [{ group: 'adults', value: '8-23 mg/dL' }],
      note: 'Lower in children',
    },
    { test: 'Calcium, ionized', range: '4.6-5.1 mg/dL' },
    { test: 'Calcium, total serum', range: '8.2-10.2 mg/dL' },
    { test: 'Carbon dioxide (venous) (CO2)', range: '22-28 mEq/L' },
    { test: 'Chloride (Cl)', range: '96-106 mEq/L' },
    { test: 'C-reactive protein (CRP)', range: '0.08-3.1 mg/L' },
    { test: 'Creatinine kinase (CK)', range: '40-150 U/L' },
    {
      test: 'Creatinine, serum (SCr)',
      range: [
        { group: 'adults', value: '0.6-1.2 mg/dL' },
        { group: 'children', value: '0.2-0.7 mg/dL' },
      ],
    },
    { test: 'Creatinine (clearance) (CrCl)', range: '75-125 mL/minute/1.73 m2' },
    { test: 'Ferritin', range: '15-200 ng/mL' },
    { test: 'Gamma-glutamyl transpeptidase', range: '2-30 U/L' },
    { test: 'Glucose, serum', range: '70-110 mg/dL' },
    { test: 'Hemoglobin A1C percent of total hemoglobin', range: '4%-7%' },
    { test: 'Lactate dehydrogenase (LDH)', range: '100-200 U/L' },
    { test: 'Lipase', range: '31-186 U/L' },
    { test: 'Magnesium', range: '1.3-2.1 mEq/L' },
    { test: 'Osmolality, serum', range: '275-295 mOsm/kg' },
    {
      test: 'Phosphorus',
      range: [
        { group: 'adults', value: '2.3-4.7 mg/dL' },
        { group: 'children', value: '3.7-5.6 mg/dL' },
      ],
    },
    { test: 'Potassium', range: '3.5-5.0 mEq/L' },
    { test: 'Prealbumin', range: '19.5-35.8 mg/dL' },
    { test: 'Sodium', range: '136-142 mEq/L' },
    { test: 'Uric acid, serum', range: '4-8 mg/dL' },
  ],
  hematology_coagulation: [
    {
      test: 'Hematocrit (Hct)',
      range: [
        { group: 'men', value: '42%-50%' },
        { group: 'women', value: '36%-45%' },
      ],
    },
    {
      test: 'Hemoglobin (Hgb)',
      range: [
        { group: 'men', value: '14-18 g/dL' },
        { group: 'women', value: '12-16 g/dL' },
      ],
    },
    { test: 'International normalized ratio (INR)', range: '0.9-1.1' },
    { test: 'Mean corpuscular hemoglobin (MCH)', range: '26-34 pg/cell' },
    { test: 'Mean corpuscular hemoglobin concentration (MCHC)', range: '33-37 g/dL' },
    { test: 'Mean corpuscular volume (MCV)', range: '80-100 fL/cell' },
    { test: 'Partial thromboplastin time (PTT)', range: '25-40 seconds' },
    { test: 'Platelet count (Plt)', range: '150,000-350,000 cells/mm3' },
    { test: 'Prothrombin time (PT)', range: '10-13 seconds' },
    {
      test: 'Red blood cell count (RBC)',
      range: [
        { group: 'men', value: '4.5-5.9 x10^6 cells/mm3' },
        { group: 'women', value: '4.1-5.1 x10^6 cells/mm3' },
      ],
    },
    { test: 'Reticulocyte percent of red blood cells', range: '0.5%-1.5%' },
    { test: 'White blood cell count (WBC)', range: '4.5-11.0 x10^3 cells/mm3' },
  ],
  serum_lipids: [
    { test: 'Cholesterol, total (TC), desirable', range: '< 200 mg/dL' },
    { test: 'High-density lipoprotein (HDL) cholesterol, desirable', range: '>= 60 mg/dL' },
    { test: 'Low-density lipoprotein (LDL) cholesterol', range: '< 100 mg/dL' },
    { test: 'Triglycerides (TG)', range: '< 150 mg/dL' },
  ],
  blood_gases: [
    { test: 'pH', arterial: '7.35-7.45', venous: '7.31-7.41' },
    { test: 'Partial pressure of carbon dioxide (PCO2)', arterial: '35-45 mm Hg', venous: '40-52 mm Hg' },
    { test: 'Partial pressure of oxygen (PO2)', arterial: '80-100 mm Hg', venous: '30-50 mm Hg' },
    { test: 'Oxygen saturation (SaO2)', arterial: '> 90%', venous: '60%-75%' },
    { test: 'Serum bicarbonate (HCO3)', arterial: '22-26 mEq/L', venous: '21-28 mEq/L' },
  ],
  urinalysis: [
    {
      test: 'Leukocyte esterase, nitrite, protein, blood, ketones, bilirubin, glucose',
      range: 'Negative',
    },
    { test: 'pH', range: '4.5-8.0' },
    { test: 'Specific gravity', range: '1.010-1.025' },
  ],
};

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeRangeText(value) {
  return String(value || '')
    .replace(/[–—−]/g, '-')
    .replace(/≥/g, '>=')
    .replace(/≤/g, '<=')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNumeric(rawValue) {
  return Number(String(rawValue).replace(/,/g, ''));
}

function cleanUnit(unit) {
  const normalized = String(unit || '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || null;
}

function parseRangeSpec(rawRange) {
  const normalized = normalizeRangeText(rawRange);

  if (/^negative$/i.test(normalized)) {
    return {
      resultType: 'CATEGORICAL',
      rangeLow: null,
      rangeHigh: null,
      rangeText: 'Negative',
      unit: null,
    };
  }

  const thresholdMatch = normalized.match(/^(<=|>=|<|>)\s*([0-9.,]+)\s*(%?)\s*(.*)$/);
  if (thresholdMatch) {
    const operator = thresholdMatch[1];
    const value = parseNumeric(thresholdMatch[2]);
    const percentUnit = thresholdMatch[3] ? '%' : '';
    const trailingUnit = cleanUnit(thresholdMatch[4]);
    const unit = cleanUnit(`${percentUnit}${percentUnit && trailingUnit ? ' ' : ''}${trailingUnit || ''}`);

    return {
      resultType: 'NUMERIC',
      rangeLow: operator.startsWith('>') ? value : null,
      rangeHigh: operator.startsWith('<') ? value : null,
      rangeText: null,
      unit,
    };
  }

  const intervalMatch = normalized.match(/^([0-9.,]+)\s*(%?)\s*-\s*([0-9.,]+)\s*(%?)\s*(.*)$/);
  if (intervalMatch) {
    const leftValue = parseNumeric(intervalMatch[1]);
    const rightValue = parseNumeric(intervalMatch[3]);
    const hasPercent = Boolean(intervalMatch[2] || intervalMatch[4]);
    const trailingUnit = cleanUnit(intervalMatch[5]);
    const unit = cleanUnit(`${hasPercent ? '%' : ''}${hasPercent && trailingUnit ? ' ' : ''}${trailingUnit || ''}`);

    return {
      resultType: 'NUMERIC',
      rangeLow: leftValue,
      rangeHigh: rightValue,
      rangeText: null,
      unit,
    };
  }

  return {
    resultType: 'CATEGORICAL',
    rangeLow: null,
    rangeHigh: null,
    rangeText: normalized,
    unit: null,
  };
}

function buildRangeLabel(range) {
  const unit = range.unit ? ` ${range.unit}` : '';
  if (range.rangeText) {
    return range.rangeText;
  }
  if (range.rangeLow !== null && range.rangeHigh !== null) {
    return `${range.rangeLow}-${range.rangeHigh}${unit}`;
  }
  if (range.rangeLow !== null) {
    return `>= ${range.rangeLow}${unit}`;
  }
  if (range.rangeHigh !== null) {
    return `<= ${range.rangeHigh}${unit}`;
  }
  return null;
}

function buildLegacyReferenceRange(ranges) {
  const labels = ranges
    .map((range) => {
      const parts = [];
      if (range.gender === 'male') parts.push('Male');
      if (range.gender === 'female') parts.push('Female');
      if (range.ageMin === 18 && range.ageMax === 999 && range.gender === 'any') parts.push('Adults');
      if (range.ageMin === 0 && range.ageMax === 17) parts.push('Children');
      const value = buildRangeLabel(range);
      if (!value) return null;
      return parts.length ? `${parts.join(' ')} ${value}` : value;
    })
    .filter(Boolean);

  return labels.length ? labels.join(' / ') : null;
}

function buildRangeRow({
  rawRange,
  groupLabel = null,
  itemNote = null,
  extraNotes = [],
  priority = 10,
}) {
  const parsed = parseRangeSpec(rawRange);
  const group = groupLabel ? RANGE_GROUPS[groupLabel.toLowerCase()] : null;

  if (groupLabel && !group) {
    throw new Error(`Unhandled range group: ${groupLabel}`);
  }

  const notes = [...extraNotes];
  if (group?.note) notes.push(group.note);
  if (itemNote) notes.push(itemNote);
  if (groupLabel) notes.push(`PSAP group: ${groupLabel}`);

  return {
    gender: group?.gender || 'any',
    ageMin: group?.ageMin ?? 0,
    ageMax: group?.ageMax ?? 999,
    fastingState: null,
    cyclePhase: null,
    isPregnant: null,
    rangeLow: parsed.rangeLow,
    rangeHigh: parsed.rangeHigh,
    rangeText: parsed.rangeText,
    unit: parsed.unit,
    notes: notes.length ? notes.join(' | ') : null,
    priority,
    resultType: parsed.resultType,
  };
}

function resolveResultType(ranges) {
  return ranges.some((range) => range.resultType === 'CATEGORICAL') ? 'CATEGORICAL' : 'NUMERIC';
}

function buildTestDescription(sectionKey, item, variantLabel = null) {
  const sectionLabel = SECTION_CONFIG[sectionKey].label;
  const suffix = variantLabel ? ` (${variantLabel})` : '';
  const note = item.note ? ` ${item.note}.` : '';
  return `${PSAP_DOCUMENT.source} reference entry for ${sectionLabel}${suffix}.${note} ${PSAP_DOCUMENT.footnote}`;
}

function finalizeTest(sectionKey, {
  name,
  sampleType,
  item,
  ranges,
  variantLabel = null,
}) {
  return {
    name,
    description: buildTestDescription(sectionKey, item, variantLabel),
    unit: ranges.find((range) => range.unit)?.unit || null,
    referenceRange: buildLegacyReferenceRange(ranges),
    sampleType,
    resultType: resolveResultType(ranges),
    requiresFasting: false,
    requiresGender: ranges.some((range) => range.gender !== 'any'),
    requiresAge: ranges.some((range) => range.ageMin !== 0 || range.ageMax !== 999),
    requiresCyclePhase: false,
    requiresPregnancy: false,
    isVipExclusive: false,
    isActive: true,
    ranges,
  };
}

function expandStandardItem(sectionKey, item) {
  const baseSampleType = SECTION_CONFIG[sectionKey].sampleType;
  const rawRanges = Array.isArray(item.range)
    ? item.range.map((entry, index) => buildRangeRow({
        rawRange: entry.value,
        groupLabel: entry.group,
        itemNote: item.note,
        priority: 20 - index,
      }))
    : [buildRangeRow({ rawRange: item.range, itemNote: item.note, priority: 10 })];

  return [finalizeTest(sectionKey, {
    name: item.test,
    sampleType: baseSampleType,
    item,
    ranges: rawRanges,
  })];
}

function expandBloodGasItem(sectionKey, item) {
  return [
    finalizeTest(sectionKey, {
      name: `${item.test} (Arterial)`,
      sampleType: 'Arterial Blood',
      item,
      variantLabel: 'Arterial',
      ranges: [
        buildRangeRow({
          rawRange: item.arterial,
          itemNote: item.note,
          extraNotes: ['PSAP specimen: arterial'],
          priority: 15,
        }),
      ],
    }),
    finalizeTest(sectionKey, {
      name: `${item.test} (Venous)`,
      sampleType: 'Venous Blood',
      item,
      variantLabel: 'Venous',
      ranges: [
        buildRangeRow({
          rawRange: item.venous,
          itemNote: item.note,
          extraNotes: ['PSAP specimen: venous'],
          priority: 15,
        }),
      ],
    }),
  ];
}

function buildCatalogDefinitions() {
  const allTests = [];
  for (const [sectionKey, items] of Object.entries(SOURCE_DATA)) {
    for (const item of items) {
      const tests = item.arterial || item.venous
        ? expandBloodGasItem(sectionKey, item)
        : expandStandardItem(sectionKey, item);
      allTests.push(...tests);
    }
  }
  return allTests;
}

async function tableExists(client, tableName) {
  const result = await client.query(
    "SELECT to_regclass($1) AS table_name",
    [`public.${tableName}`]
  );
  return Boolean(result.rows[0]?.table_name);
}

async function columnExists(client, tableName, columnName) {
  const result = await client.query(
    `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
      AND column_name = $2
    LIMIT 1
    `,
    [tableName, columnName]
  );
  return result.rowCount > 0;
}

async function ensureLabCategory(client) {
  const knownNames = ['lab', 'laboratory', 'medical lab', 'lab tests', 'مختبر'];
  const result = await client.query(
    `
    SELECT id
    FROM service_categories
    WHERE LOWER(name) = ANY($1::text[])
    ORDER BY CASE
      WHEN LOWER(name) = 'مختبر' THEN 0
      WHEN LOWER(name) = 'medical lab' THEN 1
      WHEN LOWER(name) = 'lab tests' THEN 2
      WHEN LOWER(name) = 'laboratory' THEN 3
      WHEN LOWER(name) = 'lab' THEN 4
      ELSE 9
    END
    LIMIT 1
    `,
    [knownNames]
  );

  if (result.rows[0]?.id) {
    return result.rows[0].id;
  }

  const inserted = await client.query(
    `
    INSERT INTO service_categories (name, description)
    VALUES ($1, $2)
    RETURNING id
    `,
    ['Medical Lab', 'Laboratory catalog seeded from PSAP reference values']
  );

  return inserted.rows[0].id;
}

async function buildExistingCostMap(client) {
  const costMap = new Map();
  const result = await client.query('SELECT name, cost FROM lab_tests');
  for (const row of result.rows) {
    const normalized = normalizeName(row.name);
    if (normalized && !costMap.has(normalized)) {
      costMap.set(normalized, Number(row.cost));
    }
  }
  return costMap;
}

function resolveCost(testName, existingCostMap) {
  const normalized = normalizeName(testName);
  const candidateKeys = [
    normalized,
    ...(COST_ALIASES[normalized] || []).map((alias) => normalizeName(alias)),
  ];

  for (const key of candidateKeys) {
    if (existingCostMap.has(key)) {
      return existingCostMap.get(key);
    }
  }

  return 0;
}

async function ensureSmartRangeColumns(client) {
  const requiredLabTestColumns = [
    'result_type',
    'requires_fasting',
    'requires_gender',
    'requires_age',
    'requires_cycle_phase',
    'requires_pregnancy',
  ];
  const requiredRangeColumns = [
    'fasting_state',
    'cycle_phase',
    'is_pregnant',
  ];

  for (const columnName of requiredLabTestColumns) {
    if (!(await columnExists(client, 'lab_tests', columnName))) {
      throw new Error(`Missing required smart-range lab_tests column: ${columnName}`);
    }
  }

  for (const columnName of requiredRangeColumns) {
    if (!(await columnExists(client, 'lab_test_reference_ranges', columnName))) {
      throw new Error(`Missing required smart-range range column: ${columnName}`);
    }
  }
}

async function cleanupExistingLabCatalog(client) {
  if (await tableExists(client, 'service_requests')) {
    const updates = [];
    if (await columnExists(client, 'service_requests', 'lab_test_id')) updates.push('lab_test_id = NULL');
    if (await columnExists(client, 'service_requests', 'lab_panel_id')) updates.push('lab_panel_id = NULL');
    if (await columnExists(client, 'service_requests', 'lab_package_id')) updates.push('lab_package_id = NULL');
    if (updates.length) {
      await client.query(`UPDATE service_requests SET ${updates.join(', ')}`);
    }
  }

  if (await tableExists(client, 'request_additional_orders') && await columnExists(client, 'request_additional_orders', 'lab_test_id')) {
    await client.query('UPDATE request_additional_orders SET lab_test_id = NULL WHERE lab_test_id IS NOT NULL');
  }

  if (await tableExists(client, 'service_ratings') && await columnExists(client, 'service_ratings', 'lab_test_id')) {
    await client.query('UPDATE service_ratings SET lab_test_id = NULL WHERE lab_test_id IS NOT NULL');
  }

  if (await tableExists(client, 'lab_test_results')) {
    await client.query('DELETE FROM lab_test_results');
  }

  if (await tableExists(client, 'ordinal_scale_items')) {
    await client.query('DELETE FROM ordinal_scale_items');
  }

  if (await tableExists(client, 'lab_package_panels')) {
    await client.query('DELETE FROM lab_package_panels');
  }
  if (await tableExists(client, 'lab_package_tests')) {
    await client.query('DELETE FROM lab_package_tests');
  }
  if (await tableExists(client, 'lab_packages')) {
    await client.query('DELETE FROM lab_packages');
  }
  if (await tableExists(client, 'lab_panel_tests')) {
    await client.query('DELETE FROM lab_panel_tests');
  }
  if (await tableExists(client, 'lab_panels')) {
    await client.query('DELETE FROM lab_panels');
  }
  if (await tableExists(client, 'lab_test_reference_ranges')) {
    await client.query('DELETE FROM lab_test_reference_ranges');
  }
  await client.query('DELETE FROM lab_tests');
}

async function insertLabTest(client, categoryId, definition, cost) {
  const testInsert = await client.query(
    `
    INSERT INTO lab_tests (
      name,
      description,
      unit,
      reference_range,
      sample_type,
      cost,
      category_id,
      is_vip_exclusive,
      is_active,
      result_type,
      requires_fasting,
      requires_gender,
      requires_age,
      requires_cycle_phase,
      requires_pregnancy
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    RETURNING id
    `,
    [
      definition.name,
      definition.description,
      definition.unit,
      definition.referenceRange,
      definition.sampleType,
      cost,
      categoryId,
      definition.isVipExclusive,
      definition.isActive,
      definition.resultType,
      definition.requiresFasting,
      definition.requiresGender,
      definition.requiresAge,
      definition.requiresCyclePhase,
      definition.requiresPregnancy,
    ]
  );

  const labTestId = testInsert.rows[0].id;

  for (const range of definition.ranges) {
    await client.query(
      `
      INSERT INTO lab_test_reference_ranges (
        lab_test_id,
        gender,
        age_min,
        age_max,
        fasting_state,
        cycle_phase,
        is_pregnant,
        range_low,
        range_high,
        range_text,
        unit,
        notes,
        priority
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      `,
      [
        labTestId,
        range.gender,
        range.ageMin,
        range.ageMax,
        range.fastingState,
        range.cyclePhase,
        range.isPregnant,
        range.rangeLow,
        range.rangeHigh,
        range.rangeText,
        range.unit,
        range.notes,
        range.priority,
      ]
    );
  }

  return {
    labTestId,
    rangesInserted: definition.ranges.length,
  };
}

async function run() {
  const client = await pool.connect();
  const definitions = buildCatalogDefinitions();
  let insertedTests = 0;
  let insertedRanges = 0;
  let reusedCosts = 0;
  let zeroCostTests = 0;

  try {
    await client.query('BEGIN');
    await ensureSmartRangeColumns(client);

    const existingCostMap = await buildExistingCostMap(client);
    const categoryId = await ensureLabCategory(client);

    console.log(`Preparing to replace lab catalog with ${definitions.length} PSAP-driven tests...`);
    await cleanupExistingLabCatalog(client);

    for (const definition of definitions) {
      const cost = resolveCost(definition.name, existingCostMap);
      if (cost > 0) reusedCosts += 1;
      else zeroCostTests += 1;

      const result = await insertLabTest(client, categoryId, definition, cost);
      insertedTests += 1;
      insertedRanges += result.rangesInserted;
    }

    await client.query('COMMIT');

    console.log('PSAP lab catalog replacement completed successfully.');
    console.log(JSON.stringify({
      document: PSAP_DOCUMENT.title,
      source: PSAP_DOCUMENT.source,
      tests_inserted: insertedTests,
      smart_ranges_inserted: insertedRanges,
      reused_existing_costs: reusedCosts,
      zero_cost_tests: zeroCostTests,
    }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('PSAP lab catalog replacement failed:', error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
