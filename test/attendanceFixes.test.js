// Covers the fixes for duplicate events, geofence edge detection and
// attendance spoofing, without a database: config/db.js is replaced by a
// stub that answers each query from a small script.
//
// No test framework required -- run directly with:
//   node test/attendanceFixes.test.js

const path = require('path');

let failures = 0;
function check(cond, label, detail) {
  if (cond) console.log(`ok   ${label}`);
  else {
    console.error(`FAIL ${label}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ''}`);
    failures++;
  }
}

// ---- stub database -------------------------------------------------------
// handler(sql, params) returns the [rows] (or [result]) mysql2 would.
let handler = () => [[]];
const log = [];
function runQuery(sql, params) {
  log.push({ sql, params });
  return Promise.resolve(handler(sql, params));
}
const conn = {
  query: runQuery,
  beginTransaction: async () => log.push({ sql: 'BEGIN' }),
  commit: async () => log.push({ sql: 'COMMIT' }),
  rollback: async () => log.push({ sql: 'ROLLBACK' }),
  release: () => log.push({ sql: 'RELEASE' })
};
const pool = { query: runQuery, getConnection: async () => conn, pool: { on() {} } };
require.cache[path.join(__dirname, '..', 'config', 'db.js')] = {
  id: 'db', filename: 'db', loaded: true, exports: pool
};

const geofenceService = require('../services/geofenceService');
const geofenceController = require('../controllers/geofenceController');
const attendanceController = require('../controllers/attendanceController');
const attendanceRoutes = require('../routes/attendanceRoutes');

function call(fn, { body = {}, params = {}, employee, admin = { id: 1 } } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(data) { resolve({ status: this.statusCode, data }); return this; }
    };
    fn({ body, params, employee, admin, ip: '127.0.0.1', headers: {} }, res, (err) => resolve({ status: 500, err }));
  });
}

// A square around CSPC, ~111 m on each side.
const SQUARE = [
  { lat: 13.4054, lng: 123.3753 }, { lat: 13.4054, lng: 123.3763 },
  { lat: 13.4064, lng: 123.3763 }, { lat: 13.4064, lng: 123.3753 }
];
const metersNorth = (m) => m / 111320;

