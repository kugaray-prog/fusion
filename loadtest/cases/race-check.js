/**
 * Double-tap race check (supplements LT-05 / LT-10): each employee sends the
 * SAME attendance submission twice at the same instant. submitAttendance()
 * checks "already recorded?" and then inserts, with no unique key on
 * (employee_id, event_id, attendance_date) behind it, so two requests that
 * both pass the check before either inserts would create a duplicate row.
 *
 *   node loadtest/cases/race-check.js [pairs=50] [port=3200]
 *
 * Creates its own event (reusing LT-01's employees, tokens and devices) so it
 * doesn't disturb any other case's numbers. Uses the LT_DB_* env vars.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const mysql = require('mysql2/promise');

const pairs = Number(process.argv[2] || 50);
const port = Number(process.argv[3] || 3200);
const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'expected.json'), 'utf8'));
const rows = fs.readFileSync(path.join(__dirname, 'data', 'LT-01.csv'), 'utf8').trim().split('\n').slice(1)
  .map((l) => l.split(','))
  .map(([employee_id, device_uid, token, ip, lat, lng]) => ({ employee_id, device_uid, token, ip, lat, lng }));

function post(body, token, ip) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: 'localhost', port, path: '/api/attendance/submit', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: `Bearer ${token}`, 'CF-Connecting-IP': ip }
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', () => resolve(-1));
    req.end(data);
  });
}

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.LT_DB_HOST || 'localhost', user: process.env.LT_DB_USER || 'root',
    password: process.env.LT_DB_PASSWORD, database: expected.db
  });
  await conn.query("SET time_zone = '+08:00'");
  const [ev] = await conn.query(
    "INSERT INTO events (title, venue, start_datetime, end_datetime) VALUES ('Race check (load test)', 'CSPC Grounds', NOW() - INTERVAL 5 MINUTE, NOW() + INTERVAL 8 HOUR)");
  const [[g]] = await conn.query('SELECT center_lat, center_lng, radius_meters FROM geofences WHERE event_id = ?', [expected.eventIds['LT-01']]);
  await conn.query(
    "INSERT INTO geofences (event_id, title, venue, shape_type, center_lat, center_lng, radius_meters) VALUES (?, 'Race check geofence', 'CSPC Grounds', 'circle', ?, ?, ?)",
    [ev.insertId, g.center_lat, g.center_lng, g.radius_meters]);

  const statuses = await Promise.all(rows.slice(0, pairs).flatMap((r) => {
    const body = { employee_id: Number(r.employee_id), device_uid: r.device_uid, event_id: ev.insertId, latitude: Number(r.lat), longitude: Number(r.lng), accuracy: 12 };
    return [post(body, r.token, r.ip), post(body, r.token, r.ip)];
  }));
  const counts = statuses.reduce((m, s) => ({ ...m, [s]: (m[s] || 0) + 1 }), {});

  const [[summary]] = await conn.query(
    'SELECT COUNT(*) AS attendance_rows, COUNT(DISTINCT employee_id) AS employees FROM attendance WHERE event_id = ?', [ev.insertId]);
  const [dupes] = await conn.query(
    'SELECT employee_id, COUNT(*) AS n FROM attendance WHERE event_id = ? GROUP BY employee_id HAVING n > 1', [ev.insertId]);
  const [[sessions]] = await conn.query(
    'SELECT COUNT(*) AS n FROM attendance_sessions s JOIN attendance a ON a.id = s.attendance_id WHERE a.event_id = ?', [ev.insertId]);
  await conn.end();

  console.log(JSON.stringify({
    pairs, requests: statuses.length, response_codes: counts,
    attendance_rows: summary.attendance_rows, employees: summary.employees, sessions: sessions.n,
    employees_with_duplicate_rows: dupes.length,
    pass: dupes.length === 0 && summary.attendance_rows === pairs
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
