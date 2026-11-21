/**
 * Provider expenses on an order (mounted under /api/v1/cases). Review and reimbursement live in
 * modules/earnings (GET/PATCH /earnings/expenses...). Patients never see expenses.
 *
 *   POST /:id/expenses   provider on the order: receipt (image/PDF) + amount + description
 *   GET  /:id/expenses   admin: all on the order; provider: their own
 */
const express = require('express');
const Joi = require('joi');
const { authenticate, providerOnly, requireRole } = require('../../middlewares/auth');
const { apiLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const validate = require('../../middlewares/validate');
const { AppError } = require('../../middlewares/errorHandler');
const asyncHandler = require('../../utils/asyncHandler');
const { uploadCaseFile } = require('../../utils/upload');
const { savePrivateFile, deleteStoredFile } = require('../../utils/storage');
const { t } = require('../../utils/i18n/ar');
const notificationService = require('../notifications/notification.service');
const earnings = require('../earnings/earnings.service');
const schemas = require('./case.schemas');

const router = express.Router();
const { NOTIF_TYPES, notifySafely } = notificationService;

const expenseFieldsSchema = Joi.object({
  amount: Joi.number().positive().max(100000).precision(3).required(),
  description: Joi.string().trim().min(2).max(1000).required(),
});

router.post(
  '/:id/expenses',
  authenticate,
  providerOnly,
  apiLimiter,
  validate(schemas.caseIdParams, 'params'),
  ...uploadCaseFile,
  validate(expenseFieldsSchema),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError('A photo or PDF of the receipt is required', 400, 'NO_FILE');
    const key = await savePrivateFile(req.file.buffer, { folder: 'expense-receipts', mimeType: req.file.mimetype });
    let expense;
    try {
      expense = await earnings.createExpense(req.user, req.params.id, req.body, {
        key,
        name: String(req.file.originalname || '').slice(0, 255),
        mime: req.file.mimetype,
      });
    } catch (err) {
      await deleteStoredFile(key).catch(() => {});
      throw err;
    }

    notifySafely('expense_submitted', () => notificationService.notifyAdmins({
      type: NOTIF_TYPES.CASE_UPDATED,
      title: t('notifications.expenses.submitted_admin_title'),
      body: t('notifications.expenses.submitted_admin_body', {
        provider: expense.provider_name,
        amount: expense.amount.toFixed(3),
        caseRef: `#${expense.case_reference_number}`,
      }),
      data: { case_id: req.params.id, expense_id: expense.id },
    }));
    return res.status(201).json({ data: expense });
  })
);

router.get(
  '/:id/expenses',
  authenticate,
  requireRole('ADMIN', 'PROVIDER'),
  readLimiter,
  validate(schemas.caseIdParams, 'params'),
  asyncHandler(async (req, res) => {
    const result = await earnings.listExpenses({
      caseId: req.params.id,
      providerId: req.user.role === 'PROVIDER' ? req.user.id : undefined,
    }, { limit: 100, offset: 0 });
    return res.json({ data: result.data, summary: result.summary });
  })
);

module.exports = router;
