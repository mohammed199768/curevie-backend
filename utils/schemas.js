const Joi = require('joi');

// =============================================
// REUSABLE RULES
// =============================================
const uuid = Joi.string().uuid();
const phone = Joi.string().pattern(/^[0-9+\-\s()]{7,20}$/).messages({
  'string.pattern.base': 'Invalid phone number format',
});
const password = Joi.string().min(8).max(100)
  .pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
  .messages({
    'string.pattern.base': 'Password must contain uppercase, lowercase, and number',
    'string.min': 'Password must be at least 8 characters',
  });
const pagination = {
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(500).default(10),
};

// =============================================
// AUTH
// =============================================
const loginSchema = Joi.object({
  email: Joi.string().email().required().lowercase().trim(),
  password: Joi.string().required(),
  role: Joi.string().valid('ADMIN', 'PROVIDER', 'PATIENT').required(),
});

const registerSchema = Joi.object({
  full_name: Joi.string().min(2).max(100).required().trim(),
  email: Joi.string().email().required().lowercase().trim(),
  password: password.required(),
  phone: phone.required(),
  secondary_phone: Joi.string().trim().max(30).allow('', null).optional(),
  address: Joi.string().max(300).trim(),
  date_of_birth: Joi.date().max('now').iso(),
  gender: Joi.string().valid('male', 'female', 'other').allow(null, ''),
});

const refreshTokenSchema = Joi.object({
  refresh_token: Joi.string().required(),
});

const changePasswordSchema = Joi.object({
  current_password: Joi.string().required(),
  new_password: password.required(),
  confirm_password: Joi.string().valid(Joi.ref('new_password')).required()
    .messages({ 'any.only': 'Passwords do not match' }),
});

// =============================================
// PATIENTS
// =============================================
const patientMedicalSchema = Joi.object({
  height: Joi.number().min(30).max(300),
  weight: Joi.number().min(1).max(500),
  allergies: Joi.string().max(1000).trim().allow('', null),
  gender: Joi.string().valid('male', 'female', 'other').allow(null, ''),
});

const patientProfileSchema = Joi.object({
  full_name: Joi.string().min(2).max(100).trim(),
  phone,
  secondary_phone: Joi.string().trim().max(30).allow('', null).optional(),
  address: Joi.string().max(300).trim().allow('', null),
  date_of_birth: Joi.date().max('now').iso().allow(null),
  gender: Joi.string().valid('male', 'female', 'other').allow(null, ''),
}).min(1);

const patientHistorySchema = Joi.object({
  note: Joi.string().min(3).max(2000).required().trim(),
});

