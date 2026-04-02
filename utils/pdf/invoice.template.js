function escapeHtml(value) {
  if (value === null || value === undefined) return '-';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString('en-GB') : '-';
}

function formatDateTime(value) {
  return value ? new Date(value).toLocaleString('en-GB') : '-';
}

function formatMoney(value) {
  return `${parseFloat(value || 0).toFixed(2)} JD`;
}

function buildFontFaceCss(assets = {}) {
  const entries = [];
  if (assets.regularFontDataUri) {
    entries.push(`
      @font-face {
        font-family: 'ReportSans';
        font-weight: 400;
        font-style: normal;
        src: url('${assets.regularFontDataUri}') format('truetype');
      }
    `);
  }
  if (assets.boldFontDataUri) {
    entries.push(`
      @font-face {
        font-family: 'ReportSans';
        font-weight: 700;
        font-style: normal;
        src: url('${assets.boldFontDataUri}') format('truetype');
      }
    `);
  }
  return entries.join('\n');
}

function renderInvoiceHtml(invoiceData, assets = {}) {
  const invoice = invoiceData.invoice || {};
  const payments = Array.isArray(invoiceData.payments) ? invoiceData.payments : [];

  const patientName = invoice.patient_name || invoice.guest_name || 'Guest';
  const patientPhone = invoice.patient_phone || invoice.guest_phone || '-';
  const serviceName = invoice.service_name || invoice.lab_test_name || invoice.package_name || 'Service';
  const serviceType = invoice.service_type || invoice.request_type || '-';
  const paymentStatus = String(invoice.payment_status || 'PENDING').toUpperCase();
  const isPaid = paymentStatus === 'PAID';

  const adjustmentRows = [];
  if (parseFloat(invoice.vip_discount_amount) > 0) {
    adjustmentRows.push({
      label: `VIP Discount (${invoice.vip_discount}%)`,
      value: `- ${formatMoney(invoice.vip_discount_amount)}`,
      kind: 'success',
    });
  }
  if (parseFloat(invoice.coupon_discount_amount) > 0) {
    adjustmentRows.push({
      label: `Coupon: ${invoice.coupon_code || '-'}`,
      value: `- ${formatMoney(invoice.coupon_discount_amount)}`,
      kind: 'success',
    });
  }
  if (parseFloat(invoice.points_discount_amount) > 0) {
    adjustmentRows.push({
      label: `Points Discount (${invoice.points_used || 0} pts)`,
      value: `- ${formatMoney(invoice.points_discount_amount)}`,
      kind: 'success',
    });
  }

  const totalPaid = payments.reduce((sum, payment) => sum + parseFloat(payment.amount || 0), 0);
  const remaining = Math.max(0, parseFloat(invoice.final_amount || 0) - totalPaid);
  const logoHtml = assets.logoDataUri
    ? `<img class="brand-logo" src="${assets.logoDataUri}" alt="Curevie" />`
    : `<span class="brand-wordmark">CUREVIE</span>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Curevie Invoice</title>
  <style>
    ${buildFontFaceCss(assets)}

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      background: #edf2ee;
      color: #16211f;
      font-family: 'ReportSans', 'Trebuchet MS', 'Segoe UI', Arial, sans-serif;
      font-size: 10pt;
      line-height: 1.5;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    @page { size: A4; margin: 0; }
    .page-shell { padding: 14px; }
    .invoice-page {
      background: #f8fbf8;
      border-radius: 20px;
      overflow: hidden;
    }

    .hero {
      background: linear-gradient(135deg, #104d49 0%, #304a43 100%);
      padding: 30px 36px 28px;
      position: relative;
    }
    .hero::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 5px;
      background: #c69d2e;
    }
    .hero-grid {
      display: flex;
      justify-content: space-between;
      gap: 24px;
      align-items: flex-start;
    }
    .brand-logo {
      height: 42px;
      display: block;
      margin-bottom: 14px;
    }
    .brand-wordmark {
      display: block;
      margin-bottom: 14px;
      color: #fff;
      font-size: 22pt;
      font-weight: 700;
      letter-spacing: 0.06em;
    }
    .hero-kicker {
      font-size: 7.5pt;
      color: #7fb0a2;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      margin-bottom: 6px;
    }
    .hero-title {
      font-size: 22pt;
      line-height: 1.12;
      font-weight: 700;
      color: #fff;
      margin-bottom: 8px;
    }
    .hero-copy {
      font-size: 10pt;
      color: #a4d0c5;
      max-width: 380px;
    }
    .invoice-chip {
      min-width: 182px;
      background: rgba(255,255,255,0.96);
      color: #104d49;
      border-radius: 16px;
      padding: 18px 18px 16px;
    }
    .invoice-chip-label {
      font-size: 8pt;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #738381;
      margin-bottom: 8px;
    }
    .invoice-chip-number {
      font-size: 16pt;
      font-weight: 700;
      margin-bottom: 6px;
    }
    .invoice-chip-date {
      font-size: 8.5pt;
      color: #5b6a68;
    }

    .body {
      padding: 30px 36px 38px;
    }
    .overview-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      margin-bottom: 20px;
    }
    .card {
      background: #fff;
      border: 1px solid #dde6dc;
      border-radius: 16px;
      overflow: hidden;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .card-bar {
      height: 6px;
      background: #104d49;
    }
    .card-bar.gold { background: #c69d2e; }
    .card-body {
      padding: 18px 20px 20px;
    }
    .card-tag {
      display: inline-block;
      margin-bottom: 10px;
      padding: 3px 8px;
      border-radius: 999px;
      background: #edf4e8;
      color: #4f7a41;
      font-size: 7pt;
      font-weight: 700;
      letter-spacing: 0.10em;
      text-transform: uppercase;
    }
    .card-tag.gold {
      background: #f7f0dc;
      color: #7a5a0a;
    }
    .card-title {
      font-size: 15pt;
      line-height: 1.18;
      color: #104d49;
      font-weight: 700;
      margin-bottom: 14px;
    }
    .info-table {
      width: 100%;
      border-collapse: collapse;
    }
    .info-table td {
      padding: 4px 0;
      vertical-align: top;
      font-size: 8.5pt;
    }
    .info-label {
      width: 42%;
      color: #6a7775;
      font-weight: 700;
      padding-right: 10px;
      white-space: nowrap;
    }
    .info-value {
      color: #16211f;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      margin-top: 12px;
      padding: 5px 12px;
      border-radius: 999px;
      font-size: 8pt;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      border: 1px solid transparent;
    }
    .status-paid {
      background: #e7f5ea;
      color: #1d6633;
      border-color: #b7dcc0;
    }
    .status-pending {
      background: #fdeaea;
      color: #8b2b2b;
      border-color: #efbcbc;
    }

    .section {
      margin-top: 22px;
    }
    .section-kicker {
      font-size: 7pt;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #8da2a0;
      margin-bottom: 4px;
    }
    .section-title {
      font-size: 16pt;
      font-weight: 700;
      color: #104d49;
      line-height: 1.08;
    }
    .section-rule {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 8px;
      margin-bottom: 14px;
    }
    .section-rule-accent {
      width: 84px;
      height: 3px;
      background: #4f7a41;
      border-radius: 2px;
      flex-shrink: 0;
    }
    .section-rule-line {
      flex: 1;
      height: 1px;
      background: #dde6dc;
    }

    .table-shell {
      border: 1px solid #dde6dc;
      border-radius: 14px;
      overflow: hidden;
      background: #fff;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .table-header,
    .table-row,
    .table-total {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 120px;
      gap: 14px;
      align-items: start;
    }
    .table-header {
      background: #104d49;
      color: #fff;
      padding: 12px 16px;
      font-size: 8pt;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .table-row {
      padding: 12px 16px;
      border-top: 1px solid #edf1ec;
      font-size: 9pt;
    }
    .table-row:nth-child(odd) {
      background: #fbfdfb;
    }
    .table-row.adjustment {
      background: #f5faf6;
      color: #21663a;
    }
    .table-row-desc {
      color: #16211f;
    }
    .table-row-value {
      text-align: right;
      font-weight: 700;
      white-space: nowrap;
    }
    .table-total {
      background: #104d49;
      color: #fff;
      padding: 14px 16px;
      font-size: 11pt;
      font-weight: 700;
    }
    .table-total .table-row-value {
      color: #d8f0d0;
      font-size: 13pt;
    }

    .payments-shell {
      border: 1px solid #dde6dc;
      border-radius: 14px;
      overflow: hidden;
      background: #fff;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    table.payments {
      width: 100%;
      border-collapse: collapse;
    }
    .payments th {
      background: #edf3ed;
      color: #304a43;
      padding: 11px 14px;
      text-align: left;
      font-size: 8pt;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .payments td {
      padding: 11px 14px;
      border-top: 1px solid #edf1ec;
      font-size: 8.7pt;
    }
    .payments tbody tr:nth-child(even) td {
      background: #fbfdfb;
    }
    .payments .amount {
      text-align: right;
      font-weight: 700;
      color: #21663a;
      white-space: nowrap;
    }
    .payments-summary {
      display: flex;
      gap: 20px;
      justify-content: flex-end;
      padding: 14px 16px 16px;
      border-top: 1px solid #edf1ec;
      background: #fbfdfb;
      font-size: 9pt;
      flex-wrap: wrap;
    }
    .payments-summary strong {
      color: #104d49;
    }
    .payments-summary .remaining {
      color: #8b2b2b;
    }

    .footer {
      background: #104d49;
      padding: 18px 36px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      position: relative;
    }
    .footer::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: #c69d2e;
    }
    .footer-brand {
      color: #9fcfc4;
      font-weight: 700;
      font-size: 9pt;
    }
    .footer-copy {
      color: #7fb0a2;
      font-size: 8pt;
    }

    @media print {
      .page-shell { padding: 0; }
      .invoice-page { border-radius: 0; }
      .body { padding-bottom: 56px; }
      .overview-grid { display: block; }
      .card { margin-bottom: 14px; }
      tr, td, th, .table-row, .table-total, .payments-summary {
        break-inside: avoid;
        page-break-inside: avoid;
      }
    }
  </style>
</head>
<body>
  <div class="page-shell">
    <div class="invoice-page">
      <header class="hero">
        <div class="hero-grid">
          <div>
            ${logoHtml}
            <div class="hero-kicker">Medical Billing Record</div>
            <div class="hero-title">Invoice</div>
            <div class="hero-copy">Professional summary of charges and payment activity.</div>
          </div>
          <div class="invoice-chip">
            <div class="invoice-chip-label">Invoice</div>
            <div class="invoice-chip-number">#${escapeHtml(String(invoice.id || '').slice(0, 8).toUpperCase())}</div>
            <div class="invoice-chip-date">Issued ${escapeHtml(formatDate(invoice.created_at))}</div>
          </div>
        </div>
      </header>

      <main class="body">
        <section class="overview-grid">
          <article class="card">
            <div class="card-bar"></div>
            <div class="card-body">
              <div class="card-tag">Bill To</div>
              <div class="card-title">${escapeHtml(patientName)}</div>
              <table class="info-table">
                <tr><td class="info-label">Phone</td><td class="info-value">${escapeHtml(patientPhone)}</td></tr>
                <tr><td class="info-label">Address</td><td class="info-value">${escapeHtml(invoice.patient_address || invoice.guest_address || '-')}</td></tr>
                <tr><td class="info-label">Request</td><td class="info-value">${escapeHtml(String(invoice.request_id || '').slice(0, 8).toUpperCase() || '-')}</td></tr>
              </table>
              <div class="status-pill ${isPaid ? 'status-paid' : 'status-pending'}">${escapeHtml(paymentStatus)}</div>
            </div>
          </article>

          <article class="card">
            <div class="card-bar gold"></div>
            <div class="card-body">
              <div class="card-tag gold">Service</div>
              <div class="card-title">${escapeHtml(serviceName)}</div>
              <table class="info-table">
                <tr><td class="info-label">Type</td><td class="info-value">${escapeHtml(serviceType)}</td></tr>
                <tr><td class="info-label">Provider</td><td class="info-value">${escapeHtml(invoice.provider_name || '-')}</td></tr>
                <tr><td class="info-label">Visit Date</td><td class="info-value">${escapeHtml(formatDateTime(invoice.completed_at))}</td></tr>
              </table>
            </div>
          </article>
        </section>

        <section class="section">
          <div class="section-kicker">Section</div>
          <div class="section-title">Charges Summary</div>
          <div class="section-rule">
            <div class="section-rule-accent"></div>
            <div class="section-rule-line"></div>
          </div>
          <div class="table-shell">
            <div class="table-header">
              <div>Description</div>
              <div style="text-align:right">Amount</div>
            </div>
            <div class="table-row">
              <div class="table-row-desc">${escapeHtml(serviceName)}</div>
              <div class="table-row-value">${escapeHtml(formatMoney(invoice.original_amount))}</div>
            </div>
            ${adjustmentRows.map((row) => `
              <div class="table-row adjustment">
                <div class="table-row-desc">${escapeHtml(row.label)}</div>
                <div class="table-row-value">${escapeHtml(row.value)}</div>
              </div>
            `).join('')}
            <div class="table-total">
              <div>Total Due</div>
              <div class="table-row-value">${escapeHtml(formatMoney(invoice.final_amount))}</div>
            </div>
          </div>
        </section>

        ${
          payments.length
            ? `
              <section class="section">
                <div class="section-kicker">Section</div>
                <div class="section-title">Payment History</div>
                <div class="section-rule">
                  <div class="section-rule-accent"></div>
                  <div class="section-rule-line"></div>
                </div>
                <div class="payments-shell">
                  <table class="payments">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Method</th>
                        <th style="text-align:right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${payments.map((payment) => `
                        <tr>
                          <td>${escapeHtml(formatDate(payment.created_at))}</td>
                          <td>${escapeHtml(payment.payment_method || '-')}</td>
                          <td class="amount">${escapeHtml(formatMoney(payment.amount))}</td>
                        </tr>
                      `).join('')}
                    </tbody>
                  </table>
                  <div class="payments-summary">
                    <div><strong>Total Paid:</strong> ${escapeHtml(formatMoney(totalPaid))}</div>
                    ${remaining > 0 ? `<div class="remaining"><strong>Remaining:</strong> ${escapeHtml(formatMoney(remaining))}</div>` : ''}
                  </div>
                </div>
              </section>
            `
            : ''
        }
      </main>

      <footer class="footer">
        <div class="footer-brand">Curevie Clinical Billing</div>
        <div class="footer-copy">Generated ${escapeHtml(formatDateTime(new Date()))}</div>
      </footer>
    </div>
  </div>
</body>
</html>`;
}

module.exports = {
  renderInvoiceHtml,
};
