/**
 * Provider earnings (mounted under /api/v1/earnings).
 *
 *   GET   /me                 the provider's own earnings, totals and recent payouts
 *   GET   /                   earnings list (admin), filter by provider / status / dates
 *   GET   /balances           pending and paid totals per provider (admin)
 *   GET   /payouts            payouts (admin), optionally for one provider
 *   POST  /payouts            pay out a provider's pending earnings (admin)
 *   PATCH /:id                correct a pending earning with a reason (admin)
 */
const express = require('express');
const Joi = require('joi');
const asyncHandler = require('../../utils/asyncHandler');
const validate = require('../../middlewares/validate');
const { authenticate, adminOnly, requireRole } = require('../../middlewares/auth');
const { apiLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const { paginationMeta } = require('../../utils/pagination');
const { audit } = require('../../utils/logger');
const { t } = require('../../utils/i18n/ar');
const notificationService = require('../notifications/notification.service');
const { emitToUser } = require('../../utils/socket');
const earnings = require('./earnings.service');

const router = express.Router();
const uuid = Joi.string().uuid();

const listQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  status: Joi.string().valid('PENDING', 'PAID'),
  provider_id: uuid,
  from: Joi.date().iso(),
  to: Joi.date().iso(),
});
const payoutSchema = Joi.object({
  provider_id: uuid.required(),
  earning_ids: Joi.array().items(uuid).max(500).unique(),
  method: Joi.string().valid('CASH', 'BANK_TRANSFER', 'CLICK', 'OTHER').required(),
  reference: Joi.string().trim().max(120).allow('', null),
  notes: Joi.string().trim().max(500).allow('', null),
});
const adjustSchema = Joi.object({
  amount: Joi.number().min(0).precision(3).max(1000000).required(),
  reason: Joi.string().trim().min(3).max(500).required(),
});

router.get('/me', authenticate, requireRole('PROVIDER'), readLimiter, validate(listQuery, 'query'), asyncHandler(async (req, res) => {
  const { page, limit, status, from, to } = req.query;
  const [result, payouts] = await Promise.all([
    earnings.listEarnings({ providerId: req.user.id, status, from, to }, { page, limit }),
    earnings.listPayouts({ providerId: req.user.id, limit: 20 }),
  ]);
  return res.json({
    data: result.data,
    summary: result.summary,
    payouts: payouts.map(({ created_by: _admin, created_by_name: _name, ...payout }) => payout),
    pagination: paginationMeta(result.total, page, limit),
  });
}));

router.get('/', authenticate, adminOnly, readLimiter, validate(listQuery, 'query'), asyncHandler(async (req, res) => {
  const { page, limit, status, provider_id: providerId, from, to } = req.query;
  const result = await earnings.listEarnings({ providerId, status, from, to }, { page, limit });
  return res.json({ data: result.data, summary: result.summary, pagination: paginationMeta(result.total, page, limit) });
}));

router.get('/balances', authenticate, adminOnly, readLimiter, asyncHandler(async (req, res) => (
  res.json({ data: await earnings.providerBalances() })
)));

router.get(
  '/payouts',
  authenticate,
  adminOnly,
  readLimiter,
  validate(Joi.object({ provider_id: uuid }), 'query'),
  asyncHandler(async (req, res) => res.json({ data: await earnings.listPayouts({ providerId: req.query.provider_id }) }))
);

router.post('/payouts', authenticate, adminOnly, apiLimiter, validate(payoutSchema), asyncHandler(async (req, res) => {
  const result = await earnings.createPayout(req.user, req.body);
  const amount = Number(result.payout.amount).toFixed(3);
  audit('PROVIDER_PAYOUT_CREATED', {
    userId: req.user.id, role: req.user.role, targetId: req.body.provider_id, targetType: 'provider', ip: req.ip,
    details: { amount, earnings: result.earnings_count, method: req.body.method },
  });
  notificationService.notifySafely('earnings_paid', () => notificationService.createNotification({
    userId: req.body.provider_id,
    userRole: 'PROVIDER',
    type: notificationService.NOTIF_TYPES.EARNINGS_PAID,
    title: t('notifications.earnings.paid_title'),
    body: t('notifications.earnings.paid_body', { amount, count: result.earnings_count }),
    data: { payout_id: result.payout.id },
  }));
  emitToUser(req.body.provider_id, 'earnings:updated', { payout_id: result.payout.id });
  return res.status(201).json({ data: result });
}));

router.patch(
  '/:id',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(Joi.object({ id: uuid.required() }), 'params'),
  validate(adjustSchema),
  asyncHandler(async (req, res) => {
    const row = await earnings.adjustEarning(req.user, req.params.id, req.body);
    audit('PROVIDER_EARNING_ADJUSTED', {
      userId: req.user.id, role: req.user.role, targetId: req.params.id, targetType: 'provider_earning', ip: req.ip,
      details: { amount: req.body.amount, reason: req.body.reason },
    });
    emitToUser(row.provider_id, 'earnings:updated', { earning_id: row.id });
    return res.json({ data: row });
  })
);

module.exports = router;
