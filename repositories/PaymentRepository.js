const BaseRepository = require('./BaseRepository');

class PaymentRepository extends BaseRepository {
  constructor(pool) {
    super(pool, 'payments');
  }

  async getInvoiceWithPayments(invoiceId, db = null) {
    const [invoiceResult, paymentsResult] = await Promise.all([
      this._queryOne(
        `
        SELECT
          i.*,
          sr.id AS request_id,
          sr.request_type,
          sr.service_type,
          sr.status AS request_status,
          sr.guest_name,
          sr.guest_phone,
          COALESCE(i.patient_name_snapshot, sr.patient_full_name_snapshot, p.full_name, sr.guest_name, i.guest_name) AS patient_name,
          COALESCE(i.patient_phone_snapshot, sr.patient_phone_snapshot, p.phone, sr.guest_phone) AS patient_phone,
          p.is_vip,
          COALESCE(i.service_name_snapshot, sr.service_name_snapshot, s.name) AS service_name,
          COALESCE(i.service_name_snapshot, sr.service_name_snapshot, lt.name) AS lab_test_name,
          COALESCE(i.service_name_snapshot, sr.service_name_snapshot, pk.name) AS package_name,
          c.code AS coupon_code,
          c.discount_type AS coupon_discount_type,
          c.discount_value AS coupon_discount_value
        FROM invoices i
        LEFT JOIN service_requests sr ON sr.id = i.request_id
        LEFT JOIN patients p ON p.id = i.patient_id
        LEFT JOIN services s ON s.id = sr.service_id
        LEFT JOIN lab_tests lt ON lt.id = sr.lab_test_id
        LEFT JOIN packages pk ON pk.id = sr.package_id
        LEFT JOIN coupons c ON c.id = i.coupon_id
        WHERE i.id = $1
        `,
        [invoiceId],
        db
      ),
      this._query(
        `
        SELECT
          pay.*,
          sp.full_name AS provider_name
        FROM payments pay
        LEFT JOIN service_providers sp ON sp.id = pay.provider_id
        WHERE pay.invoice_id = $1
        ORDER BY pay.created_at ASC
        `,
        [invoiceId],
        db
      ),
    ]);

    if (!invoiceResult) return null;

    return {
      invoice: invoiceResult,
      payments: paymentsResult.rows,
    };
  }

  async getInvoiceForUpdate(invoiceId, db = null) {
    return this._queryOne(
      'SELECT * FROM invoices WHERE id = $1 FOR UPDATE',
      [invoiceId],
      db
    );
  }

  async insertPayment(
    {
      invoiceId,
      patientId,
      payerName,
      amount,
      paymentMethod,
      paidToProvider,
      providerId,
      providerAmount,
      notes,
      referenceNumber,
      recordedBy,
      recordedByRole,
    },
    db = null
  ) {
    return this._queryOne(
      `
      INSERT INTO payments
        (invoice_id, patient_id, payer_name, amount, payment_method,
         paid_to_provider, provider_id, provider_amount,
         notes, reference_number, recorded_by, recorded_by_role)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
      `,
      [
        invoiceId,
        patientId,
        payerName,
        amount,
        paymentMethod,
        paidToProvider,
        providerId || null,
        providerAmount || null,
        notes || null,
        referenceNumber || null,
        recordedBy,
        recordedByRole,
      ],
      db
    );
  }

  async updateInvoiceTotalsAfterPayment(
    invoiceId,
    { totalPaid, remaining, status, paymentMethod },
    db = null
  ) {
    await this._query(
      `
      UPDATE invoices SET
        total_paid = $1,
        remaining_amount = $2,
        payment_status_detail = $3,
        payment_status = CASE WHEN $4 = 'PAID' THEN 'PAID'::payment_status ELSE payment_status END,
        paid_at = CASE WHEN $4 = 'PAID' THEN NOW() ELSE paid_at END,
        payment_method = CASE WHEN $4 = 'PAID' THEN $5::payment_method ELSE payment_method END,
        updated_at = NOW()
      WHERE id = $6
      `,
      [totalPaid, remaining, status, status, paymentMethod, invoiceId],
      db
    );
  }

