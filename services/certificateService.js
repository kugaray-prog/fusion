const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

/**
 * Generates a PDF attendance certificate with an embedded QR code
 * that encodes the certificate number for verification.
 * Returns { pdfPath, qrPath }.
 */
async function generateCertificatePdf({ certificateNumber, employeeName, eventTitle, issuedDate }) {
  const dir = path.join(__dirname, '..', 'uploads', 'certificates');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const qrPath = path.join(dir, `${certificateNumber}-qr.png`);
  const pdfPath = path.join(dir, `${certificateNumber}.pdf`);

  await QRCode.toFile(qrPath, `GEOATTEND-CERT:${certificateNumber}`, { width: 200 });

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 50 });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    doc.rect(20, 20, doc.page.width - 40, doc.page.height - 40).lineWidth(3).strokeColor('#0D00A5').stroke();

    doc.fontSize(30).fillColor('#0D00A5').font('Helvetica-Bold')
      .text('CERTIFICATE OF ATTENDANCE', 0, 100, { align: 'center' });

    doc.fontSize(14).fillColor('#333').font('Helvetica')
      .text('This is to certify that', 0, 160, { align: 'center' });

    doc.fontSize(26).fillColor('#1B2559').font('Helvetica-Bold')
      .text(employeeName, 0, 190, { align: 'center' });

    doc.fontSize(14).fillColor('#333').font('Helvetica')
      .text('has successfully participated in', 0, 235, { align: 'center' });

    doc.fontSize(18).fillColor('#0D00A5').font('Helvetica-Bold')
      .text(eventTitle, 0, 260, { align: 'center' });

    doc.fontSize(12).fillColor('#666').font('Helvetica')
      .text(`Issued on ${issuedDate} — Certificate No. ${certificateNumber}`, 0, 300, { align: 'center' });

    doc.image(qrPath, doc.page.width - 170, doc.page.height - 190, { width: 100 });

    doc.fontSize(10).fillColor('#999')
      .text('Verified via GeoAttend Pro', doc.page.width - 175, doc.page.height - 85, { width: 110, align: 'center', lineBreak: false });

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  return { pdfPath, qrPath };
}

module.exports = { generateCertificatePdf };
