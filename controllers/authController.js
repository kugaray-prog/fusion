const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../config/db');
const config = require('../config/config');
const { logAction } = require('../services/auditService');

// POST /api/auth/login
async function login(req, res, next) {
  try {
    const { email, password, remember } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    const [rows] = await pool.query('SELECT * FROM admin_accounts WHERE email = ? AND is_active = 1', [email]);
    const admin = rows[0];

    if (!admin) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    const match = await bcrypt.compare(password, admin.password_hash);
    if (!match) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    const token = jwt.sign(
      { id: admin.id, email: admin.email, role: admin.role, name: admin.full_name },
      config.jwt.secret,
      { expiresIn: remember ? '30d' : config.jwt.expiresIn }
    );

    await pool.query('UPDATE admin_accounts SET last_login = NOW() WHERE id = ?', [admin.id]);
    await logAction({ adminId: admin.id, action: 'login', module: 'auth', ip: req.ip });

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: (remember ? 30 : 1) * 24 * 60 * 60 * 1000
    });

    res.json({
      success: true,
      message: 'Login successful.',
      token,
      admin: { id: admin.id, name: admin.full_name, email: admin.email, role: admin.role }
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/logout
async function logout(req, res) {
  res.clearCookie('token');
  res.json({ success: true, message: 'Logged out successfully.' });
}

// GET /api/auth/me
async function me(req, res, next) {
  try {
    const [rows] = await pool.query(
      'SELECT id, full_name, email, role, last_login FROM admin_accounts WHERE id = ?',
      [req.admin.id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Admin account not found.' });
    res.json({ success: true, admin: rows[0] });
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/forgot-password
async function forgotPassword(req, res, next) {
  try {
    const { email } = req.body;
    const [rows] = await pool.query('SELECT id FROM admin_accounts WHERE email = ?', [email]);

    // Always respond the same way to avoid leaking which emails exist
    if (!rows[0]) {
      return res.json({ success: true, message: 'If that email exists, a reset link has been generated.' });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await pool.query(
      `INSERT INTO tokens (admin_id, token, type, expires_at) VALUES (?, ?, 'reset_password', ?)`,
      [rows[0].id, resetToken, expiresAt]
    );

    // In production this token would be emailed. Returned here for local/dev testing.
    res.json({ success: true, message: 'Reset token generated.', resetToken });
  } catch (err) {
    next(err);
  }
}

// POST /api/auth/reset-password
async function resetPassword(req, res, next) {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ success: false, message: 'Valid token and a password of 6+ characters are required.' });
    }

    const [rows] = await pool.query(
      `SELECT * FROM tokens WHERE token = ? AND type = 'reset_password' AND expires_at > NOW()`,
      [token]
    );
    if (!rows[0]) {
      return res.status(400).json({ success: false, message: 'Reset token is invalid or has expired.' });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE admin_accounts SET password_hash = ? WHERE id = ?', [hash, rows[0].admin_id]);
    await pool.query('DELETE FROM tokens WHERE id = ?', [rows[0].id]);

    res.json({ success: true, message: 'Password reset successful. Please log in.' });
  } catch (err) {
    next(err);
  }
}

module.exports = { login, logout, me, forgotPassword, resetPassword };
