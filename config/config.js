const path = require('path');

// Institutional email domain. The seeded admin account and sample employees
// use it, and the admin login screen pre-fills with it.
const EMAIL_DOMAIN = 'my.cspc.edu.ph';
// Every domain accepted as institutional: students/employees on
// @my.cspc.edu.ph and staff/faculty on @cspc.edu.ph. Admin accounts and the
// admin Google sign-in accept any of these.
const INSTITUTIONAL_DOMAINS = [EMAIL_DOMAIN, 'cspc.edu.ph'];
// Old default domain. database/seed.js moves any account still on it over to
// EMAIL_DOMAIN, and a DEFAULT_ADMIN_EMAIL left on it in an old .env is
// rewritten below so it can't come back.
const LEGACY_EMAIL_DOMAIN = 'geoattend.pro';

// True for an address on an institutional domain (name@my.cspc.edu.ph or
// name@cspc.edu.ph). Compares the whole domain, so lookalikes such as
// name@evilcspc.edu.ph don't pass.
function isInstitutionalEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0) return false;
  return INSTITUTIONAL_DOMAINS.includes(value.slice(at + 1));
}

module.exports = {
  email: {
    domain: EMAIL_DOMAIN,
    domains: INSTITUTIONAL_DOMAINS,
    // For messages: "@my.cspc.edu.ph or @cspc.edu.ph"
    domainLabel: INSTITUTIONAL_DOMAINS.map(d => `@${d}`).join(' or '),
    legacyDomain: LEGACY_EMAIL_DOMAIN,
    defaultAdmin: (process.env.DEFAULT_ADMIN_EMAIL || `admin@${EMAIL_DOMAIN}`)
      .trim()
      .replace(/@geoattend\.pro$/i, `@${EMAIL_DOMAIN}`),
    isInstitutional: isInstitutionalEmail
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'dev_secret_change_me',
    expiresIn: process.env.JWT_EXPIRES_IN || '8h'
  },
  ocr: {
    minConfidence: 70 // percent — below this, OCR result is rejected as low_confidence
  },
  // Face Verification — the second identity-verification method alongside OCR
  // (see services/faceService.js). Runs the InsightFace "buffalo_l" pipeline
  // fully on-device/on-server (no cloud API): a SCRFD face DETECTOR finds the
  // face + 5 landmarks, the face is aligned to a canonical 112x112 crop from
  // those landmarks, then an ArcFace-family RECOGNIZER turns that aligned
  // crop into an embedding. Download both ONNX files from the official
  // InsightFace model zoo (https://github.com/deepinsight/insightface/tree/master/model_zoo,
  // "buffalo_s" pack, both bundled in models/), or point the *_MODEL_PATH env
  // vars at the larger "buffalo_l" pair instead:
  //   - Detector:   buffalo_s/det_500m.onnx    (SCRFD-500M, finds face + 5 landmarks)
  //   - Recognizer: buffalo_s/w600k_mbf.onnx   (MobileFaceNet ArcFace, 512-d embeddings)
  // buffalo_s is the default because buffalo_l's recognizer (w600k_r50.onnx,
  // ~174MB) ran Render's 512MB free instance out of memory while loading;
  // buffalo_s peaks around 125MB. buffalo_l is slightly more accurate -- to use
  // it on a bigger instance, set FACE_DETECTOR_MODEL_PATH=./models/det_10g.onnx
  // and FACE_MODEL_PATH=./models/w600k_r50.onnx. Embeddings from the two
  // recognizers are NOT comparable: switching means every employee has to
  // re-register their face.
  face: {
    detectorModelPath: process.env.FACE_DETECTOR_MODEL_PATH || path.join(__dirname, '..', 'models', 'det_500m.onnx'),
    detectorInputSize: Number(process.env.FACE_DETECTOR_INPUT_SIZE) || 640, // SCRFD's standard square input size
    // Faces scoring below this (0..1, post-sigmoid) are ignored as noise.
    detectorScoreThreshold: Number(process.env.FACE_DETECTOR_SCORE_THRESHOLD) || 0.5,
    detectorNmsThreshold: Number(process.env.FACE_DETECTOR_NMS_THRESHOLD) || 0.4,
    modelPath: process.env.FACE_MODEL_PATH || path.join(__dirname, '..', 'models', 'w600k_mbf.onnx'),
    inputSize: Number(process.env.FACE_INPUT_SIZE) || 112, // ArcFace/InsightFace recognizers expect 112x112 aligned faces
    // Cosine similarity (-1..1) above which two faces are considered the same person.
    // 0.5 is a reasonably conservative default for ArcFace-style embeddings; tune per model.
    matchThreshold: Number(process.env.FACE_MATCH_THRESHOLD) || 0.5
  },
  attendance: {
    // Time-ins up to this many minutes after the event starts still count as Present.
    lateGraceMinutes: 15,
    // If an employee's accumulated time inside the geofence, once the event
    // has ended, comes out to less than this fraction of the event's total
    // scheduled duration, they're marked Absent regardless of how their
    // check-in was originally classified (Present/Late) — showing up for a
    // few minutes and leaving doesn't count as having attended. Until the
    // event ends their status is shown as Ongoing.
    minAttendanceRatioForPresence: Number(process.env.ATTENDANCE_MIN_RATIO) || 0.8,
    // GPS readings less accurate (higher, in meters) than this are rejected.
    // Desktop/laptop browsers have no real GPS chip and estimate location via
    // WiFi/IP (~100-1000m accuracy), so the strict default will almost always
    // fail there — that's expected, not a bug. On an actual phone outdoors,
    // GPS accuracy is typically 5-20m and passes easily.
    // Override via .env (ATTENDANCE_MAX_ACCURACY_METERS) if you need looser
    // testing on desktop; keep it at 50-100 for real phone deployments.
    maxAccuracyMeters: Number(process.env.ATTENDANCE_MAX_ACCURACY_METERS) || 100,
    // A reading just outside the boundary still counts as inside if the
    // boundary is within the reading's own GPS accuracy, up to this many
    // meters. Off (0) by default: the admin's polygon is the exact boundary,
    // and leaving it times the employee out right away. The same value is
    // used for time-in and time-out so the two can't disagree and flap at
    // the edge. The mobile app applies the same rule (keep them in sync:
    // mobile/src/context/AttendanceTrackingContext.js).
    edgeToleranceMeters: process.env.GEOFENCE_EDGE_TOLERANCE_METERS !== undefined
      ? Number(process.env.GEOFENCE_EDGE_TOLERANCE_METERS)
      : 0,
    // Refuse check-ins (and treat heartbeats as "outside") when the phone
    // reports the reading came from a mock-location provider (Fake GPS etc.).
    rejectMockLocations: process.env.REJECT_MOCK_LOCATIONS !== 'false',
    // How many consecutive "outside the geofence" location pings from the
    // mobile app are required before the server auto-closes an attendance
    // session (sets time_out). 1 = the first reading outside the polygon
    // times the employee out immediately, at the moment that reading was
    // taken. Raise it to absorb noisy GPS at the cost of a later time-out.
    autoEndOutsideStreakThreshold: Number(process.env.ATTENDANCE_AUTO_END_STREAK) || 1,
    // Minimum minutes between accepted heartbeat pings for the same
    // attendance record, to avoid flooding the DB from a tight watchPosition loop.
    heartbeatMinIntervalSeconds: Number(process.env.ATTENDANCE_HEARTBEAT_MIN_SECONDS) || 10,
    // An open session whose phone hasn't been heard from (no heartbeat or
    // time-in) for this many seconds is timed out at the last moment it was
    // heard from. The app pings every ~12 s while a session is open, also in
    // the background with the app closed, so silence means Location was
    // turned off or the app/phone stopped with no screen open to report it.
    // Kept short so that case is timed out within about half a minute;
    // still over two pings' worth, so one late ping doesn't end a session.
    // 0 turns this off.
    silentSessionSeconds: process.env.ATTENDANCE_SILENT_SESSION_SECONDS !== undefined
      ? Number(process.env.ATTENDANCE_SILENT_SESSION_SECONDS)
      : 30,
    // Geo-anomaly ("one person carrying another's phone") detection, see
    // detectGeoAnomaly. Two different employees' phones for the same event
    // count as together when readings taken at the same moment (at most
    // anomalyPairSeconds apart) are within anomalyDistanceMeters of each
    // other (straight-line distance, default 0.5 m). They're flagged for
    // face verification only once they've been together on at least
    // anomalyMinMatches paired readings in a row spanning at least
    // anomalySustainSeconds, with none in between showing them apart, and
    // the last of those within anomalyWindowSeconds. Readings less precise
    // than anomalyMaxAccuracyMeters are ignored: GPS that coarse can't tell
    // phones apart. anomalyRecheckSeconds: after passing face verification,
    // a record is left alone for this long; if the phones are still
    // together after that, it's flagged again.
    anomalyDistanceMeters: Number(process.env.ANOMALY_DISTANCE_METERS) || 0.5,
    anomalyWindowSeconds: Number(process.env.ANOMALY_WINDOW_SECONDS) || 30,
    anomalyRecheckSeconds: Number(process.env.ANOMALY_RECHECK_SECONDS) || 30,
    anomalyPairSeconds: Number(process.env.ANOMALY_PAIR_SECONDS) || 6,
    anomalySustainSeconds: Number(process.env.ANOMALY_SUSTAIN_SECONDS) || 60,
    anomalyMinMatches: Number(process.env.ANOMALY_MIN_MATCHES) || 4,
    anomalyMaxAccuracyMeters: Number(process.env.ANOMALY_MAX_ACCURACY_METERS) || 10
  },
  // Default/initial Geo-Fence location: CSPC (Camarines Sur Polytechnic
  // Colleges). Used to pre-fill the map/coordinates when an admin opens the
  // "create event" form. Admins can still change the location/radius per event.
  // Override via .env if your campus coordinates differ.
  defaultGeofence: {
    label: process.env.CSPC_LABEL || 'CSPC - Camarines Sur Polytechnic Colleges, Nabua, Camarines Sur',
    lat: Number(process.env.CSPC_LATITUDE) || 13.4059000,
    lng: Number(process.env.CSPC_LONGITUDE) || 123.3758000
  }
};
