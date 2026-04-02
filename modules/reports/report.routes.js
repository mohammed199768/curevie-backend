const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs/promises');
const pool = require('../../config/db');
const ReportRepository = require('../../repositories/ReportRepository'); // AUDIT-FIX: P3-STEP8-DIP - report routes now wire the concrete report repository explicitly.
const { authenticate, adminOnly, staffOnly } = require('../../middlewares/auth');
const { apiLimiter, readLimiter } = require('../../middlewares/rateLimiter');
const asyncHandler = require('../../utils/asyncHandler');
const { generateInvoicePdf, processUploadedFile } = require('../../utils/pdfEngine');
const { uploadSingleImage } = require('../../utils/upload');
const multer = require('multer');
const { randomUUID } = require('crypto');
const reportControllerModule = require('./report.controller'); // AUDIT-FIX: P3-STEP8-DIP - report routes now configure the controller instead of relying on controller-side composition.
const reportService = require('./report.service'); // AUDIT-FIX: P3-STEP8-DIP - report routes now configure the service singleton explicitly.
const invoiceService = require('../invoices/invoice.service');
const {
  readStoredPdfBuffer,
  storeGeneratedPdf,
  deleteStoredPdf,
} = require('../../utils/pdf/storage');

const reportRepository = new ReportRepository(pool); // AUDIT-FIX: P3-STEP8-DIP - report routes own the concrete repository instance.
reportService.configureReportService(reportRepository); // AUDIT-FIX: P3-STEP8-DIP - route-level composition now wires the backward-compatible report service singleton explicitly.
const reportController = reportControllerModule.createReportController({ reportRepository }); // AUDIT-FIX: P3-STEP8-DIP - report routes inject the configured repository into the controller.

function toEndOfDay(value) {
  const date = new Date(value);
  date.setHours(23, 59, 59, 999);
  return date;
}

// Multer لقبول أي ملف
const anyUpload = multer({
  // AUDIT-FIX: PATH — use __dirname so uploads resolve inside backend/
  dest: path.join(__dirname, '..', '..', 'uploads', 'temp'),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
}).single('file');

