/**
 * Copies photos that already exist (from before services/uploadStore.js)
 * into the stored_uploads table, so they survive the host wiping uploads/.
 *
 *   node database/backfill-uploads.js [--from=https://geoattend-pro-njgh.onrender.com]
 *
 * Uses the DB_* settings from .env. For every photo path the database
 * refers to that has no stored copy yet, it reads the file from the local
 * uploads/ folder, or, failing that, downloads it from --from (the live
 * server, while it still has the file). Run it BEFORE a deploy/restart:
 * whatever the live server's disk has now is gone afterwards.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');
const { saveUpload, hasUpload, ensureTable } = require('../services/uploadStore');

const from = (process.argv.find((a) => a.startsWith('--from=')) || '').slice('--from='.length).replace(/\/$/, '');

const SOURCES = [
  ['attendance', 'selfie_path'],
  ['employee_faces', 'image_path'],
  ['face_records', 'image_path'],
  ['device_verification_attempts', 'image_path'],
  ['ocr_records', 'image_path'],
  ['employees', 'photo_path']
];

async function readImage(publicPath) {
  const local = path.join(__dirname, '..', ...publicPath.replace(/^\//, '').split('/'));
  if (fs.existsSync(local)) return { buf: fs.readFileSync(local), where: 'local' };
  if (!from) return null;
  const res = await fetch(`${from}${publicPath}`);
  if (!res.ok || !/^image\//.test(res.headers.get('content-type') || '')) return null;
  return { buf: Buffer.from(await res.arrayBuffer()), where: 'server' };
}

(async () => {
  await ensureTable();
  const paths = new Set();
  for (const [table, column] of SOURCES) {
    const [rows] = await pool.query(`SELECT DISTINCT ${column} AS p FROM ${table} WHERE ${column} LIKE '/uploads/%'`);
    rows.forEach((r) => paths.add(r.p));
  }
  const counts = { already: 0, local: 0, server: 0, missing: 0, failed: 0 };
  let bytes = 0;
  for (const p of paths) {
    if (await hasUpload(p)) { counts.already++; continue; }
    try {
      const img = await readImage(p);
      if (!img) { counts.missing++; continue; }
      bytes += await saveUpload(p, img.buf);
      counts[img.where]++;
    } catch (err) {
      counts.failed++;
      console.error(`  ${p}: ${err.message}`);
    }
  }
  console.log(JSON.stringify({ referenced: paths.size, ...counts, stored_kb: Math.round(bytes / 1024) }, null, 2));
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
