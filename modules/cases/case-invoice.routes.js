/**
 * case-invoice.routes.js
 * Mounted via: router.use('/', invoiceRoutes) inside case.routes.js
 * Base path: /api/v1/cases
 *
 * Endpoints:
 *   GET    /:id/invoice                       — get invoice + payments + adjustments
 *   POST   /:id/invoice/payments              — record a payment (admin only)
 *   DELETE /:id/invoice/payments/:paymentId   — delete a payment (admin only)
 *   POST   /:id/invoice/adjustments           — apply discount or surcharge (admin only)
 *   PUT    /:id/invoice/finalize              — mark invoice reviewed/finalized (admin only)
 *   GET    /:id/invoice/pdf                   — generate invoice PDF (admin | patient if visible)
 *
 * REQUIRES: migration 042_payment_system_fix.sql must be applied first
 *           (adds PARTIAL to payment_status enum, fixes recorded_by FK, adds invoice_id)
 */

const express = require('express');
const router = express.Router({ mergeParams: true });
const pool = require('../../config/db');
const asyncHandler = require('../../utils/asyncHandler');
const { authenticate, adminOnly } = require('../../middlewares/auth');
const { logger } = require('../../utils/logger');
const { generateCaseInvoicePdf } = require('../../utils/pdf/case-invoice.generator');

// ============================================================
// HELPERS
// ============================================================

/** Round to 3 decimal places (KWD precision). */
function toMoney(value) {
  const n = Math.round(Number(value) * 1000) / 1000;
  return Number.isFinite(n) ? n : 0;
}

/** Load the single invoice row for a case (no lock). */
async function getInvoiceByCaseId(caseId, client) {
  const db = client || pool;
  const result = await db.query(
    'SELECT * FROM case_invoices WHERE case_id = $1 LIMIT 1',
    [caseId]
  );
  return result.rows[0] || null;
}

/** Returns true if providerId is assigned to any service or is lead_provider on the case. */
async function hasProviderCaseAccess(caseId, providerId) {
  const result = await pool.query(
    `SELECT 1
     FROM cases c
     LEFT JOIN case_services cs ON cs.case_id = c.id
     WHERE c.id = $1
       AND (c.lead_provider_id = $2 OR cs.provider_id = $2)
     LIMIT 1`,
    [caseId, providerId]
  );
  return Boolean(result.rows[0]);
}

const VALID_PAYMENT_METHODS = ['CASH', 'CARD', 'INSURANCE', 'CLICK', 'OTHER'];

// ============================================================
// GET /:id/invoice
// Returns: invoice row + approved payment records + adjustments
// Auth: ADMIN always | PATIENT if is_patient_visible + owns case | PROVIDER if assigned
// ============================================================
router.get('/:id/invoice', authenticate, asyncHandler(async (req, res) => {
  const { id: caseId } = req.params;

  const invoice = await getInvoiceByCaseId(caseId);
  if (!invoice) {
    return res.status(404).json({ message: 'Invoice not found', code: 'NOT_FOUND' });
  }

  // --- Access control ---
  if (req.user.role === 'PATIENT') {
    if (!invoice.is_patient_visible) {
      return res.status(403).json({ message: 'Invoice is not available yet', code: 'NOT_AVAILABLE' });
    }
    const caseRow = await pool.query(
      'SELECT patient_id FROM cases WHERE id = $1 LIMIT 1',
      [caseId]
    );
    if (!caseRow.rows[0] || caseRow.rows[0].patient_id !== req.user.id) {
      return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
    }
  } else if (req.user.role === 'PROVIDER') {
    const allowed = await hasProviderCaseAccess(caseId, req.user.id);
    if (!allowed) {
      return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
    }
  }
  // ADMIN: always allowed — no check needed

  const [paymentsResult, adjustmentsResult] = await Promise.all([
    pool.query(
      `SELECT
         cpr.*,
         COALESCE(adm.full_name, sp.full_name) AS recorded_by_name
       FROM case_payment_records cpr
       LEFT JOIN admins adm
         ON adm.id = cpr.recorded_by AND cpr.recorded_by_role = 'ADMIN'
       LEFT JOIN service_providers sp
         ON sp.id = cpr.recorded_by AND cpr.recorded_by_role = 'PROVIDER'
       WHERE cpr.invoice_id = $1
       ORDER BY cpr.created_at ASC`,
      [invoice.id]
    ),
    pool.query(
      `SELECT
         ia.*,
         adm.full_name AS created_by_name
       FROM invoice_adjustments ia
       LEFT JOIN admins adm ON adm.id = ia.created_by
       WHERE ia.invoice_id = $1
       ORDER BY ia.created_at ASC`,
      [invoice.id]
    ),
  ]);

  return res.json({
    invoice,
    payments: paymentsResult.rows,
    adjustments: adjustmentsResult.rows,
  });
}));

