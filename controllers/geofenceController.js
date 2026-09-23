const pool = require('../config/db');
const config = require('../config/config');
const { logAction } = require('../services/auditService');

function centroidOf(points) {
  const sum = points.reduce((acc, p) => ({ lat: acc.lat + Number(p.lat), lng: acc.lng + Number(p.lng) }), { lat: 0, lng: 0 });
  return { lat: sum.lat / points.length, lng: sum.lng / points.length };
}

// Weekday numbers (ISO: 1=Mon..7=Sun) that fall on each recurrence type,
// used to expand a recurring event definition into individual occurrence dates.
function expandRecurrenceDates({ recurrence_type, recurrence_days, start, end, recurrence_end_date }) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const durationMs = endDate - startDate;
  const occurrences = [{ start: startDate, end: endDate }]; // the first occurrence is always the form's own start/end

  if (recurrence_type === 'none' || !recurrence_end_date) return occurrences;

  const untilDate = new Date(`${recurrence_end_date}T23:59:59`);
  const days = (recurrence_days || '')
    .split(',')
    .map((d) => Number(d.trim()))
    .filter((d) => d >= 1 && d <= 7);

  if (recurrence_type === 'weekly' && days.length) {
    const cursor = new Date(startDate);
    cursor.setDate(cursor.getDate() + 1); // start scanning the day after the first occurrence
    while (cursor <= untilDate) {
      const isoDay = cursor.getDay() === 0 ? 7 : cursor.getDay();
      if (days.includes(isoDay)) {
        const occStart = new Date(cursor);
        occStart.setHours(startDate.getHours(), startDate.getMinutes(), startDate.getSeconds(), 0);
        const occEnd = new Date(occStart.getTime() + durationMs);
        occurrences.push({ start: occStart, end: occEnd });
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  return occurrences;
}

// Formats a Date using ITS OWN local calendar/clock fields (year, month, day,
// hours, minutes, seconds) — never through toISOString(), which converts to
// UTC and silently shifts the wall-clock time (e.g. an admin in the
// Philippines, UTC+8, picking 6:00 PM would get stored as 10:00 AM).
// `start`/`end` come in as naive "YYYY-MM-DDTHH:mm" strings (no timezone
// offset) from the <input type="datetime-local">, so `new Date(start)` is
// parsed as a local wall-clock time already — we just need to read it back
// out the same way, not re-interpret it as UTC.
function toMysqlDatetime(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// GET /api/geofences/default-location — CSPC coordinates used to pre-fill the
// "create event" form. Admins can still override the location/radius per event.
async function getDefaultLocation(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('cspc_latitude','cspc_longitude','cspc_label')`
    );
    const byKey = Object.fromEntries(rows.map((r) => [r.setting_key, r.setting_value]));
    res.json({
      success: true,
      data: {
        lat: byKey.cspc_latitude ? Number(byKey.cspc_latitude) : config.defaultGeofence.lat,
        lng: byKey.cspc_longitude ? Number(byKey.cspc_longitude) : config.defaultGeofence.lng,
        label: byKey.cspc_label || config.defaultGeofence.label
      }
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/geofences  (includes each geofence's polygon points, for map rendering/editing)
// ?limit=N — return only the N most-recently-created events (used by the
// Geo-Fences panel's default "3 most recent" view; omit for the full list).
async function getGeofences(req, res, next) {
  try {
    const { limit } = req.query;
    const limitClause = limit && Number(limit) > 0 ? `LIMIT ${Number(limit)}` : '';
    const [rows] = await pool.query(
      `SELECT g.*, e.start_datetime, e.end_datetime, e.title AS event_title, e.created_at AS event_created_at,
              e.recurrence_type, e.recurrence_days, e.recurrence_end_date, e.is_recurring_parent, e.parent_event_id
       FROM geofences g JOIN events e ON g.event_id = e.id
       ORDER BY e.created_at DESC
       ${limitClause}`
    );

    const [allPoints] = await pool.query(
      `SELECT gp.geofence_id, gp.lat, gp.lng FROM geofence_points gp
       ORDER BY gp.geofence_id, gp.point_order`
    );
    const pointsByGeofence = {};
    for (const p of allPoints) {
      if (!pointsByGeofence[p.geofence_id]) pointsByGeofence[p.geofence_id] = [];
      pointsByGeofence[p.geofence_id].push({ lat: Number(p.lat), lng: Number(p.lng) });
    }

    // Auto activation/expiration based on event schedule
    const now = new Date();
    const withStatus = rows.map((g) => {
      const start = new Date(g.start_datetime);
      const end = new Date(g.end_datetime);
      let computedStatus = 'upcoming';
      if (now >= start && now <= end) computedStatus = 'active';
      else if (now > end) computedStatus = 'expired';
      return { ...g, points: pointsByGeofence[g.id] || [], computed_status: computedStatus };
    });

    res.json({ success: true, data: withStatus });
  } catch (err) {
    next(err);
  }
}

// POST /api/geofences  (creates event + polygon geofence together, matching the UI form)
// Optional recurrence fields: recurrence_type ('none'|'weekly'|'dates'), recurrence_days
// ("1,3,5" = Mon/Wed/Fri, ISO weekday numbers), recurrence_end_date (YYYY-MM-DD).
// When a recurrence is set, one event+geofence row is created per occurrence, each with
// its own attendance records, linked back to the first occurrence via parent_event_id.
async function createGeofence(req, res, next) {
  const conn = await pool.getConnection();
  try {
    const {
      title, venue, start, end, points, center_lat, center_lng,
      recurrence_type = 'none', recurrence_days, recurrence_end_date
    } = req.body;
    if (!title || !start || !end || !Array.isArray(points) || points.length < 3) {
      return res.status(400).json({ success: false, message: 'Title, schedule, and at least 3 boundary points are required.' });
    }
    // New events can't be scheduled to start in the past (mirrors the
    // `min` lock on the admin UI's date/time picker — enforced here too so
    // the rule holds even for direct API calls).
    if (new Date(start).getTime() < Date.now()) {
      return res.status(400).json({ success: false, message: "The event start date/time can't be in the past." });
    }
    if (new Date(end).getTime() < new Date(start).getTime()) {
      return res.status(400).json({ success: false, message: "The end date/time can't be before the start." });
    }
    if (recurrence_type === 'weekly' && (!recurrence_days || !recurrence_end_date)) {
      return res.status(400).json({ success: false, message: 'Recurring schedules need at least one weekday and an end date.' });
    }

    // Latitude/Longitude typed manually in the form take priority over the auto-computed centroid.
    const hasManualCoords = center_lat !== undefined && center_lat !== null && center_lat !== '' &&
                             center_lng !== undefined && center_lng !== null && center_lng !== '';
    if (hasManualCoords && (isNaN(Number(center_lat)) || isNaN(Number(center_lng)))) {
      return res.status(400).json({ success: false, message: 'Latitude and Longitude must be valid numbers.' });
    }
    const center = hasManualCoords ? { lat: Number(center_lat), lng: Number(center_lng) } : centroidOf(points);

    const occurrences = expandRecurrenceDates({ recurrence_type, recurrence_days, start, end, recurrence_end_date });

    await conn.beginTransaction();

    let parentEventId = null;
    let firstGeofenceId = null;
    const createdEventIds = [];

    for (let occIndex = 0; occIndex < occurrences.length; occIndex++) {
      const occ = occurrences[occIndex];
      const isFirst = occIndex === 0;

      const [eventResult] = await conn.query(
        `INSERT INTO events
          (title, venue, start_datetime, end_datetime, is_active, recurrence_type, recurrence_days, recurrence_end_date, is_recurring_parent, parent_event_id)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        [
          title, venue || null, toMysqlDatetime(occ.start), toMysqlDatetime(occ.end),
          recurrence_type, recurrence_type === 'weekly' ? recurrence_days : null,
          recurrence_type === 'weekly' ? recurrence_end_date : null,
          isFirst && occurrences.length > 1 ? 1 : 0,
          isFirst ? null : parentEventId
        ]
      );
      const eventId = eventResult.insertId;
      if (isFirst) parentEventId = eventId;
      createdEventIds.push(eventId);

      const [geofenceResult] = await conn.query(
        `INSERT INTO geofences (event_id, title, venue, shape_type, center_lat, center_lng, radius_meters, is_active)
         VALUES (?, ?, ?, 'polygon', ?, ?, NULL, 1)`,
        [eventId, title, venue || null, center.lat, center.lng]
      );
      const geofenceId = geofenceResult.insertId;
      if (isFirst) firstGeofenceId = geofenceId;

      for (let i = 0; i < points.length; i++) {
        await conn.query(
          `INSERT INTO geofence_points (geofence_id, point_order, lat, lng) VALUES (?, ?, ?, ?)`,
          [geofenceId, i, points[i].lat, points[i].lng]
        );
      }
    }

    await conn.commit();
    await logAction({
      adminId: req.admin.id, action: 'create', module: 'geofence',
      details: { geofenceId: firstGeofenceId, pointCount: points.length, occurrences: occurrences.length },
      ip: req.ip
    });

    res.status(201).json({
      success: true,
      message: occurrences.length > 1
        ? `Geofence protocol initialized for ${occurrences.length} occurrences.`
        : 'Geofence protocol initialized.',
      data: { id: firstGeofenceId, event_id: parentEventId, occurrence_count: occurrences.length, event_ids: createdEventIds }
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
}

// PUT /api/geofences/:id
async function updateGeofence(req, res, next) {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;
    const { title, venue, start, end, points, center_lat, center_lng } = req.body;

    const [existing] = await conn.query('SELECT * FROM geofences WHERE id = ?', [id]);
    if (!existing[0]) return res.status(404).json({ success: false, message: 'Geofence not found.' });

    if (!Array.isArray(points) || points.length < 3) {
      return res.status(400).json({ success: false, message: 'At least 3 boundary points are required.' });
    }

    // Latitude/Longitude typed manually in the form take priority over the auto-computed centroid.
    const hasManualCoords = center_lat !== undefined && center_lat !== null && center_lat !== '' &&
                             center_lng !== undefined && center_lng !== null && center_lng !== '';
    if (hasManualCoords && (isNaN(Number(center_lat)) || isNaN(Number(center_lng)))) {
      return res.status(400).json({ success: false, message: 'Latitude and Longitude must be valid numbers.' });
    }
    const center = hasManualCoords ? { lat: Number(center_lat), lng: Number(center_lng) } : centroidOf(points);

    await conn.beginTransaction();

    await conn.query(
      `UPDATE geofences SET title = ?, venue = ?, shape_type = 'polygon', center_lat = ?, center_lng = ?, radius_meters = NULL WHERE id = ?`,
      [title, venue, center.lat, center.lng, id]
    );
    await conn.query(
      `UPDATE events SET title = ?, venue = ?, start_datetime = ?, end_datetime = ? WHERE id = ?`,
      [title, venue, toMysqlDatetime(new Date(start)), toMysqlDatetime(new Date(end)), existing[0].event_id]
    );

    // Replace the polygon's points wholesale - simplest, safest way to persist an edited shape.
    await conn.query('DELETE FROM geofence_points WHERE geofence_id = ?', [id]);
    for (let i = 0; i < points.length; i++) {
      await conn.query(
        `INSERT INTO geofence_points (geofence_id, point_order, lat, lng) VALUES (?, ?, ?, ?)`,
        [id, i, points[i].lat, points[i].lng]
      );
    }

    await conn.commit();
    await logAction({ adminId: req.admin.id, action: 'update', module: 'geofence', details: { id, pointCount: points.length }, ip: req.ip });

    res.json({ success: true, message: 'Geofence protocol updated.' });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
}

// DELETE /api/geofences/:id
async function deleteGeofence(req, res, next) {
  try {
    const [rows] = await pool.query('SELECT event_id FROM geofences WHERE id = ?', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Geofence not found.' });

    // Deleting the event cascades to the geofence, which cascades to geofence_points.
    await pool.query('DELETE FROM events WHERE id = ?', [rows[0].event_id]);
    await logAction({ adminId: req.admin.id, action: 'delete', module: 'geofence', details: { id: req.params.id }, ip: req.ip });

    res.json({ success: true, message: 'Geofence protocol terminated.' });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/geofences/:id/toggle  { enable: true|false }
async function toggleGeofence(req, res, next) {
  try {
    const { enable } = req.body;
    await pool.query('UPDATE geofences SET is_active = ? WHERE id = ?', [enable ? 1 : 0, req.params.id]);
    res.json({ success: true, message: `Geofence ${enable ? 'enabled' : 'disabled'}.` });
  } catch (err) {
    next(err);
  }
}

// GET /api/geofences/mobile/active  (employee-facing — active + upcoming events only, no admin data)
async function getActiveForMobile(req, res, next) {
  try {
    const [rows] = await pool.query(
      `SELECT g.id, g.event_id, g.title, g.venue, e.start_datetime, e.end_datetime
       FROM geofences g JOIN events e ON g.event_id = e.id
       WHERE g.is_active = 1 AND e.end_datetime >= NOW()
       ORDER BY e.start_datetime ASC`
    );

    const [allPoints] = await pool.query(
      `SELECT gp.geofence_id, gp.lat, gp.lng FROM geofence_points gp
       WHERE gp.geofence_id IN (SELECT id FROM geofences WHERE is_active = 1)
       ORDER BY gp.geofence_id, gp.point_order`
    );
    const pointsByGeofence = {};
    for (const p of allPoints) {
      if (!pointsByGeofence[p.geofence_id]) pointsByGeofence[p.geofence_id] = [];
      pointsByGeofence[p.geofence_id].push({ lat: Number(p.lat), lng: Number(p.lng) });
    }

    const now = new Date();
    const withStatus = rows.map((g) => {
      const start = new Date(g.start_datetime);
      const end = new Date(g.end_datetime);
      const computed_status = now >= start && now <= end ? 'active' : 'upcoming';
      return { ...g, points: pointsByGeofence[g.id] || [], computed_status };
    });

    res.json({ success: true, data: withStatus });
  } catch (err) {
    next(err);
  }
}

module.exports = { getGeofences, createGeofence, updateGeofence, deleteGeofence, toggleGeofence, getActiveForMobile, getDefaultLocation };
