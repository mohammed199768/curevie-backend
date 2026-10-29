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
  limit: Joi.number().integer().min(1).max(100).default(10),
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
  area_id: uuid.allow(null),
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
  area_id: uuid.allow(null),
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
  area_ids: Joi.array().items(uuid).max(100).unique().default([]),
});

const updateProviderSchema = Joi.object({
  full_name: Joi.string().min(2).max(100).trim(),
  phone: phone,
  type: Joi.string().valid('DOCTOR', 'NURSE', 'LAB_TECH', 'RADIOLOGY_TECH'),
  is_active: Joi.boolean(),
  is_available: Joi.boolean(),
  area_ids: Joi.array().items(uuid).max(100).unique(),
}).min(1);

const providerAvailabilitySchema = Joi.object({
  is_available: Joi.boolean().required(),
});

const providerListQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  search: Joi.string().max(100).trim().allow(''),
  type: Joi.string().valid('DOCTOR', 'NURSE', 'LAB_TECH', 'RADIOLOGY_TECH'),
  is_active: Joi.boolean(),
  is_available: Joi.boolean(),
  area_id: uuid,
});

// =============================================
// SERVICES
// =============================================
const categorySchema = Joi.object({
  name: Joi.string().min(2).max(100).required().trim(),
  description: Joi.string().max(500).trim().allow('', null),
});

// Provider share of a catalog item: PERCENT of the line price or a FIXED amount; both null = default share.
const providerShareFields = {
  provider_share_type: Joi.string().valid('PERCENT', 'FIXED').allow(null),
  provider_share_value: Joi.number().min(0).precision(3).allow(null)
    .when('provider_share_type', { is: 'PERCENT', then: Joi.number().max(100) }),
};
const withProviderShare = (schema) => schema.custom((value, helpers) => {
  const hasType = value.provider_share_type !== undefined && value.provider_share_type !== null;
  const hasValue = value.provider_share_value !== undefined && value.provider_share_value !== null;
  const touched = 'provider_share_type' in value || 'provider_share_value' in value;
  if (touched && hasType !== hasValue) {
    return helpers.message('provider_share_type and provider_share_value must be set (or cleared) together');
  }
  return value;
});

const createServiceSchema = withProviderShare(Joi.object({
  name: Joi.string().min(2).max(150).required().trim(),
  name_ar: Joi.string().trim().max(200).allow('', null).optional(),
  name_en: Joi.string().trim().max(200).allow('', null).optional(),
  description: Joi.string().max(1000).trim().allow('', null),
  description_ar: Joi.string().trim().allow('', null).optional(),
  description_en: Joi.string().trim().allow('', null).optional(),
  price: Joi.number().positive().precision(3).required(),
  service_kind: Joi.string().valid('MEDICAL', 'NURSING', 'RADIOLOGY', 'LAB').default('MEDICAL'),
  category_id: uuid,
  is_vip_exclusive: Joi.boolean().default(false),
  ...providerShareFields,
}));

const updateServiceSchema = withProviderShare(Joi.object({
  name: Joi.string().min(2).max(150).trim(),
  name_ar: Joi.string().trim().max(200).allow('', null).optional(),
  name_en: Joi.string().trim().max(200).allow('', null).optional(),
  description: Joi.string().max(1000).trim().allow('', null),
  description_ar: Joi.string().trim().allow('', null).optional(),
  description_en: Joi.string().trim().allow('', null).optional(),
  price: Joi.number().positive().precision(3),
  service_kind: Joi.string().valid('MEDICAL', 'NURSING', 'RADIOLOGY', 'LAB'),
  category_id: uuid,
  is_vip_exclusive: Joi.boolean(),
  is_active: Joi.boolean(),
  ...providerShareFields,
}).min(1));

// =============================================
// PACKAGES (bundles of services, incl. lab)
// =============================================
const packageFields = {
  name: Joi.string().min(2).max(150).trim(),
  name_ar: Joi.string().trim().max(200).allow('', null),
  name_en: Joi.string().trim().max(200).allow('', null),
  description: Joi.string().max(2000).trim().allow('', null),
  description_ar: Joi.string().trim().max(2000).allow('', null),
  description_en: Joi.string().trim().max(2000).allow('', null),
  total_cost: Joi.number().positive().precision(3),
  category_id: uuid.allow(null),
  is_vip_exclusive: Joi.boolean(),
  // Ordered list of the services in the bundle.
  service_ids: Joi.array().items(uuid).min(1).max(50).unique(),
  ...providerShareFields,
};

const createPackageSchema = withProviderShare(Joi.object({
  ...packageFields,
  name: packageFields.name.required(),
  total_cost: packageFields.total_cost.required(),
  service_ids: packageFields.service_ids.required(),
  is_vip_exclusive: packageFields.is_vip_exclusive.default(false),
}));

const updatePackageSchema = withProviderShare(Joi.object({
  ...packageFields,
  is_active: Joi.boolean(),
}).min(1));

// =============================================
// QUERY PARAMS
// =============================================
const paginationSchema = Joi.object({
  ...pagination,
  search: Joi.string().max(100).trim(),
});

const providerRatingsQuerySchema = Joi.object({
  ...pagination,
});

module.exports = {
  loginSchema,
  registerSchema,
  changePasswordSchema,
  patientMedicalSchema,
  patientProfileSchema,
  patientHistorySchema,
  vipSchema,
  createProviderSchema,
  updateProviderSchema,
  providerAvailabilitySchema,
  providerListQuerySchema,
  categorySchema,
  createServiceSchema,
  updateServiceSchema,
  createPackageSchema,
  updatePackageSchema,
  paginationSchema,
  providerRatingsQuerySchema,
};
