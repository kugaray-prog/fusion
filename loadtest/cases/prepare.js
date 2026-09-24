/**
 * Builds the isolated database and JMeter input files for the LT-01..LT-10
 * load-test cases (see loadtest/cases/README.md).
 *
 *   node loadtest/cases/prepare.js
 *
 * Env: LT_DB_HOST (localhost), LT_DB_PORT (3306), LT_DB_USER (root),
 *      LT_DB_PASSWORD (required), LT_DB_NAME (geoattend_loadtest),
 *      LT_JWT_SECRET (must match the JWT_SECRET the test server runs with).
 *
 * DROPS and recreates LT_DB_NAME every run. It refuses any name that doesn't
 * contain "loadtest", so it can't be pointed at a real database by mistake.
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(__dirname, 'data');
const DB_NAME = process.env.LT_DB_NAME || 'geoattend_loadtest';
const JWT_SECRET = process.env.LT_JWT_SECRET || 'loadtest-secret-not-for-production';

// Enrolled for the kiosk case, and the photo the kiosk then presents.
// Two different photos of the same person, so matching is realistic.
const ENROLL_IMAGE = process.env.LT_ENROLL_IMAGE || path.join(ROOT, 'uploads/faces/1790141659097-39851841.jpg');
const KIOSK_IMAGE = process.env.LT_KIOSK_IMAGE || path.join(ROOT, 'uploads/selfies/1790146978189-118820767.jpg');
const REG_IMAGE = process.env.LT_REG_IMAGE || path.join(ROOT, 'uploads/faces/1790141712364-427676953.jpg');

// CSPC, Nabua. Employees stand on a grid 0.00015 deg (~16 m) apart, wider
// than the 0.0001 deg co-location tolerance, so no two simulated phones look
// like one person carrying two devices (detectGeoAnomaly).
const CENTER = { lat: 13.4059, lng: 123.3758 };
const GRID_STEP = 0.00015;
const GEOFENCE_RADIUS_M = 1000;
const OUTSIDE = { lat: CENTER.lat + 0.02, lng: CENTER.lng + 0.02 }; // ~3 km away

// Employees per case. Every case gets its own event and its own employees,
// so results can be checked per case and no case collides with another.
const GROUPS = {
  'LT-01': 50,
  'LT-02': 150,
  'LT-04': 1500,
  'LT-05': 210, // 10 baseline + 200 spike
  'LT-06': 291,
  'LT-08': 100,
  'LT-10': 30
};
const REGISTRATIONS = 50; // LT-07: brand-new employees, not pre-seeded
const HISTORY_EVENTS = 40; // past weekly flag ceremonies, for the LT-03 reports
const DEPARTMENTS = ['Engineering Faculty', 'College of Computer Studies', 'College of Health', 'Administrative Office'];

function ipFor(n) {
  return `10.${20 + (n >> 16)}.${(n >> 8) & 255}.${n & 255}`;
}

function gridPoint(i) {
  const row = Math.floor(i / 50);
  const col = i % 50;
  return {
    lat: +(CENTER.lat + (row - 25) * GRID_STEP).toFixed(7),
    lng: +(CENTER.lng + (col - 25) * GRID_STEP).toFixed(7)
  };
}

function randomUnitVector(dim) {
  const v = Array.from({ length: dim }, () => Math.random() * 2 - 1);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

function writeCsv(name, header, rows) {
  const lines = [header.join(','), ...rows.map((r) => header.map((h) => r[h]).join(','))];
  fs.writeFileSync(path.join(DATA_DIR, name), lines.join('\n') + '\n');
}

async function insertChunked(conn, sqlPrefix, rows, chunk = 500) {
  for (let i = 0; i < rows.length; i += chunk) {
    await conn.query(sqlPrefix, [rows.slice(i, i + chunk)]);
  }
}

async function main() {
  if (!DB_NAME.includes('loadtest')) throw new Error(`Refusing to use database "${DB_NAME}": name must contain "loadtest".`);
  if (!process.env.LT_DB_PASSWORD) throw new Error('Set LT_DB_PASSWORD (local MySQL password).');
  for (const img of [ENROLL_IMAGE, KIOSK_IMAGE, REG_IMAGE]) {
    if (!fs.existsSync(img)) throw new Error(`Face image not found: ${img} (override with LT_*_IMAGE).`);
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const base = {
    host: process.env.LT_DB_HOST || 'localhost',
    port: Number(process.env.LT_DB_PORT || 3306),
    user: process.env.LT_DB_USER || 'root',
    password: process.env.LT_DB_PASSWORD,
    multipleStatements: true,
    dateStrings: true
  };

  const admin = await mysql.createConnection(base);
  await admin.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
  await admin.query(`CREATE DATABASE \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.end();

  const conn = await mysql.createConnection({ ...base, database: DB_NAME });
  await conn.query("SET time_zone = '+08:00'"); // same as config/db.js
  const schema = fs.readFileSync(path.join(ROOT, 'database/schema.sql'), 'utf8')
    .replace(/CREATE DATABASE IF NOT EXISTS geoattend_pro[^;]*;/i, '')
    .replace(/USE geoattend_pro;/i, '');
  await conn.query(schema);
  console.log('Schema loaded into', DB_NAME);

  // Departments + admin
  for (const d of DEPARTMENTS) await conn.query('INSERT INTO departments (name, office) VALUES (?, ?)', [d, d]);
  const [deptRows] = await conn.query('SELECT id FROM departments ORDER BY id');
  const deptIds = deptRows.map((r) => r.id);
  const [adminRes] = await conn.query(
    `INSERT INTO admin_accounts (full_name, email, password_hash, role) VALUES ('Load Test Admin', 'admin@loadtest.local', ?, 'super_admin')`,
    [await bcrypt.hash('LoadTest#2026', 10)]
  );
  const adminToken = jwt.sign(
    { id: adminRes.insertId, email: 'admin@loadtest.local', role: 'super_admin', name: 'Load Test Admin' },
    JWT_SECRET,
    { expiresIn: '12h' }
  );

  // One ongoing event + circle geofence per case (open from 5 min ago for 8 h)
  const eventIds = {};
  for (const c of ['LT-01', 'LT-02', 'LT-04', 'LT-05', 'LT-06', 'LT-08', 'LT-09', 'LT-10']) {
    const [ev] = await conn.query(
      `INSERT INTO events (title, venue, start_datetime, end_datetime)
       VALUES (?, 'CSPC Grounds', NOW() - INTERVAL 5 MINUTE, NOW() + INTERVAL 8 HOUR)`,
      [`${c} Flag Ceremony (load test)`]
    );
    await conn.query(
      `INSERT INTO geofences (event_id, title, venue, shape_type, center_lat, center_lng, radius_meters)
       VALUES (?, ?, 'CSPC Grounds', 'circle', ?, ?, ?)`,
      [ev.insertId, `${c} geofence`, CENTER.lat, CENTER.lng, GEOFENCE_RADIUS_M]
    );
    eventIds[c] = ev.insertId;
  }

  // Employees + approved devices
  const employees = {};
  let n = 0;
  for (const [c, count] of Object.entries(GROUPS)) {
    const rows = [];
    for (let k = 0; k < count; k++, n++) {
      const code = `${c.replace('-', '')}-${String(k + 1).padStart(4, '0')}`;
      rows.push({ n, code, dept: deptIds[n % deptIds.length], ...gridPoint(n) });
    }
    await insertChunked(
      conn,
      `INSERT INTO employees (employee_code, full_name, surname, given_name, department_id, office, position, gender, classification, email, password_hash, status, remark) VALUES ?`,
      rows.map((r) => [r.code, `Test Employee ${r.code}`, 'Employee', `Test ${r.code}`, r.dept, 'Load Test', 'Instructor I', n % 2 ? 'Male' : 'Female', 'Permanent Academic', `${r.code.toLowerCase()}@loadtest.local`, 'x', 'Full-time', 'Active'])
    );
    const [idRows] = await conn.query('SELECT id, employee_code FROM employees WHERE employee_code LIKE ?', [`${c.replace('-', '')}-%`]);
    const idByCode = Object.fromEntries(idRows.map((r) => [r.employee_code, r.id]));
    rows.forEach((r) => { r.id = idByCode[r.code]; r.device_uid = `lt-dev-${r.code.toLowerCase()}`; });
    await insertChunked(
      conn,
      `INSERT INTO mobile_devices (employee_id, device_uid, model, brand, os, status) VALUES ?`,
      rows.map((r) => [r.id, r.device_uid, 'LoadTest Phone', 'JMeter', 'Android 14', 'approved'])
    );
    employees[c] = rows;
  }
  console.log(`Seeded ${n} employees with approved devices.`);

  const tokenFor = (r) => jwt.sign({ id: r.id, employee_code: r.code, type: 'employee' }, JWT_SECRET, { expiresIn: '12h' });
  const attendanceRow = (c) => (r) => ({
    employee_id: r.id, device_uid: r.device_uid, token: tokenFor(r), ip: ipFor(r.n), lat: r.lat, lng: r.lng, event_id: eventIds[c]
  });
  const ATT_HEADER = ['employee_id', 'device_uid', 'token', 'ip', 'lat', 'lng', 'event_id'];
  for (const c of ['LT-01', 'LT-02', 'LT-04', 'LT-06', 'LT-10']) writeCsv(`${c}.csv`, ATT_HEADER, employees[c].map(attendanceRow(c)));
  writeCsv('LT-05-baseline.csv', ATT_HEADER, employees['LT-05'].slice(0, 10).map(attendanceRow('LT-05')));
  writeCsv('LT-05-spike.csv', ATT_HEADER, employees['LT-05'].slice(10).map(attendanceRow('LT-05')));

  // LT-08: 100 sessions already open (checked in just now), ready for heartbeats
  const hbRows = [];
  for (const r of employees['LT-08']) {
    const [dev] = await conn.query('SELECT id FROM mobile_devices WHERE device_uid = ?', [r.device_uid]);
    const [geo] = await conn.query('SELECT id FROM geofences WHERE event_id = ?', [eventIds['LT-08']]);
    const [att] = await conn.query(
      `INSERT INTO attendance (employee_id, event_id, geofence_id, device_id, attendance_date, time_in, latitude, longitude, accuracy_meters, attendance_status, verification_status)
       VALUES (?, ?, ?, ?, CURDATE(), NOW(), ?, ?, 10, 'Present', 'Verified')`,
      [r.id, eventIds['LT-08'], geo[0].id, dev[0].id, r.lat, r.lng]
    );
    await conn.query(
      `INSERT INTO attendance_sessions (attendance_id, employee_id, time_in, in_latitude, in_longitude) VALUES (?, ?, NOW(), ?, ?)`,
      [att.insertId, r.id, r.lat, r.lng]
    );
    hbRows.push({ attendance_id: att.insertId, token: tokenFor(r), ip: ipFor(r.n), lat: r.lat, lng: r.lng, out_lat: OUTSIDE.lat, out_lng: OUTSIDE.lng });
  }
  writeCsv('LT-08.csv', ['attendance_id', 'token', 'ip', 'lat', 'lng', 'out_lat', 'out_lng'], hbRows);

  // LT-07: 50 brand-new employees registering their device + face
  const regRows = [];
  for (let k = 0; k < REGISTRATIONS; k++, n++) {
    const code = `LT07-${String(k + 1).padStart(4, '0')}`;
    const email = `${code.toLowerCase()}@loadtest.local`;
    regRows.push({
      employee_code: code,
      surname: 'Registrant',
      given_name: `New${k + 1}`,
      device_uid: `lt-dev-${code.toLowerCase()}`,
      pending_token: jwt.sign({ type: 'google_pending', email, given_name: `New${k + 1}`, family_name: 'Registrant' }, JWT_SECRET, { expiresIn: '12h' }),
      ip: ipFor(n)
    });
  }
  writeCsv('LT-07.csv', ['employee_code', 'surname', 'given_name', 'device_uid', 'pending_token', 'ip'], regRows);

  // LT-03 history: 40 past weekly flag ceremonies attended by the LT-06 population
  const population = employees['LT-06'];
  const statuses = ['Present', 'Present', 'Present', 'Present', 'Late', 'Late', 'Absent', 'Excused'];
  let historyRows = 0;
  for (let w = HISTORY_EVENTS; w >= 1; w--) {
    const [ev] = await conn.query(
      `INSERT INTO events (title, venue, start_datetime, end_datetime)
       VALUES (?, 'CSPC Grounds', DATE(NOW()) - INTERVAL ? WEEK + INTERVAL 7 HOUR, DATE(NOW()) - INTERVAL ? WEEK + INTERVAL 8 HOUR)`,
      [`Weekly Flag Ceremony (history ${w})`, w, w]
    );
    const rows = population.map((r, i) => {
      const status = statuses[(i * 7 + w) % statuses.length];
      const late = status === 'Late' ? 5 + ((i + w) % 20) : 0;
      return [r.id, ev.insertId, `${w}`, status, late];
    });
    await insertChunked(
      conn,
      `INSERT INTO attendance (employee_id, event_id, attendance_date, time_in, time_out, attendance_status, verification_status, late_minutes, work_hours, total_duration_seconds) VALUES ?`,
      rows.map(([empId, evId, wk, status, late]) => {
        const day = new Date(Date.now() - Number(wk) * 7 * 86400000);
        const d = day.toISOString().slice(0, 10);
        const timeIn = status === 'Absent' ? null : `${d} 07:${String(late).padStart(2, '0')}:00`;
        const timeOut = status === 'Absent' ? null : `${d} 08:00:00`;
        return [empId, evId, d, timeIn, timeOut, status, 'Verified', late, status === 'Absent' ? 0 : 1, status === 'Absent' ? 0 : 3600];
      })
    );
    historyRows += rows.length;
  }
  console.log(`Seeded ${historyRows} historical attendance rows over ${HISTORY_EVENTS} past events.`);

  // LT-09: 291 enrolled faces (1 real, the rest random 512-d vectors) so the
  // kiosk compares every photo against a full-size roster.
  const faceService = require(path.join(ROOT, 'services/faceService'));
  const realEmbedding = await faceService.getEmbedding(ENROLL_IMAGE);
  const faceRows = population.map((r, i) => [
    r.id, `/uploads/faces/loadtest-${r.code}.jpg`, JSON.stringify(i === 0 ? realEmbedding : randomUnitVector(realEmbedding.length)), 'loadtest'
  ]);
  await insertChunked(conn, 'INSERT INTO employee_faces (employee_id, image_path, embedding, model_name) VALUES ?', faceRows, 100);
  console.log(`Enrolled ${faceRows.length} faces (kiosk photo should match ${population[0].code}).`);

  fs.writeFileSync(path.join(DATA_DIR, 'run.properties'), [
    `DATA_DIR=${DATA_DIR.replace(/\\/g, '/')}`,
    `ADMIN_TOKEN=${adminToken}`,
    `KIOSK_EVENT_ID=${eventIds['LT-09']}`,
    `KIOSK_IMAGE=${KIOSK_IMAGE.replace(/\\/g, '/')}`,
    `REG_IMAGE=${REG_IMAGE.replace(/\\/g, '/')}`
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(DATA_DIR, 'expected.json'), JSON.stringify({
    db: DB_NAME, eventIds, groups: GROUPS, registrations: REGISTRATIONS, kioskEmployeeCode: population[0].code
  }, null, 2));

  await conn.end();
  console.log(`Wrote JMeter inputs to ${DATA_DIR}`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
