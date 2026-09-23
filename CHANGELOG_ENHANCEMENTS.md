# GeoAttend Pro — Enhancement Changelog

This documents the changes made against the 12-item enhancement spec. It was
written and edited without access to a running MySQL instance or the Expo
mobile app, so **please read "Before you deploy" below and test each item
before relying on it in production.**

## 1. Mark Attendance button state
- `mobile/src/screens/AttendanceScreen.js`: on mount, checks `/attendance/my-history`
  for an existing record against the active event today. If found, the button
  shows "Attendance Recorded" and is disabled — persisted across refresh/app
  restart (re-derived from the server, not local state).
- Duplicate prevention already existed server-side (`submitAttendance`'s
  `dupRows` check); the button now reflects that instead of allowing a second tap.

## 2. Recurring / multi-day Flag Ceremony events
- `database/migration_v4.sql`: adds `recurrence_type`, `recurrence_days`,
  `recurrence_end_date`, `is_recurring_parent`, `parent_event_id` to `events`.
- `controllers/geofenceController.js`: `createGeofence` now expands a weekly
  recurrence (selected weekdays, until an end date) into one `events` +
  `geofences` row per occurrence, each with its own attendance records,
  linked via `parent_event_id`.
- Admin UI: new "Recurring Schedule" section in the Geo-Fences form
  (weekday chips + "Repeat Until" date).
- **Not implemented**: arbitrary "specific dates" / date-range recurrence
  (only weekly-by-weekday). Extend `expandRecurrenceDates()` in
  `geofenceController.js` if you need that.

## 3. CSPC default Geo-Fence location
- `config/config.js` + `database/migration_v4.sql` (`settings` table) both
  carry CSPC's coordinates (13.4079, 123.3735 — Nabua campus, approximate;
  **please verify/correct this** from Google Maps before relying on it).
- New `GET /api/geofences/default-location` endpoint.
- Admin map now centers on CSPC by default, and a "Use CSPC Default Location"
  button fills the lat/lng fields.

## 4. Reports and Ratings
- Backend review found `reportController.js` and `ratingController.js`
  already functionally correct (filters, export, empty states). If they were
  "non-functional" in your deployment, it was most likely a missing
  `employee_ratings` table or stale `.env` — **run the migrations below and
  re-test**; I could not reproduce a bug without a live DB.
- Ratings now also show the new literal "Rating Points" column (see #6).

## 5. Employee Management navigation
- Removed the duplicate CRUD table from Settings. The **Employees** section
  now has the full CRUD (Add/Edit/Delete/Remark), CSV/Excel export, and the
  new Batch Import button. Settings keeps only Certificates + Admin Accounts.

## 6. Automatic attendance rating
- The existing percentage-based `attendance_score` recalculation now also
  runs after admin edits/deletes (previously only ran after a mobile
  submission) via new `PATCH /api/attendance/:id` and `DELETE /api/attendance/:id`.
- Added a **literal** "5 Attended = 1 point, 1 No-Attendance = −1" counter as
  `employees.rating_points`, recalculated alongside the percentage score on
  every add/update/delete (`recalculateAllRatings()` in `attendanceController.js`).
  This is additive — the existing percentage score and the Monday 1–5 rating
  table are unchanged and still work as before.

## 7. Events — View All
- New `controllers/eventController.js` + `routes/eventRoutes.js` → `GET /api/events`
  (search + upcoming/ongoing/completed filter) and `GET /api/events/:id/occurrences`.
- New "Events" nav item / section in the dashboard.

## 8. Geo-Fences — 3 most recent + View All
- `getGeofences` now orders by `events.created_at DESC` (was `start_datetime`).
- Admin UI shows only the 3 most recent by default with a "View All" toggle.

## 9. Batch import employees (CSV/Excel)
- `employeeController.importPreview` / `importCommit` (no new dependency —
  reused `exceljs`, which reads both CSV and XLSX).
- Two-step flow: `POST /api/employees/import/preview` (parses + validates,
  writes nothing) → admin reviews → `POST /api/employees/import/commit`
  (re-validates and inserts only the confirmed valid rows, transactionally).
- New "Batch Import" modal in the Employees section.

## 10. Dashboard — department attendance graph + classification
- New `GET /api/dashboard/department-attendance` (total vs. attended per
  department, filterable by event/classification).
- `classification` column added to `employees` (Regular/COS/Casual,
  backfilled from the existing `status` column).
- Dashboard now shows a grouped bar chart (Total vs. Attended per department)
  and a classification doughnut chart.

## 11. Attendance organized by Event
- `GET /api/attendance/by-event` replaces the department-folder view.
  Attendance tab now shows one card per event; opening one calls
  `GET /api/attendance?event_id=...` for that event's records only.

## 12. Automatic end-time via Geo-Fence exit
- `database/migration_v4.sql`: `attendance.last_lat/last_lng/last_ping_at/outside_streak/auto_ended`.
- New `POST /api/attendance/:id/heartbeat` (employee JWT). The mobile app
  pings it every ~25s while a session is open; the server closes the session
  (`time_out`, `work_hours`) only after **2 consecutive outside-geofence
  pings** (`config.attendance.autoEndOutsideStreakThreshold`), so one bad GPS
  reading won't end it early.
- `mobile/src/screens/AttendanceScreen.js` now starts this heartbeat after a
  successful submission and shows "Session Ended" once the server closes it.

---

## Before you deploy

1. **Back up your database first.**
2. Run the new migration:
   ```
   mysql -u <user> -p geoattend_pro < database/migration_v4.sql
   ```
   (Migrations v1–v3 should already be applied; this assumes your DB matches
   the state after `migration_v3.sql`.)
3. Double-check the CSPC coordinates in `database/migration_v4.sql` /
   `config/config.js` are actually correct for your campus, and adjust if not.
4. `npm install` (no new backend dependencies were added — `exceljs` and
   `json2csv` were already in `package.json`).
5. Test each numbered item above against a real MySQL instance and the Expo
   app — none of this was runtime-tested, since this sandbox has no database
   or mobile runtime. Pay particular attention to:
   - The recurring-event date math in `expandRecurrenceDates()`.
   - The geofence-exit heartbeat's outside-streak threshold — tune
     `ATTENDANCE_AUTO_END_STREAK` / `ATTENDANCE_HEARTBEAT_MIN_SECONDS` in
     `.env` if it ends sessions too eagerly/slowly for your GPS conditions.
   - The batch import with a real HR export file (header names vary a lot in
     practice — `normalizeImportRow()` in `employeeController.js` has a small
     alias list you may need to extend).

## Known gaps / not done
- Reports/Ratings filters weren't extended to include `event_id`/`status` in
  the Reports UI (the backend already supports them via `reportController.js`;
  just not wired into `dashboard.ejs`'s Reports form).
- "Specific dates" / date-range recurrence (only weekly-by-weekday is implemented).
- No automated tests were added or run.
