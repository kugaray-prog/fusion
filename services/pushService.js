// Expo push notifications: announces a new event to every approved phone,
// even while the app is closed (the live WebSocket only reaches open apps).
// Tokens are saved by PUT /api/devices/push-token (deviceController) into
// mobile_devices.push_token. Push is a bonus, so nothing here ever throws:
// a failure is logged and the admin's save still succeeds.
const pool = require('../config/db');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH_SIZE = 100; // Expo's per-request limit

function isExpoToken(token) {
  return typeof token === 'string' && /^Expo(nent)?PushToken\[[^\]]+\]$/.test(token);
}

async function sendBatch(messages) {
  const res = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(messages)
  });
  if (!res.ok) throw new Error(`Expo push responded ${res.status}`);
  const { data } = await res.json();
  // Uninstalled app / revoked permission: forget the token so it isn't retried.
  const dead = (data || [])
    .map((ticket, i) => (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered' ? messages[i].to : null))
    .filter(Boolean);
  if (dead.length) await pool.query('UPDATE mobile_devices SET push_token = NULL WHERE push_token IN (?)', [dead]);
}

async function sendToApprovedDevices(build) {
  const [rows] = await pool.query(
    `SELECT DISTINCT d.push_token
       FROM mobile_devices d
       JOIN employees e ON e.id = d.employee_id
      WHERE d.status = 'approved' AND e.is_approved = 1 AND d.push_token IS NOT NULL`
  );
  const messages = rows.map(r => r.push_token).filter(isExpoToken).map(build);
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    await sendBatch(messages.slice(i, i + BATCH_SIZE));
  }
}

function notifyNewEvent({ eventId, title, venue, start, occurrenceCount = 1 }) {
  const when = start ? new Date(String(start).replace(' ', 'T')) : null;
  const whenText = when && !isNaN(when)
    ? when.toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '';
  const body = [venue, whenText].filter(Boolean).join(' · ')
    + (occurrenceCount > 1 ? ` (${occurrenceCount} occurrences)` : '');

  sendToApprovedDevices((to) => ({
    to,
    title: `New event: ${title || 'Untitled'}`,
    body: body || 'Open GeoAttend for details.',
    sound: 'default',
    channelId: 'event-reminders',
    data: { type: 'new_event', eventId }
  })).catch((err) => console.error('[push] New-event notification failed:', err.message));
}

module.exports = { isExpoToken, notifyNewEvent };
