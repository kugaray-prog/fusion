const pool = require('../config/db');

// Who an event expects to attend. The admin can narrow an event (Geo-Fences
// form, "Required Attendees") to chosen offices and/or individual employees,
// stored in event_attendee_departments / event_attendee_employees. An event
// with no rows in either table keeps the old rule: everyone in the event's
// department, or every employee when it isn't department-specific.
//
// Only expected employees are counted Absent when they don't show up
// (attendance placeholders, ratings, reports), see the event in the mobile
// app, can time in to it, and get its new-event push.

// Map of eventId -> { departmentIds: Set, employeeIds: Set } for the events
// that have a chosen audience. Events missing from the map are open to all.
async function loadAudiences(eventIds, conn = pool) {
  const audiences = new Map();
  if (!eventIds.length) return audiences;
  const [[deptRows], [empRows]] = await Promise.all([
    conn.query('SELECT event_id, department_id FROM event_attendee_departments WHERE event_id IN (?)', [eventIds]),
    conn.query('SELECT event_id, employee_id FROM event_attendee_employees WHERE event_id IN (?)', [eventIds])
  ]);
  const entry = (eventId) => {
    if (!audiences.has(eventId)) audiences.set(eventId, { departmentIds: new Set(), employeeIds: new Set() });
    return audiences.get(eventId);
  };
  for (const r of deptRows) entry(r.event_id).departmentIds.add(r.department_id);
  for (const r of empRows) entry(r.event_id).employeeIds.add(r.employee_id);
  return audiences;
}

// Whether `emp` ({ id, department_id }) is in the event's audience, ignoring
// leave status. `audience` is the event's entry from loadAudiences, if any.
function inAudience(emp, event, audience) {
  if (audience) return audience.departmentIds.has(emp.department_id) || audience.employeeIds.has(emp.id);
  return !event.department_id || emp.department_id === event.department_id;
}

// Whether `emp` ({ id, department_id, remark }) is expected at the event:
// in its audience and not on leave. Callers pass approved employees only.
function isExpected(emp, event, audience) {
  return emp.remark === 'Active' && inAudience(emp, event, audience);
}

// Approved employee ids in the event's audience. `activeOnly` (default)
// leaves out employees on leave, i.e. returns who is expected to attend.
async function audienceEmployeeIds(event, { activeOnly = true } = {}) {
  const [audiences, [employees]] = await Promise.all([
    loadAudiences([event.id]),
    pool.query('SELECT id, department_id, remark FROM employees WHERE is_approved = 1')
  ]);
  const audience = audiences.get(event.id);
  const check = activeOnly ? isExpected : inAudience;
  return employees.filter((emp) => check(emp, event, audience)).map((emp) => emp.id);
}

// Reads `attendees` from a create/update request body:
//   { mode: 'all' }                                             -> everyone
//   { mode: 'selected', department_ids: [..], employee_ids: [..] } -> only those
// Returns { departmentIds, employeeIds } (both empty = everyone), null when
// the body has no `attendees` (leave the event as it is), or { error }.
function parseAttendees(body) {
  const attendees = body && body.attendees;
  if (attendees === undefined || attendees === null) return null;
  if (attendees.mode !== 'selected') return { departmentIds: [], employeeIds: [] };
  const ids = (list) => [...new Set((Array.isArray(list) ? list : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const departmentIds = ids(attendees.department_ids);
  const employeeIds = ids(attendees.employee_ids);
  if (!departmentIds.length && !employeeIds.length) {
    return { error: 'Choose at least one office or employee who must attend, or set Required Attendees to "All employees".' };
  }
  return { departmentIds, employeeIds };
}

// Replaces the chosen audience of every event in `eventIds` (one per
// occurrence of a recurring event). Ids that no longer exist are skipped.
async function saveAudience(conn, eventIds, { departmentIds, employeeIds }) {
  if (!eventIds.length) return;
  await conn.query('DELETE FROM event_attendee_departments WHERE event_id IN (?)', [eventIds]);
  await conn.query('DELETE FROM event_attendee_employees WHERE event_id IN (?)', [eventIds]);
  if (departmentIds.length) {
    const [rows] = await conn.query('SELECT id FROM departments WHERE id IN (?)', [departmentIds]);
    if (rows.length) {
      await conn.query('INSERT INTO event_attendee_departments (event_id, department_id) VALUES ?', [
        eventIds.flatMap((eventId) => rows.map((r) => [eventId, r.id]))
      ]);
    }
  }
  if (employeeIds.length) {
    const [rows] = await conn.query('SELECT id FROM employees WHERE id IN (?)', [employeeIds]);
    if (rows.length) {
      await conn.query('INSERT INTO event_attendee_employees (event_id, employee_id) VALUES ?', [
        eventIds.flatMap((eventId) => rows.map((r) => [eventId, r.id]))
      ]);
    }
  }
}

module.exports = { loadAudiences, inAudience, isExpected, audienceEmployeeIds, parseAttendees, saveAudience };
