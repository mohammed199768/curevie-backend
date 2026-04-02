const express = require('express');
const Joi = require('joi');
const { authenticate, adminOnly, staffOnly } = require('../../middlewares/auth');
const { apiLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const asyncHandler = require('../../utils/asyncHandler');
const { logger, audit } = require('../../utils/logger');
const pool = require('../../config/db');
const NotificationRepository = require('../../repositories/NotificationRepository');
const PaymentRepository = require('../../repositories/PaymentRepository');
const InvoiceRepository = require('../../repositories/InvoiceRepository');
const { createNotificationService } = require('../notifications/notification.service');
const paymentServiceModule = require('./payment.service'); // AUDIT-FIX: P3-STEP8-DIP - payment routes now configure the service singleton explicitly.
const { createInvoiceService } = require('../invoices/invoice.service');

const notifService = createNotificationService(new NotificationRepository(pool));
paymentServiceModule.configurePaymentService(new PaymentRepository(pool)); // AUDIT-FIX: P3-STEP8-DIP - route-level composition now wires the backward-compatible payment singleton explicitly.
const paymentService = paymentServiceModule; // AUDIT-FIX: P3-STEP8-COMPAT - keep the existing local service variable shape for route handlers.
const invoiceService = createInvoiceService(new InvoiceRepository(pool));

const router = express.Router();

const addPaymentSchema = Joi.object({
  amount: Joi.number().positive().precision(3).required(),
  payment_method: Joi.string().valid('CASH', 'CLICK', 'CARD', 'INSURANCE', 'OTHER').required(),
  paid_to_provider: Joi.boolean().default(false),
  provider_id: Joi.string().uuid().when('paid_to_provider', { is: true, then: Joi.required() }),
  provider_amount: Joi.number().positive().precision(3).when('paid_to_provider', { is: true, then: Joi.required() }),
  notes: Joi.string().max(500).trim().allow('', null),
  reference_number: Joi.string().max(100).trim().allow('', null),
});

router.get('/invoice/:invoiceId', authenticate, staffOnly, readLimiter, asyncHandler(async (req, res) => {
  const invoice = await invoiceService.getInvoiceAccessContext(req.params.invoiceId);
  if (!invoice) {
    return res.status(404).json({ message: 'Invoice not found', code: 'INVOICE_NOT_FOUND' });
  }

  const hasAccess = await invoiceService.canAccessInvoice(req.user, invoice);
  if (!hasAccess) {
    return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
  }

  const result = await paymentService.getInvoiceWithPayments(req.params.invoiceId);
  if (!result) {
    return res.status(404).json({ message: 'Invoice not found', code: 'INVOICE_NOT_FOUND' });
  }

  return res.json(result);
}));

router.post('/invoice/:invoiceId', authenticate, staffOnly, apiLimiter, asyncHandler(async (req, res) => {
  const { error, value } = addPaymentSchema.validate(req.body, { stripUnknown: true });
  if (error) {
    return res.status(400).json({ message: error.details[0].message, code: 'VALIDATION_ERROR' });
  }

  const invoice = await invoiceService.getInvoiceAccessContext(req.params.invoiceId);
  if (!invoice) {
    return res.status(404).json({ message: 'Invoice not found', code: 'INVOICE_NOT_FOUND' });
  }

  const hasAccess = await invoiceService.canAccessInvoice(req.user, invoice);
  if (!hasAccess) {
    return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
  }

  const result = await paymentService.addPayment(req.params.invoiceId, value, req.user);
  if (result.error) {
    return res.status(result.error.status).json(result.error.body);
  }

  await notifService.notifyPaymentReceived(result.notify).catch((err) => {
    logger.error('Failed to send payment notification', {
      invoiceId: req.params.invoiceId,
      error: err.message,
    });
  });

  audit('PAYMENT_ADDED', {
    userId: req.user.id,
    role: req.user.role,
    targetId: req.params.invoiceId,
    targetType: 'invoice',
    ip: req.ip,
    details: {
      amount: value.amount,
      payment_method: value.payment_method,
      remaining: result.summary.remaining,
    },
  });

  return res.status(201).json({
    message: result.message,
    payment: result.payment,
    summary: result.summary,
  });
}));

router.get('/provider/:providerId', authenticate, adminOnly, readLimiter, asyncHandler(async (req, res) => {
  const data = await paymentService.getProviderPayments(req.params.providerId, req.query);
  return res.json(data);
}));

router.delete('/:paymentId', authenticate, adminOnly, apiLimiter, asyncHandler(async (req, res) => {
  const result = await paymentService.deletePayment(req.params.paymentId);
  if (result.error) {
    return res.status(result.error.status).json(result.error.body);
  }

  audit('PAYMENT_DELETED', {
    userId: req.user.id,
    role: req.user.role,
    targetId: result.deletedPayment.id,
    targetType: 'payment',
    ip: req.ip,
    details: {
      amount: result.deletedPayment.amount,
      invoice_id: result.deletedPayment.invoice_id,
    },
  });

  return res.json({ message: result.message });
}));

module.exports = router;
