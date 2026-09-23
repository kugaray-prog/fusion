const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const config = require('../config/config');
const { logAction } = require('../services/auditService');
const faceService = require('../services/faceService');

// DoubleSafe-style device re-verification policy (mirrors GCash's DoubleSafe
// device-change lockout): how many failed live-selfie-vs-enrolled-face match
// attempts are allowed before the account is temporarily locked out of
// registering further devices, and how long that lock lasts.
const DOUBLESAFE_MAX_ATTEMPTS = 3;
const DOUBLESAFE_LOCK_MINUTES = 30;

let googleClient = null;
function getGoogleClient() {
  if (!process.env.GOOGLE_CLIENT_ID) return null;
  if (!googleClient) {
    const { OAuth2Client } = require('google-auth-library');
    // No single audience is bound here — verifyIdToken() below is called with an
    // array of every accepted client ID (web portal + native Android app), since
    // each platform's Google Sign-In issues tokens audienced to its own client ID.
    googleClient = new OAuth2Client();
  }
  return googleClient;
}

// Every OAuth Client ID this server accepts Google ID tokens from. The web portal
// uses GOOGLE_CLIENT_ID; the native Android dev-client build uses its own separate
// GOOGLE_ANDROID_CLIENT_ID. Falsy/unset entries are filtered out so this still works
// if only one of the two is configured.
function getAcceptedAudiences() {
  return [process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_ANDROID_CLIENT_ID].filter(Boolean);
}

function employeePayload(employee) {
  return {
    id: employee.id,
    employee_code: employee.employee_code,
    full_name: employee.full_name,
    surname: employee.surname,
    given_name: employee.given_name,
    middle_name: employee.middle_name,
    suffix: employee.suffix,
    department: employee.department_name,
    position: employee.position,
    gender: employee.gender,
    classification: employee.classification,
    photo_path: employee.photo_path,
    // The photo captured during mobile face registration (same one shown
    // in the admin's Device Management "View" modal) -- what the Profile
    // screen displays as the employee's profile picture. Falls back to
    // `photo_path` (an admin-uploaded photo, a separate/older concept --
    // see controllers/employeeController.js updateEmployee) only if
    // there's genuinely no registration photo on file at all.
    face_photo_url: employee.face_photo_url || employee.photo_path || null
  };
}

// The image_path of an employee's most recently captured registration
// photo. An employee can register more than once (each attempt/device adds
// its own employee_faces row -- see FACE_VERIFICATION_README.md's "Known
// gaps" note, and deviceController.getDevices' comment on the same
// one-employee-many-photos reality), so "most recent" is what actually
// represents how they look now, not an arbitrarily-picked old photo.
async function getLatestFacePhoto(employeeId) {
  const [rows] = await pool.query(
    'SELECT image_path FROM employee_faces WHERE employee_id = ? ORDER BY created_at DESC LIMIT 1',
    [employeeId]
  );
  return rows[0] ? rows[0].image_path : null;
}

// Looks up the most recently registered device for an employee. Only used as a
// fallback when the caller didn't tell us which physical device it's asking
// about (e.g. an older client build).
async function getLatestDeviceStatus(employeeId) {
  const [rows] = await pool.query(
    `SELECT status FROM mobile_devices WHERE employee_id = ? ORDER BY registered_at DESC LIMIT 1`,
    [employeeId]
  );
  return rows[0] ? rows[0].status : null;
}

// Looks up the status of THIS SPECIFIC device for an employee, so login/status
// responses can tell the mobile app whether it should show the "waiting for
// approval" screen instead of the main app content. Since an employee may now
// have several registered devices, we must check the one actually in use
// rather than just "the most recently registered device" — otherwise a
// long-approved device could be blocked just because a different device was
// registered more recently elsewhere.
async function getDeviceStatusFor(employeeId, deviceUid) {
  if (!deviceUid) return getLatestDeviceStatus(employeeId);
  const [rows] = await pool.query(
    `SELECT status FROM mobile_devices WHERE employee_id = ? AND device_uid = ?`,
    [employeeId, deviceUid]
  );
  return rows[0] ? rows[0].status : null;
}

function issueEmployeeToken(employee) {
  return jwt.sign(
    { id: employee.id, employee_code: employee.employee_code, type: 'employee' },
    config.jwt.secret,
    { expiresIn: '30d' }
  );
}

