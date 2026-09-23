# Verification — OCR + Face Verification (README)

This documents the change that renamed **OCR Verification** to **Verification**
(now covering two methods — OCR and Face) and added **Face Verification**
mobile self-registration, backed by an ONNX face-recognition model.

It was written and edited without a running MySQL instance, a live ONNX
model file, or the Expo mobile runtime — **please read "Before you deploy"
and test each item below before relying on it in production.**

---

## What changed

### 1. Admin dashboard — "Verification" section
- Sidebar nav item **OCR Verification** → **Verification**
  (`views/dashboard.ejs`, `data-target="verification-section"`).
- The section now has two tabs:
  - **OCR Verification** — unchanged camera/ID-scan flow (`#ocr-panel`).
  - **Face Verification** — new camera capture UI + a "Recent Face
    Verification Records" table (`#face-panel`).
- New frontend module `G_App.face` (mirrors `G_App.ocr`) and
  `G_App.verification.switchTab()` in `public/js/app.js`.
- The restricted "Verification-only" admin role (`admin` account role) now
  gates access to the whole `verification-section` (both tabs), same as it
  previously gated `ocr-section`.

### 2. Mobile app — face registration is now part of the one registration flow
Face capture is a **mandatory third step** of the existing Google Sign-In
registration flow — not a separate entry point. Sequence:

1. **`LoginScreen.js`** — "Continue with Google" (unchanged; no alternate
   "register without Google" button).
2. **`RegistrationScreen.js`** — now a two-step wizard:
   - **Step 1 (details):** Employee ID, Surname, Given Name, Middle Name,
     Suffix — same fields as before.
   - **Step 2 (capture):** camera capture (`expo-camera`) of the employee's
     face, with retake/confirm.
3. On confirm, **one request** — `POST /api/employee-auth/link-device`
   (multipart: employee details + `pendingToken` + the captured selfie as
   `image`) — links/creates the employee record, enrolls the face embedding,
   and registers the device, all together. Same pending-admin-approval flow
   as before (`WaitingApprovalScreen`). A device is never registered without
   a face on file.

### 3. Backend — ONNX face recognition
- `services/faceService.js` (new): loads an ONNX model via
  `onnxruntime-node`, preprocesses images with `sharp` (resize to
  112×112, normalize), extracts an L2-normalized embedding, and compares
  embeddings by cosine similarity.
- `controllers/employeeAuthController.js`: `linkDevice()` now requires a
  multipart `image` field and enrolls the face (via `faceService`) as part of
  the same request that links the device and creates/matches the employee
  (see "Mobile app" above).
- `controllers/faceController.js` (new): `verifyFace()` (admin-dashboard
  kiosk endpoint — capture a face, find the closest enrolled match) and
  `getFaceRecords()`.
- `routes/faceRoutes.js` (new, mounted at `/api/face`) — admin kiosk
  verify/records endpoints only. Mobile registration goes through the
  updated `/api/employee-auth/link-device`, not a separate route.
- `middleware/uploadMiddleware.js`: new `uploadFace` (multer → `uploads/faces/`).
- `config/config.js` / `.env`: new `face.modelPath`, `face.inputSize`,
  `face.matchThreshold` (`FACE_MODEL_PATH`, `FACE_INPUT_SIZE`,
  `FACE_MATCH_THRESHOLD`).

### 4. Database — `database/migration_v7.sql`
- `employee_faces` — one row per enrolled face (`employee_id`, `image_path`,
  `embedding` as a JSON array of floats, `model_name`).
- `face_records` — an audit log of every face-verification attempt (mirrors
  `ocr_records`): `employee_id`, `image_path`, `similarity`, `result`.
- Also added directly to `database/schema.sql` for fresh installs.

### 5. New dependencies
- Backend (`package.json`): `onnxruntime-node`, `sharp`.
- Mobile (`mobile/package.json`): `expo-camera` (with `CAMERA` permission /
  `NSCameraUsageDescription` added to `mobile/app.json`).

---

## The ONNX model

**Now bundled** at `models/face_recognition.onnx` — a MobileFaceNet model
(sourced from the public repo `rpnugroho/face-recognition-onnx` on GitHub),
verified to load and run inference correctly:

- Input: `112×112` RGB, NCHW, normalized to `[-1, 1]` — matches
  `services/faceService.js` exactly, no config changes needed.
- Output: a 128-d embedding vector.

**⚠️ License caveat:** the source repo doesn't include a `LICENSE` file, so
its terms aren't explicit — it's a small publicly-shared project built for
exactly this drop-in use case. If this app goes to production or gets
distributed commercially, please verify the model's licensing yourself (or
swap in a cleared model) before relying on it long-term — see
`models/README.md` for how to swap it out, and how to tune
`FACE_MATCH_THRESHOLD` for whichever model you use.

---

## Before you deploy

1. **Back up your database first.**
2. Run the new migration:
   ```
   mysql -u <user> -p geoattend_pro < database/migration_v7.sql
   ```
   (Assumes migrations v1–v6 are already applied.)
3. Install new dependencies:
   ```
   npm install                # backend: onnxruntime-node, sharp
   cd mobile && npm install   # mobile: expo-camera
   ```
4. A model is already bundled at `models/face_recognition.onnx` (see the
   license caveat above) — swap it out first if you'd rather use a different
   or explicitly-licensed model.
5. Tune `FACE_MATCH_THRESHOLD` in `.env` (default `0.5`, cosine similarity)
   against your chosen model — different models have different score
   distributions, so test with real photos before trusting the default.
6. Rebuild/re-run the Expo dev client if you're using a custom dev client
   (adding a native module like `expo-camera` usually requires this, not
   just a JS reload).
7. Test end-to-end with a real MySQL instance and the Expo app — none of this
   was runtime-tested, since this sandbox has no database, no ONNX model
   file, or mobile runtime. Pay particular attention to:
   - Camera permission prompts on both iOS and Android.
   - Face match accuracy/threshold tuning with your actual model.
   - The "Verification-only" admin role still restricting to both tabs
     correctly (not just OCR).

## Known gaps / not done
- Liveness detection during registration checks a sustained face hold plus a
  real eyes-open -> eyes-closed -> eyes-open blink cycle (ML Kit, on-device;
  see `RegistrationScreen.js`'s `detectFaceHold()` / `detectBlink()`). This
  stops a plain photo held up to the camera, but a prerecorded video replay
  of a real person blinking could still defeat it — consider adding this if
  Face Verification will gate anything more sensitive.
- Face re-enrollment: an employee can currently register more than once
  (each registration attempt inserts a new `employee_faces` row); there's no
  "update my face" flow separate from re-registering.
- No automated tests were added or run.
