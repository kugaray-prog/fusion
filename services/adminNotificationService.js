const pool = require('../config/db');

// Alerts for the admin dashboard's notification bell (Notification & Alert
// module): device registrations, sign-in / attendance attempts from
// unregistered or blocked devices, and geo anomalies. Stored in
// admin_notifications (created by services/schemaUpgrades.js).
//
// notifyAdmins never throws -- an alert failing to save must not fail the
// employee's request that triggered it.

// Same alert (type + employee + title) within this window is skipped, so a
// phone retrying a refused request every few seconds doesn't flood the bell.
const DEDUPE_MINUTES = 10;

async function notifyAdmins({ type, severity = 'info', title, message, targetView = null, employeeId = null, dedupe = true }) {
  try {
    if (dedupe) {
      const [dup] = await pool.query(
        `SELECT id FROM admin_notifications
         WHERE type = ? AND title = ? AND employee_id <=> ? AND created_at >= NOW() - INTERVAL ? MINUTE LIMIT 1`,
        [type, title, employeeId, DEDUPE_MINUTES]
      );
      if (dup[0]) return;
    }
    await pool.query(
      `INSERT INTO admin_notifications (type, severity, title, message, target_view, employee_id) VALUES (?, ?, ?, ?, ?, ?)`,
      [type, severity, title, message, targetView, employeeId]
    );
  } catch (err) {
    console.error('[adminNotifications] Could not save alert:', err.message);
  }
}

// "Juan Dela Cruz (E004)" for an employee id, for alert messages.
async function employeeLabel(employeeId) {
  try {
    const [rows] = await pool.query('SELECT full_name, employee_code FROM employees WHERE id = ?', [employeeId]);
    if (!rows[0]) return 'An employee';
    return rows[0].employee_code ? `${rows[0].full_name} (${rows[0].employee_code})` : rows[0].full_name;
  } catch (err) {
    return 'An employee';
  }
}

function deviceLabel({ brand, model, device_uid: uid } = {}) {
  const name = [brand, model].filter(Boolean).join(' ');
  if (name) return name;
  return uid ? `device ${String(uid).slice(0, 12)}` : 'an unknown device';
}

module.exports = { notifyAdmins, employeeLabel, deviceLabel };
