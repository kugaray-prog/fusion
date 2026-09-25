/**
 * Returns the distance in meters between two lat/lng points using the
 * Haversine formula.
 */
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Point-in-polygon test using the ray-casting algorithm.
 * points: [{lat, lng}, ...]
 * Coordinates are explicitly coerced to Number here — MySQL's DECIMAL columns
 * come back from mysql2 as strings (no `decimalNumbers: true` set on the pool),
 * and `+` on a string concatenates instead of adding, silently breaking the
 * intersection math and making every point register as "outside" regardless
 * of actual location. Coercing here makes this function correct no matter
 * what type the caller passes in.
 */
function isInsidePolygon(lat, lng, points) {
  lat = Number(lat);
  lng = Number(lng);
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = Number(points[i].lat), yi = Number(points[i].lng);
    const xj = Number(points[j].lat), yj = Number(points[j].lng);
    const intersect =
      yi > lng !== yj > lng &&
      lat < ((xj - xi) * (lng - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Shortest distance in meters from a point to a polygon's boundary. Uses a
 * flat (equirectangular) projection around the point, which is accurate to
 * well under a meter at geofence scale.
 */
function distanceToPolygonEdgeMeters(lat, lng, points) {
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

/**
 * Determines whether a given lat/lng is inside a geofence record.
 * geofence: { shape_type, center_lat, center_lng, radius_meters, points: [...] }
 * center_lat/center_lng/radius_meters are also DECIMAL columns and get the same
 * Number() coercion treatment as the polygon points, for the same reason.
 *
 * toleranceMeters: a point outside the boundary by no more than this still
 * counts as inside (GPS error allowance). distanceMeters is how far outside
 * the boundary the point is (0 when inside).
 */
function isInsideGeofence(lat, lng, geofence, toleranceMeters = 0) {
  const tol = Math.max(0, Number(toleranceMeters) || 0);
  if (geofence.shape_type === 'circle') {
    const dist = distanceMeters(Number(lat), Number(lng), Number(geofence.center_lat), Number(geofence.center_lng));
    const outsideBy = Math.max(0, dist - Number(geofence.radius_meters));
    return { inside: outsideBy <= tol, distanceMeters: Math.round(outsideBy) };
  }
  // polygon / rectangle both stored as point lists
  const points = geofence.points || [];
  if (points.length < 3) return { inside: false, distanceMeters: null };
  if (isInsidePolygon(lat, lng, points)) return { inside: true, distanceMeters: 0 };
  const outsideBy = distanceToPolygonEdgeMeters(lat, lng, points);
  return { inside: outsideBy <= tol, distanceMeters: Math.round(outsideBy) };
}

module.exports = { distanceMeters, isInsidePolygon, distanceToPolygonEdgeMeters, isInsideGeofence };
