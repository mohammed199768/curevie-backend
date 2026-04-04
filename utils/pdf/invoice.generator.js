const fsPromises = require('fs/promises');
const path = require('path');
const pool = require('../../config/db');
const { logger } = require('../logger');
const {
  TEMP_DIR,
  LOGO_PATH,
  PDF_FONT_REGULAR_CANDIDATES,
  PDF_FONT_BOLD_CANDIDATES,
  getFirstExistingPath,
} = require('./shared');
const { addWatermark } = require('./conversion');
const { fileToDataUri, renderPdfFromHtml } = require('./html-renderer');
const { renderInvoiceHtml } = require('./invoice.template');
const {
  generateInvoicePdf: generateInvoicePdfWithPdfLib,
} = require('./invoice.pdflib');

async function loadInvoicePdfData(invoiceId) {
  const invoiceResult = await pool.query(`
    SELECT
      i.*,
      i.payments_snapshot,
      sr.id AS request_id,
      sr.request_type,
      sr.service_type,
      sr.status AS request_status,
      sr.guest_name,
      sr.guest_phone,
      sr.guest_address,
      sr.notes AS request_notes,
      sr.completed_at,
      COALESCE(i.patient_name_snapshot, sr.patient_full_name_snapshot, p.full_name, sr.guest_name, i.guest_name) AS patient_name,
      COALESCE(i.patient_phone_snapshot, sr.patient_phone_snapshot, p.phone, sr.guest_phone) AS patient_phone,
      COALESCE(i.patient_address_snapshot, sr.patient_address_snapshot, p.address, sr.guest_address) AS patient_address,
      p.is_vip,
      p.vip_discount,
      COALESCE(i.service_name_snapshot, sr.service_name_snapshot, s.name, lt.name, pk.name) AS service_name,
      s.price AS service_price,
      COALESCE(i.service_name_snapshot, sr.service_name_snapshot, lt.name) AS lab_test_name,
      lt.cost AS lab_test_cost,
      COALESCE(i.service_name_snapshot, sr.service_name_snapshot, pk.name) AS package_name,
      pk.total_cost AS package_cost,
      COALESCE(i.coupon_code_snapshot, c.code) AS coupon_code,
      COALESCE(i.coupon_discount_type_snapshot, c.discount_type::text) AS discount_type,
      COALESCE(i.coupon_discount_value_snapshot, c.discount_value) AS discount_value,
      COALESCE(i.provider_name_snapshot, sr.assigned_provider_name_snapshot, sr.lead_provider_name_snapshot, sp.full_name) AS provider_name,
      COALESCE(i.provider_type_snapshot, sr.assigned_provider_type_snapshot, sr.lead_provider_type_snapshot, sp.type::text) AS provider_type
    FROM invoices i
    LEFT JOIN service_requests sr ON sr.id = i.request_id
    LEFT JOIN patients p ON p.id = i.patient_id
    LEFT JOIN services s ON s.id = sr.service_id
    LEFT JOIN lab_tests lt ON lt.id = sr.lab_test_id
    LEFT JOIN packages pk ON pk.id = sr.package_id
    LEFT JOIN coupons c ON c.id = i.coupon_id
    LEFT JOIN service_providers sp ON sp.id = sr.assigned_provider_id
    WHERE i.id = $1
    LIMIT 1
  `, [invoiceId]);

  const invoiceRow = invoiceResult.rows[0];
  if (!invoiceRow) {
    throw new Error('Invoice not found');
  }

  let paymentsData;
  if (Array.isArray(invoiceRow.payments_snapshot)) {
    paymentsData = invoiceRow.payments_snapshot;
  } else {
    const paymentsResult = await pool.query(
      `
      SELECT id, amount, payment_method, payer_name, notes, created_at
      FROM payments
      WHERE invoice_id = $1
      ORDER BY created_at ASC
      `,
      [invoiceId]
    );
    paymentsData = paymentsResult.rows;
  }

  return {
    invoice: invoiceRow,
    payments: paymentsData,
  };
}

async function buildTemplateAssets() {
  const regularFontPath = getFirstExistingPath(PDF_FONT_REGULAR_CANDIDATES);
  const boldFontPath = getFirstExistingPath(PDF_FONT_BOLD_CANDIDATES);

  const [logoDataUri, regularFontDataUri, boldFontDataUri] = await Promise.all([
    fileToDataUri(LOGO_PATH),
    fileToDataUri(regularFontPath),
    fileToDataUri(boldFontPath),
  ]);

  return {
    logoDataUri,
    regularFontDataUri,
    boldFontDataUri,
  };
}

async function generateInvoicePdf(invoiceId) {
  const resolvedInvoiceData = await loadInvoicePdfData(invoiceId);

  try {
    const assets = await buildTemplateAssets();
    const html = renderInvoiceHtml(resolvedInvoiceData, assets);
    const pdfBuffer = await renderPdfFromHtml(html, {
      displayHeaderFooter: true,
      marginTop: '14px',
      marginRight: '14px',
      marginBottom: '64px',
      marginLeft: '14px',
      footerTemplate: `
        <div style="width:100%;padding:0 16px 10px 16px;font-family:Arial,sans-serif;font-size:8px;color:#6f7f7d;display:flex;justify-content:flex-end;align-items:center;">
          <span style="font-weight:600;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
        </div>
      `,
    });

    const tempPath = path.join(TEMP_DIR, `invoice_${invoiceId}_${Date.now()}.pdf`);
    await fsPromises.writeFile(tempPath, pdfBuffer);

    try {
      return await addWatermark(tempPath, {
        opacity: 0.04,
        logoOpacity: 0.04,
      });
    } finally {
      await fsPromises.unlink(tempPath).catch(() => {});
    }
  } catch (error) {
    logger.warn('HTML invoice generation failed, falling back to pdf-lib renderer', {
      invoiceId,
      error: error.message,
    });

    return generateInvoicePdfWithPdfLib(invoiceId);
  }
}

module.exports = {
  generateInvoicePdf,
};
