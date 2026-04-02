const { syncInvoiceSnapshots } = require('../../utils/requestSnapshots');
const { providerHasRequestAccess } = require('../requests/request.workflow.service');
const InvoiceRepository = require('../../repositories/InvoiceRepository');
const { validateAndComputeCoupon: validateCouponCode } = require('../../utils/couponValidator');
const { paginate } = require('../../utils/pagination'); // AUDIT-FIX: DRY — shared pagination helper replaces duplicated invoice offset math

function normalizeInvoicePaymentMethod(method) {
  const normalized = String(method || '').trim().toUpperCase();
  if (['CASH', 'CARD', 'INSURANCE', 'CLICK', 'OTHER'].includes(normalized)) {
    return normalized;
  }

  if (normalized === 'TRANSFER') {
    return 'OTHER';
  }

  return 'OTHER';
}

function createInvoiceService(invoiceRepo) {
  function toMoney(value) {
    const n = Math.round(Number(value) * 1000) / 1000;
    return Number.isFinite(n) ? n : 0;
  }

  function resolvePaymentStatus(finalAmount, totalPaid) {
    const safeFinalAmount = toMoney(Math.max(0, Number(finalAmount) || 0));
    const safeTotalPaid = toMoney(Math.max(0, Number(totalPaid) || 0));

    if (safeTotalPaid >= safeFinalAmount && safeFinalAmount > 0) {
      return {
        payment_status: 'PAID',
        payment_status_detail: 'PAID',
        remaining_amount: 0,
      };
    }

    if (safeTotalPaid > 0) {
      return {
        payment_status: 'PENDING',
        payment_status_detail: 'PARTIAL',
        remaining_amount: toMoney(Math.max(safeFinalAmount - safeTotalPaid, 0)),
      };
    }

    return {
      payment_status: 'PENDING',
      payment_status_detail: 'UNPAID',
      remaining_amount: safeFinalAmount,
    };
  }

  async function listInvoices({
    page,
    limit,
    payment_status,
    from_date,
    to_date,
    patient_id,
  }) {
    const { offset } = paginate({ page, limit }); // AUDIT-FIX: DRY — centralized offset calculation for invoice listings
    return invoiceRepo.listInvoices(
      { payment_status, from_date, to_date, patient_id },
      { limit, offset }
    );
  }

  async function getInvoiceStats() {
    let rating_stats = {
      total_ratings: 0,
      average_rating: 0,
      five_star_ratings: 0,
      four_star_ratings: 0,
      low_ratings: 0,
    };

    const stats = await invoiceRepo.getInvoiceStats();

    try {
      rating_stats = await invoiceRepo.getServiceRatingStats();
    } catch (err) {
      if (err.code !== '42P01') throw err;
    }

    return {
      ...stats,
      rating_stats,
    };
  }

  async function getInvoiceById(id) {
    return invoiceRepo.getInvoiceById(id);
  }

  async function getInvoiceDetailsById(id) {
    return invoiceRepo.getInvoiceDetailsById(id);
  }

  async function getInvoiceAccessContext(id, db = null) {
    return invoiceRepo.getInvoiceAccessContext(id, db);
  }

  async function canAccessInvoice(user, invoice, db = null) {
    if (!user || !invoice) return false;

    if (user.role === 'ADMIN') {
      return true;
    }

    if (user.role === 'PATIENT') {
      return Boolean(invoice.patient_id)
        && invoice.patient_id === user.id
        && Boolean(invoice.is_patient_visible);
    }

    if (user.role === 'PROVIDER') {
      if (!invoice.request_id) return false;
      return providerHasRequestAccess(invoice.request_id, user.id, db || invoiceRepo.pool);
    }

    return false;
  }

  async function markInvoicePaid(id, payment_method) {
    return invoiceRepo.markInvoicePaid(id, payment_method);
  }

  async function getInvoiceByRequestId(requestId, db = null) {
    return invoiceRepo.getInvoiceByRequestId(requestId, db);
  }

  async function upsertInvoiceForApprovedPayments(
    { requestId, adminId, makePatientVisible = false },
    db = null
  ) {
    const client = db && typeof db.query === 'function' && typeof db.release === 'function'
      ? db
      : await (invoiceRepo.pool || db).connect();
    const isNewClient = client !== db;

    try {
      if (isNewClient) await client.query('BEGIN');

      await invoiceRepo.lockInvoiceByRequestId(requestId, client);

      const approvedPayments = await invoiceRepo.getApprovedPaymentsByRequestId(
        requestId,
        client
      );

      let result = null;

      if (approvedPayments.length) {
        const billingInfo = await invoiceRepo.getRequestBillingInfo(requestId, client);

        if (billingInfo) {
          const totalApprovedAmount = toMoney(
            approvedPayments.reduce((sum, payment) => sum + toMoney(payment.amount), 0)
          );
          const directPaymentTotal = toMoney(
            await invoiceRepo.getDirectPaymentTotalByRequestId(requestId, client)
          );
          const totalPaidAmount = toMoney(totalApprovedAmount + directPaymentTotal);

          const distinctMethods = [
            ...new Set(
              approvedPayments.map((payment) => {
                return normalizeInvoicePaymentMethod(payment.method);
              })
            ),
          ];
          const paymentMethod = distinctMethods.length === 1
            ? distinctMethods[0]
            : 'OTHER';
          const approvedAt = new Date().toISOString();
          // FEAT: COUPON - honor the discount locked at request creation time.
          // Invoice creation reads the stored request values and does not re-validate the coupon.
          const couponDiscountAmount = toMoney(billingInfo.coupon_discount_amount || 0); // FEAT: COUPON — read the frozen coupon discount from the request row.
          const couponCodeSnapshot = billingInfo.coupon_code || null; // FEAT: COUPON — preserve the locked coupon code on the invoice snapshot.
          const appliedCouponId = billingInfo.coupon_id || null; // FEAT: COUPON — carry the locked coupon relation onto the invoice.
          const originalAmount = toMoney(billingInfo.service_price_snapshot || totalApprovedAmount); // FEAT: COUPON — invoice original amount must come from the frozen request price, not the paid total.
          const finalAmount = toMoney(Math.max(0, originalAmount - couponDiscountAmount)); // FEAT: COUPON — recompute the invoice final amount from the frozen request breakdown.
          const status = resolvePaymentStatus(finalAmount, totalPaidAmount); // FEAT: COUPON — derive payment status from final invoice total versus approved payments.

          const existingInvoice = await invoiceRepo.getInvoiceByRequestId(requestId, client);

          if (existingInvoice) {
            const row = await invoiceRepo.updateInvoiceForApprovedPayments(
              requestId,
              {
                originalAmount,
                couponId: appliedCouponId,
                couponDiscountAmount,
                couponCodeSnapshot,
                finalAmount,
                totalApprovedAmount: totalPaidAmount,
                remainingAmount: status.remaining_amount,
                paymentStatus: status.payment_status,
                paymentStatusDetail: status.payment_status_detail,
                paymentMethod,
                adminId,
                makePatientVisible,
              },
              client
            );

            if (row) {
              result = (await syncInvoiceSnapshots(client, row.id, requestId)) || row;
            }
          } else {
            const row = await invoiceRepo.insertInvoiceForApprovedPayments(
              {
                requestId,
                patientId: billingInfo.patient_id || null,
                guestName: billingInfo.guest_name || null,
                originalAmount,
                couponId: appliedCouponId,
                couponDiscountAmount,
                couponCodeSnapshot,
                finalAmount,
                totalApprovedAmount: totalPaidAmount,
                remainingAmount: status.remaining_amount,
                paymentStatus: status.payment_status,
                paymentStatusDetail: status.payment_status_detail,
                paymentMethod,
                adminId,
                approvedAt,
                makePatientVisible,
              },
              client
            );

            if (row) {
              result = (await syncInvoiceSnapshots(client, row.id, requestId)) || row;
            }
          }
        }
      }

      if (isNewClient) await client.query('COMMIT');
      return result;
    } catch (err) {
      if (isNewClient) await client.query('ROLLBACK');
      throw err;
    } finally {
      if (isNewClient) client.release();
    }
  }

  async function listCoupons({ page, limit, is_active }) {
    const { offset } = paginate({ page, limit }); // AUDIT-FIX: DRY — centralized offset calculation for coupon listings
    return invoiceRepo.listCoupons({ is_active }, { limit, offset });
  }

  async function createCoupon(data) {
    return invoiceRepo.createCoupon(data);
  }

  async function getCouponByCode(code) {
    return invoiceRepo.getCouponByCode(code);
  }

  async function validateAndComputeCoupon(code, orderAmount, db = null) {
    return validateCouponCode(code, Number(orderAmount) || 0, db || invoiceRepo.pool);
  }

  async function getCouponById(id) {
    return invoiceRepo.getCouponById(id);
  }

  async function deleteCoupon(id) {
    const row = await invoiceRepo.deleteUnusedCouponRow(id);
    if (row) {
      return { notFound: false, used: false, row };
    }

    const coupon = await invoiceRepo.getCouponDeleteInfo(id);

    if (!coupon) {
      return { notFound: true };
    }

    return { used: Number(coupon.used_count) > 0 };
  }

  async function updateCoupon(id, data) {
    return invoiceRepo.updateCoupon(id, data);
  }

  async function getPaymentRecordsByInvoiceId(invoiceId) {
    const invoice = await invoiceRepo.getInvoiceRequestId(invoiceId);
    if (!invoice || !invoice.request_id) return [];
    return invoiceRepo.getApprovedPaymentRecordsByRequestId(invoice.request_id);
  }

  return {
    listInvoices,
    getInvoiceStats,
    getInvoiceById,
    getInvoiceByRequestId,
    getInvoiceDetailsById,
    getInvoiceAccessContext,
    canAccessInvoice,
    markInvoicePaid,
    upsertInvoiceForApprovedPayments,
    getPaymentRecordsByInvoiceId,
    listCoupons,
    createCoupon,
    getCouponById,
    deleteCoupon,
    getCouponByCode,
    validateAndComputeCoupon,
    updateCoupon,
  };
}

