# Load testing GeoAttend Pro with Apache JMeter

`geoattend-load-test.jmx` simulates two groups of users at the same time:

| Thread group | What each virtual user does (in a loop, 1–3 s apart) |
|---|---|
| **Admin Dashboard Users** (`USERS`) | `GET /api/dashboard/stats`, `/api/dashboard/department-attendance`, `/api/dashboard/recent-activity`, `/api/employees?page=1&limit=20`, `/api/attendance`, `/api/devices`, `/api/events` |
| **Public Page Visitors** (`PUBLIC_USERS`) | `GET /` (dashboard page), `GET /js/app.js`, `GET /api/health` |

Before either group starts, a **setup** step logs in once as the admin and
shares that token with every virtual user. Every request is checked for
**HTTP 200** and for finishing within **`MAX_MS`** (default 3000 ms).

All requests are read-only; the test creates, changes and deletes nothing.

## What is *not* covered

The mobile app's employee endpoints (check-in, face verification, heartbeat,
device status) need an employee token, which only comes from a real Google
sign-in on a phone, so JMeter can't obtain one. Face verification is also far
heavier than anything here (a face-recognition model runs for each photo).
Measure it separately with a few real phones checking in at once while the
test runs.

## 1. Install JMeter

1. Install Java 17 or newer (`java -version` to check).
2. Download the **binaries** zip of Apache JMeter 5.6.3 from
   https://jmeter.apache.org/download_jmeter.cgi and unzip it, e.g. to
   `C:\apache-jmeter-5.6.3`.
3. Check it runs: `C:\apache-jmeter-5.6.3\bin\jmeter.bat --version`.

To look at or edit the plan, open `jmeter.bat` (the GUI) and **File → Open**
this `.jmx`. Use the GUI only for editing; run real tests from the command
line (step 3), since the GUI itself slows JMeter down and skews results.

## 2. Choose where to point it

**Test against a local server first.** The live Render deployment is not a
good load-test target yet:

- **Rate limits.** In production, `/api` allows 1000 requests per 15 minutes
  and admin login allows 10 per 15 minutes. A load test burns through 1000
  requests in a couple of minutes, after which everything returns **429**,
  which measures the limiter, not the system.
- **Real users share that limit.** The server doesn't set Express's
  `trust proxy`, so behind Render's proxy it likely can't tell users' IPs
  apart. A test that hits the limit can lock real employees and admins out
  for up to 15 minutes.
- **Free tier.** Render's free instance has 0.1 CPU and 512 MB, and the free
  Aiven MySQL has few connections. Results show the free tier's limits.
  Heavy load can also crash the instance (it restarts on its own).

### Local server (recommended)

Run the server in development mode (no rate limits) against your **local**
MySQL, not Aiven, so the test never touches production data:

```powershell
cd C:\geoattend-pro
$env:PORT='3100'; $env:NODE_ENV='development'
$env:DB_HOST='localhost'; $env:DB_PORT='3306'; $env:DB_USER='root'
$env:DB_PASSWORD='<local mysql password>'; $env:DB_NAME='geoattend_pro'; $env:DB_SSL_CA=''
node server.js
```

(Environment variables set this way override `.env`, which points at Aiven.)

### Production (only small, planned runs)

If you must test the live site, keep it under the rate limit, run it when
nobody is using the system, and tell users beforehand. Example that stays
around 300 requests: `-JUSERS=5 -JPUBLIC_USERS=2 -JDURATION=120 -JTHINK_MIN=2000 -JTHINK_MAX=4000`.
Open the site once beforehand so the instance is awake (a sleeping free
instance takes ~50 s to start and fails the first requests).

## 3. Run the test

From the project folder (PowerShell). Replace the paths and password:

```powershell
C:\apache-jmeter-5.6.3\bin\jmeter.bat -n -t loadtest\geoattend-load-test.jmx `
  -JHOST=localhost -JPORT=3100 -JPROTOCOL=http `
  -JADMIN_EMAIL=admin@my.cspc.edu.ph -JADMIN_PASSWORD=<admin password> `
  -JUSERS=20 -JPUBLIC_USERS=10 -JRAMP=20 -JDURATION=120 `
  -l loadtest\results\run1.jtl -e -o loadtest\results\run1-report
```

For Render use `-JHOST=geoattend-pro-njgh.onrender.com -JPORT=443 -JPROTOCOL=https`.

`-n` runs without the GUI; `-l` saves every request; `-e -o` builds an HTML
report (the `-o` folder must not already exist, so use a new name per run).
While it runs, JMeter prints a summary line every 30 s.

| Property | Default | Meaning |
|---|---|---|
| `HOST` / `PORT` / `PROTOCOL` | `localhost` / `3000` / `http` | Server to test |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin@my.cspc.edu.ph` / *(none)* | Admin account for the setup login |
| `USERS` | `10` | Concurrent admin dashboard users |
| `PUBLIC_USERS` | `5` | Concurrent anonymous visitors |
| `RAMP` | `30` | Seconds to start all users gradually |
| `DURATION` | `120` | Seconds the test runs |
| `THINK_MIN` / `THINK_MAX` | `1000` / `3000` | Random pause between a user's requests (ms) |
| `MAX_MS` | `3000` | A response slower than this counts as an error |

If the run stops immediately with "Admin login failed", the password is wrong
or the login limit (10 per 15 min) was hit; wait 15 minutes.

## 4. Suggested test series

Run each step, read the report, then move to the next. Stop when error % or
the 95th percentile climbs sharply; the step before that is your capacity.

| Test | Settings | Purpose |
|---|---|---|
| Smoke | `USERS=2 PUBLIC_USERS=1 DURATION=60` | Plan works, no errors |
| Load | `USERS=20 PUBLIC_USERS=10 DURATION=300` | Normal expected use |
| Stress | `USERS=50`, then `100`, `200` … `DURATION=300` | Find the breaking point |
| Soak | Load settings, `DURATION=1800` | Memory leaks, slowdowns over time |

## 5. Read the results

Open `loadtest\results\<run>-report\index.html`.

- **Statistics** table: per request, **Average**, **90th / 95th / 99th pct**
  (95% of requests were faster than this), **Error %** and **Throughput**
  (requests per second).
- **Errors** table: why requests failed. `429` means rate-limited,
  `5xx` means server errors or a crashed instance, and "operation lasted too
  long" is a slow but otherwise successful response (over `MAX_MS`).
- **Response Times Over Time** / **Active Threads Over Time**: how response
  time changed as users were added.

Rules of thumb for a pass: error % under 1%, 95th percentile under 2–3 s,
and throughput rising as users are added. If throughput flattens while
response times climb, the server is saturated.

Results (`loadtest/results/`) are git-ignored.

## Reference run (local, 2026-09-24)

Local server (development mode, local MySQL) on the developer's PC, 20 admin
users + 10 visitors, 20 s ramp-up, 120 s: **1,609 requests, 13.1 req/s,
average 23 ms, 0.31% errors**. All 5 errors were HTTP 200 responses over the
3 s limit during one brief slowdown, mostly on `GET /api/devices`
(max 5.5 s). This checks that the plan works; it says nothing about Render's
capacity, which is much smaller.
