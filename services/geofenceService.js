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
 * Determines whether a given lat/lng is inside a geofence record.
 * geofence: { shape_type, center_lat, center_lng, radius_meters, points: [...] }
 * center_lat/center_lng/radius_meters are also DECIMAL columns and get the same
 * Number() coercion treatment as the polygon points, for the same reason.
 */
function isInsideGeofence(lat, lng, geofence) {
  if (geofence.shape_type === 'circle') {
    const dist = distanceMeters(Number(lat), Number(lng), Number(geofence.center_lat), Number(geofence.center_lng));
    return { inside: dist <= Number(geofence.radius_meters), distanceMeters: Math.round(dist) };
  }
  // polygon / rectangle both stored as point lists
  const points = geofence.points || [];
  if (points.length < 3) return { inside: false, distanceMeters: null };
  return { inside: isInsidePolygon(lat, lng, points), distanceMeters: null };
}

module.exports = { distanceMeters, isInsidePolygon, isInsideGeofence };
