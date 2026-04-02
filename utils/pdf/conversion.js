const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const { PDFDocument, rgb, degrees } = require('pdf-lib');
const {
  TEMP_DIR,
  OUTPUT_DIR,
  LOGO_PATH,
  loadEmbeddedLogoImage,
} = require('./shared');

const execFileAsync = promisify(execFile);

const SUPPORTED_FORMATS = new Set([
  'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx',
  'odt', 'odp', 'ods', 'rtf', 'txt',
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff',
  'pdf',
]);

async function convertToPdf(inputPath, originalName) {
  const ext = path.extname(originalName).toLowerCase().replace('.', '');

  if (!SUPPORTED_FORMATS.has(ext)) {
    throw new Error(`نوع الملف غير مدعوم: .${ext}`);
  }

  if (ext === 'pdf') return inputPath;

  const isImage = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff'].includes(ext);
  return isImage ? convertImageToPdf(inputPath) : convertOfficeToPdf(inputPath);
}

async function convertOfficeToPdf(inputPath) {
  const loPath = process.env.LIBREOFFICE_PATH || 'soffice';

  await execFileAsync(loPath, [
    '--headless',
    '--convert-to', 'pdf',
    '--outdir', TEMP_DIR,
    inputPath,
  ], { timeout: 60000 });

  const baseName = path.basename(inputPath, path.extname(inputPath));
  const outputPath = path.join(TEMP_DIR, `${baseName}.pdf`);

  if (!fs.existsSync(outputPath)) {
    throw new Error('فشل تحويل الملف إلى PDF');
  }

  return outputPath;
}

async function convertImageToPdf(imagePath) {
  const sharp = require('sharp').default || require('sharp');
  const pdfDoc = await PDFDocument.create();
  const jpegBuffer = await sharp(imagePath).jpeg().toBuffer();
  const jpgImage = await pdfDoc.embedJpg(jpegBuffer);

  const { width, height } = jpgImage.scale(1);
  const page = pdfDoc.addPage([width, height]);
  page.drawImage(jpgImage, { x: 0, y: 0, width, height });

  const outputPath = path.join(TEMP_DIR, `${randomUUID()}.pdf`);
  await fsPromises.writeFile(outputPath, await pdfDoc.save());
  return outputPath;
}

async function addWatermark(pdfPath, options = {}) {
  const {
    text = 'Curevie',
    opacity = 0.08,
    logoOpacity = 0.06,
    addLogo = true,
  } = options;

  const pdfBytes = await fsPromises.readFile(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages = pdfDoc.getPages();
  const logoImage = addLogo ? await loadEmbeddedLogoImage(pdfDoc) : null;

  for (const page of pages) {
    const { width, height } = page.getSize();

    page.drawText(text, {
      x: width / 2 - 80,
      y: height / 2,
      size: 72,
      color: rgb(0.2, 0.6, 0.8),
      opacity,
      rotate: degrees(45),
    });

    const corners = [
      { x: 20, y: 20 },
      { x: width - 120, y: 20 },
      { x: 20, y: height - 30 },
      { x: width - 120, y: height - 30 },
    ];

    for (const corner of corners) {
      page.drawText(text, {
        x: corner.x,
        y: corner.y,
        size: 14,
        color: rgb(0.2, 0.6, 0.8),
        opacity: opacity * 1.5,
      });
    }

    if (logoImage) {
      const logoScale = Math.min(width * 0.3 / logoImage.width, height * 0.3 / logoImage.height);
      const logoW = logoImage.width * logoScale;
      const logoH = logoImage.height * logoScale;

      page.drawImage(logoImage, {
        x: (width - logoW) / 2,
        y: (height - logoH) / 2,
        width: logoW,
        height: logoH,
        opacity: logoOpacity,
      });
    } else {
      page.drawText('[ CUREVIE LOGO ]', {
        x: width / 2 - 80,
        y: height / 2 - 80,
        size: 16,
        color: rgb(0.2, 0.6, 0.8),
        opacity: opacity * 2,
      });
    }
  }

  const outputPath = path.join(OUTPUT_DIR, `${randomUUID()}_watermarked.pdf`);
  await fsPromises.writeFile(outputPath, await pdfDoc.save());
  return outputPath;
}

async function processUploadedFile(inputPath, originalName, options = {}) {
  let convertedPath = null;
  let watermarkedPath = null;

  try {
    convertedPath = await convertToPdf(inputPath, originalName);
    watermarkedPath = await addWatermark(convertedPath, options);
    return { success: true, outputPath: watermarkedPath };
  } finally {
    if (convertedPath && convertedPath !== inputPath && convertedPath !== watermarkedPath) {
      await fsPromises.unlink(convertedPath).catch(() => {});
    }
  }
}

async function cleanupOldFiles(maxAgeHours = 24) {
  const files = await fsPromises.readdir(TEMP_DIR).catch(() => []);
  const now = Date.now();
  let deleted = 0;

  for (const file of files) {
    const filePath = path.join(TEMP_DIR, file);
    const stat = await fsPromises.stat(filePath).catch(() => null);
    if (stat && (now - stat.mtimeMs) > maxAgeHours * 3600000) {
      await fsPromises.unlink(filePath).catch(() => {});
      deleted += 1;
    }
  }

  return deleted;
}

module.exports = {
  SUPPORTED_FORMATS,
  convertToPdf,
  convertOfficeToPdf,
  convertImageToPdf,
  addWatermark,
  processUploadedFile,
  cleanupOldFiles,
  OUTPUT_DIR,
  LOGO_PATH,
};
