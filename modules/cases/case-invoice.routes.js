/**
 * Case invoice endpoints (mounted under /api/v1/cases).
 *
 *   GET    /invoices                          admin list of invoices
 *   GET    /:id/invoice                       invoice + payments + adjustments
 *   POST   /:id/invoice/payments              record a payment (admin)
 *   DELETE /:id/invoice/payments/:paymentId   delete a payment (admin)
 *   POST   /:id/invoice/adjustments           discount or surcharge (admin)
 *   PUT    /:id/invoice/finalize              lock the invoice amounts (admin)
 *   GET    /:id/invoice/pdf                   invoice PDF
 *
 * All totals are recomputed by caseService.recomputeInvoice; nothing here edits them by hand.
 */
const express = require('express');
const Joi = require('joi');
const pool = require('../../config/db');
const asyncHandler = require('../../utils/asyncHandler');
const validate = require('../../middlewares/validate');
const { authenticate, adminOnly } = require('../../middlewares/auth');
const { apiLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const { AppError } = require('../../middlewares/errorHandler');
const { logger } = require('../../utils/logger');
const { generateCaseInvoicePdf } = require('../../utils/pdf/case-invoice.generator');
const notificationService = require('../notifications/notification.service');
const caseService = require('./case.service');
const { CASE_STATUS } = require('./case.constants');

const router = express.Router({ mergeParams: true });
const { caseRepo } = caseService;

const uuid = Joi.string().uuid();
const caseParams = Joi.object({ id: uuid.required() });
const paymentParams = Joi.object({ id: uuid.required(), paymentId: uuid.required() });
const paymentSchema = Joi.object({
  amount: Joi.number().positive().precision(3).max(1000000).required(),
  method: Joi.string().valid('CASH', 'CARD', 'INSURANCE', 'CLICK', 'OTHER').required(),
  notes: Joi.string().trim().max(500).allow('', null),
});
const adjustmentSchema = Joi.object({
  amount: Joi.number().positive().precision(3).max(1000000).required(),
  type: Joi.string().valid('DISCOUNT', 'SURCHARGE').required(),
  reason: Joi.string().trim().min(2).max(500).required(),
});
const invoicesQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  payment_status: Joi.string().valid('PENDING', 'PARTIAL', 'PAID', 'CANCELLED'),
  search: Joi.string().trim().max(100).allow(''),
});

/** Loads the invoice when the user may see it (patients only once it was released). */
async function loadVisibleInvoice(req) {
  const caseRow = await caseService.loadAccessibleCase(req.params.id, req.user);
  const invoice = await caseRepo.findInvoiceByCase(req.params.id);
  if (!invoice) throw new AppError('Invoice not found', 404, 'NOT_FOUND');

  if (req.user.role === 'PATIENT' && !invoice.is_patient_visible) {
    throw new AppError('Invoice is not available yet', 403, 'NOT_AVAILABLE');
  }
  if (req.user.role === 'PROVIDER' && caseRow.lead_provider_id !== req.user.id) {
    throw new AppError('Access denied', 403, 'FORBIDDEN');
  }
  return { caseRow, invoice };
}

async function loadPaymentsAndAdjustments(invoiceId, { approvedOnly = false } = {}) {
  const [payments, adjustments] = await Promise.all([
    pool.query(
      `SELECT cpr.id, cpr.amount, cpr.method, cpr.notes, cpr.approval_status, cpr.recorded_by_role,
              cpr.created_at, COALESCE(adm.full_name, sp.full_name) AS recorded_by_name
       FROM case_payment_records cpr
       LEFT JOIN admins adm ON adm.id = cpr.recorded_by AND cpr.recorded_by_role = 'ADMIN'
       LEFT JOIN service_providers sp ON sp.id = cpr.recorded_by AND cpr.recorded_by_role = 'PROVIDER'
       WHERE cpr.invoice_id = $1 ${approvedOnly ? "AND cpr.approval_status = 'APPROVED'" : ''}
       ORDER BY cpr.created_at ASC`,
      [invoiceId]
    ),
    pool.query(
      `SELECT ia.id, ia.amount, ia.type, ia.reason, ia.created_at, adm.full_name AS created_by_name
       FROM invoice_adjustments ia
       LEFT JOIN admins adm ON adm.id = ia.created_by
       WHERE ia.invoice_id = $1
       ORDER BY ia.created_at ASC`,
      [invoiceId]
    ),
  ]);
  return { payments: payments.rows, adjustments: adjustments.rows };
}

// ------------------------------------------------------------------ list (admin)