// ============================================================
// POST /:id/invoice/payments
// Records a manual payment by an admin against this case's invoice.
// Atomically updates total_paid, remaining_amount, payment_status.
// Auth: ADMIN only
// Body: { amount: number, method: string, notes?: string }
// ============================================================
router.post('/:id/invoice/payments', authenticate, adminOnly, asyncHandler(async (req, res) => {
  const { id: caseId } = req.params;
  const { amount, method, notes } = req.body || {};

  // --- Input validation ---
  const parsedAmount = toMoney(amount);
  if (!parsedAmount || parsedAmount <= 0) {
    return res.status(400).json({
      message: 'amount must be a positive number',
      code: 'INVALID_AMOUNT',
    });
  }

  if (!method || !VALID_PAYMENT_METHODS.includes(method)) {
    return res.status(400).json({
      message: `method must be one of: ${VALID_PAYMENT_METHODS.join(', ')}`,
      code: 'INVALID_METHOD',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the invoice row for this case to prevent concurrent writes
    const invoiceResult = await client.query(
      'SELECT * FROM case_invoices WHERE case_id = $1 FOR UPDATE',
      [caseId]
    );
    const invoice = invoiceResult.rows[0];

    if (!invoice) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Invoice not found', code: 'NOT_FOUND' });
    }

    if (invoice.payment_status === 'PAID') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: 'Invoice is already fully paid',
        code: 'INVOICE_PAID',
      });
    }

    if (invoice.payment_status === 'CANCELLED') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: 'Cannot pay a cancelled invoice',
        code: 'INVOICE_CANCELLED',
      });
    }

    const finalAmount = toMoney(invoice.final_amount);
    if (finalAmount <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: 'Invoice has zero balance — no payment required',
        code: 'ZERO_BALANCE',
      });
    }

    const currentPaid = toMoney(invoice.total_paid);
    const remaining = toMoney(Math.max(0, finalAmount - currentPaid));

    if (parsedAmount > remaining + 0.001) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: `Payment (${parsedAmount.toFixed(3)}) exceeds remaining balance (${remaining.toFixed(3)})`,
        code: 'OVERPAYMENT',
        remaining: remaining.toFixed(3),
      });
    }

    const newTotalPaid = toMoney(currentPaid + parsedAmount);
    const newRemaining = toMoney(Math.max(0, finalAmount - newTotalPaid));
    // PARTIAL requires migration 042 to be applied (adds PARTIAL to payment_status enum)
    const newStatus = newRemaining <= 0.001 ? 'PAID' : 'PARTIAL';

    // Insert the payment record — recorded_by_role = 'ADMIN', auto-approved
    const paymentResult = await client.query(
      `INSERT INTO case_payment_records
         (case_id, invoice_id, recorded_by, recorded_by_role,
          amount, method, notes, approval_status, approved_by, approved_at)
       VALUES ($1, $2, $3, 'ADMIN', $4, $5::payment_method, $6,
               'APPROVED', $3, NOW())
       RETURNING *`,
      [caseId, invoice.id, req.user.id, parsedAmount, method, notes || null]
    );

    // Update invoice totals atomically
    // payment_method, approved_by, approved_at only set when invoice becomes fully PAID
    await client.query(
      `UPDATE case_invoices SET
         total_paid       = $1,
         remaining_amount = $2,
         payment_status   = $3::payment_status,
         payment_method   = CASE WHEN $3 = 'PAID' THEN $4::payment_method ELSE payment_method END,
         approved_by      = CASE WHEN $3 = 'PAID' THEN $5::uuid            ELSE approved_by    END,
         approved_at      = CASE WHEN $3 = 'PAID' THEN NOW()               ELSE approved_at    END,
         updated_at       = NOW()
       WHERE id = $6`,
      [newTotalPaid, newRemaining, newStatus, method, req.user.id, invoice.id]
    );

    await client.query('COMMIT');

    logger.info('INVOICE_PAYMENT_RECORDED', {
      caseId,
      invoiceId: invoice.id,
      amount: parsedAmount,
      method,
      adminId: req.user.id,
      newStatus,
    });

    return res.status(201).json({
      payment: paymentResult.rows[0],
      summary: {
        total_paid: newTotalPaid,
        remaining: newRemaining,
        payment_status: newStatus,
        is_fully_paid: newRemaining <= 0,
      },
      message: newRemaining <= 0
        ? 'Invoice paid in full'
        : `Payment recorded. Remaining: ${newRemaining.toFixed(3)}`,
    });

  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('INVOICE_PAYMENT_ERROR', {
      caseId,
      message: error.message,
      stack: error.stack?.split('\n')[0],
    });
    throw error;
  } finally {
    client.release();
  }
}));

