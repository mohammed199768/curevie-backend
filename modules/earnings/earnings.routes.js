/**
 * Provider earnings (mounted under /api/v1/earnings).
 *
 *   GET   /me                 the provider's own earnings, totals and recent payouts
 *   GET   /                   earnings list (admin), filter by provider / status / dates
 *   GET   /balances           pending and paid totals per provider (admin)
 *   GET   /payouts            payouts (admin), optionally for one provider
 *   POST  /payouts            pay out a provider's pending earnings (admin)
 *   PATCH /:id                correct a pending earning with a reason (admin)
 *   GET   /expenses           provider expenses (admin), filter by provider / status
 *   GET   /expenses/me        the provider's own expenses
 *   PATCH /expenses/:id       approve or reject a pending expense (admin)
 *   GET   /expenses/:id/receipt  the receipt (admin or the provider who sent it)
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
const { readStoredFile, mimeTypeForKey, sendFile } = require('../../utils/storage');
const { AppError } = require('../../middlewares/errorHandler');
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
  expense_ids: Joi.array().items(uuid).max(500).unique(),
  method: Joi.string().valid('CASH', 'BANK_TRANSFER', 'CLICK', 'OTHER').required(),
  reference: Joi.string().trim().max(120).allow('', null),
  notes: Joi.string().trim().max(500).allow('', null),
});
const expensesQuery = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  status: Joi.string().valid('PENDING', 'APPROVED', 'REJECTED', 'PAID'),
  provider_id: uuid,
});
const reviewExpenseSchema = Joi.object({
  action: Joi.string().valid('approve', 'reject').required(),
  reason: Joi.string().trim().max(500).allow('', null)
    .when('action', { is: 'reject', then: Joi.string().trim().min(3).required() }),
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

router.get('/expenses', authenticate, adminOnly, readLimiter, validate(expensesQuery, 'query'), asyncHandler(async (req, res) => {
  const { page, limit, status, provider_id: providerId } = req.query;
  const result = await earnings.listExpenses({ providerId, status }, { limit, offset: (page - 1) * limit });
  return res.json({ data: result.data, summary: result.summary, pagination: paginationMeta(result.total, page, limit) });
}));

router.get('/expenses/me', authenticate, requireRole('PROVIDER'), readLimiter, validate(expensesQuery, 'query'), asyncHandler(async (req, res) => {
  const { page, limit, status } = req.query;
  const result = await earnings.listExpenses({ providerId: req.user.id, status }, { limit, offset: (page - 1) * limit });
  return res.json({ data: result.data, summary: result.summary, pagination: paginationMeta(result.total, page, limit) });
}));

router.get(
  '/expenses/:id/receipt',
  authenticate,
  requireRole('ADMIN', 'PROVIDER'),
  readLimiter,
  validate(Joi.object({ id: uuid.required() }), 'params'),
  asyncHandler(async (req, res) => {
    const receipt = await earnings.getExpenseReceipt(req.params.id);
    if (!receipt || (req.user.role === 'PROVIDER' && receipt.provider_id !== req.user.id)) {
      throw new AppError('Expense not found', 404, 'NOT_FOUND');
    }
    const buffer = await readStoredFile(receipt.receipt_file_key).catch(() => {
      throw new AppError('File is not available', 404, 'FILE_NOT_FOUND');
    });
    return sendFile(res, buffer, {
      fileName: receipt.receipt_file_name || 'receipt',
      mimeType: receipt.receipt_mime || mimeTypeForKey(receipt.receipt_file_key),
      inline: req.query.inline === 'true',
    });
  })
);

router.patch(
  '/expenses/:id',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(Joi.object({ id: uuid.required() }), 'params'),
  validate(reviewExpenseSchema),
  asyncHandler(async (req, res) => {
    const expense = await earnings.reviewExpense(req.user, req.params.id, req.body);
    audit('PROVIDER_EXPENSE_REVIEWED', {
      userId: req.user.id, role: req.user.role, targetId: req.params.id, targetType: 'provider_expense', ip: req.ip,
      details: { action: req.body.action, amount: expense.amount },
    });
    const approved = expense.status === 'APPROVED';
    notificationService.notifySafely('expense_reviewed', () => notificationService.createNotification({
      userId: expense.provider_id,
      userRole: 'PROVIDER',
      type: notificationService.NOTIF_TYPES.CASE_UPDATED,
      title: t(approved ? 'notifications.expenses.approved_title' : 'notifications.expenses.rejected_title'),
      body: t(approved ? 'notifications.expenses.approved_body' : 'notifications.expenses.rejected_body', {
        amount: expense.amount.toFixed(3),
        reason: expense.review_reason || '',
      }),
      data: { case_id: expense.case_id, expense_id: expense.id },
    }));
    emitToUser(expense.provider_id, 'earnings:updated', { expense_id: expense.id });
    return res.json({ data: expense });
  })
);

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
    body: t('notifications.earnings.paid_body', { amount, count: result.earnings_count + result.expenses_count }),
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
