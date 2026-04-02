const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const { StandardFonts, rgb } = require('pdf-lib');

// AUDIT-FIX: PATH — use __dirname so paths resolve inside backend/
// __dirname = backend/utils/pdf → BACKEND_ROOT = backend/
const BACKEND_ROOT = path.join(__dirname, '..', '..');
const TEMP_DIR = path.join(BACKEND_ROOT, 'uploads', 'temp');
const OUTPUT_DIR = path.join(BACKEND_ROOT, 'uploads', 'pdfs');
function resolveFontPath(envKey, linuxPath, windowsPath) {
  if (process.env[envKey] && fs.existsSync(process.env[envKey])) {
    return process.env[envKey];
  }
  if (fs.existsSync(linuxPath)) return linuxPath;
  if (fs.existsSync(windowsPath)) return windowsPath;
  return null;
}

const FONT_REGULAR = resolveFontPath(
  'PDF_FONT_REGULAR_PATH',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  'C:\\Windows\\Fonts\\arial.ttf'
);

const FONT_BOLD = resolveFontPath(
  'PDF_FONT_BOLD_PATH',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  'C:\\Windows\\Fonts\\arialbd.ttf'
);

const FONT_ARABIC = resolveFontPath(
  'PDF_FONT_ARABIC_PATH',
  '/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf',
  'C:\\Windows\\Fonts\\tahoma.ttf'
);

const FONT_ARABIC_BOLD = resolveFontPath(
  'PDF_FONT_ARABIC_BOLD_PATH',
  '/usr/share/fonts/truetype/noto/NotoNaskhArabic-Bold.ttf',
  'C:\\Windows\\Fonts\\tahomabd.ttf'
);

const PDF_FONT_REGULAR_CANDIDATES = [
  FONT_REGULAR,
  FONT_ARABIC,
].filter(Boolean);
const PDF_FONT_BOLD_CANDIDATES = [
  FONT_BOLD,
  FONT_ARABIC_BOLD,
].filter(Boolean);
const LOGO_PATH = path.join(BACKEND_ROOT, 'assets', 'logo.webp');

[TEMP_DIR, OUTPUT_DIR, path.join(BACKEND_ROOT, 'assets')].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function getFirstExistingPath(candidates = []) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function normalizePdfText(value, allowUnicode = false) {
  if (value === null || value === undefined || value === '') return '-';
  const text = String(value);
  return allowUnicode ? text : text.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}

async function embedPdfFonts(pdfDoc) {
  try {
    const fontkit = require('@pdf-lib/fontkit');
    const regularPath = getFirstExistingPath(PDF_FONT_REGULAR_CANDIDATES);
    const boldPath = getFirstExistingPath(PDF_FONT_BOLD_CANDIDATES);

    if (regularPath && boldPath) {
      pdfDoc.registerFontkit(fontkit);
      const [regularBytes, boldBytes] = await Promise.all([
        fsPromises.readFile(regularPath),
        fsPromises.readFile(boldPath),
      ]);

      return {
        font: await pdfDoc.embedFont(regularBytes, { subset: true }),
        fontBold: await pdfDoc.embedFont(boldBytes, { subset: true }),
        allowUnicode: true,
      };
    }
  } catch (_) {}

  return {
    font: await pdfDoc.embedFont(StandardFonts.Helvetica),
    fontBold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
    allowUnicode: false,
  };
}

function formatPdfDate(value) {
  return value ? new Date(value).toLocaleDateString('en-GB') : '-';
}

function formatPdfDateTime(value) {
  return value ? new Date(value).toLocaleString('en-GB') : '-';
}

