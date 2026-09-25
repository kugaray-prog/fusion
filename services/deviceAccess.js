const pool = require('../config/db');

// Device statuses (mobile_devices.status) that lock a phone out of the app
// entirely: an admin blacklisted it, or rejected its registration. A pending
// device is not blocked -- it's held on the "waiting for approval" screen.
const BLOCKED_STATUSES = ['blacklisted', 'rejected'];

function isBlockedStatus(status) {
  return BLOCKED_STATUSES.includes(status);
}

function blockedMessage(status) {
  return status === 'blacklisted'
    ? 'This device has been blacklisted by your administrator, so it can no longer be used to sign in or record attendance. Contact your administrator if you think this is a mistake.'
    : 'This device\'s registration was rejected by your administrator, so it can\'t be used to sign in or record attendance. Contact your administrator.';
}

// Sends the standard 403 the mobile app recognizes (code DEVICE_BLOCKED):
// it signs out, shows a notification and explains on the Login screen.
function sendDeviceBlocked(res, status) {
  return res.status(403).json({
    success: false,
    code: 'DEVICE_BLOCKED',
    deviceStatus: status,
    message: blockedMessage(status)
  });
}

// The blocked status of a device, or null if it's allowed or not on file.
// With employeeId, only that employee's device is considered.
async function getBlockedStatus(deviceUid, employeeId = null) {
  if (!deviceUid) return null;
  const [rows] = employeeId == null
    ? await pool.query('SELECT status FROM mobile_devices WHERE device_uid = ?', [deviceUid])
    : await pool.query('SELECT status FROM mobile_devices WHERE device_uid = ? AND employee_id = ?', [deviceUid, employeeId]);
  const status = rows[0] && rows[0].status;
  return isBlockedStatus(status) ? status : null;
}

module.exports = { BLOCKED_STATUSES, isBlockedStatus, blockedMessage, sendDeviceBlocked, getBlockedStatus };
