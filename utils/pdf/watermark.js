const { PDFDocument, rgb, degrees } = require('pdf-lib');
const { loadEmbeddedLogoImage } = require('./shared');

/**
 * Stamps every page of a PDF with the Curevie text and logo watermark.
 * @param {Buffer} pdfBuffer
 * @returns {Promise<Buffer>}
 */
async function addWatermarkToBuffer(pdfBuffer, options = {}) {
  const {
    text = 'Curevie',
    opacity = 0.08,
    logoOpacity = 0.06,
    addLogo = true,
  } = options;

  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const logoImage = addLogo ? await loadEmbeddedLogoImage(pdfDoc) : null;

  for (const page of pdfDoc.getPages()) {
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
      const logoScale = Math.min((width * 0.3) / logoImage.width, (height * 0.3) / logoImage.height);
      const logoW = logoImage.width * logoScale;
      const logoH = logoImage.height * logoScale;

      page.drawImage(logoImage, {
        x: (width - logoW) / 2,
        y: (height - logoH) / 2,
        width: logoW,
        height: logoH,
        opacity: logoOpacity,
      });
    }
  }

  return Buffer.from(await pdfDoc.save());
}

module.exports = { addWatermarkToBuffer };