router.get(
  '/invoices',
  authenticate,
  adminOnly,
  readLimiter,
  validate(invoicesQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { page, limit, payment_status: paymentStatus, search } = req.query;
    const params = [paymentStatus || null, search ? `%${search}%` : null];
    const where = `WHERE ($1::text IS NULL OR i.payment_status::text = $1)
      AND ($2::text IS NULL OR COALESCE(p.full_name, c.guest_name) ILIKE $2
           OR COALESCE(p.phone, c.guest_phone) ILIKE $2 OR c.id::text ILIKE $2)`;

    const [rows, count] = await Promise.all([
      pool.query(
        `SELECT i.*, c.status AS case_status, c.created_at AS case_created_at,
                COALESCE(p.full_name, c.guest_name) AS patient_name,
                COALESCE(p.phone, c.guest_phone) AS patient_phone
         FROM case_invoices i
         JOIN cases c ON c.id = i.case_id
         LEFT JOIN patients p ON p.id = c.patient_id
         ${where}
         ORDER BY i.created_at DESC
         LIMIT $3 OFFSET $4`,
        [...params, limit, (page - 1) * limit]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total
         FROM case_invoices i JOIN cases c ON c.id = i.case_id LEFT JOIN patients p ON p.id = c.patient_id
         ${where}`,
        params
      ),
    ]);

    const total = count.rows[0].total;
    return res.json({ data: rows.rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  })
);

// ------------------------------------------------------------------ read

router.get(
  '/:id/invoice',
  authenticate,
  readLimiter,
  validate(caseParams, 'params'),
  asyncHandler(async (req, res) => {
    const { invoice } = await loadVisibleInvoice(req);
    const { payments, adjustments } = await loadPaymentsAndAdjustments(invoice.id, {
      approvedOnly: req.user.role !== 'ADMIN',
    });
    return res.json({ invoice, payments, adjustments });
  })
);

router.get(
  '/:id/invoice/pdf',
  authenticate,
  readLimiter,
  validate(caseParams, 'params'),
  asyncHandler(async (req, res) => {
    const { invoice } = await loadVisibleInvoice(req);
    const { payments, adjustments } = await loadPaymentsAndAdjustments(invoice.id, { approvedOnly: true });

    let pdfBuffer;
    try {
      pdfBuffer = await generateCaseInvoicePdf({ caseId: req.params.id, invoice, payments, adjustments });
    } catch (error) {
      logger.error('INVOICE_PDF_GENERATION_FAILED', { caseId: req.params.id, message: error.message });
      throw new AppError('Failed to generate invoice PDF', 500, 'PDF_GENERATION_FAILED');
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${req.params.id.slice(0, 8)}.pdf"`);
    res.setHeader('Content-Length', String(pdfBuffer.length));
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).send(pdfBuffer);
  })
);

// ------------------------------------------------------------------ payments (admin)

router.post(
  '/:id/invoice/payments',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(caseParams, 'params'),
  validate(paymentSchema),
  asyncHandler(async (req, res) => {
    const caseId = req.params.id;
    const amount = caseService.toMoney(req.body.amount);

    const result = await caseService.withTransaction(async (client) => {
      const caseRow = await caseRepo.lockCase(caseId, client);
      if (!caseRow) throw new AppError('Case not found', 404, 'NOT_FOUND');
      if (caseRow.status === CASE_STATUS.CANCELLED) {
        throw new AppError('Cannot record a payment on a cancelled case', 409, 'INVOICE_CANCELLED');
      }

      const invoice = await caseService.recomputeInvoice(client, caseId, caseRow.status);
      if (Number(invoice.remaining_amount) <= 0) {
        throw new AppError('Invoice has no remaining balance', 409, 'INVOICE_PAID');
      }
      if (amount - Number(invoice.remaining_amount) > 0.0005) {
        throw new AppError(
          `Payment (${amount.toFixed(3)}) exceeds remaining balance (${Number(invoice.remaining_amount).toFixed(3)})`,
          400,
          'OVERPAYMENT'
        );
      }

      const { rows } = await client.query(
        `INSERT INTO case_payment_records
           (case_id, invoice_id, recorded_by, recorded_by_role, amount, method, notes,
            approval_status, approved_by, approved_at)
         VALUES ($1, $2, $3, 'ADMIN', $4, $5::payment_method, $6, 'APPROVED', $3, NOW())
         RETURNING *`,
        [caseId, invoice.id, req.user.id, amount, req.body.method, req.body.notes || null]
      );

      const updated = await caseService.recomputeInvoice(client, caseId, caseRow.status);
      if (updated.payment_status === 'PAID') {
        await client.query(
          'UPDATE case_invoices SET payment_method = $2::payment_method, approved_by = $3 WHERE id = $1',
          [invoice.id, req.body.method, req.user.id]
        );
      }
      await caseRepo.addLifecycleEvent({
        case_id: caseId,
        actor_id: req.user.id,
        actor_role: 'ADMIN',
        event_type: 'PAYMENT_RECORDED',
        notes: `${amount.toFixed(3)} ${req.body.method}`,
      }, client);

      return { caseRow, payment: rows[0], invoice: updated };
    });

    notificationService.notifySafely('payment_received', () => notificationService.notifyPaymentReceived({
      caseId,
      invoiceId: result.invoice.id,
      patientId: result.caseRow.patient_id,
      amount: amount.toFixed(3),
      remaining: Number(result.invoice.remaining_amount).toFixed(3),
      method: req.body.method,
    }));

    return res.status(201).json({
      payment: result.payment,
      summary: {
        total_paid: Number(result.invoice.total_paid),
        remaining: Number(result.invoice.remaining_amount),
        payment_status: result.invoice.payment_status,
        is_fully_paid: result.invoice.payment_status === 'PAID',
      },
    });
  })
);

