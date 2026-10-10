const pool = require('../config/db');
const { localDate } = require('../services/dateService');
const geofenceService = require('../services/geofenceService');
const faceService = require('../services/faceService');
const config = require('../config/config');
const { logAction } = require('../services/auditService');
const { notifyAdmins, employeeLabel, deviceLabel } = require('../services/adminNotificationService');
const realtime = require('../services/realtime');
// NOTE: employee_ratings (the Ratings module) is no longer fed from here.
// It's now generated on-demand, per actual EVENT, by
// ratingController.generateRatingsForRange — run automatically every time
// the admin dashboard's Ratings tab is loaded (self-healing on read, same
// pattern as settleEndedEvents below) once an event's schedule has
// ended, from whatever attendance_status ended up on each employee's row for
// that event. That covers every weekday an event is scheduled on (not just
// Mondays) and also correctly rates a true no-show (nobody ever timed in for
// that event) as Absent, which a time-in-triggered hook here never could.

// `mocked` as sent by the mobile app (Android's mock-location flag).
function isMockedLocation(mocked) {
  return config.attendance.rejectMockLocations && (mocked === true || mocked === 'true');
}

// Boundary allowance for a GPS reading: its reported accuracy, capped at
// config.attendance.edgeToleranceMeters so a client can't claim a huge
// accuracy to stretch the geofence.
function edgeTolerance(accuracy) {
  const acc = Number(accuracy);
  if (!Number.isFinite(acc) || acc <= 0) return 0;
  return Math.min(acc, config.attendance.edgeToleranceMeters);
}

// Runs bookkeeping that the reply doesn't depend on (logs, notifications,
// rating recalculation) after the response has been sent: the database is
// remote, so every round trip left in the request path delays the time-in or
// time-out the employee is waiting on. A failure here is logged, never sent.
function afterResponse(label, work) {
  Promise.resolve()
    .then(work)
    .catch((err) => console.error(`[attendance] ${label} failed:`, err.message));
}

// The duration clock is stopped while a record awaits face verification:
// its open session is closed right now and folded into the running total,
// but the attendance row itself stays open (time_out NULL) so the app keeps
// pinging and doesn't try to time in again. resumeSessionAfterVerification
// opens a fresh session once the employee passes verification.
async function pauseOpenSession(attendanceId) {
  const [openRows] = await pool.query(
    'SELECT id FROM attendance_sessions WHERE attendance_id = ? AND time_out IS NULL ORDER BY time_in DESC LIMIT 1',
    [attendanceId]
  );
  const openSession = openRows[0];
  if (!openSession) return;
  // `time_out IS NULL` makes the close atomic: two pings flagging the same
  // record at once (or this and the heartbeat's auto time-out) would
  // otherwise both close the session and both add its duration to the total.
  const [closed] = await pool.query(
    `UPDATE attendance_sessions
     SET time_out = NOW(), duration_seconds = GREATEST(0, TIMESTAMPDIFF(SECOND, time_in, NOW()))
     WHERE id = ? AND time_out IS NULL`,
    [openSession.id]
  );
  if (closed.affectedRows === 0) return; // someone else closed (and counted) it first
  const [[updatedSession]] = await pool.query('SELECT duration_seconds FROM attendance_sessions WHERE id = ?', [openSession.id]);
  const sessionDurationSeconds = updatedSession ? updatedSession.duration_seconds : 0;
  await pool.query(
    `UPDATE attendance SET total_duration_seconds = COALESCE(total_duration_seconds, 0) + ?,
       work_hours = ROUND(total_duration_seconds / 3600, 2) WHERE id = ?`,
    [sessionDurationSeconds, attendanceId]
  );
  await pool.query(
    `INSERT INTO attendance_logs (attendance_id, employee_id, action, details)
     SELECT id, employee_id, 'duration_paused', ? FROM attendance WHERE id = ?`,
    [JSON.stringify({ reason: 'face_verification_required', sessionDurationSeconds }), attendanceId]
  );
}

