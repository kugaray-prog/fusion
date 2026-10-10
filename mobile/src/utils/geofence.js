// Geofence math shared by the in-app tracker (AttendanceTrackingContext) and
// the background task that keeps attendance running with the app closed
// (tasks/backgroundAttendance.js), so both decide "inside" the same way --
// and the same way as the backend's geofenceService.

// Point-in-polygon test (ray-casting). Coerced to Number like the backend's
// version, so string coordinates can never silently turn the math into
// string concatenation.
export function isInsidePolygon(lat, lng, points) {
  lat = Number(lat);
  lng = Number(lng);
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = Number(points[i].lat), yi = Number(points[i].lng);
    const xj = Number(points[j].lat), yj = Number(points[j].lng);
    const intersect = (yi > lng) !== (yj > lng) && lat < ((xj - xi) * (lng - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// GPS error allowance at the boundary, mirroring the backend's
// config.attendance.edgeToleranceMeters (keep the two in sync): a reading
// just outside the polygon still counts as inside when the edge is within
// the reading's own accuracy, capped at this many meters. 0 = the admin's
// polygon is the exact boundary: stepping outside it times the employee out.
export const EDGE_TOLERANCE_METERS = 0;

// Shortest distance in meters from a point to the polygon's boundary (flat
// projection; accurate to well under a meter at geofence scale). Same math
// as geofenceService.distanceToPolygonEdgeMeters on the backend.
export function distanceToEdgeMeters(lat, lng, points) {
  lat = Number(lat);
  lng = Number(lng);
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat * Math.PI) / 180);
  const xy = points.map((p) => ({ x: (Number(p.lng) - lng) * mPerDegLng, y: (Number(p.lat) - lat) * mPerDegLat }));
  let best = Infinity;
  for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) {
    const a = xy[j];
    const b = xy[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / lenSq)) : 0;
    best = Math.min(best, Math.hypot(a.x + t * dx, a.y + t * dy));
  }
  return best;
}

// Straight-line distance in meters between two points (same flat projection).
export function distanceMeters(lat1, lng1, lat2, lng2) {
  const mPerDegLng = 111320 * Math.cos((Number(lat1) * Math.PI) / 180);
  return Math.hypot((Number(lng2) - Number(lng1)) * mPerDegLng, (Number(lat2) - Number(lat1)) * 111320);
}

export function isInsideGeofence(lat, lng, points, acc) {
  if (isInsidePolygon(lat, lng, points)) return true;
  const tol = Math.min(Number(acc) > 0 ? Number(acc) : 0, EDGE_TOLERANCE_METERS);
  return tol > 0 && distanceToEdgeMeters(lat, lng, points) <= tol;
}

// Whether an event's attendance window is open right now. The server's
// computed_status is only as fresh as the last geofence poll (up to 30s
// old), so an event that has just started is also recognized from its own
// start/end times. Falls back to computed_status if they can't be parsed.
export function isEventActiveNow(g, nowMs = Date.now()) {
  const start = new Date(String(g.start_datetime || '').replace(' ', 'T')).getTime();
  const end = new Date(String(g.end_datetime || '').replace(' ', 'T')).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return g.computed_status === 'active';
  return nowMs >= start && nowMs <= end;
}

// Today's date in the phone's local timezone as 'YYYY-MM-DD' -- matches the
// server's attendance_date. toISOString() gives the UTC date, which is still
// "yesterday" before 8:00 AM Philippine time.
export function localDateString(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