router.delete(
  '/:id/invoice/payments/:paymentId',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(paymentParams, 'params'),
  asyncHandler(async (req, res) => {
    const { id: caseId, paymentId } = req.params;

    const invoice = await caseService.withTransaction(async (client) => {
      const caseRow = await caseRepo.lockCase(caseId, client);
      if (!caseRow) throw new AppError('Case not found', 404, 'NOT_FOUND');
      const locked = await caseRepo.lockInvoice(caseId, client);
      if (locked?.finalized_at) throw new AppError('Invoice is finalized', 409, 'INVOICE_FINALIZED');

      const { rows } = await client.query(
        'DELETE FROM case_payment_records WHERE id = $1 AND case_id = $2 RETURNING id, amount',
        [paymentId, caseId]
      );
      if (!rows[0]) throw new AppError('Payment not found', 404, 'NOT_FOUND');

      await caseRepo.addLifecycleEvent({
        case_id: caseId,
        actor_id: req.user.id,
        actor_role: 'ADMIN',
        event_type: 'PAYMENT_DELETED',
        notes: Number(rows[0].amount).toFixed(3),
      }, client);
      return caseService.recomputeInvoice(client, caseId, caseRow.status);
    });

    return res.json({
      message: 'Payment deleted and invoice totals recalculated',
      summary: {
        total_paid: Number(invoice.total_paid),
        remaining: Number(invoice.remaining_amount),
        payment_status: invoice.payment_status,
      },
    });
  })
);

// ------------------------------------------------------------------ adjustments / finalize (admin)

router.post(
  '/:id/invoice/adjustments',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(caseParams, 'params'),
  validate(adjustmentSchema),
  asyncHandler(async (req, res) => {
    const caseId = req.params.id;
    const amount = caseService.toMoney(req.body.amount);

    const result = await caseService.withTransaction(async (client) => {
      const caseRow = await caseRepo.lockCase(caseId, client);
      if (!caseRow) throw new AppError('Case not found', 404, 'NOT_FOUND');
      if (caseRow.status === CASE_STATUS.CANCELLED) {
        throw new AppError('Cannot adjust a cancelled case', 409, 'INVOICE_CANCELLED');
      }
      const invoice = await caseRepo.lockInvoice(caseId, client);
      if (!invoice) throw new AppError('Invoice not found', 404, 'NOT_FOUND');
      if (invoice.finalized_at) throw new AppError('Invoice is finalized', 409, 'INVOICE_FINALIZED');

      const { rows } = await client.query(
        `INSERT INTO invoice_adjustments (invoice_id, amount, type, reason, created_by)
         VALUES ($1, $2, $3::adjustment_type, $4, $5)
         RETURNING *`,
        [invoice.id, amount, req.body.type, req.body.reason, req.user.id]
      );
      const updated = await caseService.recomputeInvoice(client, caseId, caseRow.status, { forbidOverpaid: true });
      await caseRepo.addLifecycleEvent({
        case_id: caseId,
        actor_id: req.user.id,
        actor_role: 'ADMIN',
        event_type: 'INVOICE_ADJUSTED',
        notes: `${req.body.type} ${amount.toFixed(3)}: ${req.body.reason}`,
      }, client);
      return { adjustment: rows[0], invoice: updated };
    });

    return res.status(201).json({
      adjustment: result.adjustment,
      invoice_summary: {
        original_amount: Number(result.invoice.original_amount),
        final_amount: Number(result.invoice.final_amount),
        total_paid: Number(result.invoice.total_paid),
        remaining: Number(result.invoice.remaining_amount),
        payment_status: result.invoice.payment_status,
      },
    });
  })
);

router.put(
  '/:id/invoice/finalize',
  authenticate,
  adminOnly,
  apiLimiter,
  validate(caseParams, 'params'),
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE case_invoices
       SET finalized_at = NOW(), finalized_by = $1, updated_at = NOW()
       WHERE case_id = $2 AND finalized_at IS NULL
       RETURNING *`,
      [req.user.id, req.params.id]
    );

    if (!rows[0]) {
      const existing = await caseRepo.findInvoiceByCase(req.params.id);
      if (!existing) throw new AppError('Invoice not found', 404, 'NOT_FOUND');
      return res.status(409).json({
        message: 'Invoice is already finalized',
        code: 'ALREADY_FINALIZED',
        finalized_at: existing.finalized_at,
      });
    }

    return res.json({ invoice: rows[0], message: 'Invoice finalized' });
  })
);

module.exports = router;