// =============================================
// GET /api/reports/financial
// تقرير مالي شامل
// =============================================
router.get('/financial', authenticate, adminOnly, readLimiter, asyncHandler(async (req, res) => {
  const { period = 'monthly', from, to, year, month } = req.query;

  let dateFrom, dateTo;
  const now = new Date();

  if (from || to) {
    dateFrom = from ? new Date(from) : new Date('2000-01-01');
    dateTo   = to ? toEndOfDay(to) : new Date();
  } else if (period === 'daily') {
    dateFrom = new Date(now.setHours(0, 0, 0, 0));
    dateTo   = new Date();
  } else if (period === 'monthly') {
    const m = month ? parseInt(month) - 1 : now.getMonth();
    const y = year ? parseInt(year) : now.getFullYear();
    dateFrom = new Date(y, m, 1);
    dateTo   = new Date(y, m + 1, 0, 23, 59, 59);
  } else if (period === 'yearly') {
    const y = year ? parseInt(year) : now.getFullYear();
    dateFrom = new Date(y, 0, 1);
    dateTo   = new Date(y, 11, 31, 23, 59, 59);
  }

  // إجماليات الفواتير
  const totalsQuery = pool.query(`
    SELECT
      COUNT(*)::int                                              AS total_invoices,
      COUNT(*) FILTER (WHERE payment_status = 'PAID')::int      AS paid_invoices,
      COUNT(*) FILTER (WHERE payment_status = 'PENDING')::int   AS pending_invoices,
      COUNT(*) FILTER (WHERE payment_status = 'CANCELLED')::int AS cancelled_invoices,
      COALESCE(SUM(original_amount), 0)                         AS gross_revenue,
      COALESCE(SUM(final_amount), 0)                            AS net_revenue,
      COALESCE(SUM(total_paid), 0)                              AS collected_revenue,
      COALESCE(SUM(remaining_amount), 0)                        AS pending_revenue,
      COALESCE(SUM(vip_discount_amount), 0)                     AS total_vip_discounts,
      COALESCE(SUM(coupon_discount_amount), 0)                  AS total_coupon_discounts,
      COALESCE(SUM(points_discount_amount), 0)                  AS total_points_discounts,
      COALESCE(SUM(total_paid), 0)                              AS total_collected
    FROM invoices
    WHERE created_at BETWEEN $1 AND $2
  `, [dateFrom, dateTo]);

  // إحصاءات الطلبات
  const requestsQuery = pool.query(`
    SELECT
      COUNT(*)::int                                                  AS total_requests,
      COUNT(*) FILTER (WHERE status IN ('COMPLETED', 'CLOSED'))::int AS completed,
      COUNT(*) FILTER (WHERE status = 'PENDING')::int               AS pending,
      COUNT(*) FILTER (WHERE status = 'CANCELLED')::int             AS cancelled,
      COUNT(*) FILTER (WHERE request_type = 'GUEST')::int           AS guest_requests,
      COUNT(*) FILTER (WHERE request_type = 'PATIENT')::int         AS patient_requests,
      COUNT(*) FILTER (WHERE service_type = 'MEDICAL')::int         AS medical_count,
      COUNT(*) FILTER (WHERE service_type = 'LAB')::int             AS lab_count,
      COUNT(*) FILTER (WHERE service_type = 'PACKAGE')::int         AS package_count,
      COUNT(*) FILTER (WHERE service_type = 'RADIOLOGY')::int       AS xray_count
    FROM service_requests
    WHERE created_at BETWEEN $1 AND $2
  `, [dateFrom, dateTo]);

  // إحصاءات الدفع
  const paymentStatsQuery = pool.query(`
    SELECT
      payment_method,
      COUNT(*)::int AS count,
      SUM(amount) AS total
    FROM payments
    WHERE created_at BETWEEN $1 AND $2
    GROUP BY payment_method
    ORDER BY total DESC
  `, [dateFrom, dateTo]);

  // أعلى الخدمات مبيعاً
  const topServicesQuery = pool.query(`
    SELECT
      COALESCE(i.service_name_snapshot, sr.service_name_snapshot, s.name, lt.name, lp.name_en, lpk.name_en, pk.name, 'Unknown') AS service_name,
      sr.service_type,
      COUNT(*)::int AS count,
      COALESCE(SUM(i.final_amount), 0) AS revenue
    FROM service_requests sr
    LEFT JOIN invoices i ON i.request_id = sr.id
    LEFT JOIN services s ON s.id = sr.service_id
    LEFT JOIN lab_tests lt ON lt.id = sr.lab_test_id
    LEFT JOIN lab_panels lp ON lp.id = sr.lab_panel_id
    LEFT JOIN lab_packages lpk ON lpk.id = sr.lab_package_id
    LEFT JOIN packages pk ON pk.id = sr.package_id
    WHERE sr.created_at BETWEEN $1 AND $2
      AND sr.status IN ('COMPLETED', 'CLOSED')
    GROUP BY service_name, sr.service_type
    ORDER BY revenue DESC
    LIMIT 10
  `, [dateFrom, dateTo]);

  // تقرير يومي (للمخطط البياني)
  const dailyBreakdownQuery = pool.query(`
    SELECT
      DATE(i.created_at) AS date,
      COUNT(i.id)::int AS invoices,
      COALESCE(SUM(i.final_amount), 0) AS revenue,
      COALESCE(SUM(p.day_collected), 0) AS collected
    FROM invoices i
    LEFT JOIN (
      SELECT
        invoice_id,
        DATE(created_at) AS pay_date,
        SUM(amount) AS day_collected
      FROM payments
      WHERE created_at BETWEEN $1 AND $2
      GROUP BY invoice_id, DATE(created_at)
    ) p ON p.invoice_id = i.id AND p.pay_date = DATE(i.created_at)
    WHERE i.created_at BETWEEN $1 AND $2
    GROUP BY DATE(i.created_at)
    ORDER BY date ASC
  `, [dateFrom, dateTo]);

  const [
    totals,
    requests,
    paymentStats,
    topServices,
    dailyBreakdown,
  ] = await Promise.all([
    totalsQuery,
    requestsQuery,
    paymentStatsQuery,
    topServicesQuery,
    dailyBreakdownQuery,
  ]);

  res.json({
    period: { type: period, from: dateFrom, to: dateTo },
    summary: totals.rows[0],
    requests: requests.rows[0],
    payment_methods: paymentStats.rows,
    top_services: topServices.rows,
    daily_breakdown: dailyBreakdown.rows,
  });
}));

// =============================================
// GET /api/reports/invoice/:invoiceId/pdf
// تصدير فاتورة PDF
// =============================================
router.get('/invoice/:invoiceId/pdf', authenticate, asyncHandler(async (req, res) => {
  const { invoiceId } = req.params;
  if (!['ADMIN', 'PROVIDER', 'PATIENT'].includes(req.user.role)) {
    return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
  }

  const invoice = await invoiceService.getInvoiceAccessContext(invoiceId);
  if (!invoice) {
    return res.status(404).json({ message: 'Invoice not found', code: 'INVOICE_NOT_FOUND' });
  }

  const hasAccess = await invoiceService.canAccessInvoice(req.user, invoice);
  if (!hasAccess) {
    return res.status(403).json({ message: 'Access denied', code: 'FORBIDDEN' });
  }

  const invoiceUpdatedAt = invoice.updated_at ? new Date(invoice.updated_at) : null;
  const pdfGeneratedAt = invoice.pdf_generated_at ? new Date(invoice.pdf_generated_at) : null;
  const hasFreshCachedPdf = Boolean(
    invoice.pdf_url
      && pdfGeneratedAt
      && invoiceUpdatedAt
      && pdfGeneratedAt >= invoiceUpdatedAt
  );

  let pdfBuffer = null;
  if (hasFreshCachedPdf) {
    try {
      pdfBuffer = await readStoredPdfBuffer(invoice.pdf_url);
    } catch (_) {
      pdfBuffer = null;
    }
  }

  if (!pdfBuffer) {
    const previousPdfUrl = invoice.pdf_url || null;
    const generatedPdfPath = await generateInvoicePdf(invoiceId);

    try {
      pdfBuffer = await fsPromises.readFile(generatedPdfPath);
    } finally {
      await fsPromises.unlink(generatedPdfPath).catch(() => {});
    }

    const persistedPdfUrl = await storeGeneratedPdf(
      pdfBuffer,
      `invoice-${invoiceId}.pdf`,
      'invoices'
    );

    if (persistedPdfUrl) {
      await pool.query(
        `
        UPDATE invoices
        SET pdf_url = $2,
            pdf_generated_at = NOW()
        WHERE id = $1
        `,
        [invoiceId, persistedPdfUrl]
      );

      if (previousPdfUrl && previousPdfUrl !== persistedPdfUrl) {
        await deleteStoredPdf(previousPdfUrl).catch(() => {});
      }
    }
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoiceId.slice(0, 8)}.pdf"`);
  res.setHeader('Content-Length', String(pdfBuffer.length));

  // حذف الملف بعد الإرسال
  return res.status(200).send(pdfBuffer);
}));

