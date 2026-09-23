const pool = require('../config/db');

/**
 * Records an entry in audit_logs. Never throws — logging failures
 * should never break the primary request.
 */
async function logAction({ adminId = null, action, module, details = null, ip = null }) {
  const detailsJson = details ? JSON.stringify(details) : null;
  try {
    await pool.query(
      `INSERT INTO audit_logs (admin_id, action, module, details, ip_address) VALUES (?, ?, ?, ?, ?)`,
      [adminId, action, module, detailsJson, ip]
    );
  } catch (err) {
    // requireAuth (middleware/authMiddleware.js) now checks the admin still
    // exists before any request reaches here, so adminId referencing a
    // deleted/deactivated admin_accounts row should no longer happen in
    // practice. This fallback is defense-in-depth for a genuinely
    // concurrent case (the admin's own account gets deleted by someone else
    // in the moment between that check and this INSERT): rather than
    // silently losing the log entry, retry once recording it against no
    // admin (admin_id is nullable, same as it becomes automatically via
    // ON DELETE SET NULL for entries that already existed before a delete).
    if (adminId !== null && /foreign key constraint fails/i.test(err.message)) {
      try {
        await pool.query(
          `INSERT INTO audit_logs (admin_id, action, module, details, ip_address) VALUES (NULL, ?, ?, ?, ?)`,
          [action, module, detailsJson, ip]
        );
        return;
      } catch (retryErr) {
        console.error('Audit log write failed (retry with NULL admin_id also failed):', retryErr.message);
        return;
      }
    }
    console.error('Audit log write failed:', err.message);
  }
}

module.exports = { logAction };
