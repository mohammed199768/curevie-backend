const express = require('express');
const Joi = require('joi');
const { authenticate, adminOnly } = require('../../middlewares/auth');
const { apiLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const validate = require('../../middlewares/validate');
const { createCouponSchema, payInvoiceSchema, validateCouponSchema } = require('../../utils/schemas');
const asyncHandler = require('../../utils/asyncHandler');
const pool = require('../../config/db');
const InvoiceRepository = require('../../repositories/InvoiceRepository');
const invoiceServiceModule = require('./invoice.service'); // AUDIT-FIX: P3-STEP8-DIP - invoice routes now configure the service singleton explicitly.
const { createInvoiceController } = require('./invoice.controller');

const invoiceRepo = new InvoiceRepository(pool);
invoiceServiceModule.configureInvoiceService(invoiceRepo); // AUDIT-FIX: P3-STEP8-DIP - route-level composition now wires the backward-compatible invoice singleton explicitly.
const invoiceService = invoiceServiceModule; // AUDIT-FIX: P3-STEP8-COMPAT - keep the existing local service variable shape for controller wiring.
const invoiceController = createInvoiceController(invoiceService);

const router = express.Router();

const invoicesQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(10),
  payment_status: Joi.string().valid('PENDING', 'PAID', 'CANCELLED'),
  from_date: Joi.date().iso(),
  to_date: Joi.date().iso().min(Joi.ref('from_date')),
});

const couponsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(10),
  is_active: Joi.boolean(),
});

const updateCouponSchema = Joi.object({
  code: Joi.string().min(3).max(50).uppercase().trim(),
  discount_type: Joi.string().valid('PERCENTAGE', 'FIXED'),
  discount_value: Joi.number().positive(),
  min_order_amount: Joi.number().min(0),
  max_uses: Joi.number().integer().min(1),
  expires_at: Joi.date().iso(),
  is_active: Joi.boolean(),
}).min(1);

router.get(
  '/',
  authenticate,
  readLimiter,
  validate(invoicesQuerySchema, 'query'),
  asyncHandler(invoiceController.listInvoices)
);

router.get(
  '/stats',
  authenticate,
  adminOnly,
  readLimiter,
  asyncHandler(invoiceController.getStats)
);

router.put(
  '/:id/pay',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(payInvoiceSchema),
  asyncHandler(invoiceController.payInvoice)
);

router.get(
  '/coupons',
  authenticate,
  adminOnly,
  readLimiter,
  validate(couponsQuerySchema, 'query'),
  asyncHandler(invoiceController.listCoupons)
);

router.post(
  '/coupons',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(createCouponSchema),
  asyncHandler(invoiceController.createCoupon)
);

router.get(
  '/coupons/validate/:code',
  authenticate,
  readLimiter,
  asyncHandler(invoiceController.validateCoupon)
);

router.post(
  '/coupons/validate',
  authenticate,
  readLimiter,
  validate(validateCouponSchema),
  asyncHandler(invoiceController.validateCouponPost)
);

router.put(
  '/coupons/:id',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(updateCouponSchema),
  asyncHandler(invoiceController.updateCoupon)
);

router.get(
  '/coupons/:id',
  authenticate,
  adminOnly,
  readLimiter,
  asyncHandler(invoiceController.getCouponById)
);

router.delete(
  '/coupons/:id',
  authenticate,
  adminOnly,
  apiLimiter,
  asyncHandler(invoiceController.deleteCoupon)
);

router.get(
  '/request/:requestId',
  authenticate,
  readLimiter,
  asyncHandler(invoiceController.getInvoiceByRequestId)
);

router.get(
  '/:id/payment-records',
  authenticate,
  readLimiter,
  asyncHandler(invoiceController.getInvoicePaymentRecords)
);

router.get(
  '/:id',
  authenticate,
  readLimiter,
  asyncHandler(invoiceController.getInvoiceById)
);

module.exports = router;
