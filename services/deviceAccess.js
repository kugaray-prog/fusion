const pool = require('../config/db');

// Device statuses (mobile_devices.status) that lock a phone out of the app
// entirely: an admin blacklisted it, or rejected its registration. A pending
// device is not blocked -- it's held on the "waiting for approval" screen.
// 'removed' isn't stored anywhere: it's reported for a signed-in phone whose
// device record an admin deleted (it must sign in and register again).
const BLOCKED_STATUSES = ['blacklisted', 'rejected', 'removed'];

function isBlockedStatus(status) {
  return BLOCKED_STATUSES.includes(status);
}

function blockedMessage(status) {
  if (status === 'blacklisted') {
    return 'This device has been blacklisted by your administrator, so it can no longer be used to sign in or record attendance. Contact your administrator if you think this is a mistake.';
  }
  if (status === 'removed') {
    return 'This device was removed by your administrator. Sign in again to register it.';
  }
  return "This device's registration was rejected by your administrator, so it can't be used to sign in or record attendance. Contact your administrator.";
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

// The blocked status of a device, or null if it's allowed.
// Without employeeId (sign-in/registration): a device not on file is fine.
// With employeeId (a signed-in request): that employee's device must still
// exist -- if an admin deleted it, the phone is 'removed'.
async function getBlockedStatus(deviceUid, employeeId = null) {
  if (!deviceUid) return null;
  const [rows] = employeeId == null
    ? await pool.query('SELECT status FROM mobile_devices WHERE device_uid = ?', [deviceUid])
    : await pool.query('SELECT status FROM mobile_devices WHERE device_uid = ? AND employee_id = ?', [deviceUid, employeeId]);
  if (!rows[0]) return employeeId == null ? null : 'removed';
  return isBlockedStatus(rows[0].status) ? rows[0].status : null;
}

// Fits client-reported device details to the mobile_devices column sizes.
// Some Android builds (e.g. Xiaomi/HyperOS) report a full build fingerprint
// as the OS name, which overflowed os VARCHAR(60) and failed registration
// with a raw "Data too long" error; older app builds still send it.
function cleanDeviceInfo({ model, brand, os }) {
  const clip = (v, max) => {
    const s = v == null ? '' : String(v).trim();
    return s ? s.slice(0, max) : null;
  };
  return { model: clip(model, 120), brand: clip(brand, 120), os: clip(os, 60) };
}

module.exports = { BLOCKED_STATUSES, isBlockedStatus, blockedMessage, sendDeviceBlocked, getBlockedStatus, cleanDeviceInfo };
