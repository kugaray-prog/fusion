const pool = require('../config/db');
const { logAction } = require('../services/auditService');

// The employees "expected" at a given event: everyone in the event's
// department, or the entire roster when the event isn't department-scoped
// (department_id IS NULL === company-wide, e.g. a flag ceremony everyone
// must attend).
async function expectedEmployeeIdsForEvent(event) {
  const params = [];
  // Inactive/On-leave employees aren't expected anywhere — never auto-mark
  // them Absent for an event they were never going to attend.
  let where = "remark = 'Active'";
  if (event.department_id) {
    where += ' AND department_id = ?';
    params.push(event.department_id);
  }
  const [rows] = await pool.query(`SELECT id FROM employees WHERE ${where}`, params);
  return rows.map((r) => r.id);
}

// Auto-generates/refreshes employee_ratings rows for every COMPLETED event
// (its schedule has already ended) that starts within [rangeStart, rangeEnd).
// This is what makes ratings follow the actual event calendar instead of
// only Mondays: whatever days an event is scheduled on — Monday, Wednesday,
// Friday, any combination — each occurrence gets its own rating record for
// every employee expected to attend it, the moment the event ends.
//
// Rating is derived straight from the employee's attendance_status for that
// event: Present or Late = 5, Absent/Excused = 1, and an employee who never
// checked in at all (no attendance row exists) also = 1 (a genuine no-show
// is the same as an absence). Runs before every /api/ratings read — the
// same self-healing-on-read pattern attendanceController.closeSessionsForEndedEvents
// already uses — so the table is always caught up with real attendance
// without needing a cron job. An admin's manual edit (is_manual = 1) is
// never overwritten by this.
async function generateRatingsForRange(rangeStart, rangeEnd) {
  const [events] = await pool.query(
    `SELECT id, title, department_id, start_datetime, end_datetime
     FROM events
     WHERE end_datetime < NOW() AND start_datetime >= ? AND start_datetime < ?
     ORDER BY start_datetime ASC`,
    [rangeStart, rangeEnd]
  );
  if (!events.length) return events;

  for (const ev of events) {
    const employeeIds = await expectedEmployeeIdsForEvent(ev);
    if (!employeeIds.length) continue;

    const [attendanceRows] = await pool.query(
      `SELECT employee_id, attendance_status FROM attendance WHERE event_id = ?`,
      [ev.id]
    );
    const statusByEmployee = {};
    for (const r of attendanceRows) statusByEmployee[r.employee_id] = r.attendance_status;

    const ratingDate = new Date(ev.start_datetime).toISOString().slice(0, 10);

    for (const empId of employeeIds) {
      const status = statusByEmployee[empId]; // undefined = never checked in = no-show
      const rating = status === 'Present' || status === 'Late' ? 5 : 1;
      await pool.query(
        `INSERT INTO employee_ratings (employee_id, event_id, rating_date, rating, is_manual)
         VALUES (?, ?, ?, ?, 0)
         ON DUPLICATE KEY UPDATE
           rating = IF(is_manual = 0, VALUES(rating), rating),
           rating_date = VALUES(rating_date)`,
        [empId, ev.id, ratingDate, rating]
      );
    }
  }
  return events;
}

