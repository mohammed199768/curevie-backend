const fs = require('fs');
const path = require('path');

const BACKEND_ROOT = path.join(__dirname, '..', '..');
const LOGO_PATH = path.join(BACKEND_ROOT, 'assets', '3.png');

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

/** Converts stored bytes into a data URI that can be embedded in report HTML. */
function bufferToDataUri(buffer, mimeType) {
  return `data:${mimeType};base64,${Buffer.from(buffer).toString('base64')}`;
}

module.exports = {
  LOGO_PATH,
  loadEmbeddedLogoImage,
  bufferToDataUri,
};
