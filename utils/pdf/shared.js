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

const RTL_CHAR_PATTERN = /[\u0590-\u08FF\uFB1D-\uFDFD\uFE70-\uFEFC]/;
const LTR_CHAR_PATTERN = /[A-Za-z]/;
const DIGIT_CHAR_PATTERN = /[0-9]/;
const BIDI_TOKEN_PATTERN = /[\u0590-\u08FF\uFB1D-\uFDFD\uFE70-\uFEFC]+|[A-Za-z0-9]+(?:[/:.,_%+-][A-Za-z0-9]+)*|\s+|./g;

function containsArabicText(value) {
  return RTL_CHAR_PATTERN.test(String(value || ''));
}

function detectTextDirection(value) {
  const normalized = String(value || '');

  for (const char of normalized) {
    if (RTL_CHAR_PATTERN.test(char)) return 'rtl';
    if (LTR_CHAR_PATTERN.test(char) || DIGIT_CHAR_PATTERN.test(char)) return 'ltr';
  }

  return containsArabicText(normalized) ? 'rtl' : 'ltr';
}

function normalizeOptionalAge(value) {
  if (value === null || value === undefined || value === '') return null;

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;

  return Math.max(0, Math.floor(numeric));
}

async function embedPdfFonts(pdfDoc) {
  try {
    const fontkit = require('@pdf-lib/fontkit');
    const regularPath = getFirstExistingPath(PDF_FONT_REGULAR_CANDIDATES);
    const boldPath = getFirstExistingPath(PDF_FONT_BOLD_CANDIDATES);
    const arabicPath = getFirstExistingPath([FONT_ARABIC, regularPath].filter(Boolean));
    const arabicBoldPath = getFirstExistingPath([FONT_ARABIC_BOLD, boldPath].filter(Boolean));

    if (regularPath && boldPath) {
      pdfDoc.registerFontkit(fontkit);
      const fontBytesCache = new Map();
      const embeddedFontCache = new Map();
      const loadFontBytes = async (fontPath) => {
        if (!fontPath) return null;
        if (!fontBytesCache.has(fontPath)) {
          fontBytesCache.set(fontPath, fsPromises.readFile(fontPath));
        }
        return fontBytesCache.get(fontPath);
      };
      const embedFontByPath = async (fontPath) => {
        if (!fontPath) return null;
        if (!embeddedFontCache.has(fontPath)) {
          embeddedFontCache.set(
            fontPath,
            loadFontBytes(fontPath).then((fontBytes) => pdfDoc.embedFont(fontBytes, { subset: true }))
          );
        }
        return embeddedFontCache.get(fontPath);
      };

      const [font, fontBold, fontArabic, fontArabicBold] = await Promise.all([
        embedFontByPath(regularPath),
        embedFontByPath(boldPath),
        embedFontByPath(arabicPath),
        embedFontByPath(arabicBoldPath),
      ]);

      return {
        font,
        fontBold,
        fontArabic: fontArabic || font,
        fontArabicBold: fontArabicBold || fontBold,
        allowUnicode: true,
      };
    }
  } catch (_) {}

  return {
    font: await pdfDoc.embedFont(StandardFonts.Helvetica),
    fontBold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
    fontArabic: null,
    fontArabicBold: null,
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

  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();

  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age -= 1;
  }

  return Math.max(0, age);
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

function createPdfTextToolkit({
  font,
  fontBold,
  fontArabic = null,
  fontArabicBold = null,
  allowUnicode,
}) {
  const asDisplay = (value, fallback = '-') => {
    if (value === null || value === undefined || value === '') return fallback;
    return normalizePdfText(value, allowUnicode);
  };

  const isBoldFont = (pdfFont) => pdfFont === fontBold || pdfFont === fontArabicBold;
  const getTokenDirection = (token, fallbackDirection = 'ltr') => {
    if (containsArabicText(token)) return 'rtl';
    if (LTR_CHAR_PATTERN.test(token) || DIGIT_CHAR_PATTERN.test(token)) return 'ltr';
    return fallbackDirection;
  };
  const getFontForDirection = (direction, bold = false) => {
    if (direction === 'rtl') {
      return bold ? (fontArabicBold || fontBold) : (fontArabic || font);
    }
    return bold ? fontBold : font;
  };
  const tokenizeLine = (line) => {
    const normalized = asDisplay(line, '');
    const fallbackDirection = detectTextDirection(normalized);
    const tokens = normalized.match(BIDI_TOKEN_PATTERN) || [];

    return tokens.map((token) => ({
      text: token,
      direction: getTokenDirection(token, fallbackDirection),
    }));
  };
  const measureFontText = (pdfFont, text, size) => {
    const normalized = normalizePdfText(text, allowUnicode);
    if (!normalized) return 0;

    try {
      return pdfFont.widthOfTextAtSize(normalized, size);
    } catch (_) {
      return pdfFont.widthOfTextAtSize(normalizePdfText(normalized, false), size);
    }
  };
  const measureText = (pdfFont, text, size) => {
    const normalized = asDisplay(text, '');
    if (!normalized) return 0;

    const bold = isBoldFont(pdfFont);
    return tokenizeLine(normalized).reduce((total, token) => {
      const tokenFont = getFontForDirection(token.direction, bold);
      return total + measureFontText(tokenFont, token.text, size);
    }, 0);
  };

  const wrapText = (pdfFont, text, size, maxWidth) => {
    const normalized = asDisplay(text, '').replace(/\r/g, '');
    if (!normalized) return [];

    const paragraphs = normalized.split('\n');
    const lines = [];

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

    paragraphs.forEach((paragraph, paragraphIndex) => {
      const collapsed = paragraph.replace(/\s+/g, ' ').trim();
      if (!collapsed) {
        if (paragraphIndex < paragraphs.length - 1) lines.push('');
        return;
      }

      const words = collapsed.split(' ');
      let current = '';

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
      if (paragraphIndex < paragraphs.length - 1) lines.push('');
    });

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
    maxWidth,
    align = 'left',
  } = {}) => {
    let cursorY = startY;

    for (const line of lines) {
      const normalizedLine = asDisplay(line, '');
      if (!normalizedLine) {
        cursorY -= lineGap;
        continue;
      }

      const lineDirection = detectTextDirection(normalizedLine);
      const tokens = tokenizeLine(normalizedLine);
      const tokenWidths = tokens.map((token) => ({
        ...token,
        font: getFontForDirection(token.direction, bold),
      })).map((token) => ({
        ...token,
        width: measureFontText(token.font, token.text, size),
      }));
      const resolvedAlign = align === 'auto'
        ? (lineDirection === 'rtl' ? 'right' : 'left')
        : align;

      if (resolvedAlign === 'right') {
        let cursorX = x + (typeof maxWidth === 'number'
          ? maxWidth
          : tokenWidths.reduce((total, token) => total + token.width, 0));

        tokenWidths.forEach((token) => {
          cursorX -= token.width;
          const drawableText = normalizePdfText(token.text, allowUnicode);
          if (!drawableText.trim()) return;
          targetPage.drawText(drawableText, {
            x: cursorX,
            y: cursorY,
            size,
            font: token.font,
            color,
          });
        });
      } else {
        let cursorX = x;

        tokenWidths.forEach((token) => {
          const drawableText = normalizePdfText(token.text, allowUnicode);
          if (drawableText.trim()) {
            targetPage.drawText(drawableText, {
              x: cursorX,
              y: cursorY,
              size,
              font: token.font,
              color,
            });
          }
          cursorX += token.width;
        });
      }

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
    containsArabicText,
    detectTextDirection,
    normalizeOptionalAge,
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
  containsArabicText,
  detectTextDirection,
  embedPdfFonts,
  formatPdfDate,
  formatPdfDateTime,
  humanizeEnum,
  getProviderTypeLabel,
  calculateAgeFromDate,
  normalizeOptionalAge,
  getAttachmentFileName,
  loadEmbeddedLogoImage,
  createPdfTextToolkit,
};
