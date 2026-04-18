/**
 * case-invoice.generator.js
 * Generates a case invoice PDF as a Buffer (not stored to disk).
 *
 * Data strategy:
 *   - Patient info  → case_snapshots.patient_data   (immutable at close time)
 *                     fallback: live cases JOIN patients
 *   - Services list → case_snapshots.services_data  (immutable at close time)
 *                     fallback: live case_services JOIN services
 *   - Financials    → live case_invoices             (always current)
 *   - Payments      → live case_payment_records      (always current)
 *   - Adjustments   → live invoice_adjustments       (always current)
 *
 * Called by: GET /api/v1/cases/:id/invoice/pdf
 */

const pool = require('../../config/db');
const { renderPdfFromHtml, fileToDataUri } = require('./html-renderer');
const { LOGO_PATH } = require('./shared');

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function escapeHtml(value) {
  return String(value ?? '-')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDate(value) {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '-';
  return parsed.toLocaleDateString('en-GB');
}

function formatDateTime(value) {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '-';
  return parsed.toLocaleString('en-GB');
}

function formatMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(3) : '0.000';
}

function normalizeJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return null; }
}

function paymentStatusStyle(status) {
  const styles = {
    PAID:      'background:#d4edda; color:#155724; border:1px solid #c3e6cb;',
    PARTIAL:   'background:#fff3cd; color:#856404; border:1px solid #ffeeba;',
    PENDING:   'background:#f8d7da; color:#721c24; border:1px solid #f5c6cb;',
    CANCELLED: 'background:#e2e3e5; color:#383d41; border:1px solid #d6d8db;',
  };
  return styles[status] || styles.PENDING;
}

function paymentStatusLabel(status) {
  const labels = {
    PAID:      'مدفوعة بالكامل',
    PARTIAL:   'مدفوعة جزئياً',
    PENDING:   'غير مدفوعة',
    CANCELLED: 'ملغية',
  };
  return labels[status] || status;
}

function methodLabel(method) {
  const labels = {
    CASH:      'نقداً',
    CARD:      'بطاقة',
    INSURANCE: 'تأمين',
    CLICK:     'KNET/Click',
    OTHER:     'أخرى',
  };
  return labels[method] || method || '-';
}

// ============================================================
// HTML TEMPLATE BUILDER
// ============================================================

