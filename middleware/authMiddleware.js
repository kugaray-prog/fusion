const jwt = require('jsonwebtoken');
const config = require('../config/config');
const pool = require('../config/db');

/**
 * Verifies the JWT sent in the Authorization header (Bearer token)
 * or in the httpOnly cookie set at login, and attaches the decoded
 * admin payload to req.admin.
 *
 * The JWT signature alone only proves the token was issued by this server
 * at some point in the past -- it says nothing about whether that admin
 * account is still around NOW, and a session can last up to 30 days
 * ("remember me"). Without re-checking, a deleted or deactivated admin's
 * existing session keeps working exactly as before until the token expires
 * on its own: they can still approve devices, edit ratings, and so on, and
 * every one of those actions calls logAction() (services/auditService.js)
 * with their admin_id, which then fails to INSERT into audit_logs with
 * "Cannot add or update a child row: a foreign key constraint fails ...
 * admin_id ... REFERENCES admin_accounts" -- because that admin_id no
 * longer exists to reference. Re-checking here closes the actual gap (the
 * account should stop working the moment it's deleted/deactivated, not
 * just fail to log that it did something) rather than only patching the
 * audit-log symptom.
 */
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  const bearerToken = header && header.startsWith('Bearer ') ? header.split(' ')[1] : null;
  const token = bearerToken || (req.cookies && req.cookies.token) || req.query.token;

  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication required. Please log in.' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, config.jwt.secret);
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired session. Please log in again.' });
  }
  if (decoded.type === 'employee' || decoded.type === 'google_pending') {
    return res.status(403).json({ success: false, message: 'This endpoint requires an admin session.' });
  }

  try {
    const [rows] = await pool.query('SELECT id, role, is_active FROM admin_accounts WHERE id = ?', [decoded.id]);
    const admin = rows[0];
    if (!admin || !admin.is_active) {
      return res.status(401).json({ success: false, message: 'Your account is no longer active. Please contact an administrator.' });
    }
    // Role is taken from the database, not the token, so a role change
    // (e.g. demoted from super_admin) takes effect on the admin's very next
    // request instead of only after their current session expires.
    req.admin = { ...decoded, role: admin.role };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Restricts a route to specific admin roles.
 * Usage: requireRole('super_admin', 'admin')
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.admin || !roles.includes(req.admin.role)) {
      return res.status(403).json({ success: false, message: 'You do not have permission to perform this action.' });
    }
    next();
  };
}

/**
 * Verifies an employee JWT (issued by /api/employee-auth/login) and attaches
 * the decoded payload to req.employee. Used by mobile-app-facing routes.
 */
function requireEmployeeAuth(req, res, next) {
  const header = req.headers.authorization;
  const token = header && header.startsWith('Bearer ') ? header.split(' ')[1] : null;

  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication required. Please log in.' });
  }

  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    if (decoded.type !== 'employee') {
      return res.status(403).json({ success: false, message: 'Invalid token type for this route.' });
    }
    req.employee = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired session. Please log in again.' });
  }
}

module.exports = { requireAuth, requireRole, requireEmployeeAuth };
