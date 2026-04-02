const BaseRepository = require('./BaseRepository');

class InvoiceRepository extends BaseRepository {
  constructor(pool) {
    super(pool, 'invoices');
  }

  async listInvoices(
    { payment_status, from_date, to_date, patient_id } = {},
    { limit, offset } = {},
    db = null
  ) {
    const where = [];
    const params = [];

    if (payment_status) {
      params.push(payment_status);
      where.push(`i.payment_status = $${params.length}`);
    }

    if (from_date) {
      params.push(from_date);
      where.push(`i.created_at >= $${params.length}`);
    }

    if (to_date) {
      params.push(to_date);
      where.push(`i.created_at <= $${params.length}`);
    }

    if (patient_id) {
      params.push(patient_id);
      where.push(`i.patient_id = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countResult = await this._query(
      `SELECT COUNT(*)::int AS total FROM invoices i ${whereSql}`,
      params,
      db
    );

    params.push(limit);
    params.push(offset);

    const dataResult = await this._query(
      `
      SELECT i.*, sr.request_type, sr.service_type, sr.status AS request_status,
             COALESCE(i.patient_name_snapshot, sr.patient_full_name_snapshot, p.full_name, sr.guest_name, i.guest_name) AS patient_name,
             COALESCE(i.patient_phone_snapshot, sr.patient_phone_snapshot, p.phone, sr.guest_phone) AS patient_phone,
             COALESCE(i.service_name_snapshot, sr.service_name_snapshot) AS service_name,
             COALESCE(i.provider_name_snapshot, sr.assigned_provider_name_snapshot, sr.lead_provider_name_snapshot) AS provider_name
      FROM invoices i
      JOIN service_requests sr ON sr.id = i.request_id
      LEFT JOIN patients p ON p.id = i.patient_id
      ${whereSql}
      ORDER BY i.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params,
      db
    );

    return { data: dataResult.rows, total: countResult.rows[0].total };
  }

  async getInvoiceStats(db = null) {
    const [summaryResult, methodResult, dailyResult] = await Promise.all([
      this._query(
        `
        SELECT
          COALESCE(SUM(CASE WHEN payment_status = 'PAID' THEN final_amount ELSE 0 END), 0) AS total_paid_revenue,
          COALESCE(SUM(CASE WHEN payment_status = 'PENDING' THEN final_amount ELSE 0 END), 0) AS total_pending_amount,
          COUNT(*) FILTER (WHERE payment_status = 'PAID')::int AS paid_invoices,
          COUNT(*) FILTER (WHERE payment_status = 'PENDING')::int AS pending_invoices,
          COUNT(*)::int AS total_invoices
        FROM invoices
        `,
        [],
        db
      ),
      this._query(
        `
        SELECT payment_method, COUNT(*)::int AS count, COALESCE(SUM(final_amount), 0) AS amount
        FROM invoices
        WHERE payment_status = 'PAID' AND payment_method IS NOT NULL
        GROUP BY payment_method
        ORDER BY amount DESC
        `,
        [],
        db
      ),
      this._query(
        `
        SELECT DATE(paid_at) AS day, COALESCE(SUM(final_amount), 0) AS amount
        FROM invoices
        WHERE payment_status = 'PAID' AND paid_at >= NOW() - INTERVAL '30 days'
        GROUP BY DATE(paid_at)
        ORDER BY day ASC
        `,
        [],
        db
      ),
    ]);

    return {
      summary: summaryResult.rows[0],
      by_payment_method: methodResult.rows,
      daily_revenue_last_30_days: dailyResult.rows,
    };
  }

  async getServiceRatingStats(db = null) {
    return this._queryOne(
      `
      SELECT
        COUNT(*)::int AS total_ratings,
        COALESCE(ROUND(AVG(rating)::numeric, 2), 0) AS average_rating,
        COUNT(*) FILTER (WHERE rating = 5)::int AS five_star_ratings,
        COUNT(*) FILTER (WHERE rating = 4)::int AS four_star_ratings,
        COUNT(*) FILTER (WHERE rating <= 3)::int AS low_ratings
      FROM service_ratings
      `,
      [],
      db
    );
  }

  async getInvoiceById(id, db = null) {
    return this._queryOne(
      'SELECT id, payment_status FROM invoices WHERE id = $1',
      [id],
      db
    );
  }

  async getInvoiceDetailsById(id, db = null) {
    return this._queryOne(
      `
      SELECT
        i.id,
        i.request_id,
        i.patient_id,
        i.guest_name,
        i.original_amount,
        i.vip_discount_amount,
        i.coupon_id,
        i.coupon_discount_amount,
        i.coupon_code_snapshot,
        i.points_used,
        i.points_discount_amount,
        i.final_amount,
        i.total_paid,
        i.remaining_amount,
        i.payment_status,
        i.payment_status_detail,
        i.payment_method,
        i.paid_at,
        i.approved_by,
        i.approved_at,
        i.is_patient_visible,
        i.patient_name_snapshot,
        i.patient_phone_snapshot,
        i.patient_address_snapshot,
        i.service_name_snapshot,
        i.service_type_snapshot,
        i.service_description_snapshot,
        i.service_category_name_snapshot,
        i.provider_name_snapshot,
        i.provider_type_snapshot,
        i.pdf_url,
        i.pdf_generated_at,
        i.created_at,
        i.updated_at,
        sr.request_type,
        sr.service_type,
        sr.status AS request_status,
        sr.guest_phone,
        COALESCE(i.patient_name_snapshot, sr.patient_full_name_snapshot, p.full_name, sr.guest_name, i.guest_name) AS patient_name,
        COALESCE(i.patient_phone_snapshot, sr.patient_phone_snapshot, p.phone, sr.guest_phone) AS patient_phone,
        COALESCE(i.coupon_code_snapshot, c.code) AS coupon_code,
        COALESCE(i.service_name_snapshot, sr.service_name_snapshot, s.name, lt.name, pk.name) AS service_name,
        COALESCE(i.provider_name_snapshot, sr.assigned_provider_name_snapshot, sr.lead_provider_name_snapshot) AS provider_name,
        COALESCE(i.provider_type_snapshot, sr.assigned_provider_type_snapshot, sr.lead_provider_type_snapshot) AS provider_type
      FROM invoices i
      LEFT JOIN service_requests sr ON sr.id = i.request_id
      LEFT JOIN patients p ON p.id = i.patient_id
      LEFT JOIN coupons c ON c.id = i.coupon_id
      LEFT JOIN services s ON s.id = sr.service_id
      LEFT JOIN lab_tests lt ON lt.id = sr.lab_test_id
      LEFT JOIN packages pk ON pk.id = sr.package_id
      WHERE i.id = $1
      LIMIT 1
      `,
      [id],
      db
    );
  }

  async getInvoiceAccessContext(id, db = null) {
    return this._queryOne(
      `
      SELECT
        id,
        request_id,
        patient_id,
        is_patient_visible,
        pdf_url,
        pdf_generated_at,
        updated_at
      FROM invoices
      WHERE id = $1
      LIMIT 1
      `,
      [id],
      db
    );
  }

  async markInvoicePaid(id, payment_method, db = null) {
    return this._queryOne(
      `
      UPDATE invoices
      SET payment_status = 'PAID',
          payment_method = $1,
          paid_at = NOW(),
          updated_at = NOW()
      WHERE id = $2
      RETURNING *
      `,
      [payment_method, id],
      db
    );
  }

  async getInvoiceByRequestId(requestId, db = null) {
    return this._queryOne(
      `
      SELECT *
      FROM invoices
      WHERE request_id = $1
      LIMIT 1
      `,
      [requestId],
      db
    );
  }

  async lockInvoiceByRequestId(requestId, db = null) {
    return this._queryOne(
      `SELECT id FROM invoices WHERE request_id = $1 FOR UPDATE`,
      [requestId],
      db
    );
  }

  async getApprovedPaymentsByRequestId(requestId, db = null) {
    const result = await this._query(
      `
      SELECT id, amount, method, created_at
      FROM payment_records
      WHERE request_id = $1
        AND approval_status = 'APPROVED'
      ORDER BY created_at ASC
      `,
      [requestId],
      db
    );

    return result.rows;
  }

  async getRequestBillingInfo(requestId, db = null) {
    return this._queryOne(
      `
      SELECT
        sr.id,
        sr.patient_id,
        sr.guest_name,
        sr.coupon_id,
        sr.coupon_code,
        sr.coupon_discount_amount,
        sr.service_price_snapshot
      FROM service_requests sr
      WHERE id = $1
      LIMIT 1
      FOR UPDATE
      `,
      [requestId],
      db
    );
  }

  async getDirectPaymentTotalByRequestId(requestId, db = null) {
    const row = await this._queryOne(
      `
      SELECT COALESCE(SUM(p.amount), 0) AS total
      FROM invoices i
      LEFT JOIN payments p ON p.invoice_id = i.id
      WHERE i.request_id = $1
      GROUP BY i.id
      `,
      [requestId],
      db
    );

    return row ? row.total : 0;
  }

  async updateInvoiceForApprovedPayments(
    requestId,
    {
      originalAmount,
      couponId,
      couponDiscountAmount,
      couponCodeSnapshot,
      finalAmount,
      totalApprovedAmount,
      remainingAmount,
      paymentStatus,
      paymentStatusDetail,
      paymentMethod,
      adminId,
      makePatientVisible,
    },
    db = null
  ) {
    return this._queryOne(
      `
      UPDATE invoices
      SET original_amount = $2,
          coupon_id = $3,
          coupon_discount_amount = $4,
          coupon_code_snapshot = $5,
          final_amount = $6,
          total_paid = $7,
          remaining_amount = $8,
          payment_status = $9,
          payment_status_detail = $10,
          payment_method = $11,
          paid_at = CASE WHEN $9::payment_status = 'PAID'::payment_status THEN COALESCE(paid_at, NOW()) ELSE paid_at END, -- FEAT: COUPON — cast the status placeholder consistently so invoice updates do not hit enum/text inference errors.
          approved_by = $12,
          approved_at = NOW(),
          is_patient_visible = CASE
            WHEN $13 THEN TRUE
            ELSE COALESCE(is_patient_visible, FALSE)
          END,
          updated_at = NOW()
      WHERE request_id = $1
      RETURNING *
      `,
      [
        requestId,
        originalAmount,
        couponId,
        couponDiscountAmount,
        couponCodeSnapshot,
        finalAmount,
        totalApprovedAmount,
        remainingAmount,
        paymentStatus,
        paymentStatusDetail,
        paymentMethod,
        adminId,
        makePatientVisible,
      ],
      db
    );
  }

  async insertInvoiceForApprovedPayments(
    {
      requestId,
      patientId,
      guestName,
      originalAmount,
      couponId,
      couponDiscountAmount,
      couponCodeSnapshot,
      finalAmount,
      totalApprovedAmount,
      remainingAmount,
      paymentStatus,
      paymentStatusDetail,
      paymentMethod,
      adminId,
      approvedAt,
      makePatientVisible,
    },
    db = null
  ) {
    return this._queryOne(
      `
      INSERT INTO invoices (
        request_id,
        patient_id,
        guest_name,
        original_amount,
        vip_discount_amount,
        coupon_id,
        coupon_discount_amount,
        coupon_code_snapshot,
        points_used,
        points_discount_amount,
        final_amount,
        total_paid,
        remaining_amount,
        payment_status,
        payment_status_detail,
        payment_method,
        paid_at,
        approved_by,
        approved_at,
        is_patient_visible
      )
      VALUES (
        $1,$2,$3,$4,0,$5,$6,$7,0,0,$8,$9,$10,$11,$12,$13,
        CASE WHEN $11::payment_status = 'PAID'::payment_status THEN $14::timestamp ELSE NULL::timestamp END,
        $15,$14,$16
      )
      RETURNING *
      `,
      [
        requestId,
        patientId,
        guestName,
        originalAmount,
        couponId,
        couponDiscountAmount,
        couponCodeSnapshot,
        finalAmount,
        totalApprovedAmount,
        remainingAmount,
        paymentStatus,
        paymentStatusDetail,
        paymentMethod,
        approvedAt,
        adminId,
        makePatientVisible,
      ],
      db
    );
  }

  async listCoupons({ is_active } = {}, { limit, offset } = {}, db = null) {
    const where = [];
    const params = [];

    if (typeof is_active !== 'undefined') {
      params.push(is_active);
      where.push(`is_active = $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countResult = await this._query(
      `SELECT COUNT(*)::int AS total FROM coupons ${whereSql}`,
      params,
      db
    );

    params.push(limit);
    params.push(offset);

    const dataResult = await this._query(
      `
      SELECT *
      FROM coupons
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
      `,
      params,
      db
    );

    return { data: dataResult.rows, total: countResult.rows[0].total };
  }

  async createCoupon(data, db = null) {
    const {
      code,
      discount_type,
      discount_value,
      min_order_amount,
      max_uses,
      expires_at,
    } = data;

    return this._queryOne(
      `
      INSERT INTO coupons (code, discount_type, discount_value, min_order_amount, max_uses, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [
        code,
        discount_type,
        discount_value,
        min_order_amount || 0,
        max_uses || 1,
        expires_at || null,
      ],
      db
    );
  }

  async getCouponByCode(code, db = null) {
    return this._queryOne(
      `
      SELECT *,
             CASE
               WHEN is_active = FALSE THEN FALSE
               WHEN expires_at IS NOT NULL AND expires_at <= NOW() THEN FALSE
               WHEN used_count >= max_uses THEN FALSE
               ELSE TRUE
             END AS is_valid
      FROM coupons
      WHERE code = $1
      LIMIT 1
      `,
      [code],
      db
    );
  }

  async getCouponById(id, db = null) {
    return this._queryOne(
      `
      SELECT *
      FROM coupons
      WHERE id = $1
      LIMIT 1
      `,
      [id],
      db
    );
  }

  async getCouponDeleteInfo(id, db = null) {
    return this._queryOne(
      `
      SELECT id, used_count
      FROM coupons
      WHERE id = $1
      LIMIT 1
      `,
      [id],
      db
    );
  }

  async deleteCouponRow(id, db = null) {
    return this._queryOne(
      `
      DELETE FROM coupons
      WHERE id = $1
      RETURNING *
      `,
      [id],
      db
    );
  }

  async deleteUnusedCouponRow(id, db = null) {
    return this._queryOne(
      `
      DELETE FROM coupons
      WHERE id = $1
        AND COALESCE(used_count, 0) = 0
      RETURNING *
      `,
      [id],
      db
    );
  }

  async updateCoupon(id, data, db = null) {
    const allowedFields = [
      'code',
      'discount_type',
      'discount_value',
      'min_order_amount',
      'max_uses',
      'expires_at',
      'is_active',
    ];

    const updates = [];
    const params = [];

    allowedFields.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(data, field)) {
        params.push(data[field]);
        updates.push(`${field} = $${params.length}`);
      }
    });

    if (!updates.length) {
      return { noUpdates: true };
    }

    params.push(id);

    return {
      noUpdates: false,
      row: await this._queryOne(
        `
        UPDATE coupons
        SET ${updates.join(', ')}
        WHERE id = $${params.length}
        RETURNING *
        `,
        params,
        db
      ),
    };
  }

  async getInvoiceRequestId(invoiceId, db = null) {
    return this._queryOne(
      'SELECT request_id FROM invoices WHERE id = $1 LIMIT 1',
      [invoiceId],
      db
    );
  }

  async getApprovedPaymentRecordsByRequestId(requestId, db = null) {
    const result = await this._query(
      `
      SELECT
        pr.id,
        pr.amount,
        pr.method AS payment_method,
        pr.notes,
        pr.approval_status,
        pr.recorder_role,
        pr.created_at,
        pr.approved_at
      FROM payment_records pr
      WHERE pr.request_id = $1
        AND pr.approval_status = 'APPROVED'
      ORDER BY pr.created_at ASC
      `,
      [requestId],
      db
    );

    return result.rows;
  }
}

module.exports = InvoiceRepository;
