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
const CASE_RADIOLOGY_MATCHER = `(
  LOWER(COALESCE(s.name, '')) ~ '(xray|x-ray|radiology|scan|اشعة|أشعة)'
  OR LOWER(COALESCE(sc.name, '')) ~ '(xray|x-ray|radiology|scan|اشعة|أشعة)'
)`;

function toEndOfDay(value) {
  const date = new Date(value);
  date.setHours(23, 59, 59, 999);
  return date;
}

function resolveFinancialDateRange(query = {}) {
  const { period = 'monthly', from, to, year, month } = query;
  const now = new Date();
  let dateFrom;
  let dateTo;

  if (from || to) {
    dateFrom = from ? new Date(from) : new Date('2000-01-01');
    dateTo = to ? toEndOfDay(to) : new Date();
  } else if (period === 'daily') {
    dateFrom = new Date(now);
    dateFrom.setHours(0, 0, 0, 0);
    dateTo = new Date();
  } else if (period === 'monthly') {
    const parsedMonth = month ? parseInt(month, 10) - 1 : now.getMonth();
    const parsedYear = year ? parseInt(year, 10) : now.getFullYear();
    dateFrom = new Date(parsedYear, parsedMonth, 1);
    dateTo = new Date(parsedYear, parsedMonth + 1, 0, 23, 59, 59, 999);
  } else {
    const parsedYear = year ? parseInt(year, 10) : now.getFullYear();
    dateFrom = new Date(parsedYear, 0, 1);
    dateTo = new Date(parsedYear, 11, 31, 23, 59, 59, 999);
  }

  return { period, dateFrom, dateTo };
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
router.get('/cases/financial', authenticate, adminOnly, readLimiter, asyncHandler(async (req, res) => {
  const { period, dateFrom, dateTo } = resolveFinancialDateRange(req.query);

  const summaryQuery = pool.query(`
    SELECT
      COUNT(*)::int AS total_invoices,
      COUNT(*) FILTER (WHERE ci.payment_status = 'PAID')::int AS paid_invoices,
      COUNT(*) FILTER (WHERE ci.payment_status = 'PENDING')::int AS pending_invoices,
      COUNT(*) FILTER (WHERE ci.payment_status = 'CANCELLED')::int AS cancelled_invoices,
      COALESCE(SUM(ci.original_amount), 0) AS gross_revenue,
      COALESCE(SUM(ci.final_amount), 0) AS net_revenue,
      COALESCE(SUM(ci.total_paid), 0) AS collected_revenue,
      COALESCE(SUM(ci.remaining_amount), 0) AS pending_revenue,
      COALESCE(SUM(GREATEST(ci.original_amount - ci.final_amount, 0)), 0) AS total_coupon_discounts,
      0::numeric AS total_points_discounts,
      COALESCE(SUM(ci.total_paid), 0) AS total_collected
    FROM case_invoices ci
    JOIN cases c ON c.id = ci.case_id
    WHERE c.created_at BETWEEN $1 AND $2
  `, [dateFrom, dateTo]);

  const casesQuery = pool.query(`
    SELECT
      COUNT(*)::int AS total_cases,
      COUNT(*) FILTER (WHERE c.status IN ('COMPLETED', 'CLOSED'))::int AS completed,
      COUNT(*) FILTER (WHERE c.status = 'PENDING')::int AS pending,
      COUNT(*) FILTER (WHERE c.status = 'CANCELLED')::int AS cancelled,
      COUNT(*) FILTER (WHERE c.status = 'IN_PROGRESS')::int AS in_progress,
      COUNT(*) FILTER (WHERE c.status = 'CLOSED')::int AS closed,
      COUNT(*) FILTER (WHERE c.patient_id IS NULL)::int AS guest_cases,
      COUNT(*) FILTER (WHERE c.patient_id IS NOT NULL)::int AS patient_cases,
      COUNT(*) FILTER (WHERE COALESCE(service_flags.has_medical, FALSE))::int AS medical_count,
      0::int AS lab_count,
      COUNT(*) FILTER (WHERE c.package_id IS NOT NULL)::int AS package_count,
      COUNT(*) FILTER (WHERE COALESCE(service_flags.has_radiology, FALSE))::int AS xray_count,
      COUNT(*) FILTER (WHERE COALESCE(service_flags.has_nursing, FALSE))::int AS nursing_count
    FROM cases c
    LEFT JOIN LATERAL (
      SELECT
        BOOL_OR(NOT ${CASE_RADIOLOGY_MATCHER}) AS has_medical,
        BOOL_OR(${CASE_RADIOLOGY_MATCHER}) AS has_radiology,
        FALSE AS has_nursing
      FROM case_services cs
      LEFT JOIN services s ON s.id = cs.service_id
      LEFT JOIN service_categories sc ON sc.id = s.category_id
      WHERE cs.case_id = c.id
    ) service_flags ON TRUE
    WHERE c.created_at BETWEEN $1 AND $2
  `, [dateFrom, dateTo]);

  const paymentMethodsQuery = pool.query(`
    SELECT
      ci.payment_method,
      COUNT(*)::int AS count,
      COALESCE(SUM(ci.total_paid), 0) AS total
    FROM case_invoices ci
    JOIN cases c ON c.id = ci.case_id
    WHERE c.created_at BETWEEN $1 AND $2
      AND ci.payment_status = 'PAID'
      AND ci.payment_method IS NOT NULL
    GROUP BY ci.payment_method
    ORDER BY total DESC
  `, [dateFrom, dateTo]);

  const topServicesQuery = pool.query(`
    SELECT
      COALESCE(s.name, pkg.name, 'General case') AS service_name,
      CASE
        WHEN c.package_id IS NOT NULL AND cs.id IS NULL THEN 'PACKAGE'
        WHEN ${CASE_RADIOLOGY_MATCHER} THEN 'RADIOLOGY'
        ELSE 'MEDICAL'
      END AS service_type,
      COUNT(*)::int AS count,
      COALESCE(SUM(COALESCE(cs.bundle_price, ci.final_amount, ci.original_amount, 0)), 0) AS revenue
    FROM cases c
    LEFT JOIN case_invoices ci ON ci.case_id = c.id
    LEFT JOIN case_services cs ON cs.case_id = c.id
    LEFT JOIN services s ON s.id = cs.service_id
    LEFT JOIN service_categories sc ON sc.id = s.category_id
    LEFT JOIN packages pkg ON pkg.id = c.package_id
    WHERE c.created_at BETWEEN $1 AND $2
      AND (cs.id IS NOT NULL OR c.package_id IS NOT NULL)
    GROUP BY service_name, service_type
    ORDER BY revenue DESC, count DESC
    LIMIT 10
  `, [dateFrom, dateTo]);

  const dailyBreakdownQuery = pool.query(`
    SELECT
      DATE(c.created_at) AS date,
      COUNT(ci.id)::int AS invoices,
      COALESCE(SUM(ci.final_amount), 0) AS revenue,
      COALESCE(SUM(ci.total_paid), 0) AS collected
    FROM cases c
    LEFT JOIN case_invoices ci ON ci.case_id = c.id
    WHERE c.created_at BETWEEN $1 AND $2
    GROUP BY DATE(c.created_at)
    ORDER BY date ASC
  `, [dateFrom, dateTo]);

  const caseRegisterQuery = pool.query(`
    SELECT
      c.id AS case_id,
      ci.id AS invoice_id,
      COALESCE(cs.provider_id, c.lead_provider_id) AS provider_id,
      COALESCE(sp.full_name, lead_sp.full_name, 'Unassigned provider') AS provider_name,
      COALESCE(p.full_name, c.guest_name, 'Unknown') AS patient_name,
      COALESCE(s.name, pkg.name, 'General case') AS service_name,
      CASE
        WHEN c.package_id IS NOT NULL AND cs.id IS NULL THEN 'PACKAGE'
        WHEN ${CASE_RADIOLOGY_MATCHER} THEN 'RADIOLOGY'
        ELSE 'MEDICAL'
      END AS service_type,
      COALESCE(cs.bundle_price, ci.final_amount, ci.original_amount, 0) AS amount,
      COALESCE(ci.payment_status, 'PENDING') AS payment_status,
      c.status::text AS case_status,
      c.created_at,
      ci.approved_at AS paid_at
    FROM cases c
    LEFT JOIN patients p ON p.id = c.patient_id
    LEFT JOIN case_invoices ci ON ci.case_id = c.id
    LEFT JOIN case_services cs ON cs.case_id = c.id
    LEFT JOIN services s ON s.id = cs.service_id
    LEFT JOIN service_categories sc ON sc.id = s.category_id
    LEFT JOIN packages pkg ON pkg.id = c.package_id
    LEFT JOIN service_providers sp ON sp.id = cs.provider_id
    LEFT JOIN service_providers lead_sp ON lead_sp.id = c.lead_provider_id
    WHERE c.created_at BETWEEN $1 AND $2
      AND (cs.id IS NOT NULL OR c.package_id IS NOT NULL)
    ORDER BY c.created_at DESC, COALESCE(cs.created_at, c.created_at) DESC
  `, [dateFrom, dateTo]);

  const [
    summaryResult,
    casesResult,
    paymentMethodsResult,
    topServicesResult,
    dailyBreakdownResult,
    caseRegisterResult,
  ] = await Promise.all([
    summaryQuery,
    casesQuery,
    paymentMethodsQuery,
    topServicesQuery,
    dailyBreakdownQuery,
    caseRegisterQuery,
  ]);

  res.json({
    period: { type: period, from: dateFrom, to: dateTo },
    summary: summaryResult.rows[0],
    cases: casesResult.rows[0],
    payment_methods: paymentMethodsResult.rows,
    top_services: topServicesResult.rows,
    daily_breakdown: dailyBreakdownResult.rows,
    case_register: caseRegisterResult.rows,
  });
}));

async function buildLegacyFinancialReport(query = {}) {
  const { period, dateFrom, dateTo } = resolveFinancialDateRange(query);

  const summaryQuery = pool.query(`
    SELECT
      COUNT(*)::int AS total_invoices,
      COUNT(*) FILTER (WHERE ci.payment_status = 'PAID')::int AS paid_invoices,
      COUNT(*) FILTER (WHERE ci.payment_status = 'PENDING')::int AS pending_invoices,
      COUNT(*) FILTER (WHERE ci.payment_status = 'CANCELLED')::int AS cancelled_invoices,
      COALESCE(SUM(ci.original_amount), 0) AS gross_revenue,
      COALESCE(SUM(ci.final_amount), 0) AS net_revenue,
      COALESCE(SUM(ci.total_paid), 0) AS collected_revenue,
      COALESCE(SUM(ci.remaining_amount), 0) AS pending_revenue,
      COALESCE(SUM(GREATEST(ci.original_amount - ci.final_amount, 0)), 0) AS total_coupon_discounts,
      0::numeric AS total_points_discounts,
      COALESCE(SUM(ci.total_paid), 0) AS total_collected
    FROM case_invoices ci
    JOIN cases c ON c.id = ci.case_id
    WHERE c.created_at BETWEEN $1 AND $2
  `, [dateFrom, dateTo]);

  const requestsQuery = pool.query(`
    SELECT
      COUNT(*)::int AS total_requests,
      COUNT(*) FILTER (WHERE c.status IN ('COMPLETED', 'CLOSED'))::int AS completed,
      COUNT(*) FILTER (WHERE c.status = 'PENDING')::int AS pending,
      COUNT(*) FILTER (WHERE c.status = 'CANCELLED')::int AS cancelled,
      COUNT(*) FILTER (WHERE c.patient_id IS NULL)::int AS guest_requests,
      COUNT(*) FILTER (WHERE c.patient_id IS NOT NULL)::int AS patient_requests,
      COUNT(*) FILTER (WHERE COALESCE(service_flags.has_medical, FALSE))::int AS medical_count,
      0::int AS lab_count,
      COUNT(*) FILTER (WHERE c.package_id IS NOT NULL)::int AS package_count,
      COUNT(*) FILTER (WHERE COALESCE(service_flags.has_radiology, FALSE))::int AS xray_count
    FROM cases c
    LEFT JOIN LATERAL (
      SELECT
        BOOL_OR(NOT ${CASE_RADIOLOGY_MATCHER}) AS has_medical,
        BOOL_OR(${CASE_RADIOLOGY_MATCHER}) AS has_radiology
      FROM case_services cs
      LEFT JOIN services s ON s.id = cs.service_id
      LEFT JOIN service_categories sc ON sc.id = s.category_id
      WHERE cs.case_id = c.id
    ) service_flags ON TRUE
    WHERE c.created_at BETWEEN $1 AND $2
  `, [dateFrom, dateTo]);

  const paymentMethodsQuery = pool.query(`
    SELECT
      ci.payment_method,
      COUNT(*)::int AS count,
      COALESCE(SUM(ci.total_paid), 0) AS total
    FROM case_invoices ci
    JOIN cases c ON c.id = ci.case_id
    WHERE c.created_at BETWEEN $1 AND $2
      AND ci.payment_status = 'PAID'
      AND ci.payment_method IS NOT NULL
    GROUP BY ci.payment_method
    ORDER BY total DESC
  `, [dateFrom, dateTo]);

  const topServicesQuery = pool.query(`
    SELECT
      COALESCE(s.name, pkg.name, 'General case') AS service_name,
      CASE
        WHEN c.package_id IS NOT NULL AND cs.id IS NULL THEN 'PACKAGE'
        WHEN ${CASE_RADIOLOGY_MATCHER} THEN 'RADIOLOGY'
        ELSE 'MEDICAL'
      END AS service_type,
      COUNT(*)::int AS count,
      COALESCE(SUM(COALESCE(cs.bundle_price, ci.final_amount, ci.original_amount, 0)), 0) AS revenue
    FROM cases c
    LEFT JOIN case_invoices ci ON ci.case_id = c.id
    LEFT JOIN case_services cs ON cs.case_id = c.id
    LEFT JOIN services s ON s.id = cs.service_id
    LEFT JOIN service_categories sc ON sc.id = s.category_id
    LEFT JOIN packages pkg ON pkg.id = c.package_id
    WHERE c.created_at BETWEEN $1 AND $2
      AND (cs.id IS NOT NULL OR c.package_id IS NOT NULL)
    GROUP BY service_name, service_type
    ORDER BY revenue DESC, count DESC
    LIMIT 10
  `, [dateFrom, dateTo]);

  const dailyBreakdownQuery = pool.query(`
    SELECT
      DATE(c.created_at) AS date,
      COUNT(ci.id)::int AS invoices,
      COALESCE(SUM(ci.final_amount), 0) AS revenue,
      COALESCE(SUM(ci.total_paid), 0) AS collected
    FROM cases c
    LEFT JOIN case_invoices ci ON ci.case_id = c.id
    WHERE c.created_at BETWEEN $1 AND $2
    GROUP BY DATE(c.created_at)
    ORDER BY date ASC
  `, [dateFrom, dateTo]);

  const [
    summaryResult,
    requestsResult,
    paymentMethodsResult,
    topServicesResult,
    dailyBreakdownResult,
  ] = await Promise.all([
    summaryQuery,
    requestsQuery,
    paymentMethodsQuery,
    topServicesQuery,
    dailyBreakdownQuery,
  ]);

  return {
    period: { type: period, from: dateFrom, to: dateTo },
    summary: summaryResult.rows[0],
    requests: requestsResult.rows[0],
    payment_methods: paymentMethodsResult.rows,
    top_services: topServicesResult.rows,
    daily_breakdown: dailyBreakdownResult.rows,
  };
}

router.get('/financial', authenticate, adminOnly, readLimiter, asyncHandler(async (req, res) => {
  const report = await buildLegacyFinancialReport(req.query);
  res.json(report);
}));

router.get('/financial-requests-legacy', authenticate, adminOnly, readLimiter, asyncHandler(async (req, res) => {
  // REMOVED: This endpoint queried service_requests, invoices, payments tables
  // which were permanently dropped by migration 039_new_case_system.sql.
  // Use GET /api/v1/reports/cases/financial for current financial data.
  return res.status(410).json({
    message: 'This report endpoint has been retired. Use /api/v1/reports/cases/financial instead.',
    code: 'ENDPOINT_RETIRED',
  });
  // --- DEAD CODE BELOW (kept for reference, never executed) ---
  const { period, dateFrom, dateTo } = resolveFinancialDateRange(req.query);

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
  // REMOVED: This endpoint queried the old `invoices` table dropped by migration 039.
  // For case invoice PDFs use: GET /api/v1/cases/:id/invoice/pdf
  return res.status(410).json({
    message: 'This endpoint has been retired. Use /api/v1/cases/:id/invoice/pdf instead.',
    code: 'ENDPOINT_RETIRED',
  });
  // --- DEAD CODE BELOW (kept for reference, never executed) ---
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
  // REMOVED: Queried old service_requests table dropped by migration 039.
  // For case medical reports use: GET /api/v1/cases/:id/report/download
  asyncHandler(async (req, res) => res.status(410).json({
    message: 'This endpoint has been retired. Use /api/v1/cases/:id/report/download instead.',
    code: 'ENDPOINT_RETIRED',
  }))
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
  // REMOVED: Queried old `invoices` and `service_requests` tables dropped by migration 039.
  // Patient financial history is now available via GET /api/v1/reports/cases/financial
  // filtered by patient_id, or via GET /api/v1/cases?patient_id=:id.
  return res.status(410).json({
    message: 'This endpoint has been retired. Patient case history is available via /api/v1/cases?patient_id=:id',
    code: 'ENDPOINT_RETIRED',
  });
}));

module.exports = router;
