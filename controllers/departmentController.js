const pool = require('../config/db');
const { logAction } = require('../services/auditService');

async function getDepartments(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT d.*, COUNT(e.id) AS employee_count
       FROM departments d LEFT JOIN employees e ON e.department_id = d.id
       GROUP BY d.id ORDER BY d.name`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

async function createDepartment(req, res, next) {
  try {
    const { name, office, description } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Department name is required.' });

    const [result] = await pool.query(
      'INSERT INTO departments (name, office, description) VALUES (?, ?, ?)',
      [name, office || name, description || null]
    );
    await logAction({ adminId: req.admin.id, action: 'create', module: 'departments', details: { name }, ip: req.ip });
    res.status(201).json({ success: true, message: 'Department created.', data: { id: result.insertId } });
  } catch (err) {
    next(err);
  }
}

async function deleteDepartment(req, res, next) {
  try {
    const [result] = await pool.query('DELETE FROM departments WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Department not found.' });
    res.json({ success: true, message: 'Department deleted.' });
  } catch (err) {
    next(err);
  }
}

module.exports = { getDepartments, createDepartment, deleteDepartment };
