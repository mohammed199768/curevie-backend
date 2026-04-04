const fsPromises = require('fs/promises');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');
const pool = require('../../config/db');
const {
  TEMP_DIR,
  embedPdfFonts,
  normalizePdfText,
  formatPdfDate,
  formatPdfDateTime,
  loadEmbeddedLogoImage,
  createPdfTextToolkit,
} = require('./shared');
const { addWatermark } = require('./conversion');

async function generateInvoicePdf(invoiceId) {
  const result = await pool.query(`
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
  `, [invoiceId]);

  if (!result.rows[0]) throw new Error('الفاتورة غير موجودة');
  const inv = result.rows[0];

  let paymentsData;
  if (Array.isArray(inv.payments_snapshot)) {
    paymentsData = inv.payments_snapshot;
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

  const pdfDoc = await PDFDocument.create();
  const { font, fontBold, allowUnicode } = await embedPdfFonts(pdfDoc);
  const {
    wrapText,
    drawTextLines,
    measureText,
    truncateText,
  } = createPdfTextToolkit({ font, fontBold, allowUnicode });
  const logoImage = await loadEmbeddedLogoImage(pdfDoc);

  const PAGE_W = 595;
  const PAGE_H = 842;
  const MARGIN = 46;
  const CONTENT_W = PAGE_W - (MARGIN * 2);
  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);

  const C = {
    brandPrimary: rgb(0x10 / 255, 0x4d / 255, 0x49 / 255),
    brandSecondary: rgb(0x30 / 255, 0x4a / 255, 0x43 / 255),
    brandAccent: rgb(0x86 / 255, 0xab / 255, 0x62 / 255),
    brandStone: rgb(0x9c / 255, 0x9f / 255, 0xa2 / 255),
    surface: rgb(0.97, 0.98, 0.97),
    white: rgb(1, 1, 1),
    line: rgb(0.84, 0.87, 0.85),
    ink: rgb(0.12, 0.16, 0.16),
    muted: rgb(0.38, 0.42, 0.41),
    success: rgb(0.14, 0.48, 0.24),
    successBg: rgb(0.89, 0.95, 0.89),
    danger: rgb(0.70, 0.20, 0.20),
    dangerBg: rgb(0.99, 0.91, 0.91),
  };

  const safe = (value, fallback = '-') => {
    if (value === null || value === undefined || value === '') return fallback;
    return normalizePdfText(value, allowUnicode);
  };
  const formatMoney = (amount) => `${parseFloat(amount || 0).toFixed(2)} JD`;
  const drawShadowCard = ({ x, y, width, height, accentColor = C.brandAccent }) => {
    page.drawRectangle({
      x: x + 5,
      y: y - height - 5,
      width,
      height,
      color: C.brandPrimary,
      opacity: 0.05,
    });
    page.drawRectangle({
      x,
      y: y - height,
      width,
      height,
      color: C.white,
      borderColor: C.line,
      borderWidth: 0.9,
    });
    page.drawRectangle({
      x,
      y: y - 7,
      width,
      height: 7,
      color: accentColor,
    });
  };

  page.drawRectangle({
    x: 0,
    y: PAGE_H - 154,
    width: PAGE_W,
    height: 154,
    color: C.brandPrimary,
  });
  page.drawRectangle({
    x: PAGE_W - 208,
    y: PAGE_H - 154,
    width: 208,
    height: 154,
    color: C.brandSecondary,
    opacity: 0.56,
  });
  page.drawRectangle({
    x: 0,
    y: PAGE_H - 8,
    width: PAGE_W,
    height: 8,
    color: C.brandAccent,
  });

  if (logoImage) {
    const maxHeight = 44;
    const scale = maxHeight / logoImage.height;
    const logoWidth = logoImage.width * scale;
    page.drawImage(logoImage, {
      x: MARGIN,
      y: PAGE_H - 72,
      width: logoWidth,
      height: maxHeight,
    });
  } else {
    page.drawText('CUREVIE', {
      x: MARGIN,
      y: PAGE_H - 60,
      size: 24,
      font: fontBold,
      color: C.white,
    });
  }

  const brandOffset = logoImage ? 82 : 0;
  page.drawText('MEDICAL BILLING RECORD', {
    x: MARGIN + brandOffset,
    y: PAGE_H - 52,
    size: 9,
    font: fontBold,
    color: rgb(0.84, 0.92, 0.88),
  });
  page.drawText('Invoice', {
    x: MARGIN + brandOffset,
    y: PAGE_H - 74,
    size: 26,
    font: fontBold,
    color: C.white,
  });
  drawTextLines(page, wrapText(font, 'Professional summary of charges and payment activity.', 10, 240), MARGIN + brandOffset, PAGE_H - 92, {
    size: 10,
    color: rgb(0.92, 0.96, 0.94),
    lineGap: 11,
  });

  const invoiceBadgeX = PAGE_W - MARGIN - 146;
  page.drawRectangle({
    x: invoiceBadgeX,
    y: PAGE_H - 116,
    width: 146,
    height: 76,
    color: rgb(1, 1, 1),
    opacity: 0.96,
  });
  page.drawText('INVOICE', {
    x: invoiceBadgeX + 16,
    y: PAGE_H - 68,
    size: 17,
    font: fontBold,
    color: C.brandPrimary,
  });
  page.drawText(`#${invoiceId.slice(0, 8).toUpperCase()}`, {
    x: invoiceBadgeX + 16,
    y: PAGE_H - 85,
    size: 10,
    font: fontBold,
    color: C.brandSecondary,
  });
  page.drawText(`Issued ${formatPdfDate(inv.created_at)}`, {
    x: invoiceBadgeX + 16,
    y: PAGE_H - 101,
    size: 8.5,
    font,
    color: C.muted,
  });

  let y = PAGE_H - 178;
  const gap = 14;
  const billCardWidth = Math.round((CONTENT_W * 0.47) * 10) / 10;
  const serviceCardWidth = CONTENT_W - billCardWidth - gap;
  const cardHeight = 118;

  drawShadowCard({
    x: MARGIN,
    y,
    width: billCardWidth,
    height: cardHeight,
    accentColor: C.brandPrimary,
  });
  page.drawText('BILL TO', {
    x: MARGIN + 16,
    y: y - 24,
    size: 8,
    font: fontBold,
    color: C.brandStone,
  });
  page.drawText(safe(inv.patient_name || inv.guest_name, 'Guest'), {
    x: MARGIN + 16,
    y: y - 46,
    size: 15,
    font: fontBold,
    color: C.ink,
  });
  page.drawText(`Phone: ${safe(inv.patient_phone || inv.guest_phone)}`, {
    x: MARGIN + 16,
    y: y - 64,
    size: 9.5,
    font,
    color: C.muted,
  });
  const statusText = String(inv.payment_status || 'PENDING').toUpperCase();
  const isPaid = statusText === 'PAID';
  const statusBg = isPaid ? C.successBg : C.dangerBg;
  const statusColor = isPaid ? C.success : C.danger;
  const statusWidth = measureText(fontBold, statusText, 8.5) + 24;
  page.drawRectangle({
    x: MARGIN + 16,
    y: y - 92,
    width: statusWidth,
    height: 18,
    color: statusBg,
    borderColor: statusColor,
    borderWidth: 0.7,
  });
  page.drawText(statusText, {
    x: MARGIN + 28,
    y: y - 86,
    size: 8.5,
    font: fontBold,
    color: statusColor,
  });

  drawShadowCard({
    x: MARGIN + billCardWidth + gap,
    y,
    width: serviceCardWidth,
    height: cardHeight,
    accentColor: C.brandAccent,
  });
  page.drawText('SERVICE', {
    x: MARGIN + billCardWidth + gap + 16,
    y: y - 24,
    size: 8,
    font: fontBold,
    color: C.brandStone,
  });
  const serviceName = safe(inv.service_name || inv.lab_test_name || inv.package_name, 'Service');
  drawTextLines(page, wrapText(fontBold, serviceName, 13, serviceCardWidth - 32), MARGIN + billCardWidth + gap + 16, y - 42, {
    size: 13,
    bold: true,
    color: C.ink,
    lineGap: 15,
  });
  page.drawText(`Type: ${safe(inv.service_type || inv.request_type)}`, {
    x: MARGIN + billCardWidth + gap + 16,
    y: y - 74,
    size: 9,
    font,
    color: C.muted,
  });
  page.drawText(`Provider: ${safe(inv.provider_name)}`, {
    x: MARGIN + billCardWidth + gap + 16,
    y: y - 90,
    size: 9,
    font,
    color: C.muted,
  });

  y -= cardHeight + 24;

  page.drawText('Charges Summary', {
    x: MARGIN,
    y,
    size: 15,
    font: fontBold,
    color: C.brandPrimary,
  });
  page.drawRectangle({
    x: MARGIN,
    y: y - 8,
    width: 104,
    height: 3,
    color: C.brandAccent,
  });
  y -= 28;

  page.drawRectangle({
    x: MARGIN,
    y: y - 28,
    width: CONTENT_W,
    height: 28,
    color: C.brandPrimary,
  });
  page.drawText('Description', {
    x: MARGIN + 14,
    y: y - 18,
    size: 8.5,
    font: fontBold,
    color: C.white,
  });
  page.drawText('Amount', {
    x: PAGE_W - MARGIN - 86,
    y: y - 18,
    size: 8.5,
    font: fontBold,
    color: C.white,
  });
  y -= 36;

  const rows = [
    { label: serviceName, value: formatMoney(inv.original_amount), color: C.ink, bg: C.white },
  ];

  if (parseFloat(inv.vip_discount_amount) > 0) {
    rows.push({
      label: `VIP Discount (${inv.vip_discount}%)`,
      value: `- ${formatMoney(inv.vip_discount_amount)}`,
      color: C.success,
      bg: rgb(0.96, 0.99, 0.97),
    });
  }
  if (parseFloat(inv.coupon_discount_amount) > 0) {
    rows.push({
      label: `Coupon: ${safe(inv.coupon_code)}`,
      value: `- ${formatMoney(inv.coupon_discount_amount)}`,
      color: C.success,
      bg: rgb(0.96, 0.99, 0.97),
    });
  }
  if (parseFloat(inv.points_discount_amount) > 0) {
    rows.push({
      label: `Points Discount (${inv.points_used || 0} pts)`,
      value: `- ${formatMoney(inv.points_discount_amount)}`,
      color: C.success,
      bg: rgb(0.96, 0.99, 0.97),
    });
  }

  rows.forEach((row) => {
    page.drawRectangle({
      x: MARGIN,
      y: y - 26,
      width: CONTENT_W,
      height: 26,
      color: row.bg,
      borderColor: C.line,
      borderWidth: 0.5,
    });
    page.drawText(truncateText(font, row.label, 9.5, CONTENT_W - 124), {
      x: MARGIN + 14,
      y: y - 16,
      size: 9.5,
      font,
      color: row.color,
    });
    page.drawText(row.value, {
      x: PAGE_W - MARGIN - 96,
      y: y - 16,
      size: 9.5,
      font: row.color === C.ink ? font : fontBold,
      color: row.color,
    });
    y -= 28;
  });

  page.drawRectangle({
    x: MARGIN,
    y: y - 40,
    width: CONTENT_W,
    height: 40,
    color: C.brandPrimary,
  });
  page.drawRectangle({
    x: PAGE_W - MARGIN - 166,
    y: y - 40,
    width: 166,
    height: 40,
    color: C.brandAccent,
  });
  page.drawText('TOTAL DUE', {
    x: MARGIN + 16,
    y: y - 24,
    size: 12,
    font: fontBold,
    color: C.white,
  });
  page.drawText(formatMoney(inv.final_amount), {
    x: PAGE_W - MARGIN - 152,
    y: y - 24,
    size: 14,
    font: fontBold,
    color: C.brandPrimary,
  });
  y -= 58;

  if (paymentsData.length > 0) {
    page.drawText('Payment History', {
      x: MARGIN,
      y,
      size: 15,
      font: fontBold,
      color: C.brandPrimary,
    });
    page.drawRectangle({
      x: MARGIN,
      y: y - 8,
      width: 94,
      height: 3,
      color: C.brandAccent,
    });
    y -= 28;

    page.drawRectangle({
      x: MARGIN,
      y: y - 24,
      width: CONTENT_W,
      height: 24,
      color: rgb(0.93, 0.96, 0.93),
    });
    page.drawText('Date', {
      x: MARGIN + 12,
      y: y - 16,
      size: 8,
      font: fontBold,
      color: C.brandSecondary,
    });
    page.drawText('Method', {
      x: MARGIN + 190,
      y: y - 16,
      size: 8,
      font: fontBold,
      color: C.brandSecondary,
    });
    page.drawText('Amount', {
      x: PAGE_W - MARGIN - 86,
      y: y - 16,
      size: 8,
      font: fontBold,
      color: C.brandSecondary,
    });
    y -= 28;

    let totalPaid = 0;
    paymentsData.forEach((pay, index) => {
      const rowBg = index % 2 === 0 ? C.white : C.surface;
      page.drawRectangle({
        x: MARGIN,
        y: y - 22,
        width: CONTENT_W,
        height: 22,
        color: rowBg,
        borderColor: C.line,
        borderWidth: 0.4,
      });
      page.drawText(formatPdfDate(pay.created_at), {
        x: MARGIN + 12,
        y: y - 14,
        size: 8.5,
        font,
        color: C.ink,
      });
      page.drawText(safe(pay.payment_method), {
        x: MARGIN + 190,
        y: y - 14,
        size: 8.5,
        font,
        color: C.ink,
      });
      page.drawText(formatMoney(pay.amount), {
        x: PAGE_W - MARGIN - 92,
        y: y - 14,
        size: 8.5,
        font: fontBold,
        color: C.success,
      });
      totalPaid += parseFloat(pay.amount || 0);
      y -= 24;
    });

    const remaining = Math.max(0, parseFloat(inv.final_amount || 0) - totalPaid);
    y -= 4;
    page.drawText(`Total Paid: ${formatMoney(totalPaid)}`, {
      x: MARGIN,
      y,
      size: 9.5,
      font: fontBold,
      color: C.success,
    });
    if (remaining > 0) {
      page.drawText(`Remaining: ${formatMoney(remaining)}`, {
        x: MARGIN + 188,
        y,
        size: 9.5,
        font: fontBold,
        color: C.danger,
      });
    }
  }

  page.drawRectangle({
    x: 0,
    y: 0,
    width: PAGE_W,
    height: 54,
    color: C.brandPrimary,
  });
  page.drawRectangle({
    x: 0,
    y: 48,
    width: PAGE_W,
    height: 6,
    color: C.brandAccent,
  });
  page.drawText('Curevie Clinical Billing', {
    x: MARGIN,
    y: 24,
    size: 9,
    font: fontBold,
    color: C.white,
  });
  page.drawText(`Generated ${formatPdfDateTime(new Date())}`, {
    x: MARGIN,
    y: 12,
    size: 8,
    font,
    color: rgb(0.78, 0.88, 0.84),
  });
  const footerUrl = 'www.curevie.com';
  const footerUrlWidth = measureText(fontBold, footerUrl, 9);
  page.drawText(footerUrl, {
    x: PAGE_W - MARGIN - footerUrlWidth,
    y: 24,
    size: 9,
    font: fontBold,
    color: rgb(0.93, 0.96, 0.94),
  });

  const tempPath = path.join(TEMP_DIR, `invoice_${invoiceId}.pdf`);
  await fsPromises.writeFile(tempPath, await pdfDoc.save());
  const finalPath = await addWatermark(tempPath, { opacity: 0.04, logoOpacity: 0.04 });
  await fsPromises.unlink(tempPath).catch(() => {});
  return finalPath;
}

module.exports = {
  generateInvoicePdf,
};
