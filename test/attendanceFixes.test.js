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

  console.log(failures ? `\n${failures} failure(s)` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
})();
