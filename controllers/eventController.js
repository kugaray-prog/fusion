const pool = require('../config/db');

// GET /api/events?search=&status=all|upcoming|ongoing|completed&page=&limit=
// Powers the Events "View All" page. Distinct from /api/geofences (which is
// the boundary-editing workspace) — this is a read-only searchable listing of
// every event (including every generated occurrence of a recurring series).
async function getAllEvents(req, res, next) {
  try {
    const { search = '', status = 'all', page = 1, limit = 25 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    let where = 'WHERE 1=1';
    const params = [];
    if (search) {
      where += ' AND (e.title LIKE ? OR e.venue LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    if (status === 'upcoming') where += ' AND e.start_datetime > NOW()';
    if (status === 'ongoing') where += ' AND NOW() BETWEEN e.start_datetime AND e.end_datetime';
    if (status === 'completed') where += ' AND e.end_datetime < NOW()';

    const [rows] = await pool.query(
      `SELECT e.id, e.title, e.venue, e.start_datetime, e.end_datetime, e.recurrence_type,
              e.recurrence_days, e.recurrence_end_date, e.is_recurring_parent, e.parent_event_id,
              e.created_at, g.id AS geofence_id, g.is_active AS geofence_active,
              (SELECT COUNT(*) FROM attendance a WHERE a.event_id = e.id) AS attendance_count
       FROM events e
       LEFT JOIN geofences g ON g.event_id = e.id
       ${where}
       ORDER BY e.start_datetime DESC
       LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset]
    );

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM events e ${where}`,
      params
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

    res.json({ success: true, data, pagination: { page: Number(page), limit: Number(limit), total } });
  } catch (err) {
    next(err);
  }
}

// GET /api/events/:id/occurrences — every occurrence of a recurring series
// (siblings sharing the same parent_event_id, plus the parent itself).
async function getOccurrences(req, res, next) {
  try {
    const { id } = req.params;
    const [rows] = await pool.query(
      `SELECT id, title, start_datetime, end_datetime, parent_event_id, is_recurring_parent
       FROM events
       WHERE id = ? OR parent_event_id = ?
          OR id = (SELECT parent_event_id FROM events WHERE id = ?)
          OR parent_event_id = (SELECT parent_event_id FROM events WHERE id = ?)
       ORDER BY start_datetime ASC`,
      [id, id, id, id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

// GET /api/events/ongoing — minimal list of events currently in their
// scheduled window (title + id only), for the admin Verification panels'
// (OCR / Face) "which event is this attendance for" picker. Deliberately
// lighter/more open than getAllEvents (super_admin only): the restricted
// Verification-only 'admin' role needs this to use OCR/Face verification as
// an attendance method, but has no reason to see the full events workspace.
async function getOngoingEvents(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT id, title, venue, start_datetime, end_datetime
       FROM events
       WHERE NOW() BETWEEN start_datetime AND end_datetime
       ORDER BY start_datetime ASC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAllEvents, getOccurrences, getOngoingEvents };

