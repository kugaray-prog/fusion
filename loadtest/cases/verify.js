/**
 * Checks the database after a load-test case: were all records written,
 * exactly once, with nothing lost or duplicated.
 *
 *   node loadtest/cases/verify.js LT-01
 *
 * Uses the same LT_DB_* env vars as prepare.js. Prints one JSON object.
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const caseId = process.argv[2];
const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'expected.json'), 'utf8'));

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.LT_DB_HOST || 'localhost',
    port: Number(process.env.LT_DB_PORT || 3306),
    user: process.env.LT_DB_USER || 'root',
    password: process.env.LT_DB_PASSWORD,
    database: expected.db
  });
  const one = async (sql, params) => (await conn.query(sql, params))[0][0];
  const all = async (sql, params) => (await conn.query(sql, params))[0];

  const out = { case: caseId };
  const eventId = expected.eventIds[caseId];
  const codePrefix = `${caseId.replace('-', '')}-%`;

  if (['LT-01', 'LT-02', 'LT-04', 'LT-05', 'LT-06', 'LT-10'].includes(caseId)) {
    out.expected_employees = expected.groups[caseId];
    Object.assign(out, await one(
      `SELECT COUNT(*) AS attendance_rows, COUNT(DISTINCT employee_id) AS employees_recorded,
              SUM(requires_face_verification) AS flagged_for_face_check
       FROM attendance WHERE event_id = ?`, [eventId]));
    out.employees_with_duplicate_rows = (await all(
      'SELECT employee_id FROM attendance WHERE event_id = ? GROUP BY employee_id HAVING COUNT(*) > 1', [eventId])).length;
    out.employees_missing = (await one(
      `SELECT COUNT(*) AS n FROM employees e
       WHERE e.employee_code LIKE ? AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.employee_id = e.id AND a.event_id = ?)`,
      [codePrefix, eventId])).n;
    out.open_sessions = (await one(
      `SELECT COUNT(*) AS n FROM attendance_sessions s JOIN attendance a ON a.id = s.attendance_id
       WHERE a.event_id = ? AND s.time_out IS NULL`, [eventId])).n;
    out.attendance_rows_without_session = (await one(
      `SELECT COUNT(*) AS n FROM attendance a WHERE a.event_id = ?
       AND NOT EXISTS (SELECT 1 FROM attendance_sessions s WHERE s.attendance_id = a.id)`, [eventId])).n;
    out.pass = out.employees_recorded === out.expected_employees && out.attendance_rows === out.expected_employees &&
      out.employees_with_duplicate_rows === 0 && out.employees_missing === 0 && Number(out.flagged_for_face_check || 0) === 0 &&
      out.attendance_rows_without_session === 0;
  } else if (caseId === 'LT-07') {
    out.expected_registrations = expected.registrations;
    out.employees_created = (await one("SELECT COUNT(*) AS n FROM employees WHERE employee_code LIKE 'LT07-%'")).n;
    out.devices_registered = (await one(
      "SELECT COUNT(*) AS n FROM mobile_devices d JOIN employees e ON e.id = d.employee_id WHERE e.employee_code LIKE 'LT07-%'")).n;
    out.devices_pending_approval = (await one(
      "SELECT COUNT(*) AS n FROM mobile_devices d JOIN employees e ON e.id = d.employee_id WHERE e.employee_code LIKE 'LT07-%' AND d.status = 'pending'")).n;
    out.faces_enrolled = (await one(
      "SELECT COUNT(*) AS n FROM employee_faces f JOIN employees e ON e.id = f.employee_id WHERE e.employee_code LIKE 'LT07-%'")).n;
    out.employees_with_multiple_faces = (await all(
      "SELECT f.employee_id FROM employee_faces f JOIN employees e ON e.id = f.employee_id WHERE e.employee_code LIKE 'LT07-%' GROUP BY f.employee_id HAVING COUNT(*) > 1")).length;
    out.pass = [out.employees_created, out.devices_registered, out.faces_enrolled].every((n) => n === expected.registrations) &&
      out.employees_with_multiple_faces === 0;
  } else if (caseId === 'LT-08') {
    out.expected_sessions = expected.groups['LT-08'];
    Object.assign(out, await one(
      `SELECT COUNT(*) AS attendance_rows, SUM(auto_ended = 1) AS auto_closed, SUM(time_out IS NULL) AS still_open,
              SUM(outside_streak) AS total_outside_streak
       FROM attendance WHERE event_id = ?`, [eventId]));
    out.sessions_still_open = (await one(
      `SELECT COUNT(*) AS n FROM attendance_sessions s JOIN attendance a ON a.id = s.attendance_id WHERE a.event_id = ? AND s.time_out IS NULL`, [eventId])).n;
    out.auto_time_out_logs = (await one(
      `SELECT COUNT(*) AS n FROM attendance_logs l JOIN attendance a ON a.id = l.attendance_id WHERE a.event_id = ? AND l.action = 'auto_time_out'`, [eventId])).n;
    out.sessions_closed_more_than_once = (await all(
      `SELECT l.attendance_id FROM attendance_logs l JOIN attendance a ON a.id = l.attendance_id
       WHERE a.event_id = ? AND l.action = 'auto_time_out' GROUP BY l.attendance_id HAVING COUNT(*) > 1`, [eventId])).length;
    out.flagged_for_face_check = (await one('SELECT SUM(requires_face_verification) AS n FROM attendance WHERE event_id = ?', [eventId])).n;
    out.pass = Number(out.auto_closed) === out.expected_sessions && Number(out.still_open) === 0 && out.sessions_still_open === 0 &&
      out.auto_time_out_logs === out.expected_sessions && out.sessions_closed_more_than_once === 0 && Number(out.flagged_for_face_check || 0) === 0;
  } else if (caseId === 'LT-09') {
    Object.assign(out, await one(
      `SELECT COUNT(*) AS face_checks, SUM(result = 'matched') AS matched, SUM(result <> 'matched') AS not_matched FROM face_records`));
    out.matched_employee_ok = (await one(
      `SELECT COUNT(*) AS n FROM face_records f JOIN employees e ON e.id = f.employee_id WHERE e.employee_code = ?`, [expected.kioskEmployeeCode])).n;
    Object.assign(out, await one(
      `SELECT COUNT(*) AS kiosk_attendance_rows, COUNT(DISTINCT employee_id) AS kiosk_employees FROM attendance WHERE event_id = ?`, [eventId]));
    out.pass = Number(out.not_matched) === 0 && out.kiosk_attendance_rows === 1;
  } else {
    out.note = 'No database check for this case (read-only requests).';
    out.pass = true;
  }

  await conn.end();
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
