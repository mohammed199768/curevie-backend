const { audit } = require('../../utils/logger');
const { paginate, paginationMeta } = require('../../utils/pagination'); // AUDIT-FIX: DRY — shared pagination helpers replace manual invoice list metadata

function createInvoiceController(invoiceService) {
  async function listInvoices(req, res) {
    const { page, limit, payment_status, from_date, to_date } = req.query;
    const { page: currentPage, limit: currentLimit } = paginate(req.query); // AUDIT-FIX: DRY — normalize invoice pagination via the shared helper
    if (!['ADMIN', 'PATIENT'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
    }

    const { data, total } = await invoiceService.listInvoices({
      page,
      limit,
      payment_status,
      from_date,
      to_date,
      patient_id: req.user.role === 'PATIENT' ? req.user.id : undefined,
    });

    return res.json({
      data,
      pagination: paginationMeta(total, currentPage, currentLimit), // AUDIT-FIX: DRY — standardized list response shape for invoices
    });
  }

  async function getStats(req, res) {
    const stats = await invoiceService.getInvoiceStats();
    return res.json(stats);
  }

  async function getInvoiceById(req, res) {
    const invoice = await invoiceService.getInvoiceDetailsById(req.params.id);
    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found', code: 'INVOICE_NOT_FOUND' });
    }

    const isAdmin = req.user.role === 'ADMIN';
    const isOwnInvoice = req.user.role === 'PATIENT'
      && invoice.patient_id === req.user.id
      && invoice.is_patient_visible;
    if (!isAdmin && !isOwnInvoice) {
      return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
    }

    return res.json(invoice);
  }

  async function getInvoiceByRequestId(req, res) {
    const invoice = await invoiceService.getInvoiceByRequestId(req.params.requestId);
    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found', code: 'INVOICE_NOT_FOUND' });
    }

    const isAdmin = req.user.role === 'ADMIN';
    const isOwnVisibleInvoice = req.user.role === 'PATIENT'
      && invoice.patient_id === req.user.id
      && invoice.is_patient_visible;

    if (!isAdmin && !isOwnVisibleInvoice) {
      return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
    }

    return res.json(invoice);
  }

  async function getInvoicePaymentRecords(req, res) {
    const invoice = await invoiceService.getInvoiceAccessContext(req.params.id);
    if (!invoice) {
      return res.status(404).json({ message: 'Invoice not found', code: 'INVOICE_NOT_FOUND' });
    }

    const hasAccess = await invoiceService.canAccessInvoice(req.user, invoice);
    if (!hasAccess) {
      return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
    }

    const rows = await invoiceService.getPaymentRecordsByInvoiceId(req.params.id);
    return res.json({ payments: rows });
  }

  async function payInvoice(req, res) {
    const { payment_method } = req.body;
    const existing = await invoiceService.getInvoiceById(req.params.id);

    if (!existing) {
      return res.status(404).json({ message: 'Invoice not found', code: 'INVOICE_NOT_FOUND' });
    }

    if (existing.payment_status === 'PAID') {
      return res.status(409).json({ message: 'Invoice is already paid', code: 'INVOICE_ALREADY_PAID' });
    }

    if (existing.payment_status === 'CANCELLED') {
      return res.status(409).json({ message: 'Invoice is cancelled', code: 'INVOICE_CANCELLED' });
    }

    const paid = await invoiceService.markInvoicePaid(req.params.id, payment_method);

    audit('INVOICE_PAID', {
      userId: req.user.id,
      role: req.user.role,
      targetId: req.params.id,
      targetType: 'invoice',
      ip: req.ip,
      details: { payment_method },
    });

    return res.json(paid);
  }

  async function listCoupons(req, res) {
    const { page, limit, is_active } = req.query;
    const { page: currentPage, limit: currentLimit } = paginate(req.query); // AUDIT-FIX: DRY — normalize coupon pagination via the shared helper
    const { data, total } = await invoiceService.listCoupons({ page, limit, is_active });

    return res.json({
      data,
      pagination: paginationMeta(total, currentPage, currentLimit), // AUDIT-FIX: DRY — standardized list response shape for coupons
    });
  }

  async function createCoupon(req, res) {
    const created = await invoiceService.createCoupon(req.body);

    audit('COUPON_CREATED', {
      userId: req.user.id,
      role: req.user.role,
      targetId: created.id,
      targetType: 'coupon',
      ip: req.ip,
      details: { code: req.body.code },
    });

    return res.status(201).json(created);
  }

  async function getCouponById(req, res) {
    const coupon = await invoiceService.getCouponById(req.params.id);
    if (!coupon) {
      return res.status(404).json({ message: 'Coupon not found', code: 'COUPON_NOT_FOUND' });
    }
    return res.json(coupon);
  }

  async function validateCoupon(req, res) {
    const code = String(req.params.code || '').toUpperCase();
    const coupon = await invoiceService.getCouponByCode(code);

    if (!coupon) {
      return res.status(404).json({ message: 'Coupon not found', code: 'COUPON_NOT_FOUND' });
    }

    return res.json({
      is_valid: coupon.is_valid,
      coupon,
    });
  }

  async function validateCouponPost(req, res) {
    const code = String(req.body.code || '').toUpperCase();
    const orderAmount = Number(req.body.order_amount) || 0;
    const result = await invoiceService.validateAndComputeCoupon(code, orderAmount);

    return res.json({
      is_valid: true,
      coupon: result.coupon,
      original_amount: orderAmount,
      discount_amount: result.discountAmount,
      final_amount: result.finalAmount,
    });
  }

  async function updateCoupon(req, res) {
    if (
      req.body.discount_type === 'PERCENTAGE' &&
      Object.prototype.hasOwnProperty.call(req.body, 'discount_value') &&
      req.body.discount_value > 100
    ) {
      return res.status(400).json({
        message: 'Percentage discount cannot exceed 100',
        code: 'INVALID_DISCOUNT',
      });
    }

    const result = await invoiceService.updateCoupon(req.params.id, req.body);
    if (result.noUpdates) {
      return res.status(400).json({ message: 'No fields to update', code: 'NO_UPDATES' });
    }
    if (!result.row) {
      return res.status(404).json({ message: 'Coupon not found', code: 'COUPON_NOT_FOUND' });
    }

    audit('COUPON_UPDATED', {
      userId: req.user.id,
      role: req.user.role,
      targetId: req.params.id,
      targetType: 'coupon',
      ip: req.ip,
      details: req.body,
    });

    return res.json(result.row);
  }

  async function deleteCoupon(req, res) {
    const result = await invoiceService.deleteCoupon(req.params.id);
    if (result.notFound) {
      return res.status(404).json({ message: 'Coupon not found', code: 'COUPON_NOT_FOUND' });
    }
    if (result.used) {
      return res.status(409).json({
        message: 'Cannot delete a coupon that has been used',
        code: 'COUPON_ALREADY_USED',
      });
    }

    audit('COUPON_DELETED', {
      userId: req.user.id,
      role: req.user.role,
      targetId: req.params.id,
      targetType: 'coupon',
      ip: req.ip,
    });

    return res.json({ message: 'Coupon deleted successfully', coupon: result.row });
  }

  return {
    listInvoices,
    getStats,
    getInvoiceById,
    getInvoiceByRequestId,
    getInvoicePaymentRecords,
    payInvoice,
    listCoupons,
    createCoupon,
    getCouponById,
    validateCoupon,
    validateCouponPost,
    updateCoupon,
    deleteCoupon,
  };
}

module.exports = { createInvoiceController };
