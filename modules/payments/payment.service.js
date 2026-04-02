const { syncInvoiceSnapshots } = require('../../utils/requestSnapshots');
const PaymentRepository = require('../../repositories/PaymentRepository');
const { paginate } = require('../../utils/pagination');

function createPaymentService(paymentRepo) {
  function toMoney(value) {
    const n = Math.round(Number(value) * 1000) / 1000;
    return Number.isFinite(n) ? n : 0;
  }

  async function getInvoiceWithPayments(invoiceId) {
    const result = await paymentRepo.getInvoiceWithPayments(invoiceId);
    if (!result) return null;

    const { invoice, payments } = result;
    const totalPaid = toMoney(payments.reduce((sum, p) => sum + toMoney(p.amount), 0));
    const totalProviderPaid = toMoney(
      payments
        .filter((p) => p.paid_to_provider)
        .reduce((sum, p) => sum + toMoney(p.provider_amount || 0), 0)
    );

    return {
      invoice,
      payments,
      summary: {
        original_amount: toMoney(invoice.original_amount),
        vip_discount: toMoney(invoice.vip_discount_amount || 0),
        coupon_discount: toMoney(invoice.coupon_discount_amount || 0),
        points_discount: toMoney(invoice.points_discount_amount || 0),
        final_amount: toMoney(invoice.final_amount),
        total_paid: totalPaid,
        remaining: toMoney(Math.max(0, toMoney(invoice.final_amount) - totalPaid)),
        total_provider_paid: totalProviderPaid,
        payment_status: invoice.payment_status_detail || invoice.payment_status,
      },
    };
  }

  async function addPayment(invoiceId, paymentData, actor) {
    const {
      amount,
      payment_method,
      paid_to_provider,
      provider_id,
      provider_amount,
      notes,
      reference_number,
    } = paymentData;
    const normalizedAmount = toMoney(amount);
    const normalizedProviderAmount = provider_amount == null
      ? null
      : toMoney(provider_amount);

    return paymentRepo.withTransaction(async (client) => {
      const invoice = await paymentRepo.getInvoiceForUpdate(invoiceId, client);

      if (!invoice) {
        return {
          error: {
            status: 404,
            body: { message: 'Invoice not found', code: 'INVOICE_NOT_FOUND' },
          },
        };
      }

      if (invoice.payment_status === 'CANCELLED') {
        return {
          error: {
            status: 400,
            body: {
              message: 'Cannot pay a cancelled invoice',
              code: 'INVOICE_CANCELLED',
            },
          },
        };
      }

      const finalAmount = toMoney(invoice.final_amount);
      const currentPaid = toMoney(invoice.total_paid || 0);
      const newTotalPaid = toMoney(currentPaid + normalizedAmount);
      const remaining = toMoney(Math.max(0, finalAmount - newTotalPaid));
      const remainingBalance = toMoney(finalAmount - currentPaid);

      if (remainingBalance <= 0) {
        return {
          error: {
            status: 400,
            body: {
              message: 'Invoice is already fully paid',
              code: 'INVOICE_FULLY_PAID',
              remaining: '0.000',
            },
          },
        };
      }

      if (normalizedAmount > toMoney(remainingBalance + 0.001)) {
        return {
          error: {
            status: 400,
            body: {
              message: `Payment amount (${amount}) exceeds remaining balance (${remainingBalance.toFixed(3)})`,
              code: 'OVERPAYMENT',
              remaining: remainingBalance.toFixed(3),
            },
          },
        };
      }

      const payment = await paymentRepo.insertPayment(
        {
          invoiceId,
          patientId: invoice.patient_id,
          payerName: invoice.guest_name,
          amount: normalizedAmount,
          paymentMethod: payment_method,
          paidToProvider: paid_to_provider,
          providerId: provider_id,
          providerAmount: normalizedProviderAmount,
          notes,
          referenceNumber: reference_number,
          recordedBy: actor.id,
          recordedByRole: actor.role,
        },
        client
      );

      const status = remaining <= 0 ? 'PAID' : 'PARTIAL';
      await paymentRepo.updateInvoiceTotalsAfterPayment(
        invoiceId,
        {
          totalPaid: newTotalPaid,
          remaining,
          status,
          paymentMethod: payment_method,
        },
        client
      );

      await syncInvoiceSnapshots(client, invoiceId, invoice.request_id);

      return {
        payment,
        message: remaining <= 0
          ? 'Invoice paid in full'
          : `Payment recorded. Remaining: ${remaining.toFixed(3)}`,
        summary: {
          total_paid: newTotalPaid,
          remaining,
          status,
          is_fully_paid: remaining <= 0,
        },
        notify: {
          invoiceId,
          patientId: invoice.patient_id,
          amount: normalizedAmount,
          remaining,
          method: payment_method,
        },
      };
    });
  }

  async function deletePayment(paymentId) {
    return paymentRepo.withTransaction(async (client) => {
      const payment = await paymentRepo.getPaymentForUpdate(paymentId, client);

      if (!payment) {
        return {
          error: {
            status: 404,
            body: { message: 'Payment not found', code: 'PAYMENT_NOT_FOUND' },
          },
        };
      }

      await paymentRepo.deletePaymentRow(payment.id, client);

      await paymentRepo.lockInvoiceForUpdate(payment.invoice_id, client);

      const directPaidTotal = toMoney(
        await paymentRepo.getInvoicePaidTotal(payment.invoice_id, client)
      );
      const approvedPaidTotal = toMoney(
        await paymentRepo.getApprovedPaymentRecordTotalForInvoice(payment.invoice_id, client)
      );
      const paidTotal = toMoney(directPaidTotal + approvedPaidTotal);
      const invoiceRow = await paymentRepo.getInvoiceFinalAmount(
        payment.invoice_id,
        client
      );
      const finalAmount = toMoney(invoiceRow.final_amount);
      const remaining = toMoney(Math.max(0, finalAmount - paidTotal));
      const status = paidTotal <= 0
        ? 'UNPAID'
        : (remaining <= 0 ? 'PAID' : 'PARTIAL');

      await paymentRepo.updateInvoiceTotalsAfterPaymentDeletion(
        payment.invoice_id,
        {
          totalPaid: paidTotal,
          remaining,
          status,
        },
        client
      );

      const request = await paymentRepo.getInvoiceRequestId(
        payment.invoice_id,
        client
      );

      await syncInvoiceSnapshots(
        client,
        payment.invoice_id,
        request?.request_id || null
      );

      return {
        deletedPayment: payment,
        message: 'Payment deleted and invoice totals updated',
      };
    });
  }

  async function getProviderPayments(providerId, { from, to, page, limit } = {}) {
    const {
      limit: safeLimit,
      offset,
    } = paginate({ page, limit }, { defaultLimit: 200, maxLimit: 200 });
    const result = await paymentRepo.getProviderPayments(providerId, {
      from,
      to,
      limit: safeLimit,
      offset,
    });
    const provider = await paymentRepo.getProviderSummary(providerId);

    return {
      provider,
      payments: result.rows,
      total_paid_to_provider: toMoney(result.total_paid_to_provider),
      count: Number(result.total) || 0,
    };
  }

  return {
    getInvoiceWithPayments,
    addPayment,
    deletePayment,
    getProviderPayments,
  };
}