// ============================================================
// DELETE /:id/invoice/payments/:paymentId
// Deletes a payment record and recalculates invoice totals from scratch.
// Auth: ADMIN only
// ============================================================
router.delete('/:id/invoice/payments/:paymentId', authenticate, adminOnly, asyncHandler(async (req, res) => {
  const { id: caseId, paymentId } = req.params;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock payment row — verify it belongs to this case
    const paymentResult = await client.query(
      'SELECT * FROM case_payment_records WHERE id = $1 AND case_id = $2 FOR UPDATE',
      [paymentId, caseId]
    );
    const payment = paymentResult.rows[0];

    if (!payment) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Payment not found', code: 'NOT_FOUND' });
    }

    // Lock the invoice
    const invoiceResult = await client.query(
      'SELECT * FROM case_invoices WHERE case_id = $1 FOR UPDATE',
      [caseId]
    );
    const invoice = invoiceResult.rows[0];

    if (!invoice) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Invoice not found', code: 'NOT_FOUND' });
    }

    // Delete the payment record
    await client.query('DELETE FROM case_payment_records WHERE id = $1', [paymentId]);

    // Recalculate total_paid from remaining APPROVED payments on this invoice
    // (Source of truth: sum of actual records, not cached totals)
    const totalsResult = await client.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM case_payment_records
       WHERE invoice_id = $1 AND approval_status = 'APPROVED'`,
      [invoice.id]
    );
    const newTotalPaid = toMoney(totalsResult.rows[0].total);
    const finalAmount = toMoney(invoice.final_amount);
    const newRemaining = toMoney(Math.max(0, finalAmount - newTotalPaid));
    const newStatus = newTotalPaid <= 0
      ? 'PENDING'
      : (newRemaining <= 0.001 ? 'PAID' : 'PARTIAL');

    // Clear payment_method, approved_by, approved_at if no longer fully paid
    await client.query(
      `UPDATE case_invoices SET
         total_paid       = $1,
         remaining_amount = $2,
         payment_status   = $3::payment_status,
         payment_method   = CASE WHEN $3 != 'PAID' THEN NULL ELSE payment_method END,
         approved_by      = CASE WHEN $3 != 'PAID' THEN NULL ELSE approved_by    END,
         approved_at      = CASE WHEN $3 != 'PAID' THEN NULL ELSE approved_at    END,
         updated_at       = NOW()
       WHERE id = $4`,
      [newTotalPaid, newRemaining, newStatus, invoice.id]
    );

    await client.query('COMMIT');

    logger.info('INVOICE_PAYMENT_DELETED', {
      caseId,
      paymentId,
      adminId: req.user.id,
      newStatus,
    });

    return res.json({
      message: 'Payment deleted and invoice totals recalculated',
      summary: {
        total_paid: newTotalPaid,
        remaining: newRemaining,
        payment_status: newStatus,
      },
    });

  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('INVOICE_PAYMENT_DELETE_ERROR', {
      caseId,
      paymentId,
      message: error.message,
      stack: error.stack?.split('\n')[0],
    });
    throw error;
  } finally {
    client.release();
  }
}));

// ============================================================
// POST /:id/invoice/adjustments
// Applies a DISCOUNT or SURCHARGE to the invoice final_amount.
// Each adjustment is recorded in invoice_adjustments for full audit trail.
// Auth: ADMIN only
// Body: { amount: number, type: 'DISCOUNT' | 'SURCHARGE', reason: string }
// ============================================================
router.post('/:id/invoice/adjustments', authenticate, adminOnly, asyncHandler(async (req, res) => {
  const { id: caseId } = req.params;
  const { amount, type, reason } = req.body || {};

  // --- Input validation ---
  const parsedAmount = toMoney(amount);
  if (!parsedAmount || parsedAmount <= 0) {
    return res.status(400).json({
      message: 'amount must be a positive number',
      code: 'INVALID_AMOUNT',
    });
  }

  if (!['DISCOUNT', 'SURCHARGE'].includes(type)) {
    return res.status(400).json({
      message: 'type must be DISCOUNT or SURCHARGE',
      code: 'INVALID_TYPE',
    });
  }

  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    return res.status(400).json({
      message: 'reason is required',
      code: 'REASON_REQUIRED',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const invoiceResult = await client.query(
      'SELECT * FROM case_invoices WHERE case_id = $1 FOR UPDATE',
      [caseId]
    );
    const invoice = invoiceResult.rows[0];

    if (!invoice) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Invoice not found', code: 'NOT_FOUND' });
    }

    if (invoice.payment_status === 'PAID') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: 'Cannot adjust a fully paid invoice',
        code: 'INVOICE_PAID',
      });
    }

    const currentFinal = toMoney(invoice.final_amount);
    const currentPaid = toMoney(invoice.total_paid);

    // DISCOUNT reduces final_amount (floor at 0), SURCHARGE increases it
    const newFinalAmount = type === 'DISCOUNT'
      ? toMoney(Math.max(0, currentFinal - parsedAmount))
      : toMoney(currentFinal + parsedAmount);

    const newRemaining = toMoney(Math.max(0, newFinalAmount - currentPaid));
    const newStatus = currentPaid <= 0
      ? 'PENDING'
      : (newRemaining <= 0.001 ? 'PAID' : 'PARTIAL');

    // Insert adjustment record (immutable audit trail)
    const adjustmentResult = await client.query(
      `INSERT INTO invoice_adjustments (invoice_id, amount, type, reason, created_by)
       VALUES ($1, $2, $3::adjustment_type, $4, $5)
       RETURNING *`,
      [invoice.id, parsedAmount, type, reason.trim(), req.user.id]
    );

    // Update invoice financials
    await client.query(
      `UPDATE case_invoices SET
         final_amount     = $1,
         remaining_amount = $2,
         payment_status   = $3::payment_status,
         updated_at       = NOW()
       WHERE id = $4`,
      [newFinalAmount, newRemaining, newStatus, invoice.id]
    );

    await client.query('COMMIT');

    logger.info('INVOICE_ADJUSTED', {
      caseId,
      invoiceId: invoice.id,
      type,
      amount: parsedAmount,
      adminId: req.user.id,
    });

    return res.status(201).json({
      adjustment: adjustmentResult.rows[0],
      invoice_summary: {
        original_amount: toMoney(invoice.original_amount),
        final_amount: newFinalAmount,
        total_paid: currentPaid,
        remaining: newRemaining,
        payment_status: newStatus,
      },
    });

  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('INVOICE_ADJUST_ERROR', {
      caseId,
      message: error.message,
      stack: error.stack?.split('\n')[0],
    });
    throw error;
  } finally {
    client.release();
  }
}));

// ============================================================
// PUT /:id/invoice/finalize
// Admin explicitly marks invoice amounts as reviewed and locked.
// Separate from PAID status — an invoice can be finalized before full payment,
// or marked paid without being explicitly finalized.
// Idempotent guard: returns 409 if already finalized.
// Auth: ADMIN only
// ============================================================
router.put('/:id/invoice/finalize', authenticate, adminOnly, asyncHandler(async (req, res) => {
  const { id: caseId } = req.params;

  const result = await pool.query(
    `UPDATE case_invoices
     SET finalized_at = NOW(),
         finalized_by = $1,
         updated_at   = NOW()
     WHERE case_id = $2
       AND finalized_at IS NULL
     RETURNING *`,
    [req.user.id, caseId]
  );

  if (!result.rows[0]) {
    const existing = await pool.query(
      'SELECT finalized_at FROM case_invoices WHERE case_id = $1 LIMIT 1',
      [caseId]
    );
    if (!existing.rows[0]) {
      return res.status(404).json({ message: 'Invoice not found', code: 'NOT_FOUND' });
    }
    return res.status(409).json({
      message: 'Invoice is already finalized',
      code: 'ALREADY_FINALIZED',
      finalized_at: existing.rows[0].finalized_at,
    });
  }

  logger.info('INVOICE_FINALIZED', { caseId, adminId: req.user.id });

  return res.json({ invoice: result.rows[0], message: 'Invoice finalized' });
}));

// ============================================================
// GET /:id/invoice/pdf
// Generates invoice PDF on demand (not cached).
// Data sources:
//   - case_snapshots → patient name, services list (immutable at close time)
//   - case_invoices → live financial totals
//   - case_payment_records → payment history
//   - invoice_adjustments → discount/surcharge history
// Auth: ADMIN always | PATIENT if is_patient_visible
// ============================================================
router.get('/:id/invoice/pdf', authenticate, asyncHandler(async (req, res) => {
  const { id: caseId } = req.params;

  const invoice = await getInvoiceByCaseId(caseId);
  if (!invoice) {
    return res.status(404).json({ message: 'Invoice not found', code: 'NOT_FOUND' });
  }

  // --- Access control ---
  if (req.user.role === 'PATIENT') {
    if (!invoice.is_patient_visible) {
      return res.status(403).json({ message: 'Invoice is not available yet', code: 'NOT_AVAILABLE' });
    }
    const caseRow = await pool.query(
      'SELECT patient_id FROM cases WHERE id = $1 LIMIT 1',
      [caseId]
    );
    if (!caseRow.rows[0] || caseRow.rows[0].patient_id !== req.user.id) {
      return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
    }
  } else if (!['ADMIN'].includes(req.user.role)) {
    return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
  }

  // Load payment history and adjustments
  const [paymentsResult, adjustmentsResult] = await Promise.all([
    pool.query(
      `SELECT *
       FROM case_payment_records
       WHERE invoice_id = $1 AND approval_status = 'APPROVED'
       ORDER BY created_at ASC`,
      [invoice.id]
    ),
    pool.query(
      `SELECT *
       FROM invoice_adjustments
       WHERE invoice_id = $1
       ORDER BY created_at ASC`,
      [invoice.id]
    ),
  ]);

  let pdfBuffer;
  try {
    pdfBuffer = await generateCaseInvoicePdf({
      caseId,
      invoice,
      payments: paymentsResult.rows,
      adjustments: adjustmentsResult.rows,
    });
  } catch (error) {
    logger.error('INVOICE_PDF_GENERATION_FAILED', {
      caseId,
      message: error.message,
      stack: error.stack?.split('\n')[0],
    });
    return res.status(500).json({
      message: 'Failed to generate invoice PDF',
      code: 'PDF_GENERATION_FAILED',
    });
  }

  const shortId = String(caseId).slice(0, 8);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="invoice-${shortId}.pdf"`);
  res.setHeader('Content-Length', String(pdfBuffer.length));
  return res.status(200).send(pdfBuffer);
}));

module.exports = router;
