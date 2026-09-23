const Tesseract = require('tesseract.js');
const path = require('path');

const TESSDATA_PATH = path.join(__dirname, '..', 'tessdata');

/**
 * Runs Tesseract OCR on the given image path and returns raw text + confidence.
 * Uses a locally bundled eng.traineddata (see /tessdata) so this works fully
 * offline / behind restrictive firewalls, with no runtime CDN dependency.
 */
async function extractText(imagePath) {
  try {
    const { data } = await Tesseract.recognize(imagePath, 'eng', {
      langPath: TESSDATA_PATH,
      gzip: true,
      cacheMethod: 'none',
      logger: () => {} // silence per-tile progress logs
    });
    return {
      text: data.text || '',
      confidence: data.confidence || 0 // 0-100
    };
  } catch (err) {
    // Never let an OCR engine failure (bad image, corrupted upload, etc.) crash the process.
    console.error('OCR extraction failed:', err.message);
    return { text: '', confidence: 0 };
  }
}

/**
 * Parses raw OCR text looking for the employee ID number only (e.g. E001,
 * EMP-001, or a purely numeric ID like 2025020147). Name and position are
 * intentionally NOT extracted from the card — once the ID number is found,
 * the employee's name/position are pulled straight from the `employees`
 * table instead, which is both more reliable and matches what's actually
 * on record.
 */
function parseIdCard(rawText) {
  const lines = rawText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // Prefer digits sitting right under/near an "EMPLOYEE NUMBER" label,
  // since that's the most reliable anchor. Fall back to a classic
  // letter-prefixed code (E001), then to any standalone 6-12 digit run
  // (modern CSPC-style IDs print a plain numeric employee number).
  let employeeCode = null;
  const labelIdx = lines.findIndex((l) => /employee\s*number/i.test(l));
  if (labelIdx !== -1) {
    // The number is usually printed just above its "EMPLOYEE NUMBER" label.
    for (let i = labelIdx; i >= Math.max(0, labelIdx - 2); i--) {
      const m = lines[i].match(/\b(\d{6,12})\b/);
      if (m) { employeeCode = m[1]; break; }
    }
  }
  if (!employeeCode) {
    const letterCode = rawText.match(/\b([A-Z]{1,4}-?\d{2,6})\b/);
    if (letterCode) employeeCode = letterCode[1].replace('-', '');
  }
  if (!employeeCode) {
    const numericCode = rawText.match(/\b(\d{6,12})\b/);
    if (numericCode) employeeCode = numericCode[1];
  }

  return { employeeCode, lines };
}

module.exports = { extractText, parseIdCard };
