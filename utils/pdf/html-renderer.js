const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');

function getMimeTypeFromPath(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();

  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.woff') return 'font/woff';
  if (ext === '.woff2') return 'font/woff2';
  if (ext === '.ttf') return 'font/ttf';
  if (ext === '.otf') return 'font/otf';

  return 'application/octet-stream';
}

async function fileToDataUri(filePath) {
  if (!filePath) return null;

  try {
    const fileBuffer = await fsPromises.readFile(filePath);
    const mimeType = getMimeTypeFromPath(filePath);
    return `data:${mimeType};base64,${fileBuffer.toString('base64')}`;
  } catch (_) {
    return null;
  }
}

function resolveChromiumExecutablePath() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROMIUM_PATH,
    process.env.CHROME_BIN,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function renderPdfFromHtml(html, options = {}) {
  const puppeteer = require('puppeteer');
  const executablePath = resolveChromiumExecutablePath();
  const launchOptions = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  };

  if (executablePath) {
    launchOptions.executablePath = executablePath;
  }

  const browser = await puppeteer.launch(launchOptions);

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 2048 });
    await page.setContent(html, { waitUntil: ['domcontentloaded', 'load', 'networkidle0'] });
    await page.emulateMediaType(options.mediaType || 'print');
    await page.evaluate(async () => {
      if (document.fonts?.ready) {
        await document.fonts.ready;
      }
    });

    const displayHeaderFooter = options.displayHeaderFooter ?? true;
    const headerTemplate = options.headerTemplate ?? '<div></div>';
    const footerTemplate = options.footerTemplate ?? `
      <div style="width:100%;padding:0 24px 10px 24px;font-family:Arial,sans-serif;font-size:8px;color:#6f7f7d;display:flex;justify-content:space-between;align-items:center;">
        <span>Curevie Clinical Records</span>
        <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
      </div>
    `;

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter,
      headerTemplate,
      footerTemplate,
      margin: {
        top: options.marginTop || '18px',
        right: options.marginRight || '14px',
        bottom: options.marginBottom || '74px',
        left: options.marginLeft || '14px',
      },
      timeout: options.timeout || 120000,
    });

    return Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
  } finally {
    await browser.close();
  }
}

module.exports = {
  fileToDataUri,
  renderPdfFromHtml,
};
