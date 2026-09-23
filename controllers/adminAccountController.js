const bcrypt = require('bcrypt');
const pool = require('../config/db');
const { logAction } = require('../services/auditService');

// GET /api/admin-accounts
async function getAdminAccounts(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT id, full_name, email, role, is_active, last_login, created_at FROM admin_accounts ORDER BY created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

// POST /api/admin-accounts — { full_name, email, password, role }
// role: 'super_admin' (full access) or 'admin' (Verification module only — OCR & Face)
async function createAdminAccount(req, res, next) {
  try {
    const { full_name, email, password, role } = req.body;
    if (!full_name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Full name, email, and password are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }
    if (!['super_admin', 'admin'].includes(role)) {
      return res.status(400).json({ success: false, message: 'Role must be super_admin or admin.' });
    }

    const [dup] = await pool.query('SELECT id FROM admin_accounts WHERE email = ?', [email]);
    if (dup[0]) return res.status(409).json({ success: false, message: 'An admin account with that email already exists.' });

    const hash = await bcrypt.hash(password, 12);
    const [result] = await pool.query(
      `INSERT INTO admin_accounts (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)`,
      [full_name, email, hash, role]
    );

    await logAction({ adminId: req.admin.id, action: 'create', module: 'admin_accounts', details: { email, role }, ip: req.ip });
    res.status(201).json({ success: true, message: 'Admin account created.', data: { id: result.insertId } });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/admin-accounts/:id — { full_name, role, is_active, password }
async function updateAdminAccount(req, res, next) {
  try {
    const { id } = req.params;
    const { full_name, role, is_active, password } = req.body;

    const [existing] = await pool.query('SELECT * FROM admin_accounts WHERE id = ?', [id]);
    if (!existing[0]) return res.status(404).json({ success: false, message: 'Admin account not found.' });

    if (Number(id) === req.admin.id && role && role !== existing[0].role) {
      return res.status(400).json({ success: false, message: 'You cannot change your own role.' });
    }
    if (Number(id) === req.admin.id && is_active === false) {
      return res.status(400).json({ success: false, message: 'You cannot deactivate your own account.' });
    }
    if (role && !['super_admin', 'admin'].includes(role)) {
      return res.status(400).json({ success: false, message: 'Role must be super_admin or admin.' });
    }

    const passwordHash = password ? await bcrypt.hash(password, 12) : existing[0].password_hash;

    await pool.query(
      `UPDATE admin_accounts SET full_name = ?, role = ?, is_active = ?, password_hash = ? WHERE id = ?`,
      [
        full_name || existing[0].full_name,
        role || existing[0].role,
        is_active === undefined ? existing[0].is_active : (is_active ? 1 : 0),
        passwordHash,
        id
      ]
    );

    await logAction({ adminId: req.admin.id, action: 'update', module: 'admin_accounts', details: { id }, ip: req.ip });
    res.json({ success: true, message: 'Admin account updated.' });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/admin-accounts/:id
async function deleteAdminAccount(req, res, next) {
  try {
    const { id } = req.params;
    if (Number(id) === req.admin.id) {
      return res.status(400).json({ success: false, message: 'You cannot delete your own account.' });
    }
    const [result] = await pool.query('DELETE FROM admin_accounts WHERE id = ?', [id]);
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Admin account not found.' });

    await logAction({ adminId: req.admin.id, action: 'delete', module: 'admin_accounts', details: { id }, ip: req.ip });
    res.json({ success: true, message: 'Admin account deleted.' });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAdminAccounts, createAdminAccount, updateAdminAccount, deleteAdminAccount };