let configuredPaymentService = null; // AUDIT-FIX: P3-STEP8-DIP - payment-service singleton wiring now happens outside the module.

function configurePaymentService(paymentRepo) { // AUDIT-FIX: P3-STEP8-DIP - composition roots can configure the backward-compatible payment singleton explicitly.
  configuredPaymentService = createPaymentService(paymentRepo); // AUDIT-FIX: P3-STEP8-DIP - cache the injected repository-backed service for legacy method callers.
  return module.exports; // AUDIT-FIX: P3-STEP8-COMPAT - keep the historical object export shape available after configuration.
} // AUDIT-FIX: P3-STEP8-DIP - configuration helper ends the composition-root bridge for payment consumers.

function getConfiguredPaymentService() { // AUDIT-FIX: P3-STEP8-DIP - centralize singleton access so the legacy surface stays intact without config/db.
  if (!configuredPaymentService) throw new Error('Payment service is not configured'); // AUDIT-FIX: P3-STEP8-DIP - fail fast if a composition root forgot to inject dependencies.
  return configuredPaymentService; // AUDIT-FIX: P3-STEP8-DIP - return the injected singleton for legacy method callers.
} // AUDIT-FIX: P3-STEP8-DIP - singleton accessor ends the compatibility bridge.

async function getInvoiceWithPayments(...args) { return getConfiguredPaymentService().getInvoiceWithPayments(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level getInvoiceWithPayments method without a service-level DB import.
async function addPayment(...args) { return getConfiguredPaymentService().addPayment(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level addPayment method without a service-level DB import.
async function deletePayment(...args) { return getConfiguredPaymentService().deletePayment(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level deletePayment method without a service-level DB import.
async function getProviderPayments(...args) { return getConfiguredPaymentService().getProviderPayments(...args); } // AUDIT-FIX: P3-STEP8-COMPAT - preserve the legacy top-level getProviderPayments method without a service-level DB import.

module.exports = {
  configurePaymentService,
  getInvoiceWithPayments,
  addPayment,
  deletePayment,
  getProviderPayments,
  createPaymentService,
};
