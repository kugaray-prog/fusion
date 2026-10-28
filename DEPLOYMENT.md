# Deploying GeoAttend Pro — Full Guide

## Before anything else: what "deploy on GitHub" actually means here

GitHub hosts your **code** — it doesn't run it. This app is a Node.js +
Express server backed by a MySQL database (plus a separate React Native
mobile app), and GitHub has no way to keep a Node process running or host a
database. GitHub Pages, specifically, only serves static HTML/CSS/JS — it
cannot run this server at all.

So "deploying on GitHub" really means two things:

1. **Get the code into a GitHub repository** (Part 1) — this is real and
   GitHub does it well: version control, collaboration, and it's what every
   hosting option below actually deploys *from*.
2. **Connect that repo to something that runs it** — a service that starts
   the Node process, keeps it running, and gives it a real MySQL database.
   GitHub Actions can *automate* step 2 (that's most of what "CI/CD" means),
   but the actual running of the app happens somewhere else.

This guide covers both, with two alternative paths for step 2:

| | **Option A — Docker** (default) | **Option B — Your own VPS, no Docker** |
|---|---|---|
| Best for | Running on this PC or any machine with Docker | Full control without containers |
| MySQL | The `db` container in `docker-compose.yml` (MySQL 8) | You install and manage it |
| HTTPS | The `tunnel` container (dev tunnel), or Nginx in front | You set it up (Nginx + Certbot, included below) |
| Cost | $0 on your own machine | A $5-6/mo VPS covers this app comfortably |
| Catch | The machine has to stay on | You own patching, backups, uptime |
| Ongoing effort | Low | Higher |

Pick **one**. Both are covered start to finish below; skip the one you're
not using.

Everything in this guide is specific to this repository as it exists today
— real script names, real environment variable names, and two things
verified directly from this project's own files that generic deployment
advice would miss:

- **MySQL 8.0 or newer is required**, not just "MySQL." `controllers/deviceController.js`
  uses a `ROW_NUMBER() OVER (...)` window function (added when the Device
  Management "View" feature was built) that MySQL 5.7 doesn't support at
  all. A host that defaults to 5.7 will fail confusingly on that one
  endpoint while everything else works.
- **One file in this repo, `models/w600k_r50.onnx`, is 174MB** — over
  GitHub's hard 100MB-per-file limit on a normal push. Part 7 covers
  exactly how to handle it.

---

## Prerequisites

- A GitHub account, with [Git](https://git-scm.com/downloads) installed locally.
- Node.js **18 or newer** (`package.json` requires it — `node -v` to check).
- Either [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Option A) or a VPS/cloud server you can SSH into (Option B, costs a few dollars a month).
- A [Google Cloud Console](https://console.cloud.google.com/) project, for:
  - A **Maps JavaScript API** key (the admin dashboard's map views).
  - An **OAuth 2.0 Client ID**, Web application type (mobile "Continue with Google").
- Your current `.env` file, open somewhere you can copy values from (**but see the security note in Part 5 before reusing any of them**).

---

## Part 1 — Get the code onto GitHub

### 1.1 What's already in place

This repo already includes everything this guide references:
`.gitignore`, `.env.example`, `Dockerfile`, `.dockerignore`,
`docker-compose.yml`, `ecosystem.config.js`, `nginx.conf.example`, and two
workflows under `.github/workflows/` (`ci.yml`, `deploy-vps.yml`). Nothing
to copy in — skip straight to 1.2.

> `deploy-vps.yml` is only relevant if you're doing Option B; it's harmless
> to leave in place either way (it only runs if you've added the `VPS_*`
> secrets it needs — see its own comments), but delete it if you'd rather
> not see it sit unused.

### 1.2 Initialize Git and make the first commit

```bash
cd geoattend-pro
git init                          # skip if this repo already has a .git folder
git add .
git status                        # sanity check before committing --
                                   # .env should NOT appear in this list.
                                   # If it does, your .gitignore isn't in
                                   # place yet -- fix that before committing.
git commit -m "Initial commit"
```

### 1.3 Create the GitHub repository and push

On GitHub: **New repository** → choose **Private** (this app handles real
employee data and a live database password ends up in its config — keep it
private) → don't initialize with a README (you already have one) → **Create**.

```bash
git branch -M main
git remote add origin https://github.com/<your-username>/geoattend-pro.git
git push -u origin main
```

If `git push` fails specifically on a *large file* error mentioning
`w600k_r50.onnx`, your `.gitignore` didn't catch it before the first `git add`
— see Part 7.

### 1.4 Confirm what actually got pushed

Open the repo on github.com and spot-check:

- `.env` should **not** be there. `.env.example` should.
- `models/det_10g.onnx` should be there (17MB, fine to commit — see Part 7).
- `models/w600k_r50.onnx` should **not** be there.
- `node_modules/`, `mobile/node_modules/`, and `uploads/` should not be there.

---

## Part 2 — Database

This app needs MySQL 8.0+ loaded with `database/schema.sql`, which creates
every table plus the default admin, the CSPC departments/offices and the
default settings.

**Option A (Docker):** nothing to do by hand. The `db` service in
`docker-compose.yml` runs MySQL 8 and loads `database/schema.sql`
automatically the first time it starts (while its `db_data` volume is still
empty). Its connection details:

| | From this PC (`npm start`, MySQL Workbench) | From the `app` container |
|---|---|---|
| Host | `localhost` | `db` |
| Port | `3307` | `3306` |
| User | `root` | `root` |
| Password | `geoattend_root` (or `MYSQL_ROOT_PASSWORD` in `.env`) | same |
| Database | `geoattend_pro` | same |

`docker-compose.yml` already sets the container-side values for the app, so
`.env` only needs the "from this PC" column.

To start over with an empty database (this **deletes all data**):

```bash
docker compose down -v      # removes the db_data volume
docker compose up -d        # schema.sql runs again on the fresh volume
```

**Option B (VPS)** — install MySQL yourself; Part 4.3 covers this.

Optional, either way: `npm run seed` (Docker: `docker compose exec app npm run seed`)
adds the sample employees and creates the admin from `DEFAULT_ADMIN_EMAIL` /
`DEFAULT_ADMIN_PASSWORD` in `.env`. The admin created by `schema.sql` is
`admin@my.cspc.edu.ph` / `password`. **Log in once and change that password
immediately** — Settings → Admin Accounts.

---

## Part 3 — Option A: Run with Docker

### 3.1 Configure

```bash
cp .env.example .env    # then fill in real values — see Part 5
```

Set `HOST_LAN_IP` in `.env` to this machine's Wi-Fi IPv4 (`ipconfig`) so
phones on the same network can reach it.

### 3.2 Start

```bash
docker compose up -d --build
docker compose ps             # db should show "healthy", app "running"
docker compose logs -f app    # look for "MySQL connected successfully."
```

The admin dashboard is at `http://localhost:3000`. Uploaded files are kept in
the `uploads` volume and the database in the `db_data` volume, so both
survive `docker compose down` / `up` and rebuilds (but not `down -v`).

### 3.3 Updates

```bash
git pull
docker compose up -d --build app
```

New columns/tables are added by `services/schemaUpgrades.js` when the app
starts, so an existing `db_data` volume doesn't need re-importing.

---

## Part 4 — Option B: Deploy to your own VPS

### 4.1 Provision the server

Any Ubuntu 22.04+ VPS with at least 1GB RAM works (DigitalOcean, Linode, AWS
Lightsail, etc. are all fine — pick whichever you're comfortable
administering). Point a domain's A record at its IP now, so it's ready by
the time you set up HTTPS.

Create a non-root user for deploys rather than using `root` directly:

```bash
ssh root@your-server-ip
adduser deploy
usermod -aG sudo deploy
su - deploy
```

### 4.2 Install Node, MySQL, PM2, and Nginx

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs mysql-server nginx
sudo npm install -g pm2

sudo mysql_secure_installation     # set a real MySQL root password when prompted
```

### 4.3 Set up the database

```bash
sudo mysql -u root -p -e "CREATE DATABASE geoattend_pro CHARACTER SET utf8mb4;"
sudo mysql -u root -p geoattend_pro < database/schema.sql
sudo mysql -u root -p geoattend_pro < database/migration_v15_cspc_email_domain.sql
sudo mysql -u root -p geoattend_pro < database/migration_v16_position_gender_classification.sql
sudo mysql -u root -p geoattend_pro < database/migration_v17_classification_remark_cleanup.sql
```

(You'll `git clone` the repo in the next step, before these commands can
actually reference `database/schema.sql` — adjust the order to taste, or run
this after 4.4.)

### 4.4 Clone the repo and configure

```bash
git clone https://github.com/<your-username>/geoattend-pro.git
cd geoattend-pro
cp .env.example .env
nano .env       # fill in real values -- see Part 5
npm ci --omit=dev
npm run seed
```

### 4.5 Start it with PM2

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup       # prints one command -- copy/paste and run it, so the app
                   # comes back up automatically after a server reboot
```

Confirm it's actually up: `curl http://localhost:3000/api/health` should
return `{"success":true,...}`.

### 4.6 Put Nginx in front of it, with HTTPS

```bash
cp nginx.conf.example /etc/nginx/sites-available/geoattend-pro
sudo nano /etc/nginx/sites-available/geoattend-pro   # replace your-domain.com
sudo ln -s /etc/nginx/sites-available/geoattend-pro /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

Certbot edits the Nginx config to serve HTTPS and sets up auto-renewal.
Your app is now live at `https://your-domain.com`.

### 4.7 Automate future deploys with GitHub Actions

1. On your **own machine** (not the server), generate a deploy key:
   ```bash
   ssh-keygen -t ed25519 -C "github-actions-deploy" -f deploy_key
   ```
2. On the **server**, add the public half:
   ```bash
   cat deploy_key.pub >> ~/.ssh/authorized_keys   # paste it there
   ```
3. This repo's GitHub **Settings → Secrets and variables → Actions**, add:
   - `VPS_HOST` — the server's IP or domain
   - `VPS_USER` — `deploy` (from step 4.1)
   - `VPS_SSH_KEY` — the contents of `deploy_key` (the *private* half)
   - `VPS_APP_PATH` — e.g. `/home/deploy/geoattend-pro`

From here, every push to `main` runs `.github/workflows/deploy-vps.yml`:
SSHes in, pulls, reinstalls, reseeds, and reloads via PM2 automatically.

---

## Part 5 — Environment variables reference

Every key `.env.example` lists, and where its value actually comes from:

| Key | Where it comes from |
|---|---|
| `PORT` | `3000` unless something else on the host needs that port (Docker sets it for the container) |
| `NODE_ENV` | `production` |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | Option A: the Docker MySQL from this PC — `localhost` / `3307` / `root` / `geoattend_root` / `geoattend_pro` (Part 2). Option B: your own values |
| `MYSQL_ROOT_PASSWORD` | Option A only, optional: the Docker MySQL root password (default `geoattend_root`). Set `DB_PASSWORD` to the same value |
| `JWT_SECRET` / `SESSION_SECRET` | Generate fresh, random values — command below |
| `DEFAULT_ADMIN_EMAIL` | Whatever you want the first admin login to be |
| `DEFAULT_ADMIN_PASSWORD` | A strong temporary password — change it after first login |
| `GOOGLE_MAPS_API_KEY` | Google Cloud Console → Credentials → API key, restricted to Maps JavaScript API |
| `GOOGLE_CLIENT_ID` | Google Cloud Console → Credentials → OAuth Client ID (Web application) |
| `GOOGLE_ANDROID_CLIENT_ID` | Same screen, Android application type — only needed for a native Android Google Sign-In build |
| `ATTENDANCE_MAX_ACCURACY_METERS` | `100` for production (the shipped `500` default is loosened for desktop testing only) |

Generate the two secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Run it twice — `JWT_SECRET` and `SESSION_SECRET` must be different values.

> **Security note on your current `.env`:** whatever database password, JWT
> secret, and API keys are sitting in your existing local `.env` file should
> be treated as no longer private the moment that file leaves your machine
> for any reason (shared with someone, included in a zipped copy of the
> project, pasted somewhere). Generate **new** values for all of the above
> for this deployment rather than copying the old ones over — it costs
> nothing and closes that door.

For the Google OAuth Client ID specifically: add your deployed URL (the dev
tunnel's `https://...devtunnels.ms` URL, or `https://your-domain.com`) to
**Authorized JavaScript origins** in Google Cloud Console, or the mobile
app's "Continue with Google" button will fail.

---

## Part 6 — Point the mobile app at your deployed backend

The mobile app's API URL isn't read from the server's `.env` — it's
configured separately in `mobile/app.json`, under `expo.extra`:

```json
{
  "expo": {
    "extra": {
      "apiBaseUrl": "https://your-domain.com/api",
      "googleWebClientId": "<your GOOGLE_CLIENT_ID>",
      "googleAndroidClientId": "<your GOOGLE_ANDROID_CLIENT_ID>"
    }
  }
}
```

(`mobile/src/config.js` reads these; without `apiBaseUrl` set, it falls back
to a placeholder LAN IP that only ever worked for local development. The
same value also derives where the mobile app loads uploaded photos from —
the Profile screen's own picture — so a wrong `apiBaseUrl` here shows up as
a broken image there too, not just failed API calls. The admin web
dashboard's own photo displays are unaffected by this — those are served by
the same Node process the browser is already talking to, so they just use
relative paths.)

Commit this change and push — it takes effect the next time the mobile app
is built, not the running admin dashboard (that part is already live from
Parts 3/4).

---

## Part 7 — The face-recognition model files, precisely

This repo ships two ONNX model files under `models/`:

| File | Size | In this repo's Git history? |
|---|---|---|
| `det_10g.onnx` | ~17MB | **Yes** — small enough, committed normally |
| `w600k_r50.onnx` | ~174MB | **No** — `.gitignore`d, over GitHub's 100MB hard limit |

GitHub rejects any single file over 100MB in a normal `git push` outright —
this isn't a soft warning, the push fails. `w600k_r50.onnx` is well over
that, which is why it's excluded.

**If you're using the included `Dockerfile`:** nothing to do — it downloads
this file automatically during the image build, using the exact command
`models/README.md` documents (from InsightFace's official `buffalo_l`
release on GitHub).

**If you're deploying without Docker** (a bare VPS running `npm start`
directly), download it once, manually, on the server:

```bash
cd geoattend-pro
curl -L -o /tmp/buffalo_l.zip https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip
unzip -o /tmp/buffalo_l.zip w600k_r50.onnx -d models/
rm /tmp/buffalo_l.zip
```

Until that file is in place, Face Verification specifically fails with a
clear setup error — every other part of the app (attendance, geofencing,
reports, ratings, device management, and so on) works normally regardless.

**Licensing note:** the `buffalo_l` model weights are available for
non-commercial research use per InsightFace's model zoo terms. If this
deployment is for commercial use, secure a commercial license or swap in a
model you've separately cleared — `models/README.md` covers what a
drop-in replacement detector/recognizer needs to match.

---

## Part 8 — Building and distributing the mobile app

The mobile app doesn't "deploy" the way the backend does — it needs to be
built into an actual installable app, then either side-loaded directly or
submitted to an app store. **Android can be entirely free, start to
finish. iOS cannot** — Apple requires a paid Developer account for any real
distribution, with no free alternative; the honest details are below rather
than a "workaround" that doesn't actually exist.

### 8.1 One-time setup

```bash
cd mobile
npm install
npm install -g eas-cli
eas login          # creates a free expo.dev account if you don't have one
eas build:configure
```

`eas build:configure` writes `mobile/eas.json` (build profiles) and asks a
few questions about the project — accept the defaults unless you have a
reason not to.

**Free plan limits** (current as of this guide, Expo's own pricing page has
the up-to-date numbers if it's been a while): **15 Android + 15 iOS builds
per month**, no credit card required, builds queue behind paying customers'
so may take a little longer. Plenty for building this app and iterating on
it; if you're doing rapid back-to-back rebuilds while debugging a build
issue specifically, you can burn through 15 faster than expected.

### 8.2 Android — free, start to finish

```bash
eas build --platform android --profile preview
```

This produces a downloadable `.apk` (a link is printed when the build
finishes, and it's on your expo.dev dashboard too). From here:

- **Direct install (fully free, no store at all):** send that `.apk` link
  to anyone with an Android phone. They'll need to allow "install from
  unknown sources" for their browser/file manager the first time — a normal
  Android setting, not a jailbreak or anything unusual. This alone
  satisfies "the app deployed to Android, for free" completely.
- **Google Play Store (one-time $25, not a subscription):** if you want it
  properly listed and auto-updating through Play, that requires a [Google
  Play Console](https://play.google.com/console) account, which has a
  one-time $25 registration fee — this is the one cost in this whole guide
  that isn't avoidable if you specifically want the Play Store; direct
  `.apk` install above has no such fee. If you do register:
  ```bash
  eas build --platform android --profile production   # produces a .aab, the format Play requires
  eas submit --platform android
  ```

### 8.3 iOS — requires Apple's $99/year Developer Program; no free path exists

Being direct about this rather than implying otherwise: Apple does not
allow installing a normal build on a real iPhone, by any method, without
enrolling in the [Apple Developer Program](https://developer.apple.com/programs/)
($99/year). This isn't an Expo/EAS limitation — EAS Build will happily
produce an iOS build on the free plan (it's included in the same 15+15
monthly builds), the wall is entirely on Apple's side for getting that
build onto a device.

- **What that $99/year unlocks:** TestFlight (Apple's beta-testing
  distribution — the practical way to share an iOS build with testers) and
  eventual App Store submission.
  ```bash
  eas build --platform ios --profile production
  eas submit --platform ios
  ```
- **The closest thing to "free" for iOS** is Xcode's free-provisioning
  path: on a Mac, with a free Apple ID (no paid account), you can build and
  run the app directly on your own iPhone via a USB-connected Xcode build.
  It expires and needs re-signing every **7 days**, only works on devices
  you personally plug in, and needs a Mac — genuinely free, but a
  development convenience, not a "deployed app" anyone else can install.
  [Expo's guide for this](https://docs.expo.dev/guides/local-app-production/)
  covers the local build steps if you want to go this route.
- **If budget allows even a one-time entry:** the $99/year is Apple's
  price for every iOS developer, individual hobbyist or company — there's
  no cheaper official tier.

### 8.4 Point the build at your deployed backend

Whichever platform, do Part 6 **before** running `eas build`
(above — it comes before this section) — `mobile/app.json`'s `apiBaseUrl`
is baked into the build at build time, not read at runtime, so a build made
before that change still points at whatever URL was in there when it ran.

---

## Part 9 — Security checklist before you consider this "live"

- [ ] Changed the seeded admin password (Settings → Admin Accounts) — don't leave `DEFAULT_ADMIN_PASSWORD` active.
- [ ] `JWT_SECRET` and `SESSION_SECRET` are freshly generated, not reused from any prior `.env`.
- [ ] `DB_PASSWORD` is a new value, not reused from any prior `.env`.
- [ ] `ATTENDANCE_MAX_ACCURACY_METERS` lowered from the testing default of `500` to something like `100`.
- [ ] `GOOGLE_MAPS_API_KEY` restricted to your domain in Google Cloud Console (an unrestricted key can be used by anyone who finds it).
- [ ] HTTPS is actually active (Docker: through the dev tunnel or Nginx; VPS: confirmed via Part 4.6) — an attendance/geofencing app should never run over plain HTTP.
- [ ] The GitHub repo is **Private**.
- [ ] `.env` is confirmed absent from the repo (Part 1.4).
- [ ] MySQL is not reachable from the public internet on a VPS (bind to `127.0.0.1` in `/etc/mysql/mysql.conf.d/mysqld.cnf` unless something outside the server genuinely needs direct access).

---

## Part 10 — Verify the deployment

```bash
curl https://your-domain.com/api/health
# {"success":true,"message":"GeoAttend Pro API is running.","environment":"production"}
```

Then, in a browser: load the admin dashboard, log in with the seeded admin
account, and check that a page which touches the database — Employees or
Departments — actually loads data. That confirms the app, the database
connection, and the schema are all correctly wired together end to end.

---

## Part 11 — Keeping it running

- **Updates:** push to `main` → your chosen workflow deploys automatically. `ci.yml` runs on every push/PR regardless of which deploy path you picked, catching an obvious syntax mistake before it reaches production.
- **Database backups:**
  ```bash
  # Docker
  docker compose exec db mysqldump -u root -pgeoattend_root geoattend_pro > backup_$(date +%Y%m%d).sql
  # VPS
  mysqldump -u root -p geoattend_pro > backup_$(date +%Y%m%d).sql
  ```
  Automate this with a daily scheduled task / cron job. Restore with
  `docker compose exec -T db mysql -u root -pgeoattend_root geoattend_pro < backup.sql`.
- **Logs:**
  - Docker: `docker compose logs -f app`
  - VPS: `pm2 logs geoattend-pro`
- **Uploaded files** (`uploads/` — employee photos, OCR scans, etc.) live in
  the `uploads` Docker volume (Option A) or on the server's disk (Option B).
  Back them up the same way as the database.

---

## Quick reference

```bash
# First-time setup (either path)
git clone <your-repo-url> && cd geoattend-pro
cp .env.example .env    # fill in real values
npm ci
npm run seed

# Local run
npm start                # http://localhost:3000
npm run dev               # same, but auto-restarts on file changes

# Database
mysql -u root -p geoattend_pro < database/schema.sql
mysql -u root -p geoattend_pro < database/migration_v15_cspc_email_domain.sql
mysql -u root -p geoattend_pro < database/migration_v16_position_gender_classification.sql
mysql -u root -p geoattend_pro < database/migration_v17_classification_remark_cleanup.sql

# Docker
docker compose up -d --build     # app on http://localhost:3000, MySQL on localhost:3307
docker compose logs -f app
docker compose down -v           # wipe the database (schema.sql reloads on next up)

# VPS process management
pm2 restart geoattend-pro
pm2 logs geoattend-pro
pm2 status
```
