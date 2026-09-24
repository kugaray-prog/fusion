# Load-test cases LT-01 – LT-10

Scripted JMeter runs for the ten load-testing test cases, plus database
checks that confirm every record was written exactly once. They run against a
**local copy of the server and a separate local database**
(`geoattend_loadtest`), never production: most cases write hundreds of fake
employees, check-ins, devices and faces.

| Case | Scenario | How it's simulated |
|---|---|---|
| LT-01 | 50 employees submit within 1 minute | 50 users, one check-in each, spread over 60 s |
| LT-02 | 150 employees submit within 1 minute | 150 users over 60 s (2.5/s) |
| LT-03 | 5 HRMDU admins generate reports at once | 5 admins released together, 3 rounds each of: report (year), report (department), insights, CSV export, Excel export. A probe times `/api/health` and `/api/dashboard/stats` for 20 s before and throughout |
| LT-04 | Peak load sustained for 10 minutes | 1,500 check-ins at LT-02's peak rate (2.5/s) for 600 s |
| LT-05 | Spike from 10 to 200 concurrent submissions | 10 check-ins over 10 s, then 200 released at the same instant |
| LT-06 | 291 employees within 5 minutes | 291 users over 300 s |
| LT-07 | 50 new employees register at once | 50 device + face registrations (`/api/employee-auth/link-device`) released together, each a new employee with a real face photo |
| LT-08 | Heartbeats from 100 active sessions | 100 open sessions each ping 10× from inside the geofence (21 s apart), then 2× from outside (must auto-close on the 2nd), then once more (must stay closed) |
| LT-09 | Concurrent kiosk face verification | 10 admin kiosk requests (`/api/face/verify`) released together, 5 rounds, against 291 enrolled faces |
| LT-10 | 30 users on slow connections | Bandwidth limited to 1,280 bytes/s; each user's check-in is sent again 1 s later (a retry / double-tap). Exactly one of each pair may be recorded |

`race-check.js` is an extra check for LT-05/LT-10: 50 employees each send two
identical check-ins at the same instant, then it counts duplicate rows.

Every simulated phone sends its own `CF-Connecting-IP`, so each gets its own
rate-limit bucket, as real phones behind Cloudflare do. Employees stand on a
grid ~16 m apart (wider than the co-location check's ~11 m), so no check-in is
flagged as one person carrying two phones.

## Run it

Requirements: local MySQL 8, Node, Apache JMeter 5.6.3 (see `../README.md`).

1. **Build the test database and JMeter inputs.** Drops and recreates
   `geoattend_loadtest` (it refuses any database name without "loadtest"):
   ```bash
   LT_DB_PASSWORD=<local mysql password> node loadtest/cases/prepare.js
   ```
   It seeds 2,331 employees with approved devices, one ongoing event per case,
   40 past weekly flag ceremonies (11,640 attendance rows, for reports) and
   291 enrolled faces, and writes signed tokens to `loadtest/cases/data/`
   (git-ignored). The kiosk and registration cases use face photos from
   `uploads/`; point `LT_ENROLL_IMAGE`, `LT_KIOSK_IMAGE` and `LT_REG_IMAGE`
   at other photos if those aren't there.

2. **Start the server against it** (Bash; an empty `DB_SSL_CA` turns off the
   Aiven certificate from `.env`):
   ```bash
   PORT=3200 NODE_ENV=production DB_HOST=localhost DB_USER=root DB_PASSWORD=<pw> \
   DB_NAME=geoattend_loadtest DB_SSL_CA= JWT_SECRET=loadtest-secret-not-for-production \
   node server.js
   ```
   To approximate a 1-CPU cloud server, pin it to one core (PowerShell):
   `(Get-Process -Id <pid>).ProcessorAffinity = 1`.

3. **Run a case**, then check the database:
   ```bash
   jmeter -n -t loadtest/cases/geoattend-test-cases.jmx -q loadtest/cases/data/run.properties \
     -JCASE=LT-01 -l results/LT-01.jtl
   LT_DB_PASSWORD=<pw> node loadtest/cases/verify.js LT-01
   node loadtest/cases/summarize.js results/LT-01.jtl
   ```
   - LT-10 also needs `-Jhttpclient.socket.http.cps=1280` (slow link).
   - `summarize.js --per-minute` gives LT-04's per-minute stability.
   - `summarize.js --split-at=20` compares LT-03's probe before and during reports.
   - Run each case once per `prepare.js`. A second run finds its employees
     already checked in (409).

`geoattend-test-cases.jmx` is generated. Change `build-plan.js` and run
`node loadtest/cases/build-plan.js` instead of editing the XML.

## Gotchas found while running these

- On a PC short on RAM, Windows paging causes multi-second stalls that look
  like slow requests. Check free memory before a run; close heavy apps.
- MySQL's default full-durability mode (`innodb_flush_log_at_trx_commit=1`,
  `sync_binlog=1`) on a laptop disk adds 0.5–1.5 s stalls per commit. For
  application numbers, relax it for the test session
  (`SET GLOBAL innodb_flush_log_at_trx_commit=2; SET GLOBAL sync_binlog=0;`)
  and set both back to `1` afterwards.