let configuredInvoiceService = null; // AUDIT-FIX: P3-STEP8-DIP - invoice-service singleton wiring now happens outside the module.

function configureInvoiceService(invoiceRepo) { // AUDIT-FIX: P3-STEP8-DIP - composition roots can configure the backward-compatible invoice singleton explicitly.
  configuredInvoiceService = createInvoiceService(invoiceRepo); // AUDIT-FIX: P3-STEP8-DIP - cache the injected repository-backed service for legacy method callers.
  return module.exports; // AUDIT-FIX: P3-STEP8-COMPAT - keep the historical object export shape available after configuration.
} // AUDIT-FIX: P3-STEP8-DIP - configuration helper ends the composition-root bridge for invoice consumers.

function getConfiguredInvoiceService() { // AUDIT-FIX: P3-STEP8-DIP - centralize singleton access so the legacy surface stays intact without config/db.
  if (!configuredInvoiceService) throw new Error('Invoice service is not configured'); // AUDIT-FIX: P3-STEP8-DIP - fail fast if a composition root forgot to inject dependencies.
  return configuredInvoiceService; // AUDIT-FIX: P3-STEP8-DIP - return the injected singleton for legacy method callers.
} // AUDIT-FIX: P3-STEP8-DIP - singleton accessor ends the compatibility bridge.

