const pool = require('../config/db');
const path = require('path');
const certificateService = require('../services/certificateService');
const { logAction } = require('../services/auditService');

// POST /api/certificates/generate  { employee_id, event_title, event_id? }
async function generateCertificate(req, res, next) {
  try {
    const { employee_id, event_title, event_id } = req.body;
    if (!employee_id || !event_title) {
      return res.status(400).json({ success: false, message: 'employee_id and event_title are required.' });
    }

    const [empRows] = await pool.query('SELECT full_name FROM employees WHERE id = ?', [employee_id]);
    if (!empRows[0]) return res.status(404).json({ success: false, message: 'Employee not found.' });

    const certificateNumber = `CERT-${new Date().getFullYear()}-${Date.now().toString().slice(-6)}`;
    const issuedDate = new Date().toISOString().slice(0, 10);

    const { pdfPath } = await certificateService.generateCertificatePdf({
      certificateNumber,
      employeeName: empRows[0].full_name,
      eventTitle: event_title,
      issuedDate
    });

    const relativePath = `/uploads/certificates/${path.basename(pdfPath)}`;

    const [result] = await pool.query(
      `INSERT INTO certificates (employee_id, event_id, certificate_number, event_title, issued_date, pdf_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [employee_id, event_id || null, certificateNumber, event_title, issuedDate, relativePath]
    );

    await logAction({ adminId: req.admin.id, action: 'generate', module: 'certificates', details: { certificateNumber }, ip: req.ip });

    res.status(201).json({
      success: true,
      message: 'Certificate generated successfully.',
      data: { id: result.insertId, certificateNumber, downloadUrl: relativePath }
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/certificates
async function getCertificates(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT c.*, e.full_name FROM certificates c JOIN employees e ON c.employee_id = e.id
       ORDER BY c.created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

module.exports = { generateCertificate, getCertificates };