router.get(
  '/requests/:id/medical/pdf',
  authenticate,
  asyncHandler(reportController.downloadMedicalRequestPdf)
);

// =============================================
// POST /api/reports/convert
// تحويل أي ملف → PDF مع Watermark
// =============================================
router.post('/convert', authenticate, staffOnly, apiLimiter, (req, res, next) => {
  anyUpload(req, res, async (err) => {
    if (err) return next(err);
    if (!req.file) return res.status(400).json({ message: 'لم يتم رفع أي ملف', code: 'NO_FILE' });

    try {
      const { success, outputPath } = await processUploadedFile(
        req.file.path,
        req.file.originalname,
        { opacity: 0.08 }
      );

      if (!success) {
        return res.status(500).json({ message: 'فشل تحويل الملف' });
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(req.file.originalname, path.extname(req.file.originalname))}.pdf"`);

      const stream = fs.createReadStream(outputPath);
      stream.pipe(res);

      stream.on('end', () => {
        fs.unlink(req.file.path, () => {});
        fs.unlink(outputPath, () => {});
      });
    } catch (error) {
      fs.unlink(req.file.path, () => {});
      if (error.message.includes('غير مدعوم')) {
        return res.status(400).json({ message: error.message, code: 'UNSUPPORTED_FORMAT' });
      }
      next(error);
    }
  });
});

// =============================================
// GET /api/reports/patients/:id/statement
// كشف حساب مريض كامل
// =============================================
router.get('/patients/:id/statement', authenticate, adminOnly, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { from, to } = req.query;

  const dateFrom = from ? new Date(from) : new Date(new Date().setFullYear(new Date().getFullYear() - 1));
  const dateTo   = to ? toEndOfDay(to) : new Date();

  const patient = await pool.query(
    'SELECT id, full_name, email, phone, is_vip, vip_discount, total_points FROM patients WHERE id = $1',
    [id]
  );
  if (!patient.rows[0]) return res.status(404).json({ message: 'المريض غير موجود' });

  const invoices = await pool.query(`
    SELECT
      i.*,
      sr.service_type,
      sr.status AS request_status,
      COALESCE(i.service_name_snapshot, sr.service_name_snapshot, s.name, lt.name, lp.name_en, lpk.name_en, pk.name) AS service_name,
      c.code AS coupon_code
    FROM invoices i
    LEFT JOIN service_requests sr ON sr.id = i.request_id
    LEFT JOIN services s ON s.id = sr.service_id
    LEFT JOIN lab_tests lt ON lt.id = sr.lab_test_id
    LEFT JOIN lab_panels lp ON lp.id = sr.lab_panel_id
    LEFT JOIN lab_packages lpk ON lpk.id = sr.lab_package_id
    LEFT JOIN packages pk ON pk.id = sr.package_id
    LEFT JOIN coupons c ON c.id = i.coupon_id
    WHERE i.patient_id = $1 AND i.created_at BETWEEN $2 AND $3
    ORDER BY i.created_at DESC
  `, [id, dateFrom, dateTo]);

  const stats = await pool.query(`
    SELECT
      COUNT(*)::int AS total_invoices,
      COALESCE(SUM(original_amount), 0) AS gross_total,
      COALESCE(SUM(final_amount), 0) AS net_total,
      COALESCE(SUM(total_paid), 0) AS total_paid,
      COALESCE(SUM(remaining_amount), 0) AS total_remaining,
      COALESCE(SUM(vip_discount_amount), 0) AS total_vip_savings,
      COALESCE(SUM(coupon_discount_amount), 0) AS total_coupon_savings
    FROM invoices
    WHERE patient_id = $1 AND created_at BETWEEN $2 AND $3
  `, [id, dateFrom, dateTo]);

  res.json({
    patient: patient.rows[0],
    period: { from: dateFrom, to: dateTo },
    stats: stats.rows[0],
    invoices: invoices.rows,
  });
}));

module.exports = router;