const vipSchema = Joi.object({
  is_vip: Joi.boolean().required(),
  vip_discount: Joi.number().min(0).max(100).when('is_vip', {
    is: true,
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
});

// =============================================
// PROVIDERS
// =============================================
const createProviderSchema = Joi.object({
  full_name: Joi.string().min(2).max(100).required().trim(),
  email: Joi.string().email().required().lowercase().trim(),
  password: password.required(),
  phone: phone,
  type: Joi.string().valid('DOCTOR', 'NURSE', 'LAB_TECH', 'RADIOLOGY_TECH').required(),
});

const updateProviderSchema = Joi.object({
  full_name: Joi.string().min(2).max(100).trim(),
  phone: phone,
  type: Joi.string().valid('DOCTOR', 'NURSE', 'LAB_TECH', 'RADIOLOGY_TECH'),
  is_available: Joi.boolean(),
}).min(1);

// =============================================
// SERVICES
// =============================================
const categorySchema = Joi.object({
  name: Joi.string().min(2).max(100).required().trim(),
  description: Joi.string().max(500).trim().allow('', null),
});

const createServiceSchema = Joi.object({
  name: Joi.string().min(2).max(150).required().trim(),
  description: Joi.string().max(1000).trim().allow('', null),
  price: Joi.number().positive().precision(2).required(),
  category_id: uuid,
  is_vip_exclusive: Joi.boolean().default(false),
});

const updateServiceSchema = Joi.object({
  name: Joi.string().min(2).max(150).trim(),
  description: Joi.string().max(1000).trim().allow('', null),
  price: Joi.number().positive().precision(2),
  category_id: uuid,
  is_vip_exclusive: Joi.boolean(),
  is_active: Joi.boolean(),
}).min(1);

// =============================================
// LAB TESTS
// =============================================
const labReferenceRangePattern = /^-?\d+(?:\.\d+)?\s*[-–]\s*-?\d+(?:\.\d+)?$/;
const labSampleTypeValues = ['serum', 'edta', 'plasma', 'citrate'];
const rangeGenderValues = ['male', 'female', 'any'];

const createLabTestSchema = Joi.object({
  name: Joi.string().min(2).max(150).required().trim(),
  description: Joi.string().max(1000).trim().allow('', null),
  unit: Joi.string().max(50).trim(),
  reference_range: Joi.string().max(200).trim().pattern(labReferenceRangePattern),
  result_type: Joi.string()
    .valid('NUMERIC', 'ORDINAL', 'CATEGORICAL', 'CULTURE')
    .default('NUMERIC'),
  sample_type: Joi.string().valid(...labSampleTypeValues),
  cost: Joi.number().positive().precision(2).required(),
  category_id: uuid,
  is_vip_exclusive: Joi.boolean().default(false),
  requires_fasting: Joi.boolean().default(false),
  requires_gender: Joi.boolean().default(true),
  requires_age: Joi.boolean().default(true),
  requires_cycle_phase: Joi.boolean().default(false),
  requires_pregnancy: Joi.boolean().default(false),
});

const packageWorkflowItemSchema = Joi.object({
  item_type: Joi.string().valid('service', 'test').required(),
  item_id: uuid.required(),
});

function validatePackageContents(value, helpers) {
  const workflowItems = Array.isArray(value.workflow_items) ? value.workflow_items : [];
  const testsCount = workflowItems.length
    ? workflowItems.filter((item) => item?.item_type === 'test').length
    : Array.isArray(value.test_ids) ? value.test_ids.length : 0;
  const servicesCount = workflowItems.length
    ? workflowItems.filter((item) => item?.item_type === 'service').length
    : Array.isArray(value.service_ids) ? value.service_ids.length : 0;

  if (testsCount + servicesCount < 1) {
    return helpers.message('At least one lab test or service is required');
  }

  return value;
}

const createPackageSchema = Joi.object({
  name: Joi.string().min(2).max(150).required().trim(),
  description: Joi.string().max(1000).trim().allow('', null),
  total_cost: Joi.number().positive().precision(2).required(),
  category_id: uuid,
  is_vip_exclusive: Joi.boolean().default(false),
  workflow_items: Joi.array().items(packageWorkflowItemSchema).default([]),
  test_ids: Joi.array().items(uuid).default([]),
  service_ids: Joi.array().items(uuid).default([]),
}).custom(validatePackageContents, 'package contents validation');

const createLabPanelSchema = Joi.object({
  name_en: Joi.string().max(200).required(),
  name_ar: Joi.string().max(200).required(),
  description_en: Joi.string().allow('', null),
  description_ar: Joi.string().allow('', null),
  price: Joi.number().positive().required(),
  sample_types: Joi.string().allow('', null),
  turnaround_hours: Joi.number().integer().positive().allow(null),
  is_active: Joi.boolean().default(true),
  is_vip_exclusive: Joi.boolean().default(false),
  test_ids: Joi.array().items(uuid).min(1).required(),
});

const updateLabPanelSchema = Joi.object({
  name_en: Joi.string().max(200),
  name_ar: Joi.string().max(200),
  description_en: Joi.string().allow('', null),
  description_ar: Joi.string().allow('', null),
  price: Joi.number().positive(),
  sample_types: Joi.string().allow('', null),
  turnaround_hours: Joi.number().integer().positive().allow(null),
  is_active: Joi.boolean(),
  is_vip_exclusive: Joi.boolean(),
  test_ids: Joi.array().items(uuid).min(1),
}).min(1);

const labCatalogWorkflowItemSchema = Joi.object({
  item_type: Joi.string().valid('test', 'panel').required(),
  item_id: uuid.required(),
});

function validateLabPackageContents(value, helpers) {
  const workflowItems = Array.isArray(value.workflow_items) ? value.workflow_items : [];
  const testsCount = workflowItems.length
    ? workflowItems.filter((item) => item?.item_type === 'test').length
    : Array.isArray(value.test_ids) ? value.test_ids.length : 0;
  const panelsCount = workflowItems.length
    ? workflowItems.filter((item) => item?.item_type === 'panel').length
    : Array.isArray(value.panel_ids) ? value.panel_ids.length : 0;

  if (testsCount + panelsCount < 1) {
    return helpers.message('lab package must contain at least one test or panel');
  }

  return value;
}

const createLabPackageSchema = Joi.object({
  name_en: Joi.string().max(200).required(),
  name_ar: Joi.string().max(200).required(),
  description_en: Joi.string().allow('', null),
  description_ar: Joi.string().allow('', null),
  price: Joi.number().positive().required(),
  is_active: Joi.boolean().default(true),
  is_vip_exclusive: Joi.boolean().default(false),
  workflow_items: Joi.array().items(labCatalogWorkflowItemSchema).default([]),
  test_ids: Joi.array().items(uuid).default([]),
  panel_ids: Joi.array().items(uuid).default([]),
}).custom(validateLabPackageContents, 'lab package contents validation');

const updateLabPackageSchema = Joi.object({
  name_en: Joi.string().max(200),
  name_ar: Joi.string().max(200),
  description_en: Joi.string().allow('', null),
  description_ar: Joi.string().allow('', null),
  price: Joi.number().positive(),
  is_active: Joi.boolean(),
  is_vip_exclusive: Joi.boolean(),
  workflow_items: Joi.array().items(labCatalogWorkflowItemSchema),
  test_ids: Joi.array().items(uuid),
  panel_ids: Joi.array().items(uuid),
}).min(1).custom((value, helpers) => {
  const updatesPackageContents = Object.prototype.hasOwnProperty.call(value, 'workflow_items')
    || Object.prototype.hasOwnProperty.call(value, 'test_ids')
    || Object.prototype.hasOwnProperty.call(value, 'panel_ids');

  if (!updatesPackageContents) {
    return value;
  }

  return validateLabPackageContents(value, helpers);
}, 'lab package contents validation');

const rangeFastingStateValues = ['fasting', 'non_fasting'];
const rangeCyclePhaseValues = ['follicular', 'ovulatory', 'luteal', 'postmenopausal'];
const rangeConditionValues = ['pregnant', 'fasting', 'non_fasting', 'luteal', 'follicular', 'postmenopausal'];

function validateRangeShape(value, helpers) {
  const hasLow = Object.prototype.hasOwnProperty.call(value, 'range_low') && value.range_low !== null;
  const hasHigh = Object.prototype.hasOwnProperty.call(value, 'range_high') && value.range_high !== null;
  const hasText = typeof value.range_text === 'string' && value.range_text.trim().length > 0;

  if (Object.prototype.hasOwnProperty.call(value, 'age_min')
    && Object.prototype.hasOwnProperty.call(value, 'age_max')
    && value.age_min > value.age_max) {
    return helpers.message('age_min must be less than or equal to age_max');
  }

  if (hasLow && hasHigh && value.range_low > value.range_high) {
    return helpers.message('range_low must be less than or equal to range_high');
  }

  if (!hasLow && !hasHigh && !hasText) {
    return helpers.message('At least one numeric boundary or range_text is required');
  }

  return value;
}

function validatePartialRangeShape(value, helpers) {
  if (Object.prototype.hasOwnProperty.call(value, 'age_min')
    && Object.prototype.hasOwnProperty.call(value, 'age_max')
    && value.age_min > value.age_max) {
    return helpers.message('age_min must be less than or equal to age_max');
  }

  if (Object.prototype.hasOwnProperty.call(value, 'range_low')
    && value.range_low !== null
    && Object.prototype.hasOwnProperty.call(value, 'range_high')
    && value.range_high !== null
    && value.range_low > value.range_high) {
    return helpers.message('range_low must be less than or equal to range_high');
  }

  const touchesRangeFields = ['range_low', 'range_high', 'range_text']
    .some((field) => Object.prototype.hasOwnProperty.call(value, field));
  const clearsAllRangeFields = touchesRangeFields
    && value.range_low === null
    && value.range_high === null
    && (value.range_text === null || value.range_text === '');

  if (clearsAllRangeFields) {
    return helpers.message('At least one numeric boundary or range_text is required');
  }

  return value;
}

const createRangeSchema = Joi.object({
  gender: Joi.string().trim().lowercase().valid(...rangeGenderValues).default('any'),
  age_min: Joi.number().integer().min(0).default(0),
  age_max: Joi.number().integer().min(0).default(999),
  fasting_state: Joi.string().trim().lowercase()
    .valid(...rangeFastingStateValues).allow(null, '').optional(),
  cycle_phase: Joi.string().trim().lowercase()
    .valid(...rangeCyclePhaseValues).allow(null, '').optional(),
  is_pregnant: Joi.boolean().allow(null).optional(),
  range_low: Joi.number().allow(null),
  range_high: Joi.number().allow(null),
  range_text: Joi.string().max(200).trim().allow('', null),
  unit: Joi.string().max(50).trim().allow('', null),
  notes: Joi.string().max(1000).trim().allow('', null),
  priority: Joi.number().integer().default(0),
}).custom(validateRangeShape, 'range validation');

const updateRangeSchema = Joi.object({
  gender: Joi.string().trim().lowercase().valid(...rangeGenderValues),
  age_min: Joi.number().integer().min(0),
  age_max: Joi.number().integer().min(0),
  fasting_state: Joi.string().trim().lowercase()
    .valid(...rangeFastingStateValues).allow(null, '').optional(),
  cycle_phase: Joi.string().trim().lowercase()
    .valid(...rangeCyclePhaseValues).allow(null, '').optional(),
  is_pregnant: Joi.boolean().allow(null).optional(),
  range_low: Joi.number().allow(null),
  range_high: Joi.number().allow(null),
  range_text: Joi.string().max(200).trim().allow('', null),
  unit: Joi.string().max(50).trim().allow('', null),
  notes: Joi.string().max(1000).trim().allow('', null),
  priority: Joi.number().integer(),
})
  .min(1)
  .custom(validatePartialRangeShape, 'partial range validation');

const bulkImportRangesSchema = Joi.object({
  ranges: Joi.array().min(1).max(500).items(createRangeSchema).required(),
});

const ordinalScaleItemSchema = Joi.object({
  value_text: Joi.string().trim().min(1).max(50).required(),
  numeric_rank: Joi.number().integer().min(0).required(),
  is_normal_max: Joi.boolean().default(false),
});

const replaceOrdinalScaleSchema = Joi.object({
  items: Joi.array().items(ordinalScaleItemSchema).min(1).max(20).required(),
});

const sensitivityEntrySchema = Joi.object({
  antibiotic_name: Joi.string().trim().min(1).max(200).required(),
  mic_value: Joi.string().trim().max(50).allow('', null).optional(),
  interpretation: Joi.string().valid('S', 'I', 'R').required(),
});

const upsertCultureSchema = Joi.object({
  growth_status: Joi.string()
    .valid('NO_GROWTH', 'GROWTH', 'CONTAMINATED', 'PENDING')
    .required(),
  organism_name: Joi.string().trim().max(200).allow('', null).optional(),
  colony_count: Joi.string().trim().max(100).allow('', null).optional(),
  notes: Joi.string().trim().max(2000).allow('', null).optional(),
  sensitivity: Joi.array().items(sensitivityEntrySchema).max(50).default([]),
});

// =============================================
// SERVICE REQUESTS
// =============================================
function validateLabRequestTarget(value, helpers) {
  const serviceType = String(value?.service_type || '').trim().toUpperCase();

  if (serviceType !== 'LAB') {
    return value;
  }

  const targetCount = [value.lab_test_id, value.lab_panel_id, value.lab_package_id]
    .filter((item) => Boolean(item))
    .length;

  if (targetCount !== 1) {
    return helpers.message('Exactly one of lab_test_id, lab_panel_id, or lab_package_id is required for LAB requests');
  }

  return value;
}

const createRequestSchema = Joi.object({
  request_type: Joi.string().valid('PATIENT', 'GUEST').required(),

  // Patient fields
  patient_id: uuid.when('request_type', { is: 'PATIENT', then: Joi.required() }),

  // Guest fields
  guest_name: Joi.string().min(2).max(100).trim()
    .when('request_type', { is: 'GUEST', then: Joi.required() }),
  guest_phone: phone
    .when('request_type', { is: 'GUEST', then: Joi.required() }),
  guest_address: Joi.string().min(5).max(300).trim()
    .when('request_type', { is: 'GUEST', then: Joi.required() }),

  // Service
  service_type: Joi.string().valid('MEDICAL', 'RADIOLOGY', 'LAB', 'PACKAGE').required(),
  service_id: Joi.when('service_type', {
    is: Joi.valid('MEDICAL', 'RADIOLOGY'),
    then: uuid.required(),
    otherwise: uuid.allow(null),
  }),
  lab_test_id: uuid.allow(null),
  lab_panel_id: uuid.allow(null),
  lab_package_id: uuid.allow(null),
  package_id: Joi.when('service_type', {
    is: 'PACKAGE',
    then: uuid.required(),
    otherwise: uuid.allow(null),
  }),

  // Extras
  notes: Joi.string().max(1000).trim().allow('', null),
  requested_at: Joi.date().iso(),
  coupon_code: Joi.string().max(50).uppercase().trim().allow('', null),
  points_to_use: Joi.number().integer().min(0),
}).custom(validateLabRequestTarget, 'LAB request target validation');

const updateStatusSchema = Joi.object({
  status: Joi.string().valid('PENDING', 'ACCEPTED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'CLOSED').required(),
  admin_notes: Joi.string().max(1000).trim().allow('', null),
  scheduled_at: Joi.date().iso(),
});

const updateGuestDemographicsSchema = Joi.object({
  guest_gender: Joi.string().valid('male', 'female', 'other').allow('', null),
  guest_age: Joi.number().integer().min(0).max(130).allow(null),
}).min(1);

const completeWithPaymentSchema = Joi.object({
  collected_amount: Joi.number().positive().precision(3).required(),
  collected_method: Joi.string().valid('CASH', 'TRANSFER').required(),
  collected_notes: Joi.string().max(500).trim().allow('', null),
});

const assignProviderSchema = Joi.object({
  provider_id: uuid.required(),
});

const addLabResultSchema = Joi.object({
  lab_test_id: uuid.required(),
  result: Joi.string().max(500).required().trim(),
  is_normal: Joi.boolean(),
  fasting_state: Joi.string().trim().lowercase()
    .valid(...rangeFastingStateValues).allow(null, '').optional(),
  cycle_phase: Joi.string().trim().lowercase()
    .valid(...rangeCyclePhaseValues).allow(null, '').optional(),
  is_pregnant: Joi.boolean().allow(null).optional(),
  notes: Joi.string().max(1000).trim().allow('', null),
});
const labResultSchema = addLabResultSchema;

const bulkAddLabResultsSchema = Joi.object({
  results: Joi.array().items(labResultSchema).min(1).unique('lab_test_id').required(),
});

const updateLabResultSchema = Joi.object({
  result: Joi.string().max(500).trim(),
  is_normal: Joi.boolean(),
  condition: Joi.string().valid(...rangeConditionValues).allow('', null),
  notes: Joi.string().max(1000).trim().allow('', null),
}).min(1);

const requestWorkflowTaskAssignSchema = Joi.object({
  provider_id: uuid.required(),
  task_type: Joi.string().valid('MEDICAL', 'LAB', 'RADIOLOGY', 'NURSING', 'FINAL_REPORT').required(),
  role: Joi.string().valid('LEAD_DOCTOR', 'ASSISTANT').default('ASSISTANT'),
  scheduled_at: Joi.date().iso().allow(null),
  notes: Joi.string().max(1000).trim().allow('', null),
});

const requestWorkflowTaskUpdateSchema = Joi.object({
  status: Joi.string().valid('SUBMITTED', 'COMPLETED').optional(),
  notes: Joi.string().max(1000).trim().allow('', null),
});

const requestWorkflowStageUpdateSchema = Joi.object({
  stage: Joi.string().valid('IN_PROGRESS', 'WAITING_SUB_REPORTS', 'DOCTOR_REVIEW', 'COMPLETED', 'PUBLISHED').optional(),
  notes: Joi.string().max(2000).trim().allow('', null),
});

const requestAdditionalOrderSchema = Joi.object({
  order_type: Joi.string().valid('LAB', 'RADIOLOGY', 'NURSING', 'MEDICAL').required(),
  ordered_by_provider_id: uuid,
  service_id: uuid.allow(null, ''),
  lab_test_id: uuid.allow(null, ''),
  description: Joi.string().min(2).max(2000).required().trim(),
  priority: Joi.string().valid('LOW', 'NORMAL', 'HIGH', 'URGENT').default('NORMAL'),
  additional_cost: Joi.number().min(0).default(0),
  notes: Joi.string().max(1000).trim().allow('', null),
});

const requestProviderReportSchema = Joi.object({
  provider_id: uuid,
  task_id: uuid.allow(null, ''),
  report_type: Joi.string().valid('SUB_REPORT', 'FINAL_REPORT').required(),
  status: Joi.string().valid('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'),
  symptoms_summary: Joi.string().max(5000).trim().allow('', null),
  procedures_performed: Joi.string().max(5000).trim().allow('', null),
  procedures_done: Joi.string().max(5000).trim().allow('', null),
  allergies_noted: Joi.string().max(5000).trim().allow('', null),
  patient_allergies: Joi.string().max(5000).trim().allow('', null),
  findings: Joi.string().max(5000).trim().allow('', null),
  diagnosis: Joi.string().max(5000).trim().allow('', null),
  recommendations: Joi.string().max(5000).trim().allow('', null),
  treatment_plan: Joi.string().max(5000).trim().allow('', null),
  lab_notes: Joi.string().max(5000).trim().allow('', null),
  imaging_notes: Joi.string().max(5000).trim().allow('', null),
  image_url: Joi.string().trim().allow('', null),
  pdf_report_url: Joi.string().trim().allow('', null),
  nurse_notes: Joi.string().max(5000).trim().allow('', null),
  notes: Joi.string().max(5000).trim().allow('', null),
});

const requestFinalReportConfirmSchema = Joi.object({
  notes: Joi.string().max(2000).trim().allow('', null),
});

const closeRequestSchema = Joi.object({
  admin_close_notes: Joi.string().max(1000).trim().allow('', null),
});

const updateReportSnapshotSchema = Joi.object({
  snapshot: Joi.object().required(),
});

const recordPaymentSchema = Joi.object({
  amount: Joi.number().positive().precision(3).required(),
  method: Joi.string().valid('CASH', 'CARD', 'TRANSFER', 'OTHER').required(),
  notes: Joi.string().max(500).trim().allow('', null),
});

const requestIdParamSchema = Joi.object({
  id: uuid.required(),
});

const requestTaskParamsSchema = Joi.object({
  id: uuid.required(),
  taskId: uuid.required(),
});

const requestResultParamsSchema = Joi.object({
  id: uuid.required(),
  resultId: uuid.required(),
});

const requestChatRoomTypeParamsSchema = Joi.object({
  id: uuid.required(),
  roomType: Joi.string().valid('CARE_TEAM', 'PATIENT_CARE', 'DOCTOR_ADMIN', 'PROVIDER_PATIENT').required(),
});

const requestChatRoomIdParamsSchema = Joi.object({
  id: uuid.required(),
  roomId: uuid.required(),
});

const requestPaymentApprovalParamsSchema = Joi.object({
  id: uuid.required(),
  paymentId: uuid.required(),
});

const requestLifecycleQuerySchema = Joi.object({
  ...pagination,
});

const requestChatMessagesQuerySchema = Joi.object({
  ...pagination,
});

const requestChatMessageSchema = Joi.object({
  body: Joi.string().max(5000).trim().allow('', null),
});

const rateRequestSchema = Joi.object({
  rating: Joi.number().integer().min(1).max(5).required(),
  comment: Joi.string().max(1000).trim().allow('', null),
});

const rateEntitySchema = Joi.object({
  rating: Joi.number().integer().min(1).max(5).required(),
  comment: Joi.string().max(1000).trim().allow('', null),
});

// =============================================
// CHAT
// =============================================
const createConversationSchema = Joi.object({
  participant_id: uuid,
  participant_role: Joi.string().valid('ADMIN', 'PROVIDER'),
  patient_id: uuid,
}).xor('patient_id', 'participant_id')
  .with('participant_id', 'participant_role')
  .with('participant_role', 'participant_id');

const chatMessagesQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(500).default(20),
});

const createChatMessageSchema = Joi.object({
  body: Joi.string().max(5000).trim().allow('', null),
});

// =============================================
// COUPONS
// =============================================
const createCouponSchema = Joi.object({
  code: Joi.string().min(3).max(50).uppercase().trim().required(),
  discount_type: Joi.string().valid('PERCENTAGE', 'FIXED').required(),
  discount_value: Joi.number().positive().precision(3).required()
    .when('discount_type', {
      is: 'PERCENTAGE',
      then: Joi.number().max(100),
    }),
  min_order_amount: Joi.number().min(0).precision(3).default(0),
  max_uses: Joi.number().integer().min(1).default(1),
  expires_at: Joi.date().iso().greater('now'),
});

// =============================================
// INVOICES
// =============================================
const payInvoiceSchema = Joi.object({
  payment_method: Joi.string().valid('CASH', 'CARD', 'INSURANCE', 'CLICK', 'OTHER').required(),
});

const validateCouponSchema = Joi.object({
  code: Joi.string().min(3).max(50).uppercase().trim().required(),
  order_amount: Joi.number().min(0).precision(3).required(),
});

// =============================================
// QUERY PARAMS
// =============================================
const paginationSchema = Joi.object({
  ...pagination,
  search: Joi.string().max(100).trim(),
});

const requestsQuerySchema = Joi.object({
  ...pagination,
  status: Joi.string().valid('PENDING', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'CLOSED'),
  patient_id: uuid,
});

const requestsListQuerySchema = requestsQuerySchema
  .fork(['status'], (schema) => schema.allow('', null))
  .keys({
    search: Joi.string().max(100).trim().allow('', null),
  });

const providerRatingsQuerySchema = Joi.object({
  ...pagination,
});

module.exports = {
  loginSchema,
  registerSchema,
  refreshTokenSchema,
  changePasswordSchema,
  patientMedicalSchema,
  patientProfileSchema,
  patientHistorySchema,
  vipSchema,
  createProviderSchema,
  updateProviderSchema,
  categorySchema,
  createServiceSchema,
  updateServiceSchema,
  createLabTestSchema,
  createPackageSchema,
  createLabPanelSchema,
  updateLabPanelSchema,
  createLabPackageSchema,
  updateLabPackageSchema,
  createRangeSchema,
  updateRangeSchema,
  bulkImportRangesSchema,
  ordinalScaleItemSchema,
  replaceOrdinalScaleSchema,
  sensitivityEntrySchema,
  upsertCultureSchema,
  createRequestSchema,
  updateStatusSchema,
  updateGuestDemographicsSchema,
  completeWithPaymentSchema,
  assignProviderSchema,
  addLabResultSchema,
  bulkAddLabResultsSchema,
  updateLabResultSchema,
  requestWorkflowTaskAssignSchema,
  requestWorkflowTaskUpdateSchema,
  requestWorkflowStageUpdateSchema,
  requestAdditionalOrderSchema,
  requestProviderReportSchema,
  requestFinalReportConfirmSchema,
  closeRequestSchema,
  updateReportSnapshotSchema,
  recordPaymentSchema,
  requestIdParamSchema,
  requestTaskParamsSchema,
  requestResultParamsSchema,
  requestChatRoomTypeParamsSchema,
  requestChatRoomIdParamsSchema,
  requestPaymentApprovalParamsSchema,
  requestLifecycleQuerySchema,
  requestChatMessagesQuerySchema,
  requestChatMessageSchema,
  labResultSchema,
  rateRequestSchema,
  rateEntitySchema,
  createConversationSchema,
  chatMessagesQuerySchema,
  createChatMessageSchema,
  createCouponSchema,
  payInvoiceSchema,
  validateCouponSchema,
  paginationSchema,
  requestsQuerySchema,
  requestsListQuerySchema,
  providerRatingsQuerySchema,
};
