const Joi = require('joi');
const { ITEM_TYPES, MAX_ITEMS_PER_CASE, CASE_STATUS, SERVICE_STATUS } = require('./case.constants');

const uuid = Joi.string().uuid();
const phone = Joi.string().trim().pattern(/^[0-9+\-\s()]{7,20}$/).messages({
  'string.pattern.base': 'Invalid phone number format',
});

const itemSchema = Joi.object({
  type: Joi.string().valid(...ITEM_TYPES).required(),
  id: uuid.required(),
  notes: Joi.string().trim().max(500).allow('', null),
});

// Prices are never accepted from clients: unknown keys (original_price, bundle_price...) are stripped.
const orderFields = {
  items: Joi.array().items(itemSchema).min(1).max(MAX_ITEMS_PER_CASE).required()
    .unique((a, b) => a.type === b.type && a.id === b.id)
    .messages({ 'array.unique': 'Each item can only be ordered once per request' }),
  area_id: uuid.required(),
  address: Joi.string().trim().min(3).max(500),
  scheduled_for: Joi.date().iso().greater('now').allow(null),
  notes: Joi.string().trim().max(2000).allow('', null),
};

const createCaseSchema = Joi.object(orderFields);

const createGuestCaseSchema = Joi.object({
  ...orderFields,
  address: orderFields.address.required(),
  guest_name: Joi.string().trim().min(2).max(100).required(),
  guest_phone: phone.required(),
});

const listCasesQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(10),
  status: Joi.string().pattern(new RegExp(`^(${Object.values(CASE_STATUS).join('|')})(,(${Object.values(CASE_STATUS).join('|')}))*$`)),
  service_status: Joi.string().valid(...Object.values(SERVICE_STATUS)),
  patient_id: uuid,
  area_id: uuid,
  unassigned: Joi.boolean(),
  search: Joi.string().trim().max(100).allow(''),
  from: Joi.date().iso(),
  to: Joi.date().iso(),
});

const caseIdParams = Joi.object({ id: uuid.required() });
const caseServiceParams = Joi.object({ id: uuid.required(), serviceId: uuid.required() });
const caseFileParams = Joi.object({ id: uuid.required(), fileId: uuid.required() });
const trackingParams = Joi.object({ token: Joi.string().pattern(/^[A-Za-z0-9_-]{20,64}$/).required() });

const assignTeamSchema = Joi.object({
  assignments: Joi.array().items(Joi.object({
    case_service_id: uuid.required(),
    provider_id: uuid.required(),
  })).max(20).default([]),
  lead_provider_id: uuid.allow(null),
}).custom((value, helpers) => (
  value.assignments.length || value.lead_provider_id !== undefined
    ? value
    : helpers.message('Provide at least one assignment or a lead_provider_id')
));

const candidatesQuerySchema = Joi.object({
  include_all: Joi.boolean().default(false),
});

const appointmentSchema = Joi.object({
  case_service_id: uuid.required(),
  scheduled_at: Joi.date().iso().required(),
  type: Joi.string().valid('INITIAL', 'FOLLOW_UP').default('INITIAL'),
  notes: Joi.string().trim().max(1000).allow('', null),
});

const reasonSchema = Joi.object({
  reason: Joi.string().trim().max(500).allow('', null),
});

const rejectSchema = Joi.object({
  reason: Joi.string().trim().min(2).max(500).required(),
});

const closeCaseSchema = Joi.object({
  notes: Joi.string().trim().max(2000).allow('', null),
});

const rateSchema = Joi.object({
  rating: Joi.number().integer().min(1).max(5).required(),
  comment: Joi.string().trim().max(1000).allow('', null),
});

const claimSchema = Joi.object({
  tracking_token: Joi.string().pattern(/^[A-Za-z0-9_-]{20,64}$/).required(),
});

const uploadFileFieldsSchema = Joi.object({
  is_sick_leave: Joi.boolean().default(false),
});

const chatRoomParams = Joi.object({ room_id: uuid.required() });
const chatMessageFileParams = Joi.object({ room_id: uuid.required(), message_id: uuid.required() });
const chatMessagesQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(50),
  before: Joi.date().iso(),
});
const chatMessageSchema = Joi.object({
  content: Joi.string().trim().max(4000).allow(''),
});
const chatRoomsQuerySchema = Joi.object({
  case_id: uuid,
});

module.exports = {
  createCaseSchema,
  createGuestCaseSchema,
  listCasesQuerySchema,
  caseIdParams,
  caseServiceParams,
  caseFileParams,
  trackingParams,
  assignTeamSchema,
  candidatesQuerySchema,
  appointmentSchema,
  reasonSchema,
  rejectSchema,
  closeCaseSchema,
  rateSchema,
  claimSchema,
  uploadFileFieldsSchema,
  chatRoomParams,
  chatMessageFileParams,
  chatMessagesQuerySchema,
  chatMessageSchema,
  chatRoomsQuerySchema,
};