// Restarts the duration clock after a paused record is verified, as long as
// the employee is still timed in (not auto-ended while waiting) and the
// event is still running. If they left in the meantime, their next re-entry
// time-in opens the session instead.
async function resumeSessionAfterVerification(attendanceId, latitude, longitude) {
  // The attendance row is locked for the check-then-insert, so two
  // verifications landing together (a double submit, or the employee's own
  // and an admin-assisted one) can't both see "no open session" and open two.
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('SELECT id FROM attendance WHERE id = ? FOR UPDATE', [attendanceId]);
    const [rows] = await conn.query(
      `SELECT a.id, a.employee_id, a.time_out, e.end_datetime,
              (SELECT COUNT(*) FROM attendance_sessions s WHERE s.attendance_id = a.id AND s.time_out IS NULL) AS open_sessions
       FROM attendance a LEFT JOIN events e ON a.event_id = e.id
       WHERE a.id = ?`,
      [attendanceId]
    );
    const record = rows[0];
    if (!record || record.time_out || Number(record.open_sessions) > 0
        || (record.end_datetime && new Date(record.end_datetime) <= new Date())) {
      await conn.commit();
      return false;
    }
    const [sessionResult] = await conn.query(
      `INSERT INTO attendance_sessions (attendance_id, employee_id, time_in, in_latitude, in_longitude)
       VALUES (?, ?, NOW(), ?, ?)`,
      [attendanceId, record.employee_id, latitude || null, longitude || null]
    );
    await conn.query(
      `INSERT INTO attendance_logs (attendance_id, employee_id, action, details) VALUES (?, ?, 'duration_resumed', ?)`,
      [attendanceId, record.employee_id, JSON.stringify({ session_id: sessionResult.insertId })]
    );
    await conn.commit();
    return true;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

// Logs a geo_anomalies row for one attendance record, flags it for face
// verification, stops its duration clock, and notifies its employee --
// including a live push so their app opens Face Verification right away
// instead of waiting for its next heartbeat.
async function flagAttendanceForVerification({ attendanceId, employeeId, eventId, deviceUid, latitude, longitude, details }) {
  // Only the first of two pings flagging the same record at once (each
  // phone's own ping sees the other) logs and notifies; the second finds it
  // already flagged.
  const [flagged] = await pool.query(
    'UPDATE attendance SET requires_face_verification = 1, verification_status = ? WHERE id = ? AND COALESCE(requires_face_verification, 0) = 0',
    ['Pending', attendanceId]
  );
  if (flagged.affectedRows === 0) return;

  await pool.query(
    `INSERT INTO geo_anomalies (attendance_id, employee_id, event_id, device_uid, anomaly_type, details, latitude, longitude)
     VALUES (?, ?, ?, ?, 'duplicate_geolocation', ?, ?, ?)`,
    [attendanceId, employeeId, eventId, deviceUid || null, details, latitude, longitude]
  );

  await pauseOpenSession(attendanceId);
  realtime.notifyEmployee(employeeId, 'attendance');

  const [[event]] = await pool.query('SELECT title FROM events WHERE id = ?', [eventId]);
  const eventPart = event?.title ? ` at "${event.title}"` : '';

  await pool.query(
    `INSERT INTO notifications (employee_id, title, message, type) VALUES (?, 'Face Verification Required', ?, 'face_verification_required')`,
    [employeeId, `Your phone reported the same location as another employee's phone${eventPart}. Open the app and complete face verification before the event ends, or your attendance will not be recorded.`]
  );

  await notifyAdmins({
    type: 'geo_anomaly', severity: 'warning', targetView: 'geofence', employeeId,
    title: 'Possible proxy attendance',
    message: `${await employeeLabel(employeeId)}'s phone was at the same spot as another employee's phone${eventPart}. They were asked to complete face verification.`
  });
}

// Looks for OTHER employees' attendance for the same event whose device is
// currently (or very recently) reporting a position suspiciously close to
// this one — the signature of one person carrying a colleague's phone in to
// record attendance for them. Compares against each record's most recent
// heartbeat position (last_lat/last_lng) as well as its latest time-in
// position, so it catches two phones that arrived together AND two phones
// that stay together afterwards. Called on every time-in and every inside
// heartbeat.
//
// Both sides of a match are flagged: the server can't tell which phone is
// the "real" one, and only the employee actually present can pass the face
// verification on their own phone. A record that's already flagged just
// reports true again (so its app keeps being prompted).
//
// Triggers on the FIRST ping that finds another employee's phone within
// config.attendance.anomalyDistanceMeters (0.5 m by default), as long as
// that other phone reported its position within the last
// config.attendance.anomalyWindowSeconds (30 s) -- no waiting period. Every
// open record at that spot is flagged, however many there are.
//
// Passing face verification does NOT exempt a record: it's only left alone
// for config.attendance.anomalyRecheckSeconds (30 s) after it was verified,
// so for as long as the phones stay together, face verification is asked
// for again every 30 seconds.
//
// Returns whether THIS record currently requires face verification.
async function detectGeoAnomaly({ attendanceId, employeeId, eventId, deviceUid, latitude, longitude }) {
  // Ages are worked out in SQL (TIMESTAMPDIFF against NOW()) rather than by
  // parsing the DATETIME strings in Node, so they stay right whatever
  // timezone the Node process and the database session happen to use.
  const [selfRows] = await pool.query(
    'SELECT requires_face_verification, TIMESTAMPDIFF(SECOND, face_verified_at, NOW()) AS verified_ago_s FROM attendance WHERE id = ?',
    [attendanceId]
  );
  const self = selfRows[0];
  if (!self) return false;
  if (self.requires_face_verification) return true;

  const recheckSeconds = config.attendance.anomalyRecheckSeconds;
  const recentlyVerified = (row) => row.verified_ago_s != null && Number(row.verified_ago_s) < recheckSeconds;
  if (recentlyVerified(self)) return false;

  // The SQL box is only a coarse prefilter (a degree box sized to the
  // distance threshold); the real check is the straight-line distance below,
  // so only phones practically side by side count -- not merely nearby.
  const maxMeters = config.attendance.anomalyDistanceMeters;
  const latTol = maxMeters / 111320;
  const lngTol = maxMeters / (111320 * Math.max(Math.cos(Number(latitude) * Math.PI / 180), 0.01));
  const windowSeconds = config.attendance.anomalyWindowSeconds;
  const [candidates] = await pool.query(
    `SELECT x.*, (x.last_ping_at >= NOW() - INTERVAL ? SECOND) AS ping_fresh,
            (x.latest_time_in >= NOW() - INTERVAL ? SECOND) AS time_in_fresh,
            (x.last_ping_at IS NOT NULL AND (x.latest_time_in IS NULL OR x.last_ping_at >= x.latest_time_in)) AS ping_is_newest
     FROM (
       SELECT a.id, a.employee_id, a.requires_face_verification,
              TIMESTAMPDIFF(SECOND, a.face_verified_at, NOW()) AS verified_ago_s,
              a.last_lat, a.last_lng, a.latitude, a.longitude, a.last_ping_at,
              GREATEST(a.time_in, COALESCE((SELECT MAX(s.time_in) FROM attendance_sessions s WHERE s.attendance_id = a.id), a.time_in)) AS latest_time_in,
              md.device_uid
       FROM attendance a
       LEFT JOIN mobile_devices md ON a.device_id = md.id
       WHERE a.event_id = ? AND a.employee_id != ? AND a.id != ?
         AND a.time_out IS NULL
     ) x
     WHERE (x.last_ping_at >= NOW() - INTERVAL ? SECOND
             AND ABS(x.last_lat - ?) < ? AND ABS(x.last_lng - ?) < ?)
        OR (x.latest_time_in >= NOW() - INTERVAL ? SECOND
             AND ABS(x.latitude - ?) < ? AND ABS(x.longitude - ?) < ?)`,
    [
      windowSeconds, windowSeconds,
      eventId, employeeId, attendanceId,
      windowSeconds, latitude, latTol, longitude, lngTol,
      windowSeconds, latitude, latTol, longitude, lngTol
    ]
  );
  const within = (lat, lng) => lat != null && lng != null &&
    geofenceService.distanceMeters(Number(latitude), Number(longitude), Number(lat), Number(lng)) <= maxMeters;
  // Each other phone is judged only by its NEWEST known position: a ping
  // after its time-in supersedes the time-in spot, so a phone that has
  // walked away doesn't still count as "here" off its old check-in point.
  const rows = [];
  for (const c of candidates) {
    if (Number(c.ping_is_newest)) {
      if (Number(c.ping_fresh) && within(c.last_lat, c.last_lng)) rows.push({ ...c, cur_lat: c.last_lat, cur_lng: c.last_lng });
    } else if (Number(c.time_in_fresh) && within(c.latitude, c.longitude)) {
      rows.push({ ...c, cur_lat: c.latitude, cur_lng: c.longitude });
    }
  }
  if (!rows.length) return false;

  const first = rows[0];
  await flagAttendanceForVerification({
    attendanceId,
    employeeId,
    eventId,
    deviceUid,
    latitude,
    longitude,
    details: `Same location as employee #${first.employee_id}` +
      (first.device_uid && first.device_uid !== deviceUid ? ` (device: ${first.device_uid})` : '')
  });

  for (const other of rows) {
    if (Number(other.requires_face_verification)) continue;
    // Just passed verification -- it gets its own 30 seconds first.
    if (recentlyVerified(other)) continue;
    await flagAttendanceForVerification({
      attendanceId: other.id,
      employeeId: other.employee_id,
      eventId,
      deviceUid: other.device_uid,
      latitude: Number(other.cur_lat),
      longitude: Number(other.cur_lng),
      details: `Same location as employee #${employeeId}` +
        (deviceUid && deviceUid !== other.device_uid ? ` (device: ${deviceUid})` : '')
    });
  }

  return true;
}

// The end-of-event presence rule as a whole percentage, e.g. 80.
function presenceRulePercent() {
  return Math.round(config.attendance.minAttendanceRatioForPresence * 100);
}

// Recomputes an employee's attendance_score from their real attendance history —
// Present counts full credit, Late counts half credit, out of all recorded days.
// Keeps the Ratings leaderboard on the admin dashboard reflecting actual behavior
// instead of the static 100.00 default every employee starts with.
async function recalculateAttendanceScore(employeeId) {
  const [rows] = await pool.query(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN attendance_status = 'Present' THEN 1 ELSE 0 END) AS present_count,
       SUM(CASE WHEN attendance_status = 'Late' THEN 1 ELSE 0 END) AS late_count
     FROM attendance WHERE employee_id = ?`,
    [employeeId]
  );
  const { total, present_count, late_count } = rows[0];
  if (!total) return;
  const score = ((Number(present_count) + Number(late_count) * 0.5) / total) * 100;
  await pool.query('UPDATE employees SET attendance_score = ? WHERE id = ?', [score.toFixed(2), employeeId]);
}

// Literal "5 Attended = 1 Rating Point, 1 No Attendance = deduction" rule
// requested for the employee/dashboard/report Rating displays. This is kept
// separate from recalculateAttendanceScore's percentage score and from the
// Monday employee_ratings leaderboard — each already has call sites elsewhere
// that depend on their current behavior, so this adds the literal counter
// alongside them rather than replacing either.
// Present/Late count as "Attended"; Absent counts as "No Attendance".
async function recalculateRatingPoints(employeeId) {
  const [rows] = await pool.query(
    `SELECT
       SUM(CASE WHEN attendance_status IN ('Present','Late') THEN 1 ELSE 0 END) AS attended_count,
       SUM(CASE WHEN attendance_status = 'Absent' THEN 1 ELSE 0 END) AS absent_count
     FROM attendance WHERE employee_id = ?`,
    [employeeId]
  );
  const attended = Number(rows[0].attended_count) || 0;
  const absent = Number(rows[0].absent_count) || 0;
  const points = Math.floor(attended / 5) - absent;
  await pool.query('UPDATE employees SET rating_points = ? WHERE id = ?', [points, employeeId]);
}

// Runs both rating recalculations together — call this after ANY insert,
// update, or delete of an attendance row so ratings never drift from the
// real attendance history (added / updated / removed / status flips all funnel here).
async function recalculateAllRatings(employeeId) {
  await recalculateAttendanceScore(employeeId);
  await recalculateRatingPoints(employeeId);
}

// Appended to attendance SELECTs so callers can render a "Duration" column
// and know whether a session is still ticking. open_session_time_in is the
// time_in of the currently-open attendance_sessions row (NULL once nothing
// is open); the client adds "now - open_session_time_in" to
// total_duration_seconds to show a live, still-accumulating duration while
// attendance_status stays "on-going". session_count is how many separate
// time-in/time-out dips make up that total, for a "×3 sessions" style hint.
const ATTENDANCE_DURATION_SUBQUERIES = `,
       (SELECT s.time_in FROM attendance_sessions s
         WHERE s.attendance_id = a.id AND s.time_out IS NULL
         ORDER BY s.time_in DESC LIMIT 1) AS open_session_time_in,
       (SELECT COUNT(*) FROM attendance_sessions s WHERE s.attendance_id = a.id) AS session_count`;

// Self-healing safety net: closes any attendance session left open past its
// event's end time. Normally the mobile app's heartbeat auto-closes a
// session once the device has been outside the geofence for a couple of
// pings — but that only works while the app is open and pinging. If the
// event simply ends while the employee is still standing inside the
// boundary, or the app gets closed/backgrounded before the outside-streak
// trips, nothing ever closes the session and its duration keeps climbing
// forever every time it's viewed. This runs (via settleEndedEvents) before
// any attendance read (both the mobile "my history" and the admin attendance
// table) so a stale session
// gets closed and its total finalized before anyone sees it, capped at the
// event's own end_datetime rather than "now" so no extra time leaks in.
async function closeSessionsForEndedEvents() {
  const [staleRows] = await pool.query(
    `SELECT a.id, a.employee_id, a.total_duration_seconds, e.end_datetime
     FROM attendance a
     JOIN events e ON a.event_id = e.id
     WHERE a.time_out IS NULL AND e.end_datetime < NOW()`
  );
  for (const record of staleRows) {
    const [openSessionRows] = await pool.query(
      'SELECT * FROM attendance_sessions WHERE attendance_id = ? AND time_out IS NULL ORDER BY time_in ASC LIMIT 1',
      [record.id]
    );
    const openSession = openSessionRows[0];

    let sessionDurationSeconds = 0;
    if (openSession) {
      await pool.query(
        `UPDATE attendance_sessions
         SET time_out = ?, duration_seconds = GREATEST(0, TIMESTAMPDIFF(SECOND, time_in, ?)),
             auto_ended = 1
         WHERE id = ?`,
        [record.end_datetime, record.end_datetime, openSession.id]
      );
      const [[updatedSession]] = await pool.query('SELECT duration_seconds FROM attendance_sessions WHERE id = ?', [openSession.id]);
      sessionDurationSeconds = updatedSession ? updatedSession.duration_seconds : 0;
    }

    const totalDurationSeconds = (record.total_duration_seconds || 0) + sessionDurationSeconds;
    const workHours = (totalDurationSeconds / 3600).toFixed(2);

    await pool.query(
      `UPDATE attendance SET time_out = ?, total_duration_seconds = ?, work_hours = ?, auto_ended = 1 WHERE id = ?`,
      [record.end_datetime, totalDurationSeconds, workHours, record.id]
    );
    await pool.query(
      `INSERT INTO attendance_logs (attendance_id, employee_id, action, details) VALUES (?, ?, 'auto_time_out', ?)`,
      [record.id, record.employee_id, JSON.stringify({ reason: 'event_ended', sessionDurationSeconds, totalDurationSeconds })]
    );
  }
}

// Settles the final status of every attendance row whose event has ended
// (its sessions already closed by closeSessionsForEndedEvents above). Until
// then the status is shown as Ongoing (see DISPLAY_STATUS_SQL). A GPS-tracked
// employee who was inside the geofence for less than
// minAttendanceRatioForPresence (80%) of the event's scheduled duration is
// marked Absent, whether they stayed until the end or left early; otherwise
// they keep the Present/Late decided at their first time-in. Kiosk (OCR/face)
// roll-call rows have no duration to measure and keep their status, as does
// anything an admin already set by hand (status_finalized = 1).
async function finalizeEndedEventStatuses() {
  const [rows] = await pool.query(
    `SELECT a.id, a.employee_id, a.attendance_status, a.total_duration_seconds, a.verification_method,
            e.start_datetime, e.end_datetime
     FROM attendance a
     JOIN events e ON a.event_id = e.id
     WHERE a.status_finalized = 0 AND a.time_out IS NOT NULL AND e.end_datetime < NOW()`
  );

  for (const record of rows) {
    let finalStatus = record.attendance_status;
    let attendedRatio = null;
    if (record.verification_method === 'mobile_gps' && ['Present', 'Late'].includes(record.attendance_status)) {
      const eventDurationSeconds = Math.max(1, (new Date(record.end_datetime) - new Date(record.start_datetime)) / 1000);
      attendedRatio = (record.total_duration_seconds || 0) / eventDurationSeconds;
      if (attendedRatio < config.attendance.minAttendanceRatioForPresence) finalStatus = 'Absent';
    }

    await pool.query(
      'UPDATE attendance SET attendance_status = ?, status_finalized = 1 WHERE id = ?',
      [finalStatus, record.id]
    );
    realtime.notifyEmployee(record.employee_id, 'attendance');
    await pool.query(
      `INSERT INTO attendance_logs (attendance_id, employee_id, action, details) VALUES (?, ?, 'status_finalized', ?)`,
      [record.id, record.employee_id, JSON.stringify({
        attendedRatio: attendedRatio === null ? null : Number(attendedRatio.toFixed(3)),
        requiredRatio: config.attendance.minAttendanceRatioForPresence,
        previousStatus: record.attendance_status, finalStatus
      })]
    );
    if (finalStatus !== record.attendance_status) {
      await recalculateAllRatings(record.employee_id);
    }
  }
}

// Closes sessions left open past their event's end, then settles every
// ended event's final statuses. Runs before any attendance/report/rating read.
async function settleEndedEvents() {
  await closeSessionsForEndedEvents();
  await finalizeEndedEventStatuses();
  await rejectUnverifiedFlaggedAttendance();
}

// The status to show for an attendance row (needs `events ev` joined):
// Ongoing while its event is still running, since Present/Late/Absent is only
// decided once the event ends.
const DISPLAY_STATUS_SQL = "CASE WHEN ev.end_datetime >= NOW() THEN 'Ongoing' ELSE a.attendance_status END";

// A geo-anomaly-flagged attendance (see detectGeoAnomaly) only counts once
// the employee passes face verification. If the event ends with the flag
// still unresolved, the attendance is not recorded: status becomes Absent
// and verification_status Rejected. Runs as part of
// settleEndedEvents, so it self-heals on every attendance/report/
// rating read like the rest of the end-of-event settling.
async function rejectUnverifiedFlaggedAttendance() {
  const [rows] = await pool.query(
    `SELECT a.id, a.employee_id, a.attendance_status
     FROM attendance a
     JOIN events e ON a.event_id = e.id
     WHERE a.requires_face_verification = 1 AND a.verification_status = 'Pending' AND e.end_datetime < NOW()`
  );
  for (const record of rows) {
    await pool.query(
      `UPDATE attendance SET attendance_status = 'Absent', verification_status = 'Rejected' WHERE id = ?`,
      [record.id]
    );
    await pool.query(
      `INSERT INTO attendance_logs (attendance_id, employee_id, action, details) VALUES (?, ?, 'face_verification_expired', ?)`,
      [record.id, record.employee_id, JSON.stringify({ reason: 'event_ended_unverified', previousStatus: record.attendance_status })]
    );
    await pool.query(
      `INSERT INTO notifications (employee_id, title, message, type) VALUES (?, 'Attendance Not Recorded', ?, 'face_verification_required')`,
      [record.employee_id, 'Your attendance was not recorded because the required face verification was not completed before the event ended.']
    );
    await notifyAdmins({
      type: 'face_verification_expired', severity: 'danger', targetView: 'attendance', employeeId: record.employee_id, dedupe: false,
      title: 'Attendance rejected',
      message: `${await employeeLabel(record.employee_id)} was marked Absent: the required face verification wasn't completed before the event ended.`
    });
    await recalculateAllRatings(record.employee_id);
  }
}