function buildInvoiceHtml({
  shortInvoiceId,
  shortCaseId,
  patient,
  invoice,
  services,
  payments,
  adjustments,
  logoDataUri,
  generatedAt,
}) {
  const totalDiscount = Math.max(0, Number(invoice.original_amount) - Number(invoice.final_amount));
  const statusStyle = paymentStatusStyle(invoice.payment_status);
  const statusLabel = paymentStatusLabel(invoice.payment_status);

  // --- Services table rows ---
  const servicesRows = services.length
    ? services.map((s) => `
        <tr>
          <td>${escapeHtml(s.service_name || s.name || '-')}</td>
          <td class="center">${escapeHtml(s.provider_name || '-')}</td>
          <td class="num">${formatMoney(s.original_price || 0)}</td>
          <td class="num bold">${formatMoney(s.bundle_price || 0)}</td>
        </tr>`).join('')
    : '<tr><td colspan="4" class="empty">لا توجد خدمات مسجلة لهذه الحالة</td></tr>';

  // --- Adjustments table rows ---
  const adjustmentRows = adjustments.length
    ? adjustments.map((adj) => `
        <tr>
          <td class="center">
            <span class="badge ${adj.type === 'DISCOUNT' ? 'badge-discount' : 'badge-surcharge'}">
              ${adj.type === 'DISCOUNT' ? 'خصم' : 'إضافة'}
            </span>
          </td>
          <td>${escapeHtml(adj.reason || '-')}</td>
          <td class="num ${adj.type === 'DISCOUNT' ? 'text-green' : 'text-red'}">
            ${adj.type === 'DISCOUNT' ? '−' : '+'}${formatMoney(adj.amount)} JOD
          </td>
          <td class="center">${formatDate(adj.created_at)}</td>
        </tr>`).join('')
    : '<tr><td colspan="4" class="empty">لا توجد تعديلات على هذه الفاتورة</td></tr>';

  // --- Payments table rows ---
  const paymentRows = payments.length
    ? payments.map((p, i) => `
        <tr>
          <td class="center">${i + 1}</td>
          <td class="center ltr">${formatDateTime(p.created_at)}</td>
          <td class="center">${methodLabel(p.method)}</td>
          <td class="num bold text-green">${formatMoney(p.amount)} JOD</td>
          <td>${escapeHtml(p.notes || '-')}</td>
        </tr>`).join('')
    : '<tr><td colspan="5" class="empty">لا توجد مدفوعات مسجلة</td></tr>';

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<title>فاتورة — ${escapeHtml(shortInvoiceId)}</title>
<style>
  :root {
    --green:   #104d49;
    --green2:  #1a6b66;
    --accent:  #86ab62;
    --text:    #19332f;
    --muted:   #5e726d;
    --surface: #f5f8f6;
    --border:  rgba(16, 77, 73, 0.10);
    --red:     #8b1a1a;
    --red-bg:  #fdf0f0;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: Tahoma, Arial, 'Segoe UI', sans-serif;
    font-size: 13px;
    color: var(--text);
    background: var(--surface);
    padding: 18px 22px;
    line-height: 1.55;
  }

  /* ── HEADER ── */
  .header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    background: linear-gradient(145deg, rgba(16,77,73,0.97) 0%, rgba(48,74,67,0.97) 60%, rgba(13,53,50,0.97) 100%);
    border-radius: 20px;
    padding: 20px 26px;
    margin-bottom: 18px;
    color: #fff;
    position: relative;
    overflow: hidden;
  }
  .header::after {
    content: '';
    position: absolute;
    inset-inline: 0;
    top: 0;
    height: 4px;
    background: linear-gradient(90deg, var(--accent) 0%, #c5daa0 50%, rgba(255,255,255,0.6) 100%);
  }
  .header-logo img { height: 52px; display: block; }
  .header-logo .logo-fallback {
    font-size: 22px;
    font-weight: 800;
    color: #fff;
    letter-spacing: 0.06em;
  }
  .header-info { text-align: right; }
  .header-info h1 { font-size: 21px; margin-bottom: 6px; color: #fff; }
  .header-info p  { font-size: 12px; color: rgba(255,255,255,0.72); margin: 2px 0; }
  .status-pill {
    display: inline-block;
    padding: 5px 14px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 700;
    margin-top: 8px;
    ${statusStyle}
  }

  /* ── META CARDS ── */
  .meta-row {
    display: flex;
    gap: 14px;
    margin-bottom: 16px;
  }
  .meta-card {
    flex: 1;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 14px 16px;
    box-shadow: 0 2px 12px rgba(16,77,73,0.05);
  }
  .meta-card h3 {
    font-size: 13px;
    font-weight: 700;
    color: var(--green);
    border-bottom: 2px solid var(--accent);
    padding-bottom: 5px;
    margin-bottom: 10px;
  }
  .info-line {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 0;
    border-bottom: 1px solid rgba(16,77,73,0.06);
    font-size: 12px;
    gap: 8px;
  }
  .info-line:last-child { border-bottom: none; }
  .info-label { color: var(--muted); flex-shrink: 0; }
  .info-value { font-weight: 600; color: var(--text); text-align: left; direction: ltr; }

  /* ── SECTION TITLE ── */
  .section-title {
    font-size: 14px;
    font-weight: 700;
    color: var(--green);
    border-right: 4px solid var(--accent);
    padding-right: 10px;
    margin: 0 0 9px;
  }

  /* ── TABLES ── */
  table {
    width: 100%;
    border-collapse: collapse;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    margin-bottom: 16px;
  }
  thead th {
    background: var(--green);
    color: #fff;
    padding: 9px 12px;
    font-size: 12px;
    font-weight: 700;
    text-align: right;
  }
  tbody td {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    vertical-align: middle;
  }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:nth-child(even) td { background: rgba(16,77,73,0.025); }
  td.num    { text-align: left; direction: ltr; }
  td.center { text-align: center; }
  td.ltr    { direction: ltr; }
  td.bold   { font-weight: 700; }
  td.empty  { text-align: center; color: var(--muted); font-style: italic; padding: 16px; }
  .text-green { color: #155724; font-weight: 700; }
  .text-red   { color: var(--red); font-weight: 700; }

  /* ── BADGES ── */
  .badge {
    display: inline-block;
    padding: 2px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 700;
  }
  .badge-discount { background: #d4edda; color: #155724; }
  .badge-surcharge { background: #f8d7da; color: #721c24; }

  /* ── FINANCIAL SUMMARY BOX ── */
  .summary-box {
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 16px 20px;
    margin-bottom: 16px;
    box-shadow: 0 2px 12px rgba(16,77,73,0.05);
  }
  .summary-box h3 {
    font-size: 14px;
    font-weight: 700;
    color: var(--green);
    border-bottom: 2px solid var(--accent);
    padding-bottom: 5px;
    margin-bottom: 12px;
  }
  .sum-line {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 0;
    border-bottom: 1px solid rgba(16,77,73,0.06);
    font-size: 13px;
  }
  .sum-line:last-child { border-bottom: none; }
  .sum-line.total-line {
    font-size: 15px;
    font-weight: 800;
    color: var(--green);
    border-top: 2px solid var(--accent);
    margin-top: 4px;
    padding-top: 8px;
  }
  .sum-line.paid-line  { color: #155724; }
  .sum-line.remain-line { color: var(--red); }
  .sum-line .amount    { direction: ltr; font-weight: 600; }

  /* ── FOOTER ── */
  .footer {
    text-align: center;
    font-size: 11px;
    color: var(--muted);
    border-top: 1px solid var(--border);
    padding-top: 10px;
    margin-top: 6px;
  }
  .footer strong { color: var(--green); }
</style>
</head>
<body>

  <!-- ░░ HEADER ░░ -->
  <div class="header">
    <div class="header-logo">
      ${logoDataUri
        ? `<img src="${logoDataUri}" alt="Curevie" />`
        : '<div class="logo-fallback">CUREVIE</div>'}
    </div>
    <div class="header-info">
      <h1>فاتورة الحالة الطبية</h1>
      <p>رقم الفاتورة: <strong style="color:#fff;">${escapeHtml(shortInvoiceId)}</strong></p>
      <p>رقم الحالة: ${escapeHtml(shortCaseId)}</p>
      <p>تاريخ التوليد: ${escapeHtml(generatedAt)}</p>
      <div class="status-pill">${escapeHtml(statusLabel)}</div>
    </div>
  </div>

  <!-- ░░ PATIENT + INVOICE META ░░ -->
  <div class="meta-row">
    <div class="meta-card">
      <h3>بيانات المريض / الحالة</h3>
      <div class="info-line">
        <span class="info-label">الاسم</span>
        <span class="info-value">${escapeHtml(patient.name)}</span>
      </div>
      <div class="info-line">
        <span class="info-label">الهاتف</span>
        <span class="info-value">${escapeHtml(patient.phone)}</span>
      </div>
      ${patient.dob ? `
      <div class="info-line">
        <span class="info-label">تاريخ الميلاد</span>
        <span class="info-value">${escapeHtml(formatDate(patient.dob))}</span>
      </div>` : ''}
      ${patient.gender ? `
      <div class="info-line">
        <span class="info-label">الجنس</span>
        <span class="info-value">${escapeHtml(patient.gender)}</span>
      </div>` : ''}
    </div>

    <div class="meta-card">
      <h3>بيانات الفاتورة</h3>
      <div class="info-line">
        <span class="info-label">رقم الفاتورة</span>
        <span class="info-value">${escapeHtml(shortInvoiceId)}</span>
      </div>
      <div class="info-line">
        <span class="info-label">تاريخ الإصدار</span>
        <span class="info-value">${escapeHtml(formatDate(invoice.created_at))}</span>
      </div>
      <div class="info-line">
        <span class="info-label">حالة الدفع</span>
        <span class="info-value">${escapeHtml(statusLabel)}</span>
      </div>
      ${invoice.payment_method ? `
      <div class="info-line">
        <span class="info-label">طريقة الدفع</span>
        <span class="info-value">${escapeHtml(methodLabel(invoice.payment_method))}</span>
      </div>` : ''}
      ${invoice.approved_at ? `
      <div class="info-line">
        <span class="info-label">تاريخ اكتمال الدفع</span>
        <span class="info-value">${escapeHtml(formatDate(invoice.approved_at))}</span>
      </div>` : ''}
    </div>
  </div>

  <!-- ░░ SERVICES ░░ -->
  <div class="section-title">الخدمات المقدمة</div>
  <table>
    <thead>
      <tr>
        <th>الخدمة</th>
        <th style="text-align:center;">مقدم الخدمة</th>
        <th style="text-align:left;">السعر الأصلي</th>
        <th style="text-align:left;">سعر الباقة (JOD)</th>
      </tr>
    </thead>
    <tbody>${servicesRows}</tbody>
  </table>

  <!-- ░░ ADJUSTMENTS ░░ -->
  <div class="section-title">تعديلات الفاتورة</div>
  <table>
    <thead>
      <tr>
        <th style="text-align:center;">النوع</th>
        <th>السبب</th>
        <th style="text-align:left;">المبلغ</th>
        <th style="text-align:center;">التاريخ</th>
      </tr>
    </thead>
    <tbody>${adjustmentRows}</tbody>
  </table>

  <!-- ░░ FINANCIAL SUMMARY ░░ -->
  <div class="summary-box">
    <h3>الملخص المالي</h3>
    <div class="sum-line">
      <span>المبلغ الأصلي</span>
      <span class="amount">${formatMoney(invoice.original_amount)} JOD</span>
    </div>
    ${totalDiscount > 0 ? `
    <div class="sum-line" style="color:#155724;">
      <span>إجمالي الخصومات</span>
      <span class="amount text-green">− ${formatMoney(totalDiscount)} JOD</span>
    </div>` : ''}
    <div class="sum-line total-line">
      <span>المبلغ النهائي المستحق</span>
      <span class="amount">${formatMoney(invoice.final_amount)} JOD</span>
    </div>
    <div class="sum-line paid-line">
      <span>إجمالي المدفوع</span>
      <span class="amount">${formatMoney(invoice.total_paid)} JOD</span>
    </div>
    <div class="sum-line remain-line">
      <span>المتبقي</span>
      <span class="amount">${formatMoney(invoice.remaining_amount)} JOD</span>
    </div>
  </div>

  <!-- ░░ PAYMENT HISTORY ░░ -->
  <div class="section-title">سجل المدفوعات</div>
  <table>
    <thead>
      <tr>
        <th style="text-align:center;">#</th>
        <th style="text-align:center;">التاريخ والوقت</th>
        <th style="text-align:center;">طريقة الدفع</th>
        <th style="text-align:left;">المبلغ (JOD)</th>
        <th>ملاحظات</th>
      </tr>
    </thead>
    <tbody>${paymentRows}</tbody>
  </table>

  <!-- ░░ FOOTER ░░ -->
  <div class="footer">
    <strong>Curevie Medical Services</strong> &nbsp;|&nbsp;
    هذه الفاتورة وثيقة رسمية معتمدة — رقم الفاتورة: ${escapeHtml(shortInvoiceId)}
    &nbsp;|&nbsp; تاريخ التوليد: ${escapeHtml(generatedAt)}
  </div>

</body>
</html>`;
}

// ============================================================
// MAIN EXPORT
// ============================================================

/**
 * Generates a case invoice PDF as a Buffer.
 * @param {object} params
 * @param {string} params.caseId
 * @param {object} params.invoice    — row from case_invoices
 * @param {Array}  params.payments   — rows from case_payment_records
 * @param {Array}  params.adjustments — rows from invoice_adjustments
 * @returns {Promise<Buffer>}
 */
async function generateCaseInvoicePdf({ caseId, invoice, payments, adjustments }) {
  // --- Load case + snapshot ---
  const caseResult = await pool.query(
    `SELECT
       c.*,
       COALESCE(p.full_name, c.guest_name)  AS patient_name,
       COALESCE(p.phone,     c.guest_phone) AS patient_phone,
       p.date_of_birth                       AS patient_dob,
       p.gender                              AS patient_gender,
       cs.patient_data,
       cs.services_data
     FROM cases c
     LEFT JOIN patients p       ON p.id  = c.patient_id
     LEFT JOIN case_snapshots cs ON cs.case_id = c.id
     WHERE c.id = $1
     LIMIT 1`,
    [caseId]
  );
  const caseRecord = caseResult.rows[0];
  if (!caseRecord) throw new Error('CASE_NOT_FOUND');

  // --- Resolve patient info (snapshot first, live fallback) ---
  const patientSnap = normalizeJson(caseRecord.patient_data) || {};
  const patient = {
    name:   patientSnap.full_name    || caseRecord.patient_name  || '-',
    phone:  patientSnap.phone        || caseRecord.patient_phone || '-',
    dob:    patientSnap.date_of_birth || caseRecord.patient_dob  || null,
    gender: patientSnap.gender        || caseRecord.patient_gender || null,
  };

  // --- Resolve services (snapshot first, live fallback) ---
  const servicesSnap = normalizeJson(caseRecord.services_data);
  let services = Array.isArray(servicesSnap) && servicesSnap.length ? servicesSnap : [];

  if (!services.length) {
    // Snapshot missing or empty — use live case_services
    const liveResult = await pool.query(
      `SELECT
         cs.*,
         s.name AS service_name,
         s.description AS service_description,
         sp.full_name AS provider_name
       FROM case_services cs
       LEFT JOIN services s          ON s.id  = cs.service_id
       LEFT JOIN service_providers sp ON sp.id = cs.provider_id
       WHERE cs.case_id = $1
       ORDER BY cs.created_at ASC`,
      [caseId]
    );
    services = liveResult.rows;
  }

  // --- Logo ---
  const logoDataUri = await fileToDataUri(LOGO_PATH).catch(() => null);

  const shortInvoiceId = String(invoice.id || '').slice(0, 8).toUpperCase();
  const shortCaseId    = String(caseId     || '').slice(0, 8).toUpperCase();
  const generatedAt    = new Date().toLocaleString('en-GB');

  const html = buildInvoiceHtml({
    shortInvoiceId,
    shortCaseId,
    patient,
    invoice,
    services,
    payments,
    adjustments,
    logoDataUri,
    generatedAt,
  });

  const pdfBuffer = await renderPdfFromHtml(html, {
    marginTop:    '12mm',
    marginBottom: '12mm',
    marginLeft:   '14mm',
    marginRight:  '14mm',
  });

  return Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
}

module.exports = { generateCaseInvoicePdf };
