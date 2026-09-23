const path = require('path');

// Institutional email domain. The seeded admin account and sample employees
// use it, and the admin login screen pre-fills with it.
const EMAIL_DOMAIN = 'my.cspc.edu.ph';
// Old default domain. database/seed.js moves any account still on it over to
// EMAIL_DOMAIN, and a DEFAULT_ADMIN_EMAIL left on it in an old .env is
// rewritten below so it can't come back.
const LEGACY_EMAIL_DOMAIN = 'geoattend.pro';

module.exports = {
  email: {
    domain: EMAIL_DOMAIN,
    legacyDomain: LEGACY_EMAIL_DOMAIN,
    defaultAdmin: (process.env.DEFAULT_ADMIN_EMAIL || `admin@${EMAIL_DOMAIN}`)
      .trim()
      .replace(/@geoattend\.pro$/i, `@${EMAIL_DOMAIN}`)
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
  // "buffalo_l" pack) and place them under models/, or point the *_MODEL_PATH
  // env vars at wherever you keep them:
  //   - Detector:   buffalo_l/det_10g.onnx     (SCRFD-10GF, finds face + 5 landmarks)
  //   - Recognizer: buffalo_l/w600k_r50.onnx   (ResNet50 ArcFace, 512-d embeddings)
  face: {
    detectorModelPath: process.env.FACE_DETECTOR_MODEL_PATH || path.join(__dirname, '..', 'models', 'det_10g.onnx'),
    detectorInputSize: Number(process.env.FACE_DETECTOR_INPUT_SIZE) || 640, // SCRFD's standard square input size
    // Faces scoring below this (0..1, post-sigmoid) are ignored as noise.
    detectorScoreThreshold: Number(process.env.FACE_DETECTOR_SCORE_THRESHOLD) || 0.5,
    detectorNmsThreshold: Number(process.env.FACE_DETECTOR_NMS_THRESHOLD) || 0.4,
    modelPath: process.env.FACE_MODEL_PATH || path.join(__dirname, '..', 'models', 'w600k_r50.onnx'),
    inputSize: Number(process.env.FACE_INPUT_SIZE) || 112, // ArcFace/InsightFace recognizers expect 112x112 aligned faces
    // Cosine similarity (-1..1) above which two faces are considered the same person.
    // 0.5 is a reasonably conservative default for ArcFace-style embeddings; tune per model.
    matchThreshold: Number(process.env.FACE_MATCH_THRESHOLD) || 0.5
  },
  attendance: {
    lateGraceMinutes: 10,
    // If an employee's accumulated time inside the geofence, once the event
    // has ended, comes out to less than this fraction of the event's total
    // scheduled duration, they're marked Absent regardless of how their
    // check-in was originally classified (Present/Late) — showing up for a
    // few minutes and leaving doesn't count as having attended.
    minAttendanceRatioForPresence: Number(process.env.ATTENDANCE_MIN_RATIO) || 0.6,
    // GPS readings less accurate (higher, in meters) than this are rejected.
    // Desktop/laptop browsers have no real GPS chip and estimate location via
    // WiFi/IP (~100-1000m accuracy), so the strict default will almost always
    // fail there — that's expected, not a bug. On an actual phone outdoors,
    // GPS accuracy is typically 5-20m and passes easily.
    // Override via .env (ATTENDANCE_MAX_ACCURACY_METERS) if you need looser
    // testing on desktop; keep it at 50-100 for real phone deployments.
    maxAccuracyMeters: Number(process.env.ATTENDANCE_MAX_ACCURACY_METERS) || 100,
    // How many consecutive "outside the geofence" location pings from the
    // mobile app are required before the server auto-closes an attendance
    // session (sets time_out). Requiring more than one absorbs a single
    // noisy/inaccurate GPS reading instead of ending the session on it.
    autoEndOutsideStreakThreshold: Number(process.env.ATTENDANCE_AUTO_END_STREAK) || 2,
    // Minimum minutes between accepted heartbeat pings for the same
    // attendance record, to avoid flooding the DB from a tight watchPosition loop.
    heartbeatMinIntervalSeconds: Number(process.env.ATTENDANCE_HEARTBEAT_MIN_SECONDS) || 20
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
