/**
 * Admin-editable settings (mounted under /api/v1/settings).
 *
 *   GET /public      what the patient site needs (CliQ details when CliQ is enabled)
 *   GET /            every setting (admin)
 *   PUT /:key        replace one setting (admin), validated per key
 */
const express = require('express');
const Joi = require('joi');
const pool = require('../../config/db');
const SettingsRepository = require('../../repositories/SettingsRepository');
const cache = require('../../utils/cache');
const asyncHandler = require('../../utils/asyncHandler');
const validate = require('../../middlewares/validate');
const { authenticate, adminOnly } = require('../../middlewares/auth');
const { apiLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const { AppError } = require('../../middlewares/errorHandler');
const { audit } = require('../../utils/logger');

const router = express.Router();
const settingsRepo = new SettingsRepository(pool);
const PUBLIC_CACHE_KEY = 'settings:public';

const SETTING_SCHEMAS = {
  'payments.cliq': Joi.object({
    enabled: Joi.boolean().required(),
    alias: Joi.string().trim().max(50).allow('').required(),
    beneficiary_name: Joi.string().trim().max(120).allow('').required(),
    bank_name: Joi.string().trim().max(120).allow('').default(''),
    note: Joi.string().trim().max(300).allow('').default(''),
  }).custom((value, helpers) => (
    value.enabled && !value.alias ? helpers.message('alias is required while CliQ is enabled') : value
  )),
  'earnings.default_share': Joi.object({
    type: Joi.string().valid('PERCENT', 'FIXED').required(),
    value: Joi.number().min(0).precision(3).required()
      .when('type', { is: 'PERCENT', then: Joi.number().max(100) }),
  }),
};

const keyParams = Joi.object({ key: Joi.string().valid(...Object.keys(SETTING_SCHEMAS)).required() });

router.get('/public', readLimiter, asyncHandler(async (req, res) => {
  const cached = await cache.get(PUBLIC_CACHE_KEY);
  if (cached) return res.json(cached);

  const cliq = await settingsRepo.get('payments.cliq');
  // CliQ is only offered once it is switched on and has an alias to transfer to.
  const response = {
    data: {
      cliq: cliq?.enabled && cliq.alias
        ? { alias: cliq.alias, beneficiary_name: cliq.beneficiary_name, bank_name: cliq.bank_name, note: cliq.note }
        : null,
    },
  };
  await cache.set(PUBLIC_CACHE_KEY, response, 60);
  return res.json(response);
}));

router.get('/', authenticate, adminOnly, readLimiter, asyncHandler(async (req, res) => {
  const rows = await settingsRepo.getAll();
  return res.json({ data: Object.fromEntries(rows.map((row) => [row.key, row.value])) });
}));

router.put(
  '/:key',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(keyParams, 'params'),
  asyncHandler(async (req, res) => {
    const { error, value } = SETTING_SCHEMAS[req.params.key].validate(req.body, { stripUnknown: true });
    if (error) throw new AppError(error.message, 400, 'VALIDATION_ERROR');

    const saved = await settingsRepo.set(req.params.key, value, req.user.id);
    await cache.del(PUBLIC_CACHE_KEY);
    audit('SETTING_UPDATED', { userId: req.user.id, role: req.user.role, targetId: req.params.key, targetType: 'setting', ip: req.ip });
    return res.json({ data: saved });
  })
);

module.exports = router;
module.exports.settingsRepo = settingsRepo;