// GET /api/attendance/my-history  (employee JWT required — used by the mobile app)
async function getMyHistory(req, res, next) {
  try {
    await settleEndedEvents();
    const [rows] = await pool.query(
      `SELECT a.*, ${DISPLAY_STATUS_SQL} AS attendance_status, ev.title AS event_title, ev.venue AS event_venue,
              ev.start_datetime AS event_start, ev.end_datetime AS event_end${ATTENDANCE_DURATION_SUBQUERIES} FROM attendance a
       LEFT JOIN events ev ON a.event_id = ev.id
       WHERE a.employee_id = ?
       ORDER BY a.attendance_date DESC, a.time_in DESC
       LIMIT 200`,
      [req.employee.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

// GET /api/attendance/:id/sessions  (employee JWT required — session-level
// breakdown behind the summary row, e.g. "9:03 AM–9:41 AM", "10:15 AM–…")
async function getSessions(req, res, next) {
  try {
    const [attendanceRows] = await pool.query(
      'SELECT id FROM attendance WHERE id = ? AND employee_id = ?',
      [req.params.id, req.employee.id]
    );
    if (!attendanceRows[0]) return res.status(404).json({ success: false, message: 'Attendance record not found.' });

    const [rows] = await pool.query(
      'SELECT * FROM attendance_sessions WHERE attendance_id = ? ORDER BY time_in ASC',
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

// GET /api/attendance/:id/sessions/admin  (admin JWT required — same
// session-level breakdown as getSessions, but for the admin's attendance
// table dropdown, so it isn't scoped to a single employee's own token.)
async function getSessionsAdmin(req, res, next) {
  try {
    const [attendanceRows] = await pool.query('SELECT id FROM attendance WHERE id = ?', [req.params.id]);
    if (!attendanceRows[0]) return res.status(404).json({ success: false, message: 'Attendance record not found.' });

    const [rows] = await pool.query(
      'SELECT * FROM attendance_sessions WHERE attendance_id = ? ORDER BY time_in ASC',
      [req.params.id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

// GET /api/attendance?department=&date=&status=
async function getAttendance(req, res, next) {
  try {
    await settleEndedEvents();
    const { department = 'all', date, status = 'all', event_id } = req.query;
    let where = 'WHERE 1=1';
    const params = [];

    if (department !== 'all') {
      where += ' AND d.name = ?';
      params.push(department);
    }
    if (date) {
      where += ' AND a.attendance_date = ?';
      params.push(date);
    }
    if (status !== 'all') {
      where += ` AND ${DISPLAY_STATUS_SQL} = ?`;
      params.push(status);
    }
    if (event_id) {
      where += ' AND a.event_id = ?';
      params.push(event_id);
    }

    const [rows] = await pool.query(
      `SELECT a.*, ${DISPLAY_STATUS_SQL} AS attendance_status, e.full_name, e.employee_code, d.name AS department_name, ev.title AS event_title,
              ev.start_datetime AS event_start, ev.end_datetime AS event_end,
              ${presenceRulePercent()} AS presence_required_percent${ATTENDANCE_DURATION_SUBQUERIES}
       FROM attendance a
       JOIN employees e ON a.employee_id = e.id
       JOIN departments d ON e.department_id = d.id
       LEFT JOIN events ev ON a.event_id = ev.id
       ${where}
       ORDER BY a.attendance_date DESC, a.time_in DESC
       LIMIT 500`,
      params
    );

    if (event_id && ['all', 'Absent', 'Ongoing'].includes(status)) {
      const absentRows = await absentRowsForEvent(event_id, department);
      rows.push(...absentRows.filter((r) => status === 'all' || r.attendance_status === status));
    }

    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

// Employees expected at an event who have no attendance record for it, as
// placeholder "Absent" rows (is_placeholder, no id) so the admin sees who
// didn't show up. Expected = approved Active employees of the event's
// department, or everyone if the event isn't department-specific — the same
// rule the reports use. Only once the event has started, and shown as
// Ongoing (not yet Absent) until it ends.
async function absentRowsForEvent(eventId, department) {
  const [[ev]] = await pool.query(
    'SELECT id, title, department_id, start_datetime, end_datetime FROM events WHERE id = ?',
    [eventId]
  );
  if (!ev || new Date(ev.start_datetime) > new Date()) return [];

  let where = `WHERE e.is_approved = 1 AND e.remark = 'Active'
    AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.event_id = ? AND a.employee_id = e.id)`;
  const params = [ev.id];
  if (ev.department_id) {
    where += ' AND e.department_id = ?';
    params.push(ev.department_id);
  }
  if (department !== 'all') {
    where += ' AND d.name = ?';
    params.push(department);
  }
  const [employees] = await pool.query(
    `SELECT e.id AS employee_id, e.full_name, e.employee_code, d.name AS department_name
     FROM employees e
     JOIN departments d ON e.department_id = d.id
     ${where}
     ORDER BY e.full_name`,
    params
  );
  const eventDate = new Date(ev.start_datetime);
  const attendanceDate = `${eventDate.getFullYear()}-${String(eventDate.getMonth() + 1).padStart(2, '0')}-${String(eventDate.getDate()).padStart(2, '0')}`;
  return employees.map((emp) => ({
    ...emp,
    id: null,
    is_placeholder: true,
    event_id: ev.id,
    event_title: ev.title,
    attendance_date: attendanceDate,
    attendance_status: new Date(ev.end_datetime) >= new Date() ? 'Ongoing' : 'Absent',
    time_in: null,
    time_out: null,
    latitude: null,
    longitude: null,
    session_count: 0
  }));
}

// GET /api/attendance/by-department  (folder counts for the admin UI)
async function getAttendanceByDepartment(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT d.id, d.name, COUNT(e.id) AS member_count,
              (SELECT COUNT(*) FROM attendance a JOIN employees e2 ON a.employee_id = e2.id WHERE e2.department_id = d.id) AS log_count
       FROM departments d
       LEFT JOIN employees e ON e.department_id = d.id
       GROUP BY d.id ORDER BY d.name`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/attendance/submit
 * Core mobile attendance flow. Validates, in order:
 *   1. Employee + device authorization
 *   2. GPS accuracy
 *   3. Event schedule window
 *   4. Geofence containment
 *   5. Session continuation (multi-session time-in/time-out, same day)
 * Body: { employee_id, device_uid, event_id, latitude, longitude, accuracy, ocr_record_id }
 */
async function submitAttendance(req, res, next) {
  try {
    const { employee_id, device_uid, event_id, latitude, longitude, accuracy, ocr_record_id, mocked } = req.body;

    if (!employee_id || !event_id || latitude === undefined || longitude === undefined) {
      return res.status(400).json({ success: false, message: 'employee_id, event_id, latitude, and longitude are required.' });
    }
    // An employee can only record their OWN attendance, from their own
    // registered device (both apps always send device_uid).
    if (Number(employee_id) !== Number(req.employee.id)) {
      return res.status(403).json({ success: false, message: 'You can only record your own attendance.' });
    }
    if (!device_uid) {
      return res.status(400).json({ success: false, message: 'device_uid is required.' });
    }
    // Android marks readings from a mock-location provider (Fake GPS and
    // similar apps); the mobile app forwards that flag.
    if (isMockedLocation(mocked)) {
      await pool.query(
        `INSERT INTO attendance_logs (employee_id, action, details) VALUES (?, 'attendance_rejected', ?)`,
        [employee_id, JSON.stringify({ reason: 'mock_location', event_id, latitude, longitude })]
      );
      return res.status(403).json({
        success: false,
        code: 'MOCK_LOCATION',
        message: 'A fake/mock GPS location was detected. Turn off any location-spoofing app and try again.'
      });
    }

    // Every lookup the checks below need, fetched together: the database is
    // remote, so each sequential round trip delays the time-in.
    const now = new Date();
    const today = localDate(now);
    const [[employeeExists], [deviceRows], [eventRows], [geofenceRows], [eventPointRows], [existingRows]] = await Promise.all([
      pool.query('SELECT id FROM employees WHERE id = ?', [employee_id]),
      pool.query('SELECT * FROM mobile_devices WHERE device_uid = ? AND employee_id = ?', [device_uid, employee_id]),
      pool.query('SELECT * FROM events WHERE id = ?', [event_id]),
      pool.query('SELECT * FROM geofences WHERE event_id = ? AND is_active = 1', [event_id]),
      pool.query(
        `SELECT gp.geofence_id, gp.lat, gp.lng FROM geofence_points gp
         JOIN geofences g ON g.id = gp.geofence_id
         WHERE g.event_id = ? AND g.is_active = 1 ORDER BY gp.point_order`,
        [event_id]
      ),
      pool.query(
        'SELECT * FROM attendance WHERE employee_id = ? AND attendance_date = ? AND event_id = ?',
        [employee_id, today, event_id]
      )
    ]);

    // Same stale-local-session guard as deviceController.registerDevice —
    // fail with a clear, specific message instead of an FK constraint crash
    // if this device's cached employee_id no longer exists.
    if (!employeeExists[0]) {
      return res.status(404).json({
        success: false,
        code: 'EMPLOYEE_NOT_FOUND',
        message: 'Your account could not be found. Please sign out and sign in again.'
      });
    }

    // 1. Device authorization
    const device = deviceRows[0];
    if (!device) {
      await notifyAdmins({
        type: 'unregistered_device_attendance', severity: 'danger', targetView: 'mobile-app', employeeId: employee_id,
        title: 'Attendance from an unregistered device',
        message: `${await employeeLabel(employee_id)} tried to record attendance from a device that isn't registered to them.`
      });
      return res.status(403).json({ success: false, message: 'This device is not registered to this employee.' });
    }
    if (device.status === 'blacklisted' || device.status === 'rejected') {
      await notifyAdmins({
        type: 'blocked_device_attendance', severity: 'danger', targetView: 'mobile-app', employeeId: employee_id,
        title: 'Attendance from a blocked device',
        message: `${await employeeLabel(employee_id)} tried to record attendance from a ${device.status} device (${deviceLabel(device)}).`
      });
      return res.status(403).json({ success: false, message: 'This device is not authorized for attendance.' });
    }
    if (device.status === 'pending') {
      return res.status(403).json({ success: false, message: 'This device is pending admin approval.' });
    }

    // 2. GPS accuracy
    if (accuracy !== undefined && accuracy > config.attendance.maxAccuracyMeters) {
      return res.status(400).json({ success: false, message: `GPS accuracy too low (${accuracy}m). Move to an open area and try again.` });
    }

    // 3. Event schedule
    const event = eventRows[0];
    if (!event) return res.status(404).json({ success: false, message: 'Event not found.' });

    if (now < new Date(event.start_datetime) || now > new Date(event.end_datetime)) {
      return res.status(400).json({ success: false, message: 'Attendance is only allowed during the scheduled event window.' });
    }

    // 4. Geofence containment
    const geofence = geofenceRows[0];
    if (!geofence) return res.status(404).json({ success: false, message: 'No active geofence configured for this event.' });
    if (geofenceRows.length > 1) {
      // Shouldn't normally happen (createGeofence makes one event -> one geofence),
      // but if test data ended up with duplicates, flag it — the row picked here
      // (geofenceRows[0]) may not be the one the mobile app's own /mobile/active
      // fetch resolved to, which would explain an inside/outside mismatch.
      console.warn(`[geofence check] event_id ${event_id} has ${geofenceRows.length} active geofences — using id ${geofence.id}. Duplicate geofences can cause client/server mismatches.`);
    }

    let points = [];
    if (geofence.shape_type !== 'circle') {
      // mysql2 returns DECIMAL columns as strings by default — convert to Number
      // here (mirroring geofenceController.js's own conversion) so this array is
      // safe to hand to geofenceService regardless of that service's internals.
      points = eventPointRows
        .filter((p) => Number(p.geofence_id) === Number(geofence.id))
        .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }));
    }

    const { inside, distanceMeters } = geofenceService.isInsideGeofence(
      parseFloat(latitude),
      parseFloat(longitude),
      { ...geofence, points },
      edgeTolerance(accuracy)
    );

    // Debug logging — compares the submitted GPS point against the exact polygon
    // the server used for this decision. If the mobile app's live "inside" check
    // disagrees with this, the printed points/coords make it obvious whether it's
    // GPS drift near a small polygon's edge vs a genuine data mismatch.
    console.log('[geofence check]', {
      event_id,
      geofence_id: geofence.id,
      shape_type: geofence.shape_type,
      submitted: { lat: parseFloat(latitude), lng: parseFloat(longitude) },
      points,
      inside,
      distanceMeters
    });

    if (!inside) {
      await pool.query(
        `INSERT INTO attendance_logs (employee_id, action, details) VALUES (?, 'attendance_rejected', ?)`,
        [employee_id, JSON.stringify({ reason: 'outside_geofence', distanceMeters })]
      );
      return res.status(403).json({
        success: false,
        message: `You are outside the geofence boundary${distanceMeters ? ` (${distanceMeters}m away)` : ''}.`
      });
    }

    // 5. Session continuation — an employee may time in and out of the SAME
    // event any number of times while it hasn't ended yet, and every dip
    // accumulates into that day's total_duration_seconds. `attendance` stays
    // one row per employee/event/day (status, ratings, running total);
    // `attendance_sessions` holds one row per individual time-in/time-out.
    const existing = existingRows[0];

    const lateGraceMs = config.attendance.lateGraceMinutes * 60 * 1000;
    const lateThreshold = new Date(new Date(event.start_datetime).getTime() + lateGraceMs);
    const isLate = now > lateThreshold;
    const lateMinutes = isLate ? Math.round((now - new Date(event.start_datetime)) / 60000) : 0;

    if (existing) {
      // A session is already open (time_out not yet set) — nothing to do;
      // time-out is handled automatically by heartbeat() once the device
      // actually leaves the geofence, not by a second call to this endpoint.
      if (!existing.time_out) {
        return res.status(409).json({ success: false, message: 'Attendance session already in progress for this event.' });
      }

      // Still awaiting face verification: the employee is timed back in, but
      // the clock stays stopped (no session) until they verify -- see
      // pauseOpenSession / resumeSessionAfterVerification.
      if (existing.requires_face_verification) {
        await pool.query(
          `UPDATE attendance SET time_out = NULL, outside_streak = 0, latitude = ?, longitude = ?, last_lat = ?, last_lng = ?, accuracy_meters = ? WHERE id = ?`,
          [latitude, longitude, latitude, longitude, accuracy || null, existing.id]
        );
        realtime.broadcastNow('attendance-status');
        res.status(200).json({
          success: true,
          message: 'Welcome back — complete face verification to resume your time.',
          data: { id: existing.id, action: 're_time_in', status: existing.attendance_status, requiresFaceVerification: true }
        });
        afterResponse('re-entry time-in log', () => pool.query(
          `INSERT INTO attendance_logs (attendance_id, employee_id, action, details) VALUES (?, ?, 'time_in', ?)`,
          [existing.id, employee_id, JSON.stringify({ latitude, longitude, re_entry: true, paused_for_face_verification: true })]
        ));
        return;
      }

      // The employee left and has now re-entered the geofence while the
      // event is still running: open a brand-new session, and flip the
      // parent row back to "on-going" (time_out = NULL) without touching
      // its original time_in or accumulated total_duration_seconds.
      const [[sessionResult]] = await Promise.all([
        pool.query(
          `INSERT INTO attendance_sessions (attendance_id, employee_id, time_in, in_latitude, in_longitude)
           VALUES (?, ?, NOW(), ?, ?)`,
          [existing.id, employee_id, latitude, longitude]
        ),
        pool.query(
          `UPDATE attendance SET time_out = NULL, outside_streak = 0, latitude = ?, longitude = ?, last_lat = ?, last_lng = ?, accuracy_meters = ? WHERE id = ?`,
          [latitude, longitude, latitude, longitude, accuracy || null, existing.id]
        )
      ]);
      // Admin attendance views show the re-entry right away.
      realtime.broadcastNow('attendance-status');

      const anomalyDetectedAgain = await detectGeoAnomaly({
        attendanceId: existing.id,
        employeeId: employee_id,
        eventId: event_id,
        deviceUid: device_uid,
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude)
      });

      res.status(200).json({
        success: true,
        message: 'Welcome back — time-in recorded again.',
        data: { id: existing.id, sessionId: sessionResult.insertId, action: 'time_in', status: existing.attendance_status, requiresFaceVerification: anomalyDetectedAgain }
      });
      // The time-in itself is saved; the log and the notification don't hold up the reply.
      afterResponse('re-entry time-in log', () => Promise.all([
        pool.query(
          `INSERT INTO attendance_logs (attendance_id, employee_id, action, details) VALUES (?, ?, 'time_in', ?)`,
          [existing.id, employee_id, JSON.stringify({ latitude, longitude, session_id: sessionResult.insertId, re_entry: true })]
        ),
        !anomalyDetectedAgain && pool.query(
          `INSERT INTO notifications (employee_id, title, message, type) VALUES (?, 'Time-In Recorded', ?, 'attendance_success')`,
          [employee_id, `You re-entered "${event.title}" and were automatically timed in again.`]
        )
      ]));
      return;
    }

    // First time-in of the day for this event.
    const [insertResult] = await pool.query(
      `INSERT INTO attendance
        (employee_id, event_id, geofence_id, device_id, ocr_record_id, attendance_date, time_in,
         latitude, longitude, accuracy_meters, attendance_status, verification_status, late_minutes)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, 'Verified', ?)`,
      [
        employee_id,
        event_id,
        geofence.id,
        device ? device.id : null,
        ocr_record_id || null,
        today,
        latitude,
        longitude,
        accuracy || null,
        isLate ? 'Late' : 'Present',
        lateMinutes
      ]
    );

    await pool.query(
      `INSERT INTO attendance_sessions (attendance_id, employee_id, time_in, in_latitude, in_longitude)
       VALUES (?, ?, NOW(), ?, ?)`,
      [insertResult.insertId, employee_id, latitude, longitude]
    );
    // Admin attendance views show the time-in right away.
    realtime.broadcastNow('attendance-status');

    const anomalyDetected = await detectGeoAnomaly({
      attendanceId: insertResult.insertId,
      employeeId: employee_id,
      eventId: event_id,
      deviceUid: device_uid,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude)
    });

    res.status(201).json({
      success: true,
      message: anomalyDetected
        ? 'Attendance recorded, but unusual location activity was detected. Please complete face verification in the app.'
        : `Time-in recorded${isLate ? ' (late)' : ''}. Your status shows as Ongoing until the event ends.`,
      data: { id: insertResult.insertId, action: 'time_in', status: isLate ? 'Late' : 'Present', lateMinutes, requiresFaceVerification: anomalyDetected }
    });
    // The time-in itself is saved; the log, notification and rating
    // recalculation don't hold up the reply.
    afterResponse('time-in follow-up', () => Promise.all([
      pool.query(
        `INSERT INTO attendance_logs (attendance_id, employee_id, action, details) VALUES (?, ?, 'time_in', ?)`,
        [insertResult.insertId, employee_id, JSON.stringify({ latitude, longitude, isLate })]
      ),
      !anomalyDetected && pool.query(
        `INSERT INTO notifications (employee_id, title, message, type) VALUES (?, 'Attendance Recorded', ?, 'attendance_success')`,
        [employee_id, `You were timed in for "${event.title}"${isLate ? ' (late)' : ''}. Stay inside the event area for at least ${presenceRulePercent()}% of the event to be counted; your status shows as Ongoing until it ends.`]
      ),
      recalculateAllRatings(employee_id)
    ]));
  } catch (err) {
    next(err);
  }
}

// Records (or closes) attendance from the admin dashboard's Verification
// kiosk — used as an ALTERNATIVE to the mobile app's GPS-based check-in for
// an employee who doesn't have their phone with them (no GPS) or doesn't
// have a physical ID on hand: an admin instead confirms identity via an
// ID-card OCR scan or a live selfie match, and that successful verification
// itself records the attendance, exactly the way tapping in/out at a kiosk
// would. Called directly from ocrController.verifyId / faceController.verifyFace
// after a successful identity match — not its own HTTP route — so it's
// Records attendance from the admin dashboard's Verification kiosk — used as
// an ALTERNATIVE to the mobile app's GPS-based check-in for an employee who
// doesn't have their phone with them (no GPS) or doesn't have a physical ID
// on hand: an admin instead confirms identity via an ID-card OCR scan or a
// live selfie match. Called directly from ocrController.verifyId /
// faceController.verifyFace after a successful identity match — not its own
// HTTP route — so it's naturally scoped to whichever admin role can already
// reach those two tools (see routes/ocrRoutes.js, routes/faceRoutes.js)
// without needing separate attendance permissions.
//
// No GPS/geofence check runs here at all — the admin is physically present
// confirming identity in person, which is the whole point of this fallback.
//
// Unlike the mobile GPS flow, this is a ONE-TIME roll-call confirmation, not
// a time-in/time-out cycle: there's no ongoing physical presence to measure
// (the admin's scan is a single instant, not a geofence someone can stay
// inside or step out of), so no attendance_sessions rows or duration/work_hours
// tracking are recorded — `time_in` and `time_out` are both set to the
// verification instant (duration 0); finalizeEndedEventStatuses skips
// non-GPS rows when applying its "Absent if attended-ratio is too low" rule.
// attendance_status is decided immediately, once, by
// comparing the verification instant against the event's scheduled
// start_datetime (+ the configured late-grace window): on time = Present,
// past the grace window = Late. If this employee already has an attendance
// record for the event today (e.g. the admin re-scanned by mistake), it's
// simply reported back as-is instead of creating a duplicate row.
async function recordVerificationAttendance({ employeeId, eventId, method, ocrRecordId, faceRecordId, adminId }) {
  if (!['ocr', 'face'].includes(method)) {
    throw new Error(`recordVerificationAttendance: unsupported method "${method}"`);
  }

  const [eventRows] = await pool.query('SELECT * FROM events WHERE id = ?', [eventId]);
  const event = eventRows[0];
  if (!event) return { success: false, status: 404, message: 'Event not found.' };

  const now = new Date();
  if (now < new Date(event.start_datetime) || now > new Date(event.end_datetime)) {
    return { success: false, status: 400, message: 'This event is not currently active — attendance can only be recorded during its scheduled window.' };
  }

  const today = localDate(now);
  const [existingRows] = await pool.query(
    'SELECT * FROM attendance WHERE employee_id = ? AND attendance_date = ? AND event_id = ?',
    [employeeId, today, eventId]
  );
  const existing = existingRows[0];

  if (existing) {
    // An anomaly-flagged record (geo_anomalies logged it and set
    // requires_face_verification = 1 -- see detectGeoAnomaly above) sitting
    // here unresolved is exactly what this admin-assisted OCR/Face
    // verification is meant to clear: the admin has just independently
    // confirmed, in person, that this employee is who they say they are.
    // Mirrors the employee's own self-service resolution path
    // (faceVerify() below) but attributes it to the admin who did the
    // verifying, since here there is one.
    if (existing.requires_face_verification) {
      await pool.query(
        `UPDATE attendance SET requires_face_verification = 0, face_verified_at = NOW(), verification_status = 'Verified' WHERE id = ?`,
        [existing.id]
      );
      await pool.query(
        `UPDATE geo_anomalies SET resolved = 1, resolved_by = ?, resolved_at = NOW() WHERE attendance_id = ? AND resolved = 0`,
        [adminId || null, existing.id]
      );
      await pool.query(
        `INSERT INTO attendance_logs (attendance_id, employee_id, action, details) VALUES (?, ?, 'anomaly_resolved', ?)`,
        [existing.id, employeeId, JSON.stringify({ method, adminId: adminId || null })]
      );
      await resumeSessionAfterVerification(existing.id, null, null);
      realtime.notifyEmployee(employeeId, 'attendance');
      return {
        success: true,
        status: 200,
        action: 'anomaly_resolved',
        attendanceId: existing.id,
        status_label: existing.attendance_status
      };
    }
    return {
      success: true,
      status: 200,
      action: 'already_recorded',
      attendanceId: existing.id,
      status_label: existing.attendance_status
    };
  }

  const lateGraceMs = config.attendance.lateGraceMinutes * 60 * 1000;
  const lateThreshold = new Date(new Date(event.start_datetime).getTime() + lateGraceMs);
  const isLate = now > lateThreshold;
  const lateMinutes = isLate ? Math.round((now - new Date(event.start_datetime)) / 60000) : 0;

  const [insertResult] = await pool.query(
    `INSERT INTO attendance
      (employee_id, event_id, ocr_record_id, verification_method, face_record_id, verified_by_admin_id,
       attendance_date, time_in, time_out, attendance_status, verification_status, late_minutes)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?, 'Verified', ?)`,
    [
      employeeId,
      eventId,
      method === 'ocr' ? (ocrRecordId || null) : null,
      method === 'ocr' ? 'ocr' : 'face',
      method === 'face' ? (faceRecordId || null) : null,
      adminId || null,
      today,
      isLate ? 'Late' : 'Present',
      lateMinutes
    ]
  );

  await pool.query(
    `INSERT INTO attendance_logs (attendance_id, employee_id, action, details) VALUES (?, ?, 'attendance_recorded', ?)`,
    [insertResult.insertId, employeeId, JSON.stringify({ method, ocrRecordId: ocrRecordId || null, faceRecordId: faceRecordId || null, adminId: adminId || null, isLate })]
  );
  await pool.query(
    `INSERT INTO notifications (employee_id, title, message, type) VALUES (?, 'Attendance Recorded', ?, 'attendance_success')`,
    [employeeId, `Your attendance for "${event.title}" was recorded as ${isLate ? 'Late' : 'Present'} via admin-assisted ${method === 'ocr' ? 'ID verification' : 'face verification'}.`]
  );

  await recalculateAllRatings(employeeId);
  realtime.notifyEmployee(employeeId, 'attendance');

  return {
    success: true,
    status: 201,
    action: 'recorded',
    attendanceId: insertResult.insertId,
    status_label: isLate ? 'Late' : 'Present',
    lateMinutes
  };
}

// POST /api/attendance/:id/face-verify  (employee JWT required)
// Body (multipart): selfie (file), video (optional mp4/mov liveness clip),
// latitude, longitude, liveness_verified, liveness_actions
//
// This is the automatic, on-device self-verification an employee's app
// triggers the moment a geo-anomaly flags their attendance (see
// detectGeoAnomaly above and AttendanceTrackingContext.js on the mobile
// side) -- NOT an admin-performed check. It has to be a REAL verification,
// not a rubber stamp: the submitted selfie's face embedding is matched
// against this employee's OWN enrolled photo(s) (an employee can have more
// than one from re-registering — every one of them is a legitimate
// reference, so all are compared and the best match wins), the same
// liveness bar and matching threshold used everywhere else face
// recognition happens in this app (services/faceService.js,
// config.face.matchThreshold). Anything short of a genuine match — no
// liveness completed, no face detected in the photo, or a face that
// doesn't match closely enough — returns failure and leaves the
// attendance record exactly as flagged as it was; nothing here marks it
// Verified except an actual successful match.
async function faceVerify(req, res, next) {
  try {
    const { id } = req.params;
    const { latitude, longitude } = req.body;

    const [rows] = await pool.query('SELECT * FROM attendance WHERE id = ? AND employee_id = ?', [id, req.employee.id]);
    const record = rows[0];
    if (!record) return res.status(404).json({ success: false, message: 'Attendance record not found.' });
    const selfieFile = req.files?.selfie?.[0];
    const videoFile = req.files?.video?.[0];
    if (!selfieFile) return res.status(400).json({ success: false, message: 'A selfie photo is required.' });

    const selfiePath = `/uploads/selfies/${selfieFile.filename}`;
    const videoPath = videoFile ? `/uploads/face_videos/${videoFile.filename}` : null;
    const livenessActions = typeof req.body.liveness_actions === 'string' ? req.body.liveness_actions.slice(0, 120) : null;
    // Every attempt's photo is kept on record (face_records, source
    // 'mobile_anomaly') and shown with the admin's Face Verification
    // records, whether it matched or not.
    const recordAttempt = (result, similarity = null) => pool.query(
      `INSERT INTO face_records (employee_id, image_path, similarity, result, liveness_verified, liveness_actions, source)
       VALUES (?, ?, ?, ?, ?, ?, 'mobile_anomaly')`,
      [req.employee.id, selfiePath, similarity, result,
        req.body.liveness_verified === 'true' || req.body.liveness_verified === true ? 1 : 0, livenessActions]
    );

    // Face verification is only accepted while the event is still running —
    // once it ends, an unverified flagged record is settled as not recorded
    // (see rejectUnverifiedFlaggedAttendance).
    if (record.event_id) {
      const [eventRows] = await pool.query('SELECT end_datetime FROM events WHERE id = ?', [record.event_id]);
      if (eventRows[0] && new Date(eventRows[0].end_datetime) <= new Date()) {
        await recordAttempt('expired');
        await settleEndedEvents();
        return res.status(410).json({
          success: false,
          result: 'expired',
          message: 'This event has already ended, so face verification is closed and this attendance was not recorded.'
        });
      }
    }

    // Same rule as the admin's live-selfie tool (controllers/faceController.js
    // verifyFace): a claimed-but-unverified liveness check is rejected before
    // the comparatively expensive face-recognition model even runs.
    const livenessVerified = req.body.liveness_verified === 'true' || req.body.liveness_verified === true;
    if (!livenessVerified) {
      return res.status(400).json({
        success: false,
        result: 'liveness_failed',
        message: 'Liveness check was not completed. Please retry the selfie verification.'
      });
    }

    let embedding;
    try {
      embedding = await faceService.getEmbedding(selfieFile.path);
    } catch (err) {
      await recordAttempt('no_face_detected');
      return res.status(502).json({
        success: false,
        result: 'no_face_detected',
        message: err.message.includes('No face was detected')
          ? err.message
          : 'Could not process the captured photo. Please retake it.'
      });
    }

    const [faceRows] = await pool.query('SELECT image_path, embedding FROM employee_faces WHERE employee_id = ?', [req.employee.id]);
    if (!faceRows.length) {
      return res.status(409).json({
        success: false,
        result: 'not_enrolled',
        message: 'No enrolled face on file for your account. Please contact an administrator.'
      });
    }
    const candidates = faceRows.map((r) => ({ employeeId: req.employee.id, embedding: JSON.parse(r.embedding) }));
    const match = faceService.findBestMatch(embedding, candidates);

    if (!match) {
      await pool.query(
        `INSERT INTO attendance_logs (attendance_id, employee_id, action, details) VALUES (?, ?, 'face_verify_failed', ?)`,
        [id, req.employee.id, JSON.stringify({ latitude, longitude, reason: 'no_match', selfie_path: selfiePath, video_path: videoPath })]
      );
      await recordAttempt('no_match');
      return res.status(401).json({
        success: false,
        result: 'no_match',
        message: "This photo doesn't match your enrolled face closely enough. Please try again, centered and well-lit."
      });
    }

    // verification_method is deliberately left untouched here (still
    // 'mobile_gps' for a normal GPS-tracked employee) -- this attendance is
    // a real, ongoing GPS session with its own time-in/out, just
    // additionally confirmed by this self-verification; overwriting it to
    // 'face' would make the admin Attendance table's timeSessionCell()
    // wrongly treat it as a single admin-roll-call instant with no
    // duration, the same way an OCR/Face admin-assisted record correctly
    // is. requires_face_verification flipping to 0, face_verified_at, and
    // selfie_path/selfie_lat/selfie_lng below are what the admin's
    // faceVerificationCell() already keys off of to show this was
    // verified -- see views/dashboard.ejs / public/js/app.js.
    await pool.query(
      `UPDATE attendance SET selfie_path = ?, selfie_lat = ?, selfie_lng = ?, requires_face_verification = 0,
       face_verified_at = NOW(), verification_status = 'Verified' WHERE id = ?`,
      [selfiePath, latitude || null, longitude || null, id]
    );
    await recordAttempt('matched', Math.max(0, match.similarity) * 100);

    await pool.query(
      `UPDATE geo_anomalies SET resolved = 1, resolved_at = NOW() WHERE attendance_id = ? AND resolved = 0`,
      [id]
    );

    await pool.query(
      `INSERT INTO attendance_logs (attendance_id, employee_id, action, details) VALUES (?, ?, 'face_verified', ?)`,
      [id, req.employee.id, JSON.stringify({ latitude, longitude, similarity: match.similarity, liveness_actions: livenessActions, selfie_path: selfiePath, video_path: videoPath })]
    );

    // The clock was stopped when this record was flagged -- start it again.
    const resumed = await resumeSessionAfterVerification(id, latitude, longitude);
    realtime.notifyEmployee(req.employee.id, 'attendance');

    res.json({
      success: true,
      result: 'matched',
      resumed,
      message: resumed
        ? 'Face verified. Your attendance is confirmed and your time is being recorded again.'
        : 'Face verification submitted. Your attendance is now confirmed.'
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/attendance/anomalies  (admin — powers the Geo-Fence alerts panel)
async function getAnomalies(req, res, next) {
  try {
    const { resolved = '0' } = req.query;
    const [rows] = await pool.query(
      `SELECT ga.*, e.full_name, e.employee_code, ev.title AS event_title
       FROM geo_anomalies ga
       JOIN employees e ON ga.employee_id = e.id
       LEFT JOIN events ev ON ga.event_id = ev.id
       WHERE ga.resolved = ?
       ORDER BY ga.created_at DESC
       LIMIT 100`,
      [resolved === '1' ? 1 : 0]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

// GET /api/attendance/anomaly-rechecks  (admin — Verification page countdown)
// Records that passed face verification less than anomalyRecheckSeconds ago
// whose phone is STILL within anomalyDistanceMeters of another employee's
// phone for the same event (the same distance test detectGeoAnomaly runs).
// Those will be flagged again once the recheck window runs out, so the admin
// page shows a countdown for each. seconds_left is computed in SQL time, the
// client just ticks it down.
async function getAnomalyRechecks(req, res, next) {
  try {
    const recheckSeconds = config.attendance.anomalyRecheckSeconds;
    const windowSeconds = config.attendance.anomalyWindowSeconds;
    const maxMeters = config.attendance.anomalyDistanceMeters;
    const [rows] = await pool.query(
      `SELECT x.*, (x.last_ping_at IS NOT NULL AND (x.latest_time_in IS NULL OR x.last_ping_at >= x.latest_time_in)) AS ping_is_newest,
              (x.last_ping_at >= NOW() - INTERVAL ? SECOND) AS ping_fresh,
              (x.latest_time_in >= NOW() - INTERVAL ? SECOND) AS time_in_fresh
       FROM (
         SELECT a.id, a.employee_id, a.event_id, a.requires_face_verification,
                TIMESTAMPDIFF(SECOND, a.face_verified_at, NOW()) AS verified_ago_s,
                a.last_lat, a.last_lng, a.latitude, a.longitude, a.last_ping_at,
                GREATEST(a.time_in, COALESCE((SELECT MAX(s.time_in) FROM attendance_sessions s WHERE s.attendance_id = a.id), a.time_in)) AS latest_time_in,
                e.full_name, e.employee_code, ev.title AS event_title
         FROM attendance a
         JOIN employees e ON a.employee_id = e.id
         LEFT JOIN events ev ON a.event_id = ev.id
         WHERE a.time_out IS NULL
           AND a.event_id IN (
             SELECT event_id FROM attendance
             WHERE time_out IS NULL AND face_verified_at >= NOW() - INTERVAL ? SECOND
           )
       ) x`,
      [windowSeconds, windowSeconds, recheckSeconds]
    );
    // Each phone's newest known position, only if it's fresh enough to count.
    const pos = (r) => {
      if (Number(r.ping_is_newest)) {
        return Number(r.ping_fresh) && r.last_lat != null ? { lat: Number(r.last_lat), lng: Number(r.last_lng) } : null;
      }
      return Number(r.time_in_fresh) && r.latitude != null ? { lat: Number(r.latitude), lng: Number(r.longitude) } : null;
    };
    const data = [];
    for (const r of rows) {
      if (Number(r.requires_face_verification)) continue;
      if (r.verified_ago_s == null || Number(r.verified_ago_s) >= recheckSeconds) continue;
      const me = pos(r);
      if (!me) continue;
      const near = rows.find((o) => o.id !== r.id && o.event_id === r.event_id && o.employee_id !== r.employee_id &&
        (() => { const p = pos(o); return p && geofenceService.distanceMeters(me.lat, me.lng, p.lat, p.lng) <= maxMeters; })());
      if (!near) continue;
      data.push({
        attendance_id: r.id,
        employee_id: r.employee_id,
        full_name: r.full_name,
        employee_code: r.employee_code,
        event_title: r.event_title,
        near_full_name: near.full_name,
        near_employee_code: near.employee_code,
        seconds_left: Math.max(0, recheckSeconds - Number(r.verified_ago_s))
      });
    }
    res.json({ success: true, data, recheckSeconds, distanceMeters: maxMeters });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/attendance/anomalies/:id/resolve  (admin)
// Not currently called from anywhere in the admin UI (see
// public/js/app.js G_App.geofence / G_App.verification) -- resolving an
// anomaly now only ever happens as a side effect of the flagged employee's
// own successful on-device Face Verification (faceVerify above, triggered
// automatically by the mobile app; never an admin action). Left in place
// for any direct API integration that still wants a manual override, but
// note it only ever touches geo_anomalies.resolved -- it does NOT clear
// attendance.requires_face_verification or set verification_status, so
// using it alone would leave a record showing "resolved" here while still
// showing "Awaiting Verification" everywhere else that reads the
// attendance row directly (the admin Attendance table's
// faceVerificationCell, for one).
async function resolveAnomaly(req, res, next) {
  try {
    await pool.query(
      'UPDATE geo_anomalies SET resolved = 1, resolved_by = ?, resolved_at = NOW() WHERE id = ?',
      [req.admin.id, req.params.id]
    );
    res.json({ success: true, message: 'Alert marked as resolved.' });
  } catch (err) {
    next(err);
  }
}

// GET /api/attendance/by-event  (folder counts for the "organized by Event" admin UI)
async function getAttendanceByEvent(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT e.id, e.title, e.venue, e.start_datetime, e.end_datetime,
              (SELECT COUNT(*) FROM attendance a WHERE a.event_id = e.id) AS log_count
       FROM events e
       ORDER BY CASE WHEN NOW() BETWEEN e.start_datetime AND e.end_datetime THEN 0
                     WHEN e.start_datetime > NOW() THEN 1
                     ELSE 2 END,
                CASE WHEN e.start_datetime > NOW() THEN e.start_datetime END ASC,
                e.start_datetime DESC`
    );
    const now = new Date();
    const data = rows.map((e) => {
      const start = new Date(e.start_datetime);
      const end = new Date(e.end_datetime);
      let computed_status = 'upcoming';
      if (now >= start && now <= end) computed_status = 'ongoing';
      else if (now > end) computed_status = 'completed';
      return { ...e, computed_status };
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/attendance/:id  (admin — manual correction, e.g. flipping a
// record between Present/Late/Absent/Excused). Always re-recalculates the
// affected employee's ratings afterward so nothing goes stale.
async function updateAttendance(req, res, next) {
  try {
    const { id } = req.params;
    const { attendance_status } = req.body;
    const validStatuses = ['Present', 'Late', 'Absent', 'Excused'];
    if (!validStatuses.includes(attendance_status)) {
      return res.status(400).json({ success: false, message: `attendance_status must be one of: ${validStatuses.join(', ')}.` });
    }

    const [rows] = await pool.query('SELECT * FROM attendance WHERE id = ?', [id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Attendance record not found.' });

    // status_finalized: the admin's choice stands — the end-of-event presence
    // rule (finalizeEndedEventStatuses) won't override it.
    await pool.query('UPDATE attendance SET attendance_status = ?, status_finalized = 1 WHERE id = ?', [attendance_status, id]);
    await pool.query(
      `INSERT INTO attendance_logs (attendance_id, employee_id, action, details) VALUES (?, ?, 'admin_status_change', ?)`,
      [id, rows[0].employee_id, JSON.stringify({ from: rows[0].attendance_status, to: attendance_status, by: req.admin.id })]
    );

    await recalculateAllRatings(rows[0].employee_id);
    await logAction({ adminId: req.admin.id, action: 'update', module: 'attendance', details: { id, attendance_status }, ip: req.ip });
    realtime.notifyEmployee(rows[0].employee_id, 'attendance');

    res.json({ success: true, message: 'Attendance record updated and ratings recalculated.' });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/attendance/:id  (admin)
async function deleteAttendance(req, res, next) {
  try {
    const [rows] = await pool.query('SELECT * FROM attendance WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Attendance record not found.' });

    await pool.query('DELETE FROM attendance WHERE id = ?', [req.params.id]);
    await recalculateAllRatings(rows[0].employee_id);
    await logAction({ adminId: req.admin.id, action: 'delete', module: 'attendance', details: { id: req.params.id }, ip: req.ip });
    realtime.notifyEmployee(rows[0].employee_id, 'attendance');

    res.json({ success: true, message: 'Attendance record deleted and ratings recalculated.' });
  } catch (err) {
    next(err);
  }
}

// POST /api/attendance/:id/heartbeat  (employee JWT required — mobile app)
// Body: { latitude, longitude, observed_at? }
// The mobile app calls this periodically (see config.attendance.heartbeatMinIntervalSeconds)
// while an attendance session is open (time_in set, time_out not yet set).
// When the employee's location falls outside the event's geofence for
// config.attendance.autoEndOutsideStreakThreshold consecutive pings in a row
// (1 by default: the first outside reading), the server automatically closes
// the session (sets time_out + work_hours). The app sends that reading the
// instant it's taken, so the time-out lands in real time.
//
// `observed_at` (optional, ISO datetime) is when the mobile app actually took
// this GPS reading, which can be well before the ping reaches the server: GPS
// itself doesn't need connectivity, so the app can keep detecting "I'm
// outside the geofence" and locally freeze its displayed duration the moment
// that happens, even with no signal/WiFi — it just can't tell the SERVER
// until connectivity returns, at which point it retries this same reading
// (same coordinates, same original observed_at) rather than a fresh "now"
// one. Without this, a session left open across a connectivity gap would
// only close once the ping finally lands, crediting the entire outage —
// including time spent outside — as attendance. When present and sane
// (not in the future, not implausibly old), observed_at is used as the
// session's time_out instead of the moment this request was processed.
//
// `location_off: true` means the employee switched the phone's Location/GPS
// off while the session was open. The app can no longer prove they're inside
// the geofence, so the session is closed right away (no outside-streak, no
// debounce), at observed_at = the moment Location went off. Duration only
// resumes once Location is back on and a fresh time-in lands.
const HEARTBEAT_OBSERVED_AT_FUTURE_SKEW_MS = 2 * 60 * 1000; // small clock-skew allowance
const HEARTBEAT_OBSERVED_AT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // ignore implausibly stale/garbage values

function resolveHeartbeatEndTime(observedAtRaw, sessionOpenedAt) {
  const now = new Date();
  if (!observedAtRaw) return now;
  const observed = new Date(observedAtRaw);
  if (Number.isNaN(observed.getTime())) return now;
  if (observed.getTime() > now.getTime() + HEARTBEAT_OBSERVED_AT_FUTURE_SKEW_MS) return now; // can't be from the future
  if (now.getTime() - observed.getTime() > HEARTBEAT_OBSERVED_AT_MAX_AGE_MS) return now; // too stale to trust
  if (sessionOpenedAt && observed.getTime() < new Date(sessionOpenedAt).getTime()) return now; // can't end before it started
  return observed;
}

const TIME_OUT_MESSAGES = {
  location_off: 'Your Location was turned off, so your session was automatically timed out. Turn Location back on to continue.',
  left_geofence: 'You left the event area, so your session was automatically timed out.',
  no_signal: 'Your phone stopped reporting its location (Location turned off, or the app stopped), so your session was automatically timed out.'
};

// Times out an attendance row's open session at `endTime`: closes the
// session, folds its duration into the running total and sets time_out. A
// later re-entry (see submitAttendance) opens a new session and keeps adding
// to this same total rather than overwriting it. Used by heartbeat() and by
// the closeSilentSessions sweep. Admin views are told at once; the log and
// the employee's notification are written afterwards, without being awaited.
async function autoTimeOut({ record, openSession, endTime, latitude, longitude, outsideStreak, reason }) {
  const id = record.id;
  // The closed session's own duration_seconds is added to the total in the
  // same UPDATE (countedSessionId) instead of being read back first.
  let countedSessionId = null;
  let fallbackSeconds = 0;
  if (openSession) {
    const [closed] = await pool.query(
      `UPDATE attendance_sessions
       SET time_out = ?, duration_seconds = GREATEST(0, TIMESTAMPDIFF(SECOND, time_in, ?)),
           out_latitude = ?, out_longitude = ?, auto_ended = 1
       WHERE id = ? AND time_out IS NULL`,
      [endTime, endTime, latitude, longitude, openSession.id]
    );
    // 0 rows: a concurrent pauseOpenSession already closed this session
    // and added its time to the total -- don't count it twice.
    if (closed.affectedRows !== 0) countedSessionId = openSession.id;
  } else {
    // No open session while awaiting face verification is expected (the
    // clock is paused -- see pauseOpenSession), so nothing to add then.
    // Re-read the flag: another employee's ping may have flagged this
    // record (and closed its session) after `record` was loaded.
    // Otherwise it shouldn't normally happen (a session is opened every
    // time time_out is cleared) — fall back to the parent row's own
    // time_in so a duration is still recorded instead of silently dropping it.
    const [[fresh]] = await pool.query('SELECT requires_face_verification FROM attendance WHERE id = ?', [id]);
    if (!fresh?.requires_face_verification) {
      fallbackSeconds = Math.max(0, Math.round((endTime.getTime() - new Date(record.time_in).getTime()) / 1000));
    }
  }

  // Added in SQL rather than overwritten from `record`, so a concurrent
  // pauseOpenSession's addition to the total isn't lost.
  await pool.query(
    `UPDATE attendance SET time_out = ?,
       total_duration_seconds = COALESCE(total_duration_seconds, 0) + ?
         + COALESCE((SELECT duration_seconds FROM attendance_sessions WHERE id = ?), 0),
       work_hours = ROUND(total_duration_seconds / 3600, 2), last_lat = ?, last_lng = ?, last_ping_at = NOW(),
       outside_streak = ?, auto_ended = 1 WHERE id = ?`,
    [endTime, fallbackSeconds, countedSessionId, latitude, longitude, outsideStreak, id]
  );
  // Admin attendance views update now, not after the log/notification
  // writes below or the usual coalescing delay.
  realtime.broadcastNow('attendance-status');
  realtime.notifyEmployee(record.employee_id, 'attendance');

  afterResponse('time-out follow-up', async () => {
    const [[totals]] = await pool.query(
      `SELECT a.total_duration_seconds, s.duration_seconds AS session_seconds
       FROM attendance a LEFT JOIN attendance_sessions s ON s.id = ?
       WHERE a.id = ?`,
      [countedSessionId, id]
    );
    const totalDurationSeconds = Number(totals?.total_duration_seconds) || 0;
    const sessionDurationSeconds = countedSessionId ? Number(totals?.session_seconds) || 0 : fallbackSeconds;
    const workHours = (totalDurationSeconds / 3600).toFixed(2);
    await Promise.all([
      pool.query(
        `INSERT INTO attendance_logs (attendance_id, employee_id, action, details) VALUES (?, ?, 'auto_time_out', ?)`,
        [id, record.employee_id, JSON.stringify({ latitude, longitude, reason, sessionDurationSeconds, totalDurationSeconds, observedAt: endTime.toISOString() })]
      ),
      pool.query(
        `INSERT INTO notifications (employee_id, title, message, type) VALUES (?, 'Time-Out Recorded', ?, 'attendance_auto_end')`,
        [record.employee_id, `${TIME_OUT_MESSAGES[reason] || TIME_OUT_MESSAGES.left_geofence} Total time so far: ${workHours} hour(s).`]
      )
    ]);
  });
}

// Times out every open session whose phone has gone silent: no heartbeat (or
// time-in) for config.attendance.silentSessionSeconds. The app keeps pinging
// every ~15 s while a session is open -- in the background too, even with
// the app closed (see mobile/src/tasks/backgroundAttendance.js) -- so silence
// means its Location was turned off, or the app or phone stopped, with no
// screen open to report it. The time-out is set at the last moment the phone
// was heard from, not now. Run on a timer from server.js.
//
// Right after this server starts, phones haven't had a chance to reach it
// yet (it may have been down a while), so nothing is closed until it has
// been up for one full silence window.
const serverStartedAt = Date.now();
let sweeping = false;
async function closeSilentSessions() {
  const silentSeconds = config.attendance.silentSessionSeconds;
  if (!(silentSeconds > 0) || sweeping) return;
  if (Date.now() - serverStartedAt < silentSeconds * 1000) return;
  sweeping = true;
  try {
    // Ages are compared in SQL, against the database's own clock, like
    // detectGeoAnomaly does.
    const [rows] = await pool.query(
      `SELECT x.* FROM (
         SELECT a.*,
                GREATEST(COALESCE(a.last_ping_at, a.time_in),
                         COALESCE((SELECT MAX(s.time_in) FROM attendance_sessions s WHERE s.attendance_id = a.id), a.time_in)) AS last_heard_at
         FROM attendance a
         JOIN events e ON e.id = a.event_id
         WHERE a.time_out IS NULL AND a.verification_method = 'mobile_gps' AND e.end_datetime > NOW()
       ) x
       WHERE x.last_heard_at < NOW() - INTERVAL ? SECOND`,
      [silentSeconds]
    );
    for (const record of rows) {
      const [[[still]], [[openSession]]] = await Promise.all([
        pool.query('SELECT time_out, last_ping_at FROM attendance WHERE id = ?', [record.id]),
        pool.query(
          'SELECT * FROM attendance_sessions WHERE attendance_id = ? AND time_out IS NULL ORDER BY time_in DESC LIMIT 1',
          [record.id]
        )
      ]);
      // A ping (or another time-out) may have landed since the scan.
      if (!still || still.time_out || still.last_ping_at !== record.last_ping_at) continue;
      await autoTimeOut({
        record,
        openSession,
        endTime: new Date(record.last_heard_at),
        latitude: record.last_lat ?? record.latitude,
        longitude: record.last_lng ?? record.longitude,
        outsideStreak: record.outside_streak || 0,
        reason: 'no_signal'
      });
      console.log(`[attendance] Timed out attendance #${record.id}: no signal from the phone since ${record.last_heard_at}.`);
    }
  } catch (err) {
    console.error('[attendance] Silent-session sweep failed:', err.message);
  } finally {
    sweeping = false;
  }
}

async function heartbeat(req, res, next) {
  try {
    const { id } = req.params;
    const { observed_at, accuracy, mocked } = req.body;
    let { latitude, longitude } = req.body;
    const locationOff = req.body.location_off === true || req.body.location_off === 'true';
    if (!locationOff && (latitude === undefined || longitude === undefined)) {
      return res.status(400).json({ success: false, message: 'latitude and longitude are required.' });
    }

    const [rows] = await pool.query('SELECT * FROM attendance WHERE id = ? AND employee_id = ?', [id, req.employee.id]);
    const record = rows[0];
    if (!record) return res.status(404).json({ success: false, message: 'Attendance record not found.' });
    if (locationOff) {
      // The phone may never have had a fix to send -- fall back to the last
      // position the server already has for this session.
      if (latitude == null) latitude = record.last_lat ?? record.latitude;
      if (longitude == null) longitude = record.last_lng ?? record.longitude;
    }
    if (record.time_out) {
      // Nothing currently open — the employee already left. If they walk
      // back into the geofence, submitAttendance() opens a fresh session
      // automatically, so there's nothing for this ping to do right now.
      return res.json({ success: true, message: 'No session currently open.', data: { ended: true } });
    }

    // The event may have simply ended while the employee was still standing
    // inside the boundary — that's not a "left the geofence" case at all, so
    // the outside-streak logic below would never catch it and the session
    // (and its duration) would keep running forever. Close it immediately,
    // capped at the event's own end time.
    // Fetched together -- every round trip here delays the time-out.
    const [[eventRows], [geofenceRows], [pointRows], [openSessionRows]] = await Promise.all([
      pool.query('SELECT end_datetime FROM events WHERE id = ?', [record.event_id]),
      pool.query('SELECT * FROM geofences WHERE id = ?', [record.geofence_id]),
      pool.query('SELECT lat, lng FROM geofence_points WHERE geofence_id = ? ORDER BY point_order', [record.geofence_id]),
      pool.query(
        'SELECT * FROM attendance_sessions WHERE attendance_id = ? AND time_out IS NULL ORDER BY time_in DESC LIMIT 1',
        [id]
      )
    ]);
    if (eventRows[0] && new Date(eventRows[0].end_datetime) <= new Date()) {
      await settleEndedEvents();
      return res.json({ success: true, message: 'Event has ended.', data: { ended: true } });
    }

    const geofence = geofenceRows[0];
    let inside = true;
    if (locationOff) {
      inside = false;
    } else if (geofence) {
      const points = geofence.shape_type !== 'circle'
        ? pointRows.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }))
        : [];
      ({ inside } = geofenceService.isInsideGeofence(parseFloat(latitude), parseFloat(longitude), { ...geofence, points }, edgeTolerance(accuracy)));
    }
    // A mock (Fake GPS) reading proves nothing about where the phone is, so
    // it counts toward leaving: turning on a spoofer after timing in can't
    // keep a session open.
    if (isMockedLocation(mocked)) inside = false;

    // Debounce: an inside ping that arrives faster than the configured
    // minimum interval only updates the live position. An OUTSIDE ping is
    // never debounced -- leaving the polygon must time the employee out the
    // moment the app reports it, not on some later ping.
    if (inside && record.last_ping_at && !locationOff) {
      const secondsSinceLast = (Date.now() - new Date(record.last_ping_at).getTime()) / 1000;
      if (secondsSinceLast < config.attendance.heartbeatMinIntervalSeconds) {
        // Too soon to run the full check again, but the app also sends
        // these the moment the employee moves, so the admin's attendance view
        // follows their live position. last_ping_at stays put so the
        // debounce timing is unchanged.
        if (!observed_at && latitude != null && longitude != null) {
          await pool.query('UPDATE attendance SET last_lat = ?, last_lng = ? WHERE id = ?', [latitude, longitude, id]);
        }
        return res.json({ success: true, message: 'Ping ignored (too soon).', data: { ended: false, inside } });
      }
    }

    const newStreak = inside ? 0 : (record.outside_streak || 0) + 1;
    const shouldAutoEnd = locationOff || newStreak >= config.attendance.autoEndOutsideStreakThreshold;

    if (shouldAutoEnd) {
      const endTime = resolveHeartbeatEndTime(observed_at, openSessionRows[0]?.time_in || record.time_in);
      await autoTimeOut({
        record,
        openSession: openSessionRows[0],
        endTime,
        latitude,
        longitude,
        outsideStreak: newStreak,
        reason: locationOff ? 'location_off' : 'left_geofence'
      });
      // The time-out is saved: the app gets its answer before the
      // log/notification writes autoTimeOut leaves running.
      return res.json({ success: true, data: { ended: true, inside, outsideStreak: newStreak, requiresFaceVerification: !!record.requires_face_verification } });
    } else {
      await pool.query(
        `UPDATE attendance SET last_lat = ?, last_lng = ?, last_ping_at = NOW(), outside_streak = ? WHERE id = ?`,
        [latitude, longitude, newStreak, id]
      );
    }

    // Keep checking for co-located devices for as long as the session is
    // open, not just at time-in — two phones carried in by one person keep
    // reporting the same position on every ping.
    let requiresFaceVerification = !!record.requires_face_verification;
    if (!shouldAutoEnd && inside) {
      const [deviceRows] = record.device_id
        ? await pool.query('SELECT device_uid FROM mobile_devices WHERE id = ?', [record.device_id])
        : [[]];
      requiresFaceVerification = await detectGeoAnomaly({
        attendanceId: record.id,
        employeeId: record.employee_id,
        eventId: record.event_id,
        deviceUid: deviceRows[0]?.device_uid,
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude)
      });
    }

    res.json({ success: true, data: { ended: shouldAutoEnd, inside, outsideStreak: newStreak, requiresFaceVerification } });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getAttendance,
  getAttendanceByDepartment,
  getAttendanceByEvent,
  submitAttendance,
  getMyHistory,
  getSessions,
  getSessionsAdmin,
  faceVerify,
  getAnomalies,
  getAnomalyRechecks,
  resolveAnomaly,
  updateAttendance,
  deleteAttendance,
  heartbeat,
  closeSilentSessions,
  recordVerificationAttendance,
  // Used by reportController/ratingController to settle ended events'
  // attendance before counting it, and to show Ongoing for running events.
  settleEndedEvents,
  DISPLAY_STATUS_SQL
};