(async () => {
  // ---- geofence edge tolerance (#3) ----------------------------------------
  const poly = { shape_type: 'polygon', points: SQUARE };
  const edgeLat = 13.4064;
  {
    const r = geofenceService.isInsideGeofence(13.4059, 123.3758, poly, 0);
    check(r.inside && r.distanceMeters === 0, 'centre of polygon is inside');
  }
  {
    const r = geofenceService.isInsideGeofence(edgeLat + metersNorth(10), 123.3758, poly, 0);
    check(!r.inside && Math.abs(r.distanceMeters - 10) <= 1, '10 m outside, no tolerance -> outside, reports ~10 m', r);
  }
  {
    const r = geofenceService.isInsideGeofence(edgeLat + metersNorth(10), 123.3758, poly, 15);
    check(r.inside, '10 m outside with 15 m accuracy -> inside');
  }
  {
    const r = geofenceService.isInsideGeofence(edgeLat + metersNorth(40), 123.3758, poly, 20);
    check(!r.inside, '40 m outside with 20 m tolerance -> still outside');
  }
  {
    const circle = { shape_type: 'circle', center_lat: 13.4059, center_lng: 123.3758, radius_meters: 50 };
    const r0 = geofenceService.isInsideGeofence(13.4059 + metersNorth(60), 123.3758, circle, 0);
    const r1 = geofenceService.isInsideGeofence(13.4059 + metersNorth(60), 123.3758, circle, 15);
    check(!r0.inside && Math.abs(r0.distanceMeters - 10) <= 1 && r1.inside, 'circle: 10 m past radius, inside only with tolerance', { r0, r1 });
  }

  // ---- /submit requires an employee token (#4) -----------------------------
  {
    const layer = attendanceRoutes.stack.find((l) => l.route && l.route.path === '/submit');
    const names = layer.route.stack.map((s) => s.handle.name);
    check(names[0] === 'requireEmployeeAuth', 'POST /submit runs requireEmployeeAuth first', names);
  }

  const body = { employee_id: 7, device_uid: 'dev-7', event_id: 3, latitude: 13.4059, longitude: 123.3758, accuracy: 10 };
  {
    handler = () => [[]];
    const r = await call(attendanceController.submitAttendance, { body, employee: { id: 8, type: 'employee' } });
    check(r.status === 403, "can't submit attendance for another employee", r);
  }
  {
    const r = await call(attendanceController.submitAttendance, { body: { ...body, device_uid: undefined }, employee: { id: 7 } });
    check(r.status === 400, 'device_uid is required', r);
  }
  {
    log.length = 0;
    const r = await call(attendanceController.submitAttendance, { body: { ...body, mocked: true }, employee: { id: 7 } });
    const logged = log.some((q) => /attendance_rejected/.test(q.sql) && /mock_location/.test(q.params[1]));
    check(r.status === 403 && r.data.code === 'MOCK_LOCATION' && logged, 'mock location is refused and logged', r);
  }
  {
    // Device belongs to someone else / not registered.
    handler = (sql) => (/FROM employees WHERE id/.test(sql) ? [[{ id: 7 }]] : [[]]);
    const r = await call(attendanceController.submitAttendance, { body, employee: { id: 7 } });
    check(r.status === 403 && /not registered/.test(r.data.message), 'unregistered device is refused', r);
  }

  // ---- heartbeat: a mock reading counts as outside -------------------------
  {
    handler = (sql) => {
      if (/FROM attendance WHERE id = \? AND employee_id/.test(sql)) {
        return [[{ id: 5, employee_id: 7, event_id: 3, geofence_id: 9, time_out: null, outside_streak: 0, last_ping_at: null }]];
      }
      if (/SELECT end_datetime FROM events/.test(sql)) return [[{ end_datetime: '2099-01-01 00:00:00' }]];
      if (/FROM geofences WHERE id/.test(sql)) return [[{ id: 9, shape_type: 'polygon' }]];
      if (/FROM geofence_points/.test(sql)) return [SQUARE];
      return [[]];
    };
    const r = await call(attendanceController.heartbeat, {
      params: { id: 5 }, body: { latitude: 13.4059, longitude: 123.3758, mocked: true }, employee: { id: 7 }
    });
    check(r.status === 200 && r.data.data.inside === false && r.data.data.outsideStreak === 1, 'mocked heartbeat from inside counts as outside', r.data);
  }

  // ---- heartbeat: first reading outside the polygon times out right away ---
  {
    log.length = 0;
    const observedAt = new Date(Date.now() - 2000).toISOString();
    handler = (sql) => {
      if (/FROM attendance WHERE id = \? AND employee_id/.test(sql)) {
        // pinged 2 s ago -- inside the debounce window
        return [[{ id: 5, employee_id: 7, event_id: 3, geofence_id: 9, time_in: new Date(Date.now() - 3600000), time_out: null, outside_streak: 0, last_ping_at: new Date(Date.now() - 2000) }]];
      }
      if (/SELECT end_datetime FROM events/.test(sql)) return [[{ end_datetime: '2099-01-01 00:00:00' }]];
      if (/FROM geofences WHERE id/.test(sql)) return [[{ id: 9, shape_type: 'polygon' }]];
      if (/FROM geofence_points/.test(sql)) return [SQUARE];
      if (/FROM attendance_sessions WHERE attendance_id/.test(sql)) return [[{ id: 11, time_in: new Date(Date.now() - 3600000) }]];
      if (/UPDATE attendance_sessions/.test(sql)) return [{ affectedRows: 1 }];
      return [[]];
    };
    const r = await call(attendanceController.heartbeat, {
      params: { id: 5 }, body: { latitude: 13.4064 + metersNorth(2), longitude: 123.3758, accuracy: 10, observed_at: observedAt }, employee: { id: 7 }
    });
    const closed = log.find((q) => /UPDATE attendance_sessions/.test(q.sql));
    check(r.data.data.ended === true && closed && new Date(closed.params[0]).toISOString() === observedAt,
      '2 m outside the polygon, 2 s after the last ping: timed out at the reading\'s own time', { data: r.data, closed });
  }

  // ---- duplicate / overlapping events (#6) ---------------------------------
  const future = (h) => {
    const d = new Date(Date.now() + h * 3600000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const gfBody = { title: 'Flag Ceremony', venue: 'CSPC Grounds', start: future(24), end: future(25), points: SQUARE };
  const toSql = (s) => `${s.replace('T', ' ')}:00`;

  {
    log.length = 0;
    handler = (sql) => {
      if (/GET_LOCK/.test(sql)) return [[{ got: 1 }]];
      if (/FROM events\s+WHERE start_datetime </.test(sql)) {
        return [[{ id: 1, title: 'flag ceremony ', venue: 'CSPC Grounds', start_datetime: toSql(gfBody.start), end_datetime: toSql(gfBody.end) }]];
      }
      return [[]];
    };
    const r = await call(geofenceController.createGeofence, { body: gfBody });
    const inserted = log.some((q) => /INSERT INTO events/.test(q.sql));
    const released = log.some((q) => /RELEASE_LOCK/.test(q.sql));
    check(r.status === 409 && /already exists/.test(r.data.message) && !inserted && released, 'same event twice -> 409, nothing inserted, lock released', r.data);
  }
  {
    log.length = 0;
    handler = (sql) => {
      if (/GET_LOCK/.test(sql)) return [[{ got: 1 }]];
      if (/FROM events\s+WHERE start_datetime </.test(sql)) {
        return [[{ id: 2, title: 'Faculty Meeting', venue: 'CSPC Grounds', start_datetime: toSql(future(23)), end_datetime: toSql(future(24.5)) }]];
      }
      return [[]];
    };
    const r = await call(geofenceController.createGeofence, { body: gfBody });
    check(r.status === 409 && /already booked/.test(r.data.message), 'venue already booked for an overlapping time -> 409', r.data);
  }
  {
    log.length = 0;
    let id = 100;
    handler = (sql) => {
      if (/GET_LOCK/.test(sql)) return [[{ got: 1 }]];
      if (/^\s*INSERT/.test(sql)) return [{ insertId: ++id }];
      return [[]];
    };
    const r = await call(geofenceController.createGeofence, { body: gfBody });
    const order = log.map((q) => q.sql).filter((s) => /GET_LOCK|FROM events\s+WHERE start_datetime <|BEGIN|INSERT INTO events|COMMIT|RELEASE_LOCK/.test(s))
      .map((s) => s.match(/GET_LOCK|FROM events|BEGIN|INSERT INTO events|COMMIT|RELEASE_LOCK/)[0]);
    check(r.status === 201, 'no conflict -> event created (201)', r.data || r.err);
    check(JSON.stringify(order) === JSON.stringify(['GET_LOCK', 'FROM events', 'BEGIN', 'INSERT INTO events', 'COMMIT', 'RELEASE_LOCK']),
      'lock -> check -> insert -> commit -> unlock', order);
    const q = log.find((x) => /FROM events\s+WHERE start_datetime </.test(x.sql));
    check(q.params[4] === 'flag ceremony' && q.params[7] === 'cspc grounds', 'names compared trimmed + case-insensitive', q.params);
  }
  {
    log.length = 0;
    handler = (sql) => (/GET_LOCK/.test(sql) ? [[{ got: 0 }]] : [[]]);
    const r = await call(geofenceController.createGeofence, { body: gfBody });
    check(r.status === 503 && !log.some((q) => /RELEASE_LOCK/.test(q.sql)), 'lock timeout -> 503, no stray release', r.data);
  }
  {
    log.length = 0;
    handler = (sql) => {
      if (/SELECT \* FROM geofences WHERE id/.test(sql)) return [[{ id: 9, event_id: 42 }]];
      if (/FROM events\s+WHERE start_datetime </.test(sql)) return [[]];
      return [[]];
    };
    const r = await call(geofenceController.updateGeofence, { params: { id: 9 }, body: gfBody });
    const q = log.find((x) => /FROM events\s+WHERE start_datetime </.test(x.sql));
    check(r.status === 200 && q.params[2] === 42, 'editing an event excludes itself from the conflict check', { status: r.status, params: q && q.params });
  }

  // ---- blacklisted / rejected devices are locked out ------------------------
  {
    const jwt = require('jsonwebtoken');
    const config = require('../config/config');
    const { requireEmployeeAuth } = require('../middleware/authMiddleware');
    const token = jwt.sign({ id: 7, type: 'employee' }, config.jwt.secret);
    const run = (deviceStatus, headers) => new Promise((resolve) => {
      handler = (sql) => (/FROM mobile_devices WHERE device_uid/.test(sql) ? [deviceStatus ? [{ status: deviceStatus }] : []] : [[]]);
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        json(data) { resolve({ status: this.statusCode, data }); }
      };
      requireEmployeeAuth({ headers: { authorization: `Bearer ${token}`, ...headers } }, res, () => resolve({ status: 'next' }));
    });
    const blacklisted = await run('blacklisted', { 'x-device-uid': 'dev-7' });
    check(blacklisted.status === 403 && blacklisted.data.code === 'DEVICE_BLOCKED', 'signed-in request from a blacklisted device is refused', blacklisted);
    const rejected = await run('rejected', { 'x-device-uid': 'dev-7' });
    check(rejected.status === 403 && rejected.data.deviceStatus === 'rejected', 'rejected device is refused too', rejected);
    check((await run('approved', { 'x-device-uid': 'dev-7' })).status === 'next', 'approved device passes');
    check((await run('pending', { 'x-device-uid': 'dev-7' })).status === 'next', 'pending device passes (held on approval screen)');
    check((await run(null, {})).status === 'next', 'no device header (older app) passes');
  }
  {
    const deviceController = require('../controllers/deviceController');
    log.length = 0;
    handler = (sql) => (/SELECT employee_id, status, model FROM mobile_devices/.test(sql) ? [[{ employee_id: 7, status: 'approved' }]] : [[]]);
    const r = await call(deviceController.updateDeviceStatus, { params: { id: 3 }, body: { status: 'blacklisted' } });
    const notif = log.find((q) => /INSERT INTO notifications/.test(q.sql));
    check(r.status === 200 && notif && notif.params[0] === 7 && notif.params[1] === 'Device Blacklisted', 'blacklisting notifies the employee', { r: r.data, notif });
  }

  // ---- new registrations wait for approval; devices can be deleted ---------
  {
    const jwt = require('jsonwebtoken');
    const config = require('../config/config');
    const { requireEmployeeAuth } = require('../middleware/authMiddleware');
    const token = jwt.sign({ id: 7, type: 'employee' }, config.jwt.secret);
    handler = () => [[]]; // device row gone
    const r = await new Promise((resolve) => {
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(data) { resolve({ status: this.statusCode, data }); } };
      requireEmployeeAuth({ headers: { authorization: `Bearer ${token}`, 'x-device-uid': 'dev-7' } }, res, () => resolve({ status: 'next' }));
    });
    check(r.status === 403 && r.data.deviceStatus === 'removed', 'signed-in phone whose device was deleted is signed out', r);

    const deviceRoutes = require('../routes/deviceRoutes');
    const reg = deviceRoutes.stack.find((l) => l.route && l.route.path === '/register');
    check(reg.route.stack[0].handle.name === 'requireEmployeeAuth', 'device self-registration requires a signed-in employee');
    const del = deviceRoutes.stack.find((l) => l.route && l.route.path === '/:id' && l.route.methods.delete);
    check(!!del, 'DELETE /api/devices/:id exists');
  }
  {
    const deviceController = require('../controllers/deviceController');
    const run = async (isApproved, remaining) => {
      log.length = 0;
      handler = (sql) => {
        if (/FROM mobile_devices md JOIN employees e/.test(sql)) return [[{ id: 3, employee_id: 7, device_uid: 'dev-7', is_approved: isApproved, employee_code: 'E7' }]];
        if (/COUNT\(\*\) AS remaining/.test(sql)) return [[{ remaining }]];
        return [{ affectedRows: 1 }];
      };
      const r = await call(deviceController.deleteDevice, { params: { id: 3 } });
      return { r, deletedEmployee: log.some((q) => /DELETE FROM employees/.test(q.sql)), deletedDevice: log.some((q) => /DELETE FROM mobile_devices/.test(q.sql)) };
    };
    const pending = await run(0, 0);
    check(pending.r.status === 200 && pending.deletedDevice && pending.deletedEmployee, 'deleting a new registration\'s only device removes the pending employee', pending);
    const approved = await run(1, 0);
    check(approved.r.status === 200 && approved.deletedDevice && !approved.deletedEmployee, 'deleting an accepted employee\'s device keeps the employee', approved);

    log.length = 0;
    handler = (sql) => (/SELECT employee_id, status, model FROM mobile_devices/.test(sql) ? [[{ employee_id: 7, status: 'pending' }]] : [[]]);
    await call(deviceController.updateDeviceStatus, { params: { id: 3 }, body: { status: 'approved' } });
    check(log.some((q) => /UPDATE employees SET is_approved = 1/.test(q.sql) && q.params[0] === 7), 'approving the device accepts the employee');

    const employeeController = require('../controllers/employeeController');
    log.length = 0;
    handler = (sql) => (/COUNT\(\*\) AS total/.test(sql) ? [[{ total: 0 }]] : [[]]);
    await call(employeeController.getEmployees, {});
    check(log.every((q) => !/FROM employees e/.test(q.sql) || /e\.is_approved = 1/.test(q.sql)), 'Employees list hides pending registrations');
  }

  // ---- every mobile face-verification photo is recorded ----------------------
  {
    const faceService = require('../services/faceService');
    const origEmb = faceService.getEmbedding;
    const origMatch = faceService.findBestMatch;
    const run = async (outcome) => {
      faceService.getEmbedding = async () => { if (outcome === 'no_face') throw new Error('No face was detected'); return [1, 0]; };
      faceService.findBestMatch = () => (outcome === 'matched' ? { employeeId: 7, similarity: 0.83 } : null);
      log.length = 0;
      handler = (sql) => {
        if (/SELECT \* FROM attendance WHERE id = \? AND employee_id/.test(sql)) return [[{ id: 5, employee_id: 7, event_id: 3 }]];
        if (/SELECT end_datetime FROM events/.test(sql)) return [[{ end_datetime: '2099-01-01 00:00:00' }]];
        if (/FROM employee_faces WHERE employee_id/.test(sql)) return [[{ image_path: '/uploads/faces/x.jpg', embedding: '[1,0]' }]];
        return [{ affectedRows: 1 }];
      };
      const r = await call(attendanceController.faceVerify, {
        params: { id: 5 }, employee: { id: 7 },
        body: { liveness_verified: 'true', liveness_actions: 'hold,blink' }
      });
      const rec = log.find((q) => /INSERT INTO face_records/.test(q.sql));
      return { r, rec };
    };
    // call() doesn't pass req.file; add it through a wrapper.
    const withFile = attendanceController.faceVerify;
    attendanceController.faceVerify = (req, res, next) => withFile({ ...req, files: { selfie: [{ filename: 'selfie-1.jpg', path: '/tmp/selfie-1.jpg' }] } }, res, next);
    const noMatch = await run('no_match');
    check(noMatch.r.status === 401 && noMatch.rec && noMatch.rec.params[1] === '/uploads/selfies/selfie-1.jpg' && noMatch.rec.params[3] === 'no_match' && /mobile_anomaly/.test(noMatch.rec.sql),
      'failed mobile face verification keeps its photo on record', noMatch.rec);
    const matched = await run('matched');
    check(matched.r.status === 200 && matched.rec && matched.rec.params[3] === 'matched' && Math.round(matched.rec.params[2]) === 83,
      'successful mobile face verification is recorded with its photo', matched.rec);
    const noFace = await run('no_face');
    check(noFace.r.status === 502 && noFace.rec && noFace.rec.params[3] === 'no_face_detected', 'photo with no face detected is recorded too', noFace.rec);
    attendanceController.faceVerify = withFile;
    faceService.getEmbedding = origEmb;
    faceService.findBestMatch = origMatch;
  }

  // ---- geo-anomaly: flagged only when two phones STAY together ------------
  // Phones ping every few seconds on a fake clock. Each scenario uses its
  // own pair of attendance ids, and the clock jumps ahead between scenarios
  // so earlier readings have expired.
  {
    const cfg = require('../config/config').attendance;
    const MAX_M = cfg.anomalyDistanceMeters;
    const HERE = { lat: 13.4059, lng: 123.3758 };
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    // Per-record stub state: verifiedAgo[id], flagged[id]; lostRace for all.
    let state;
    const ping = async (id, meters, { accuracy = 5 } = {}) => {
      handler = (sql, params) => {
        if (/SET requires_face_verification = 1/.test(sql)) {
          if (state.lostRace) return [{ affectedRows: 0 }];
          state.flagged[params[1]] = 1;
          return [{ affectedRows: 1 }];
        }
        if (/FROM attendance WHERE id = \? AND employee_id/.test(sql)) {
          return [[{ id, employee_id: id + 100, event_id: 3, geofence_id: 9, device_id: 1, time_out: null, outside_streak: 0, last_ping_at: null, requires_face_verification: state.flagged[id] || 0 }]];
        }
        if (/SELECT end_datetime FROM events/.test(sql)) return [[{ end_datetime: '2099-01-01 00:00:00' }]];
        if (/FROM geofences WHERE id/.test(sql)) return [[{ id: 9, shape_type: 'polygon' }]];
        if (/FROM geofence_points/.test(sql)) return [SQUARE];
        if (/SELECT device_uid FROM mobile_devices/.test(sql)) return [[{ device_uid: `dev-${id}` }]];
        if (/verified_ago_s FROM attendance WHERE id/.test(sql)) {
          return [[{ requires_face_verification: state.flagged[id] || 0, verified_ago_s: state.verifiedAgo[id] ?? null }]];
        }
        if (/LEFT JOIN mobile_devices md/.test(sql)) {
          return [params[0].map((other) => ({
            id: other, employee_id: other + 100, requires_face_verification: state.flagged[other] || 0,
            verified_ago_s: state.verifiedAgo[other] ?? null, device_uid: `dev-${other}`
          }))];
        }
        if (/SELECT title FROM events/.test(sql)) return [[{ title: 'Flag Ceremony' }]];
        return [[]];
      };
      const r = await call(attendanceController.heartbeat, {
        params: { id }, body: { latitude: HERE.lat + metersNorth(meters), longitude: HERE.lng, accuracy }, employee: { id: id + 100 }
      });
      return r.data.data.requiresFaceVerification;
    };
    // Phones a and b ping 1 s apart every 3 s for `seconds`. `apart(t)` is
    // b's distance north of a at second t. Returns when the first flag was
    // logged (seconds in, or null), who was flagged, and a's last answer.
    const scenario = async (a, b, seconds, apart, opts = {}) => {
      clock += 10 * 60 * 1000;
      state = { verifiedAgo: opts.verifiedAgo || {}, flagged: {}, lostRace: !!opts.lostRace };
      log.length = 0;
      let firstFlagAt = null;
      let lastA = null;
      for (let t = 0; t <= seconds; t += 3) {
        clock += 2000;
        lastA = await ping(a, 0, opts);
        clock += 1000;
        await ping(b, apart(t), opts);
        if (firstFlagAt == null && log.some((q) => /INSERT INTO geo_anomalies/.test(q.sql))) firstFlagAt = t;
      }
      const flagged = log.filter((q) => /INSERT INTO geo_anomalies/.test(q.sql)).map((q) => q.params[0]);
      return { firstFlagAt, flagged, lastA };
    };
    const SUSTAIN = cfg.anomalySustainSeconds;

    let s = await scenario(5, 6, 9, () => 0.3);
    check(s.flagged.length === 0 && s.lastA === false, 'phones 0.3 m apart for a few seconds: not flagged yet', s);
    s = await scenario(7, 8, SUSTAIN + 15, () => 0.3);
    check(s.flagged.includes(7) && s.flagged.includes(8) && s.firstFlagAt >= SUSTAIN && s.lastA === true,
      `phones 0.3 m apart for ${SUSTAIN}+ s: both flagged, not before`, s);
    s = await scenario(9, 10, SUSTAIN * 3, () => MAX_M + 0.5);
    check(s.flagged.length === 0, `phones ${MAX_M + 0.5} m apart the whole time: not flagged`, s);
    // 3 m apart, but GPS jitter puts every third reading on top of each other.
    s = await scenario(11, 12, SUSTAIN * 5, (t) => (t % 9 === 0 ? 0.1 : 3));
    check(s.flagged.length === 0, '3 m apart with occasional jitter coincidences: never flagged', s);
    // Indoor Wi-Fi fixes give both phones the same coordinates, ±20 m.
    s = await scenario(13, 14, SUSTAIN * 3, () => 0, { accuracy: 20 });
    check(s.flagged.length === 0, 'identical but coarse (20 m accuracy) fixes: ignored', s);
    s = await scenario(15, 16, SUSTAIN + 15, () => 0.3, { verifiedAgo: { 15: 10, 16: 10 } });
    check(s.flagged.length === 0 && s.lastA === false, 'verified 10 s ago, still together: not asked again yet', s);
    s = await scenario(17, 18, SUSTAIN + 15, () => 0.3, { verifiedAgo: { 17: 31, 18: 31 } });
    check(s.flagged.includes(17) && s.lastA === true, 'verified 31 s ago, still together: asked again', s);
    s = await scenario(19, 20, SUSTAIN + 15, () => 0.3, { verifiedAgo: { 20: 5 } });
    check(s.flagged.includes(19) && !s.flagged.includes(20), 'the other phone verified 5 s ago keeps its own 30 s', s);
    s = await scenario(21, 22, SUSTAIN + 15, () => 0.3, { lostRace: true });
    check(s.lastA === true && s.flagged.length === 0, 'both phones pinging at once: the second flag is not logged or notified twice', s);
    // Already flagged: reported again on the very first ping, nothing re-logged.
    clock += 10 * 60 * 1000;
    state = { verifiedAgo: {}, flagged: { 23: 1 }, lostRace: false };
    log.length = 0;
    const again = await ping(23, 0);
    check(again === true && !log.some((q) => /INSERT INTO geo_anomalies/.test(q.sql)), 'already flagged: reported again, not re-logged', again);

    Date.now = realNow;
  }

  console.log(failures ? `\n${failures} failure(s)` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
})();