// GET /api/ratings?month=&year=&employee_id=&department=
// Returns every event that has already ENDED within the given month/year
// (any weekday — not just Mondays), plus each employee's auto-generated (or
// admin-edited) 1-5 rating for every such event they were expected to
// attend.
//
// Total Rating and Rating Points (requested formula):
//   Total Rating  = SUM of the employee's own ratings across every event
//                    applicable to them this month (their own department's
//                    events plus any company-wide ones — not a raw count of
//                    every event in the month).
//   Rating Points = Total Rating ÷ number of those rated events.
//
//   e.g. present at 3 events, rated 5 each: Total Rating = 5+5+5 = 15,
//        Rating Points = 15 ÷ 3 = 5.
//   e.g. present twice (5, 5) and absent once (1): Total Rating =
//        5+5+1 = 11, Rating Points = 11 ÷ 3 = 3.67.
//
// Note: `rating_points` here is unrelated to the employees.rating_points
// column written by attendanceController.recalculateRatingPoints() (an
// older, separate "5 attendances = 1 point" counter used elsewhere in the
// dashboard) — that column is intentionally not selected below, so this
// endpoint's own `rating_points` field can carry the meaning requested here
// without colliding with it.
async function getRatings(req, res, next) {
  try {
    const now = new Date();
    const month = Number(req.query.month) || now.getMonth() + 1;
    const year = Number(req.query.year) || now.getFullYear();
    const rangeStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const rangeEndDate = new Date(year, month, 1); // first day of next month
    const rangeEnd = rangeEndDate.toISOString().slice(0, 10);

    const employeeId = req.query.employee_id && req.query.employee_id !== 'all' ? req.query.employee_id : null;
    const department = req.query.department && req.query.department !== 'all' ? req.query.department : null;

    // Self-heal: make sure every completed event in this range has its
    // ratings generated/refreshed before we read them.
    await generateRatingsForRange(rangeStart, rangeEnd);

    const [events] = await pool.query(
      `SELECT e.id, e.title, e.venue, e.start_datetime, e.end_datetime, d.name AS department_name
       FROM events e
       LEFT JOIN departments d ON e.department_id = d.id
       WHERE e.end_datetime < NOW() AND e.start_datetime >= ? AND e.start_datetime < ?
       ORDER BY e.start_datetime ASC`,
      [rangeStart, rangeEnd]
    );

    const conditions = [];
    const params = [];
    if (employeeId) {
      conditions.push('e.id = ?');
      params.push(employeeId);
    }
    if (department) {
      conditions.push('d.name = ?');
      params.push(department);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [employees] = await pool.query(
      `SELECT e.id, e.employee_code, e.full_name, e.classification, d.name AS department_name
       FROM employees e JOIN departments d ON e.department_id = d.id
       ${where}
       ORDER BY e.full_name ASC`,
      params
    );

    let ratingRows = [];
    if (events.length) {
      const eventIds = events.map((e) => e.id);
      const [rows] = await pool.query(
        `SELECT employee_id, event_id, rating, is_manual, notes
         FROM employee_ratings WHERE event_id IN (?)`,
        [eventIds]
      );
      ratingRows = rows;
    }

    const eventById = {};
    for (const ev of events) eventById[ev.id] = ev;

    const byEmployee = {};
    for (const emp of employees) byEmployee[emp.id] = {};
    for (const r of ratingRows) {
      if (!byEmployee[r.employee_id]) byEmployee[r.employee_id] = {};
      byEmployee[r.employee_id][r.event_id] = { rating: r.rating, is_manual: !!r.is_manual, notes: r.notes };
    }

    const data = employees.map((emp) => {
      const ratings = byEmployee[emp.id] || {};
      // Chronological list of this employee's own rated events, for the
      // admin Ratings panel's per-employee event breakdown ("listahan ng
      // mga Events na pinasukan ng employee at ang rating niya sa bawat
      // event") -- each entry pairs the event with that specific rating.
      const ratedEvents = Object.entries(ratings)
        .map(([eventId, r]) => {
          const ev = eventById[eventId];
          if (!ev) return null; // shouldn't happen, but don't let a stale row crash rendering
          return {
            event_id: ev.id,
            title: ev.title,
            venue: ev.venue,
            date: new Date(ev.start_datetime).toISOString().slice(0, 10),
            rating: Number(r.rating),
            is_manual: r.is_manual
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.date.localeCompare(b.date) || a.event_id - b.event_id);

      const values = ratedEvents.map((r) => r.rating);
      const ratingCount = values.length;
      const totalRating = values.reduce((a, b) => a + b, 0);
      const ratingPoints = ratingCount ? Number((totalRating / ratingCount).toFixed(2)) : null;

      return {
        ...emp,
        ratings,
        rated_events: ratedEvents,
        rating_count: ratingCount,
        total_rating: ratingCount ? totalRating : null,
        rating_points: ratingPoints
      };
    });

    const eventsOut = events.map((e) => ({
      id: e.id,
      title: e.title,
      venue: e.venue,
      department_name: e.department_name,
      date: new Date(e.start_datetime).toISOString().slice(0, 10),
      start_datetime: e.start_datetime,
      end_datetime: e.end_datetime
    }));

    res.json({ success: true, events: eventsOut, month, year, data });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/ratings — { employee_id, event_id, rating, notes }
// Admin manually sets/edits a rating for a specific employee + event. Only
// two values are allowed: 1 (Absent) or 5 (Present) — matching the auto-fill
// scheme, so an admin override can't introduce an off-scale value like 2/3/4.
// Marking it is_manual = 1 so future auto-generation runs never silently
// overwrite the admin's call.
async function upsertRating(req, res, next) {
  try {
    const { employee_id, event_id, rating, notes } = req.body;
    const ratingNum = Number(rating);
    if (!employee_id || !event_id || (ratingNum !== 1 && ratingNum !== 5)) {
      return res.status(400).json({ success: false, message: 'employee_id, event_id, and a rating of either 1 (Absent) or 5 (Present) are required.' });
    }

    const [eventRows] = await pool.query('SELECT id, start_datetime FROM events WHERE id = ?', [event_id]);
    if (!eventRows.length) {
      return res.status(404).json({ success: false, message: 'Event not found.' });
    }
    const ratingDate = new Date(eventRows[0].start_datetime).toISOString().slice(0, 10);

    await pool.query(
      `INSERT INTO employee_ratings (employee_id, event_id, rating_date, rating, is_manual, notes, updated_by)
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON DUPLICATE KEY UPDATE rating = VALUES(rating), is_manual = 1, notes = VALUES(notes), updated_by = VALUES(updated_by)`,
      [employee_id, event_id, ratingDate, ratingNum, notes || null, req.admin.id]
    );

    await logAction({ adminId: req.admin.id, action: 'set_rating', module: 'ratings', details: { employee_id, event_id, rating: ratingNum }, ip: req.ip });
    res.json({ success: true, message: 'Rating saved.' });
  } catch (err) {
    next(err);
  }
}

module.exports = { getRatings, upsertRating, generateRatingsForRange };