// POST /api/employee-auth/login  { employee_code, password }
async function login(req, res, next) {
  try {
    const { employee_code, password, device_uid } = req.body;
    if (!employee_code || !password) {
      return res.status(400).json({ success: false, message: 'Employee ID and password are required.' });
    }

    const [rows] = await pool.query(
      `SELECT e.*, d.name AS department_name FROM employees e
       JOIN departments d ON e.department_id = d.id WHERE e.employee_code = ?`,
      [employee_code]
    );
    const employee = rows[0];

    if (!employee || !employee.password_hash) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }
    if (employee.status === 'Inactive') {
      return res.status(403).json({ success: false, message: 'This account is inactive. Contact your administrator.' });
    }

    const match = await bcrypt.compare(password, employee.password_hash);
    if (!match) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    const token = jwt.sign(
      { id: employee.id, employee_code: employee.employee_code, type: 'employee' },
      config.jwt.secret,
      { expiresIn: '30d' }
    );

    const deviceStatus = await getDeviceStatusFor(employee.id, device_uid);

    // Same rule as googleLogin() below: a token is only issued for a device
    // already on file for THIS employee. A device can only ever belong to
    // one employee, but an employee may register and use multiple devices
    // (see linkDevice()) -- without this check, matching credentials alone
    // would let this employee reach the Dashboard on ANY device, including
    // one already approved for someone else, bypassing admin device
    // approval entirely. This endpoint isn't called by the shipped mobile
    // app (it only uses googleLogin() via "Continue with Google"), but it's
    // a reachable public API in its own right, so it gets the same rule.
    if (device_uid && !deviceStatus) {
      const [deviceRows] = await pool.query('SELECT employee_id FROM mobile_devices WHERE device_uid = ?', [device_uid]);
      const belongsToSomeoneElse = deviceRows[0] && String(deviceRows[0].employee_id) !== String(employee.id);
      return res.status(403).json({
        success: false,
        message: belongsToSomeoneElse
          ? 'This device is already registered to another employee. Contact your administrator if this isn\'t you.'
          : 'This device is not registered. Please register it through the mobile app first.'
      });
    }

    const facePhotoUrl1 = await getLatestFacePhoto(employee.id);
    res.json({
      success: true,
      message: 'Login successful.',
      token,
      employee: employeePayload({ ...employee, department_name: employee.department_name, face_photo_url: facePhotoUrl1 }),
      deviceStatus
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/employee-auth/google  { credential }
// Verifies a real Google ID token (from Google Identity Services on the client).
// If the verified email already belongs to an employee record, logs them straight in.
// If not, issues a short-lived "pending" token so the client can proceed to the
// registration screen — the pending token proves the email was genuinely Google-verified,
// so linkDevice() below never has to trust a client-supplied email directly.
async function googleLogin(req, res, next) {
  try {
    const client = getGoogleClient();
    if (!client) {
      return res.status(501).json({
        success: false,
        message: 'Google Sign-In is not configured on this server. Set GOOGLE_CLIENT_ID in .env to enable it.'
      });
    }

    const { credential, device_uid } = req.body;
    if (!credential) {
      return res.status(400).json({ success: false, message: 'Missing Google credential.' });
    }

    const ticket = await client.verifyIdToken({ idToken: credential, audience: getAcceptedAudiences() });
    const payload = ticket.getPayload();
    const email = payload.email;
    if (!payload.email_verified) {
      return res.status(403).json({ success: false, message: 'Your Google email is not verified.' });
    }

    const [rows] = await pool.query(
      `SELECT e.*, d.name AS department_name FROM employees e
       JOIN departments d ON e.department_id = d.id WHERE e.email = ?`,
      [email]
    );
    const employee = rows[0];

    if (employee) {
      if (employee.status === 'Inactive') {
        return res.status(403).json({ success: false, message: 'This account is inactive. Contact your administrator.' });
      }

      const deviceStatus = await getDeviceStatusFor(employee.id, device_uid);

      // A device can only ever belong to one employee, but an employee may
      // register and use multiple devices (see linkDevice() below) -- so
      // "matched" login only skips straight to a token when THIS device is
      // already on file for THIS employee. Before this check, matching by
      // email alone was enough for a full login on ANY device -- a brand
      // new one, or one already registered and approved for a DIFFERENT
      // employee -- which let more than one employee reach the Dashboard
      // through the very same physical device, bypassing admin device
      // approval entirely (deviceStatus would come back null, which
      // App.js's RootNavigator doesn't treat as "needs approval", only
      // 'pending' does). Falling through to the same pendingToken +
      // RegistrationScreen path used for a genuinely new employee re-runs
      // the DoubleSafe live-face re-verification AND linkDevice()'s own
      // "this device_uid already belongs to someone else" block --
      // exactly the checks a device change already needs, instead of
      // duplicating that logic here.
      if (deviceStatus) {
        const facePhotoUrl2 = await getLatestFacePhoto(employee.id);
        return res.json({
          success: true,
          matched: true,
          message: 'Login successful.',
          token: issueEmployeeToken(employee),
          employee: employeePayload({ ...employee, face_photo_url: facePhotoUrl2 }),
          deviceStatus
        });
      }

      const pendingToken = jwt.sign(
        { type: 'google_pending', email, given_name: payload.given_name || '', family_name: payload.family_name || '' },
        config.jwt.secret,
        { expiresIn: '10m' }
      );
      return res.json({
        success: true,
        matched: false,
        pendingToken,
        google: { email, given_name: payload.given_name, family_name: payload.family_name },
        // Lets RegistrationScreen pre-fill the employee's own details (see
        // src/screens/RegistrationScreen.js) instead of asking someone who
        // already has an account to retype their Employee ID/name from
        // scratch just because they're on a new or unrecognized device.
        existingEmployee: {
          employee_code: employee.employee_code,
          surname: employee.surname || '',
          given_name: employee.given_name || '',
          middle_name: employee.middle_name || '',
          suffix: employee.suffix || '',
          department: employee.department_name || '',
          position: employee.position || '',
          gender: employee.gender || '',
          classification: employee.classification || 'Permanent Administrative'
        }
      });
    }

    // Not linked to any employee yet — issue a short-lived pending token proving
    // the email was verified, and let the client proceed to device registration.
    const pendingToken = jwt.sign(
      {
        type: 'google_pending',
        email,
        given_name: payload.given_name || '',
        family_name: payload.family_name || ''
      },
      config.jwt.secret,
      { expiresIn: '10m' }
    );

    res.json({
      success: true,
      matched: false,
      pendingToken,
      google: { email, given_name: payload.given_name, family_name: payload.family_name }
    });
  } catch (err) {
    if (err.message && err.message.includes('Token used too late')) {
      return res.status(401).json({ success: false, message: 'Your Google session expired. Please try again.' });
    }
    // Logged so audience/config mismatches (e.g. a forgotten GOOGLE_ANDROID_CLIENT_ID)
    // are visible in the server console instead of only as a generic 500 to the client.
    console.error('Google token verification failed:', err.message);
    next(err);
  }
}

// Allowed values for the (optional) name suffix dropdown, mirroring the admin dashboard.
const VALID_SUFFIXES = ['', 'Jr.', 'Sr.', 'II', 'III', 'IV', 'V'];

// The mobile registration form's Classification picker offers these plus a
// free-text "Others" override (RegistrationScreen.js CLASSIFICATION_OPTIONS
// -- keep the two lists in sync). Listed here for reference/documentation
// only: the actual server-side check below (`classification.trim().length`)
// deliberately does NOT enforce this as a strict whitelist, since "Others"
// lets the employee submit any value not on this list. `classification` was
// widened from an ENUM to VARCHAR(50) to store one (see
// database/migration_v16_position_gender_classification.sql), so any
// reasonable text is accepted here rather than only these six.
const KNOWN_CLASSIFICATIONS = [
  'Permanent Administrative', 'Permanent Academic', 'Casual Administrative',
  'COS Administrative', 'COS Academic', 'Job Order'
];

// GET /api/employee-auth/departments
// Public (no auth) — the Device Registration screen needs a live list of
// departments for its dropdown before the employee has any token at all.
// Returns just id/name, nothing sensitive.
async function listDepartments(req, res, next) {
  try {
    const [rows] = await pool.query('SELECT id, name FROM departments ORDER BY name ASC');
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

// Maps the short codes shown in the mobile app's Department picker to the full
// department names used everywhere else in the system (admin dashboard, reports).
// Kept only for backward compatibility with older mobile clients that still send
// a short code — the current registration form sends the full department name
// straight from GET /api/employee-auth/departments, which resolveDepartmentId
// below already handles directly.
const DEPARTMENT_CODE_MAP = {
  CCS: 'College of Computer Studies',
  COE: 'College of Engineering',
  CBE: 'College of Business and Economics',
  CAS: 'College of Arts and Sciences'
};

// Resolves a department name/code submitted from the mobile registration form to a
// department_id, creating the department record on the fly if it doesn't exist yet
// (e.g. first employee ever to self-register into that department). Falls back to
// a generic "Unassigned" department if nothing usable was submitted.
async function resolveDepartmentId(deptInput) {
  const name = (DEPARTMENT_CODE_MAP[deptInput] || deptInput || '').trim() || 'Unassigned';

  const [existing] = await pool.query('SELECT id FROM departments WHERE name = ?', [name]);
  if (existing[0]) return existing[0].id;

  const [created] = await pool.query('INSERT INTO departments (name) VALUES (?)', [name]);
  return created.insertId;
}

// POST /api/employee-auth/link-device  (multipart: image, video?; body: employee details)
// { pendingToken, employee_code, surname|last_name, given_name|first_name, middle_name,
//   suffix, department, device_uid, device_model, device_brand, device_os }
//
// Registration sequence: Continue with Google -> employee details -> guided,
// real-time-verified face capture (hold steady, then blink -- all verified
// on-device before this request ever fires; RegistrationScreen submits the
// captured still frame together with the employee details in one request).
// This links/creates the employee record, registers the device, AND enrolls
// the captured face — a device is never registered without a face on file.
// `video` is accepted but optional and no longer sent by the current mobile
// app (an earlier version also recorded a brief confirmation clip here; it
// was dropped -- see RegistrationScreen.js's handleStartGuidedCapture -- since
// it was never surfaced anywhere in the admin dashboard and its
// recordAsync()/stopRecording() pairing was an intermittent source of
// "Recording was stopped before any data could be produced" errors).
//
// DoubleSafe checkpoint: if the Employee ID already belongs to someone with a
// face on file AND this is a device they haven't registered before, the live
// selfie must match that face (see faceService.findBestMatch below) before
// anything else about this request is trusted — mirrors GCash's DoubleSafe
// device-change re-verification. Repeated failures temporarily lock the
// account out of further attempts (see DOUBLESAFE_MAX_ATTEMPTS/LOCK_MINUTES
// above); an admin can clear the lock early via employeeController.unlockFace.
//
// First-time flow: if no employee record exists yet for the submitted Employee ID,
// one is automatically created from the details entered here (self-registration) —
// admins no longer need to pre-provision the employee record before someone's first
// mobile registration. If the Employee ID is already on file under a different
// surname, registration is still blocked so one person can't register under
// somebody else's Employee ID.
async function linkDevice(req, res, next) {
  try {
    const imageFile = req.files?.image?.[0];
    const videoFile = req.files?.video?.[0];
    if (!imageFile) {
      return res.status(400).json({ success: false, message: 'A face photo is required to complete registration.' });
    }

    const {
      pendingToken, employee_code, device_uid, device_model, device_brand, device_os,
      middle_name, suffix, department, position, classification, gender
    } = req.body;
    // The mobile app's registration form posts first_name/last_name; surname/given_name
    // are also accepted for backward compatibility with older/alternate clients.
    const surname = req.body.surname || req.body.last_name;
    const given_name = req.body.given_name || req.body.first_name;

    if (!pendingToken || !employee_code || !surname || !given_name || !device_uid) {
      return res.status(400).json({ success: false, message: 'Missing required registration details.' });
    }
    // Every registration-form field is required except Middle Name and
    // Suffix -- enforced here too, not just on the mobile form
    // (RegistrationScreen.js handleContinueToCapture), since a request
    // could reach this endpoint directly.
    if (!department || !department.trim()) {
      return res.status(400).json({ success: false, message: 'Department is required.' });
    }
    if (!position || !position.trim()) {
      return res.status(400).json({ success: false, message: 'Position is required.' });
    }
    if (!gender || !gender.trim()) {
      return res.status(400).json({ success: false, message: 'Gender is required.' });
    }
    if (!classification || !classification.trim()) {
      return res.status(400).json({ success: false, message: 'Classification is required.' });
    }
    if (suffix && !VALID_SUFFIXES.includes(suffix)) {
      return res.status(400).json({ success: false, message: 'Invalid suffix value.' });
    }
    // Not a strict whitelist against KNOWN_CLASSIFICATIONS -- see that
    // constant's comment above. Only guards against an unreasonably long
    // value (a length cap, not a content restriction: the free-text
    // "Others" field on the mobile form has no length limit of its own).
    if (classification.trim().length > 50) {
      return res.status(400).json({ success: false, message: 'Classification must be 50 characters or fewer.' });
    }
    if (gender.trim().length > 40) {
      return res.status(400).json({ success: false, message: 'Gender must be 40 characters or fewer.' });
    }

    // Same liveness bar as the mobile app's registration flow (see
    // RegistrationScreen.js): a live face held steady in frame, then a
    // completed blink, both verified in real time on-device before ever
    // reaching this endpoint. The captured photo becomes this employee's
    // enrolled face, so it's held to the same "must be a live person, not a
    // photo of a photo" bar rather than a lighter one.
    const livenessVerified = req.body.liveness_verified === 'true' || req.body.liveness_verified === true;
    const livenessActions = typeof req.body.liveness_actions === 'string' ? req.body.liveness_actions.slice(0, 120) : null;
    if (!livenessVerified) {
      return res.status(400).json({
        success: false,
        message: 'Liveness check was not completed. Please retry face registration.'
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(pendingToken, config.jwt.secret);
    } catch (e) {
      return res.status(401).json({ success: false, message: 'Your Google sign-in has expired. Please sign in again.' });
    }
    if (decoded.type !== 'google_pending') {
      return res.status(400).json({ success: false, message: 'Invalid registration session.' });
    }

    const [rows] = await pool.query(
      `SELECT e.*, d.name AS department_name FROM employees e
       JOIN departments d ON e.department_id = d.id WHERE e.employee_code = ?`,
      [employee_code]
    );
    let employee = rows[0];

    // Compute the submitted selfie's face embedding once, up front — reused
    // below both for the DoubleSafe identity check (existing employee +
    // brand-new device) and for the permanent face enrollment further down.
    let embedding;
    try {
      embedding = await faceService.getEmbedding(imageFile.path);
    } catch (err) {
      console.error('Face processing failed:', err.message);
      return res.status(502).json({
        success: false,
        message: 'Could not process the face photo. Please retake it and try again.'
      });
    }

    const surnameVal = surname.trim();
    const givenNameVal = given_name.trim();
    const middleNameVal = middle_name ? middle_name.trim() : null;
    const suffixVal = suffix ? suffix.trim() : null;
    const fullName = [givenNameVal, middleNameVal, surnameVal, suffixVal].filter(Boolean).join(' ');

    if (employee) {
      // Match against the existing record's surname (falls back to the tail of full_name
      // for older records that haven't been split into surname/given_name yet), so this
      // Employee ID can't be claimed by someone other than who it already belongs to.
      const employeeSurname = (employee.surname || employee.full_name?.split(' ').pop() || '').trim().toLowerCase();
      if (employeeSurname !== surnameVal.toLowerCase()) {
        return res.status(409).json({
          success: false,
          message: `Employee ID "${employee_code}" is already registered under a different name. Contact your administrator if this isn't you.`
        });
      }
      if (employee.status === 'Inactive') {
        return res.status(403).json({ success: false, message: 'This account is inactive. Contact your administrator.' });
      }

      // -- DoubleSafe checkpoint --------------------------------------------
      // Registering a NEW device for an employee who already has a face on
      // file must prove it's really them first (mirrors GCash's DoubleSafe:
      // a device change requires the live selfie to match the identity
      // already verified at enrollment). This runs BEFORE any of this
      // employee's data is touched below, so a failed/locked attempt can't
      // sneak through a profile update alongside it. Re-registering on a
      // device already on file for this employee skips this entirely — it's
      // not a device change, so there's nothing new to prove.
      const [deviceRows] = await pool.query(
        'SELECT id FROM mobile_devices WHERE employee_id = ? AND device_uid = ?',
        [employee.id, device_uid]
      );
      const isNewDeviceForThisEmployee = deviceRows.length === 0;

      if (isNewDeviceForThisEmployee) {
        if (employee.face_locked_until && new Date(employee.face_locked_until) > new Date()) {
          const minsLeft = Math.max(1, Math.ceil((new Date(employee.face_locked_until) - new Date()) / 60000));
          return res.status(423).json({
            success: false,
            result: 'locked',
            message: `Too many failed identity checks. Try again in ${minsLeft} minute(s), or contact your administrator to unlock your account.`
          });
        }

        const [faceRows] = await pool.query('SELECT embedding FROM employee_faces WHERE employee_id = ?', [employee.id]);
        if (faceRows.length > 0) {
          const candidates = faceRows.map((r) => ({ employeeId: employee.id, embedding: JSON.parse(r.embedding) }));
          const match = faceService.findBestMatch(embedding, candidates);
          const bestSimilarity = Math.max(...candidates.map((c) => faceService.cosineSimilarity(embedding, c.embedding)));
          const similarityPct = Math.max(0, bestSimilarity) * 100;
          const imagePathForLog = `/uploads/faces/${imageFile.filename}`;

          if (!match) {
            const attempts = (employee.face_failed_attempts || 0) + 1;
            const locked = attempts >= DOUBLESAFE_MAX_ATTEMPTS;
            await pool.query(
              `UPDATE employees SET face_failed_attempts = ?, face_locked_until = ?, face_lock_reason = ? WHERE id = ?`,
              [
                attempts,
                locked ? new Date(Date.now() + DOUBLESAFE_LOCK_MINUTES * 60000) : null,
                locked ? 'Too many failed DoubleSafe verification attempts during new device registration.' : null,
                employee.id
              ]
            );
            await pool.query(
              `INSERT INTO device_verification_attempts (employee_id, device_uid, image_path, similarity, result, liveness_verified, liveness_actions)
               VALUES (?, ?, ?, ?, ?, 1, ?)`,
              [employee.id, device_uid, imagePathForLog, similarityPct, locked ? 'locked' : 'no_match', livenessActions]
            );
            await logAction({
              adminId: null,
              action: 'doublesafe_failed',
              module: 'employee_auth',
              details: { employeeCode: employee_code, attempts, locked, similarity: similarityPct },
              ip: req.ip
            });

            if (locked) {
              return res.status(423).json({
                success: false,
                result: 'locked',
                message: `Too many failed identity checks. Your account is temporarily locked for ${DOUBLESAFE_LOCK_MINUTES} minutes. Contact your administrator if you need immediate access.`
              });
            }
            return res.status(401).json({
              success: false,
              result: 'no_match',
              message: `We couldn't confirm this is you (attempt ${attempts} of ${DOUBLESAFE_MAX_ATTEMPTS}). Make sure you're centered in frame and well-lit, then try again.`
            });
          }

          // Matched — clear any prior failures and log the successful check.
          await pool.query(
            'UPDATE employees SET face_failed_attempts = 0, face_locked_until = NULL, face_lock_reason = NULL WHERE id = ?',
            [employee.id]
          );
          await pool.query(
            `INSERT INTO device_verification_attempts (employee_id, device_uid, image_path, similarity, result, liveness_verified, liveness_actions)
             VALUES (?, ?, ?, ?, 'matched', 1, ?)`,
            [employee.id, device_uid, imagePathForLog, similarityPct, livenessActions]
          );
          await logAction({
            adminId: null,
            action: 'doublesafe_verified',
            module: 'employee_auth',
            details: { employeeCode: employee_code, similarity: similarityPct },
            ip: req.ip
          });
        }
        // If faceRows is empty, this employee record exists but has no face
        // enrolled yet (e.g. pre-provisioned by an admin) — nothing to match
        // against, so this is treated like first-time enrollment below.
      }

      // Record the name parts the employee entered (must match their Google account
      // name — enforced on the client) and link the verified Google email if this
      // record doesn't already have one on file. Department/Position are kept in
      // sync with whatever was submitted on this registration form.
      const departmentId = await resolveDepartmentId(department);
      // Classification and gender are kept in sync with whatever was
      // submitted on this registration form, same as position below --
      // falling back to what's already on file only when this submission
      // didn't include a value at all. (Previously this had a special
      // "don't downgrade an existing COS classification" carve-out, from
      // when the picker only ever offered Regular/Casual and so could never
      // represent COS itself; the new picker's option list -- COS
      // Administrative, COS Academic, among others, or Others for anything
      // else -- can represent any classification directly, so there's no
      // longer a value this form structurally can't re-select.)
      const classificationVal = classification || employee.classification;
      const genderVal = gender || employee.gender;
      await pool.query(
        `UPDATE employees SET surname = ?, given_name = ?, middle_name = ?, suffix = ?, full_name = ?,
                email = COALESCE(email, ?), department_id = ?, position = COALESCE(?, position),
                classification = ?, gender = ?
         WHERE id = ?`,
        [surnameVal, givenNameVal, middleNameVal, suffixVal, fullName, decoded.email, departmentId, position || null, classificationVal, genderVal, employee.id]
      );
      employee.surname = surnameVal;
      employee.given_name = givenNameVal;
      employee.middle_name = middleNameVal;
      employee.suffix = suffixVal;
      employee.full_name = fullName;
    } else {
      // No employee record exists for this Employee ID yet — this is the employee's
      // first time registering, so provision the record automatically instead of
      // requiring an admin to have created it beforehand.
      const departmentId = await resolveDepartmentId(department);

      const [result] = await pool.query(
        `INSERT INTO employees (employee_code, full_name, surname, given_name, middle_name, suffix, department_id, position, gender, classification, email, status, remark)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Full-time', 'Active')`,
        [employee_code, fullName, surnameVal, givenNameVal, middleNameVal, suffixVal, departmentId, position || null, gender || null, classification || 'Permanent Administrative', decoded.email]
      );

      const [newRows] = await pool.query(
        `SELECT e.*, d.name AS department_name FROM employees e
         JOIN departments d ON e.department_id = d.id WHERE e.id = ?`,
        [result.insertId]
      );
      employee = newRows[0];

      await logAction({
        adminId: null,
        action: 'self_register',
        module: 'employees',
        details: { employeeCode: employee_code, email: decoded.email, livenessActions },
        ip: req.ip
      });
    }

    // Enroll the captured face (step 3 of the registration sequence).
    const imagePath = `/uploads/faces/${imageFile.filename}`;
    const videoPath = videoFile ? `/uploads/face_videos/${videoFile.filename}` : null;
    await pool.query(
      `INSERT INTO employee_faces (employee_id, image_path, video_path, embedding, model_name) VALUES (?, ?, ?, ?, ?)`,
      [employee.id, imagePath, videoPath, JSON.stringify(embedding), 'insightface_buffalo_l/w600k_r50']
    );

    // Register the device (mirrors deviceController.registerDevice's rules).
    // A device can only ever belong to one employee, but an employee may register
    // and use multiple devices.
    const [existingDevice] = await pool.query('SELECT * FROM mobile_devices WHERE device_uid = ?', [device_uid]);
    let deviceStatus = 'pending';
    if (existingDevice[0]) {
      if (String(existingDevice[0].employee_id) !== String(employee.id)) {
        return res.status(409).json({
          success: false,
          message: 'This device is already registered to another employee. Contact your administrator if this isn\'t you.'
        });
      }
      deviceStatus = existingDevice[0].status;
    } else {
      await pool.query(
        `INSERT INTO mobile_devices (employee_id, device_uid, model, brand, os, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
        [employee.id, device_uid, device_model || null, device_brand || null, device_os || null]
      );
    }

    // The photo just captured this request became employee_faces' newest
    // row a few lines up, so this already picks it up -- the employee sees
    // the exact photo they just took, not a stale one from a previous
    // registration.
    const facePhotoUrl3 = await getLatestFacePhoto(employee.id);
    res.status(201).json({
      success: true,
      message: deviceStatus === 'approved' ? 'Device confirmed.' : 'Face registered — device pending admin approval.',
      token: issueEmployeeToken(employee),
      employee: employeePayload({ ...employee, face_photo_url: facePhotoUrl3 }),
      deviceStatus
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/employee-auth/device-status
// Used by the mobile app's "waiting for approval" screen to poll whether an
// admin has approved this employee's device yet.
async function deviceStatus(req, res, next) {
  try {
    const status = await getDeviceStatusFor(req.employee.id, req.query.device_uid);
    res.json({ success: true, deviceStatus: status });
  } catch (err) {
    next(err);
  }
}

module.exports = { login, googleLogin, linkDevice, deviceStatus, listDepartments };