function humanizeEnum(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '-';

  return normalized
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function getProviderTypeLabel(providerType) {
  const normalized = String(providerType || '').trim().toUpperCase();

  if (normalized === 'DOCTOR') return 'Doctor';
  if (normalized === 'LAB_TECH') return 'Lab Technician';
  if (normalized === 'RADIOLOGY_TECH') return 'Radiology Technician';
  if (normalized === 'NURSE') return 'Nurse';

  return humanizeEnum(providerType);
}

function calculateAgeFromDate(dob) {
  if (!dob) return null;

  const birthDate = new Date(dob);
  if (Number.isNaN(birthDate.getTime())) return null;

  const now = new Date();
  let age = now.getFullYear() - birthDate.getFullYear();
  const monthDelta = now.getMonth() - birthDate.getMonth();

  if (monthDelta < 0 || (monthDelta === 0 && now.getDate() < birthDate.getDate())) {
    age -= 1;
  }

  return age >= 0 ? age : null;
}

function getAttachmentFileName(fileUrl) {
  try {
    if (/^https?:\/\//i.test(String(fileUrl || ''))) {
      return decodeURIComponent(path.basename(new URL(fileUrl).pathname));
    }
  } catch (_) {}

  return decodeURIComponent(path.basename(String(fileUrl || '').split('?')[0] || 'document.pdf'));
}

async function loadEmbeddedLogoImage(pdfDoc) {
  try {
    if (!fs.existsSync(LOGO_PATH)) return null;

    const sharp = require('sharp').default || require('sharp');
    const logoPngBuffer = await sharp(LOGO_PATH).png().toBuffer();
    return pdfDoc.embedPng(logoPngBuffer);
  } catch (_) {
    return null;
  }
}

function createPdfTextToolkit({ font, fontBold, allowUnicode }) {
  const asDisplay = (value, fallback = '-') => {
    if (value === null || value === undefined || value === '') return fallback;
    return normalizePdfText(value, allowUnicode);
  };

  const measureText = (pdfFont, text, size) => {
    const normalized = asDisplay(text, '');

    try {
      return pdfFont.widthOfTextAtSize(normalized, size);
    } catch (_) {
      return pdfFont.widthOfTextAtSize(normalizePdfText(normalized, false), size);
    }
  };

  const wrapText = (pdfFont, text, size, maxWidth) => {
    const normalized = asDisplay(text, '').replace(/\s+/g, ' ').trim();
    if (!normalized) return [];

    const words = normalized.split(' ');
    const lines = [];
    let current = '';

    const pushSplitWord = (token) => {
      let chunk = '';
      for (const char of token) {
        const candidate = `${chunk}${char}`;
        if (measureText(pdfFont, candidate, size) <= maxWidth) {
          chunk = candidate;
        } else {
          if (chunk) lines.push(chunk);
          chunk = char;
        }
      }
      if (chunk) lines.push(chunk);
    };

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;

      if (measureText(pdfFont, candidate, size) <= maxWidth) {
        current = candidate;
      } else if (!current) {
        pushSplitWord(word);
      } else {
        lines.push(current);
        if (measureText(pdfFont, word, size) <= maxWidth) {
          current = word;
        } else {
          pushSplitWord(word);
          current = '';
        }
      }
    }

    if (current) lines.push(current);
    return lines;
  };

  const truncateText = (pdfFont, text, size, maxWidth) => {
    const normalized = asDisplay(text, '');
    if (!normalized) return '';
    if (measureText(pdfFont, normalized, size) <= maxWidth) return normalized;

    const ellipsis = '...';
    const ellipsisWidth = measureText(pdfFont, ellipsis, size);
    let output = '';

    for (const char of normalized) {
      const candidate = `${output}${char}`;
      if (measureText(pdfFont, candidate, size) + ellipsisWidth > maxWidth) break;
      output = candidate;
    }

    return output ? `${output}${ellipsis}` : ellipsis;
  };

  const drawTextLines = (targetPage, lines, x, startY, {
    size = 10,
    bold = false,
    color = rgb(0, 0, 0),
    lineGap = 13,
  } = {}) => {
    let cursorY = startY;
    for (const line of lines) {
      targetPage.drawText(asDisplay(line, ''), {
        x,
        y: cursorY,
        size,
        font: bold ? fontBold : font,
        color,
      });
      cursorY -= lineGap;
    }
    return cursorY;
  };

  return {
    asDisplay,
    measureText,
    wrapText,
    truncateText,
    drawTextLines,
  };
}

module.exports = {
  TEMP_DIR,
  OUTPUT_DIR,
  LOGO_PATH,
  FONT_REGULAR,
  FONT_BOLD,
  FONT_ARABIC,
  FONT_ARABIC_BOLD,
  PDF_FONT_REGULAR_CANDIDATES,
  PDF_FONT_BOLD_CANDIDATES,
  getFirstExistingPath,
  normalizePdfText,
  embedPdfFonts,
  formatPdfDate,
  formatPdfDateTime,
  humanizeEnum,
  getProviderTypeLabel,
  calculateAgeFromDate,
  getAttachmentFileName,
  loadEmbeddedLogoImage,
  createPdfTextToolkit,
};