  async getPaymentForUpdate(paymentId, db = null) {
    return this._queryOne(
      'SELECT * FROM payments WHERE id = $1 FOR UPDATE',
      [paymentId],
      db
    );
  }

  async deletePaymentRow(paymentId, db = null) {
    await this._query(
      'DELETE FROM payments WHERE id = $1',
      [paymentId],
      db
    );
  }

  async getInvoicePaidTotal(invoiceId, db = null) {
    const row = await this._queryOne(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE invoice_id = $1',
      [invoiceId],
      db
    );

    return row.total;
  }

  async lockInvoiceForUpdate(invoiceId, db = null) {
    return this._queryOne(
      'SELECT id, final_amount, total_paid FROM invoices WHERE id = $1 FOR UPDATE',
      [invoiceId],
      db
    );
  }

  async getApprovedPaymentRecordTotalForInvoice(invoiceId, db = null) {
    const row = await this._queryOne(
      `
      SELECT COALESCE(SUM(pr.amount), 0) AS total
      FROM invoices i
      LEFT JOIN payment_records pr
        ON pr.request_id = i.request_id
       AND pr.approval_status = 'APPROVED'
      WHERE i.id = $1
      GROUP BY i.id
      `,
      [invoiceId],
      db
    );

    return row ? row.total : 0;
  }

  async getInvoiceFinalAmount(invoiceId, db = null) {
    return this._queryOne(
      'SELECT final_amount FROM invoices WHERE id = $1',
      [invoiceId],
      db
    );
  }

  async updateInvoiceTotalsAfterPaymentDeletion(
    invoiceId,
    { totalPaid, remaining, status },
    db = null
  ) {
    await this._query(
      `
      UPDATE invoices SET
        total_paid = $1,
        remaining_amount = $2,
        payment_status_detail = $3,
        payment_status = CASE WHEN $3 = 'PAID' THEN 'PAID'::payment_status ELSE 'PENDING'::payment_status END,
        paid_at = CASE WHEN $3 = 'PAID' THEN paid_at ELSE NULL END,
        updated_at = NOW()
      WHERE id = $4
      `,
      [totalPaid, remaining, status, invoiceId],
      db
    );
  }

  async getInvoiceRequestId(invoiceId, db = null) {
    return this._queryOne(
      'SELECT request_id FROM invoices WHERE id = $1 LIMIT 1',
      [invoiceId],
      db
    );
  }

  async getProviderPayments(providerId, { from, to, limit = 200, offset = 0 } = {}, db = null) {
    let dateFilter = '';
    const params = [providerId];

    if (from) {
      params.push(from);
      dateFilter += ` AND pay.created_at >= $${params.length}`;
    }

    if (to) {
      params.push(to);
      dateFilter += ` AND pay.created_at <= $${params.length}`;
    }

    const listParams = [...params, limit, offset];
    const [result, totals] = await Promise.all([
      this._query(
        `
        SELECT
          pay.*,
          i.final_amount AS invoice_total,
          i.request_id,
          sr.service_type,
          sr.guest_name,
          p.full_name AS patient_name
        FROM payments pay
        JOIN invoices i ON i.id = pay.invoice_id
        LEFT JOIN service_requests sr ON sr.id = i.request_id
        LEFT JOIN patients p ON p.id = i.patient_id
        WHERE pay.provider_id = $1 AND pay.paid_to_provider = TRUE ${dateFilter}
        ORDER BY pay.created_at DESC
        LIMIT $${params.length + 1}
        OFFSET $${params.length + 2}
        `,
        listParams,
        db
      ),
      this._queryOne(
        `
        SELECT
          COUNT(*)::int AS total,
          COALESCE(SUM(pay.provider_amount), 0) AS total_paid_to_provider
        FROM payments pay
        WHERE pay.provider_id = $1 AND pay.paid_to_provider = TRUE ${dateFilter}
        `,
        params,
        db
      ),
    ]);

    return {
      rows: result.rows,
      total: totals?.total || 0,
      total_paid_to_provider: totals?.total_paid_to_provider || 0,
    };
  }

  async getProviderSummary(providerId, db = null) {
    return this._queryOne(
      'SELECT id, full_name, type, phone FROM service_providers WHERE id = $1',
      [providerId],
      db
    );
  }
}

module.exports = PaymentRepository;