async function listInvoices(...args) { return getConfiguredInvoiceService().listInvoices(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level listInvoices method without a service-level DB import.
async function getInvoiceStats(...args) { return getConfiguredInvoiceService().getInvoiceStats(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level getInvoiceStats method without a service-level DB import.
async function getInvoiceById(...args) { return getConfiguredInvoiceService().getInvoiceById(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level getInvoiceById method without a service-level DB import.
async function getInvoiceByRequestId(...args) { return getConfiguredInvoiceService().getInvoiceByRequestId(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level getInvoiceByRequestId method without a service-level DB import.
async function getInvoiceDetailsById(...args) { return getConfiguredInvoiceService().getInvoiceDetailsById(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level getInvoiceDetailsById method without a service-level DB import.
async function getInvoiceAccessContext(...args) { return getConfiguredInvoiceService().getInvoiceAccessContext(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level getInvoiceAccessContext method without a service-level DB import.
async function canAccessInvoice(...args) { return getConfiguredInvoiceService().canAccessInvoice(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level canAccessInvoice method without a service-level DB import.
async function markInvoicePaid(...args) { return getConfiguredInvoiceService().markInvoicePaid(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level markInvoicePaid method without a service-level DB import.
async function upsertInvoiceForApprovedPayments(...args) { return getConfiguredInvoiceService().upsertInvoiceForApprovedPayments(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level upsertInvoiceForApprovedPayments method without a service-level DB import.
async function getPaymentRecordsByInvoiceId(...args) { return getConfiguredInvoiceService().getPaymentRecordsByInvoiceId(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level getPaymentRecordsByInvoiceId method without a service-level DB import.
async function listCoupons(...args) { return getConfiguredInvoiceService().listCoupons(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level listCoupons method without a service-level DB import.
async function createCoupon(...args) { return getConfiguredInvoiceService().createCoupon(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level createCoupon method without a service-level DB import.
async function getCouponById(...args) { return getConfiguredInvoiceService().getCouponById(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level getCouponById method without a service-level DB import.
async function deleteCoupon(...args) { return getConfiguredInvoiceService().deleteCoupon(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level deleteCoupon method without a service-level DB import.
async function getCouponByCode(...args) { return getConfiguredInvoiceService().getCouponByCode(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level getCouponByCode method without a service-level DB import.
async function validateAndComputeCoupon(...args) { return getConfiguredInvoiceService().validateAndComputeCoupon(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level validateAndComputeCoupon method without a service-level DB import.
async function updateCoupon(...args) { return getConfiguredInvoiceService().updateCoupon(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level updateCoupon method without a service-level DB import.

module.exports = {
  configureInvoiceService,
  listInvoices,
  getInvoiceStats,
  getInvoiceById,
  getInvoiceByRequestId,
  getInvoiceDetailsById,
  getInvoiceAccessContext,
  canAccessInvoice,
  markInvoicePaid,
  upsertInvoiceForApprovedPayments,
  getPaymentRecordsByInvoiceId,
  listCoupons,
  createCoupon,
  getCouponById,
  deleteCoupon,
  getCouponByCode,
  validateAndComputeCoupon,
  updateCoupon,
  createInvoiceService,
};
