#!/usr/bin/env node
'use strict';

/**
 * Generates the GeoAttend Pro data flow diagram set into docs/dfd/.
 *
 *   GeoAttend-DFD-Level0-Context             whole system as a single process
 *   GeoAttend-DFD-Level1                     processes 1.0 - 8.0 vs data stores D1 - D14
 *   GeoAttend-DFD-Level2-RecordAttendance    process 4.0 decomposed into 4.1 - 4.10
 *   GeoAttend-DFD-Level2-VerifyIdentity      process 5.0 decomposed into 5.1 - 5.10
 *
 * Layout is hand-placed on an orthogonal grid: every flow leaves a box on its own
 * dedicated port (y) and travels through a dedicated lane (x), so parallel flows
 * never overlap. SVG is the source of truth; the PNG is rasterised with sharp.
 *
 * Run:  node scripts/generate-dfds.js
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT_DIR = path.join(__dirname, '..', 'docs', 'dfd');

// ---------------------------------------------------------------- palette
const C = {
  bg: '#FFFFFF',
  title: '#0F1C6B',
  procFill: '#EAF1FF',
  procStroke: '#1D3494',
  storeFill: '#F3F4F6',
  storeStroke: '#1F2937',
  entFill: '#FFF3D6',
  entStroke: '#8A5A12',
  procId: '#1D3494',
  text: '#111111',
  muted: '#4B5563',
  line: '#222222',
  accent: '#1F2937'
};

const FONT = 'Arial, Helvetica, sans-serif';
const HEADER_H = 42;

/** Flow labels are buffered here and flushed after all boxes and lines. */
let LABELS = [];
let LABEL_RECTS = [];                 // where those labels ended up
let BOXES = [];                       // every shape, so labels can steer clear
let CANVAS = [0, 0];

/** Declare the canvas so auto-placed labels stay inside it. */
function canvas(w, h) { CANVAS = [w, h]; }

/** Reserve space for a shape (returns nothing; boxes are reserved by B()). */
function reserve(b) {
  BOXES.push({ x: b.x, y: b.y, x2: b.x + b.w, y2: b.y + b.h });
}

/**
 * A channel of parallel lanes between two columns of shapes. Flows take a lane
 * for the vertical stretch they need; a lane is only handed out when it is free
 * over that whole y-range, so two flows can never run on top of each other.
 */
function channel(x0, x1, step = 56) {
  const slots = [];
  for (let x = x0; x <= x1; x += step) slots.push(x);
  const used = slots.map(() => []);
  return {
    slots,
    take(y1, y2) {
      const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
      for (let i = 0; i < slots.length; i++) {
        if (used[i].every(([a, b]) => hi + 10 <= a || lo - 10 >= b)) {
          used[i].push([lo, hi]);
          return slots[i];
        }
      }
      used[0].push([lo, hi]);         // overflow: linter will flag it
      return slots[0];
    }
  };
}

// ---------------------------------------------------------------- basics
const esc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function wrap(str, maxChars) {
  const out = [];
  for (const para of String(str).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if (!line) line = word;
      else if ((line + ' ' + word).length <= maxChars) line += ' ' + word;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

function text(x, y, str, o = {}) {
  const { size = 15, weight = 400, fill = C.text, anchor = 'middle' } = o;
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" ` +
    `font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" ` +
    `dominant-baseline="central">${esc(str)}</text>`;
}

function block(x, yCenter, lines, o = {}) {
  const { size = 15, lh = size * 1.3, ...rest } = o;
  const top = yCenter - ((lines.length - 1) * lh) / 2;
  return lines.map((l, i) => text(x, top + i * lh, l, { size, ...rest })).join('');
}

const rect = (x, y, w, h, o = {}) => {
  const { rx = 0, fill = 'none', stroke = 'none', sw = 1, dash = '' } = o;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" ` +
    `stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
};

// ---------------------------------------------------------------- shapes
function processBox(id, name, b) {
  const lines = wrap(name, Math.max(14, Math.floor(b.w / 8.4)));
  return rect(b.x, b.y, b.w, b.h, { rx: 14, fill: C.procFill, stroke: C.procStroke, sw: 2.2 }) +
    `<line x1="${b.x}" y1="${b.y + HEADER_H}" x2="${b.x + b.w}" y2="${b.y + HEADER_H}" ` +
    `stroke="${C.procStroke}" stroke-width="1.6"/>` +
    text(b.x + b.w / 2, b.y + HEADER_H / 2, id, { size: 16, weight: 700, fill: C.procId }) +
    block(b.x + b.w / 2, b.y + HEADER_H + (b.h - HEADER_H) / 2, lines,
      { size: 16, weight: 600, lh: 20 });
}

function storeBox(id, name, b) {
  const idW = 60;
  return rect(b.x, b.y, b.w, b.h, { fill: C.storeFill, stroke: C.storeStroke, sw: 1.8 }) +
    `<line x1="${b.x + idW}" y1="${b.y}" x2="${b.x + idW}" y2="${b.y + b.h}" ` +
    `stroke="${C.storeStroke}" stroke-width="1.8"/>` +
    text(b.x + idW / 2, b.y + b.h / 2, id, { size: 15, weight: 700, fill: C.accent }) +
    text(b.x + idW + (b.w - idW) / 2, b.y + b.h / 2, name, { size: 14, weight: 500, fill: C.accent });
}

function entityBox(name, b, o = {}) {
  const size = o.size || 16;
  return rect(b.x + 7, b.y + 7, b.w, b.h, { rx: 6, fill: '#E2CFA4', sw: 0 }) +
    `<rect x="${b.x + 7}" y="${b.y + 7}" width="${b.w}" height="${b.h}" rx="6" ` +
    `fill="#E2CFA4" opacity="0.5"/>` +
    rect(b.x, b.y, b.w, b.h, { rx: 6, fill: C.entFill, stroke: C.entStroke, sw: 2 }) +
    block(b.x + b.w / 2, b.y + b.h / 2, wrap(name, Math.max(11, Math.floor(b.w / 8.2))),
      { size, weight: 700, lh: size * 1.3 });
}

/** Flow label with a white halo so it stays legible over grid lines.
 *  Labels are buffered and flushed by document_() after every box and line,
 *  so no later element can ever be painted on top of label text. The label is
 *  nudged off anything it would otherwise sit on (shapes and other labels). */
function label(lines, at, size = 13) {
  const lh = size * 1.25;
  const w = Math.max(...lines.map(l => l.length)) * size * 0.545 + 10;
  const h = lines.length * lh + 6;

  const clash = (x, y) => {
    const r = { x, y, x2: x + w, y2: y + h };
    if (r.x < 24 || r.y < 24 || r.x2 > CANVAS[0] - 24 || r.y2 > CANVAS[1] - 24) return true;
    const GAP = 7;
    const hit = o => r.x < o.x2 + GAP && r.x2 > o.x - GAP &&
      r.y < o.y2 + GAP && r.y2 > o.y - GAP;
    return BOXES.some(hit) || LABEL_RECTS.some(hit);
  };

  let x = at[0] - w / 2, y = at[1] - h / 2;
  search:
  for (const d of [0, 8, 16, 24, 32, 40, 50, 60, 72, 86, 100, 116, 134, 152]) {
    for (const [dx, dy] of d === 0
      ? [[0, 0]]
      : [[0, -d], [0, d], [-d, 0], [d, 0], [-d, -d], [d, -d], [-d, d], [d, d]]) {
      if (!clash(x + dx, y + dy)) { x += dx; y += dy; break search; }
    }
  }

  LABEL_RECTS.push({ x, y, x2: x + w, y2: y + h });
  let s = rect(x, y, w, h, { rx: 3, fill: C.bg, sw: 0 });
  s = s.replace('<rect ', '<rect opacity="0.93" ');
  lines.forEach((l, i) => {
    s += text(x + w / 2, y + 3 + lh * i + lh / 2, l,
      { size, fill: C.muted, weight: 600 });
  });
  LABELS.push(s);
}

function flow(points, lbl, o = {}) {
  const { at, size = 13, dash = '' } = o;
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0]},${p[1]}`).join(' ');
  let s = `<path d="${d}" fill="none" stroke="${C.line}" stroke-width="1.6"` +
    `${dash ? ` stroke-dasharray="${dash}"` : ''} marker-end="url(#arr)"/>`;
  if (lbl) label(Array.isArray(lbl) ? lbl : wrap(lbl, 24), at, size);
  return s;
}

// ------------------------------------------------------------- connectors
/** Right port of A -> left port of B, through one lane. Label on the lane. */
function east(a, aY, b, bY, lane, lbl, o = {}) {
  const m = (aY + bY) / 2;
  return flow([[a.x2, aY], [lane, aY], [lane, bY], [b.x, bY]], lbl,
    Object.assign({ at: [lane, m] }, o));
}
/** Left port of A -> right port of B, through one lane. */
function west(a, aY, b, bY, lane, lbl, o = {}) {
  const m = (aY + bY) / 2;
  return flow([[a.x, aY], [lane, aY], [lane, bY], [b.x2, bY]], lbl,
    Object.assign({ at: [lane, m] }, o));
}
/** Entity -> process through a lane (entity left of process). */
function entProc(ent, eY, proc, pY, lane, lbl, o = {}) {
  return flow([[ent.x2, eY], [lane, eY], [lane, pY], [proc.x, pY]], lbl,
    Object.assign({ at: [lane, (eY + pY) / 2] }, o));
}
function procEnt(proc, pY, ent, eY, lane, lbl, o = {}) {
  return flow([[proc.x, pY], [lane, pY], [lane, eY], [ent.x2, eY]], lbl,
    Object.assign({ at: [lane, (pY + eY) / 2] }, o));
}
/** Straight down / up between two stacked boxes. */
function vert(a, aY, b, bY, lbl, o = {}) {
  const x = (a.x + a.x2) / 2;
  return flow([[x, aY], [x, bY]], lbl,
    Object.assign({ at: [x + 62, (aY + bY) / 2] }, o));
}
/** Process -> entity, for an entity sitting to the RIGHT of the process. */
function procEntR(proc, pY, ent, eY, lane, lbl, o = {}) {
  return flow([[proc.x2, pY], [lane, pY], [lane, eY], [ent.x1, eY]], lbl,
    Object.assign({ at: [lane, (pY + eY) / 2] }, o));
}
/** Entity -> process, for an entity sitting to the RIGHT of the process. */
function entProcR(ent, eY, proc, pY, lane, lbl, o = {}) {
  return flow([[ent.x1, eY], [lane, eY], [lane, pY], [proc.x2, pY]], lbl,
    Object.assign({ at: [lane, (eY + pY) / 2] }, o));
}
/** Straight across between two boxes on the same row. */
function across(a, aY, b, bY, lbl, o = {}) {
  return flow([[a.x2, aY], [b.x, bY]], lbl,
    Object.assign({ at: [(a.x2 + b.x) / 2, Math.min(aY, bY) - 18] }, o));
}

// ---------------------------------------------------------------- document
function document_(title, subtitle, w, h, body) {
  const out = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" ` +
    `viewBox="0 0 ${w} ${h}">` +
    `<defs><marker id="arr" viewBox="0 0 10 10" refX="9.2" refY="5" markerWidth="8" ` +
    `markerHeight="8" orient="auto-start-reverse">` +
    `<path d="M0,0 L10,5 L0,10 z" fill="${C.line}"/></marker></defs>` +
    rect(0, 0, w, h, { fill: C.bg }) +
    text(w / 2, 46, title, { size: 29, weight: 700, fill: C.title }) +
    (subtitle ? text(w / 2, 76, subtitle, { size: 14, weight: 400, fill: C.muted }) : '') +
    body + LABELS.join('') + '</svg>';
  LABELS = [];
  LABEL_RECTS = [];
  BOXES = [];
  CANVAS = [0, 0];
  return out;
}

function noteBox(title, lines, x, y, w) {
  const size = 13, lh = 17.2;
  const h = (lines.length + 1) * lh + 20;
  reserve({ x, y, w, h });
  let s = rect(x, y, w, h, { rx: 8, fill: '#FBFCFE', stroke: '#CBD5E1', sw: 1.4, dash: '5 4' });
  s += text(x + 14, y + 10 + lh / 2, title, { size: 14, weight: 700, fill: C.procId, anchor: 'start' });
  lines.forEach((l, i) => {
    s += text(x + 14, y + 10 + lh * (i + 1) + lh / 2, l,
      { size, weight: 400, fill: C.muted, anchor: 'start' });
  });
  return { svg: s, h };
}

async function emit(name, svg, pngWidth) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, name + '.svg'), svg);
  const m = await sharp(Buffer.from(svg), { density: 96 })
    .resize({ width: pngWidth }).png({ compressionLevel: 9 })
    .toFile(path.join(OUT_DIR, name + '.png'));
  console.log(`  ${name}  (${m.width}x${m.height})`);
}

const B = (x, y, w, h) => {
  const b = { x, y, w, h, x1: x, x2: x + w, y1: y, y2: y + h };
  reserve(b);
  return b;
};

// ==================================================================
// LEVEL 0 — CONTEXT
// ==================================================================
function level0() {
  const W = 2000, H = 1330;
  canvas(W, H);
  const g = [];
  const sys = B(790, 470, 420, 300);
  const emp = B(80, 560, 310, 140);
  const adm = B(1610, 560, 310, 140);
  const goog = B(90, 130, 330, 130);
  const mail = B(1580, 130, 350, 130);
  const ips = B(90, 970, 330, 130);

  const n = noteBox('Reading this diagram', [
    'One process: every request is a single flow into or out of the system as a whole.',
    'Google sign-in, geo-fencing, OCR and face matching all run server-side. The mobile app',
    'only captures GPS, records a frame, and runs the liveness challenge on the device.',
    'The public-IP lookup only matters when an admin has configured an office-network allowlist.'
  ], 560, 1150, 880);

  g.push(flow([[emp.x2, 590], [sys.x, 590]], wrap(
    'Google ID token, registration details, ID photo, face selfie & liveness result, ' +
    'device identity, GPS location & heartbeats', 34).join('\n'), { at: [590, 545] }));
  g.push(flow([[sys.x, 690], [emp.x2, 690]], wrap(
    'session token, device approval status, active events & geo-fences, time-in / time-out ' +
    'confirmation, face-verification prompts, attendance history', 34).join('\n'), { at: [590, 745] }));

  g.push(flow([[adm.x1, 590], [sys.x2, 590]], wrap(
    'login / Google sign-in, employee & department records, event & geo-fence definitions, ' +
    'device & admin approvals, kiosk ID-card / selfie scans, rating edits, report & ' +
    'certificate requests, system settings', 34).join('\n'), { at: [1412, 545] }));
  g.push(flow([[sys.x2, 690], [adm.x1, 690]], wrap(
    'dashboard statistics, alerts & notifications, record lists, verification results, ' +
    'reports & exports, certificate PDFs', 34).join('\n'), { at: [1412, 745] }));

  g.push(flow([[880, sys.y], [880, 356], [255, 356], [255, goog.y2]], 'Google ID token (verify)',
    { at: [566, 340] }));
  g.push(flow([[goog.x2, 195], [1258, 195], [1258, 430], [1120, 430], [1120, sys.y]],
    'verified identity (email, name)', { at: [1262, 398] }));
  g.push(flow([[1140, sys.y], [1140, 332], [1755, 332], [1755, mail.y2]],
    'admin account OTP email', { at: [1448, 310] }));
  g.push(flow([[866, sys.y2], [866, 902], [240, 902], [240, ips.y]],
    'public IP lookup request', { at: [552, 888] }));
  g.push(flow([[ips.x2, 1064], [740, 1064], [740, 800], [962, 800], [962, sys.y2]],
    'server public IP', { at: [580, 1040] }));

  g.push(processBox('0', 'GeoAttend Pro\nGeofenced Attendance\nMonitoring System', sys));
  g.push(entityBox('Employee\n(Mobile App)', emp));
  g.push(entityBox('Administrator /\nSuper Admin', adm));
  g.push(entityBox('Google Identity\nServices', goog, { size: 15 }));
  g.push(entityBox('Email Service\n(Brevo / Apps Script)', mail, { size: 15 }));
  g.push(entityBox('Public IP Resolver\n(ipify / icanhazip)', ips, { size: 15 }));

  return document_('Level 0 — Context Diagram',
    'GeoAttend Pro · the whole system as a single process', W, H, g.join('') + n.svg);
}

// ==================================================================
// LEVEL 1
// ==================================================================
function level1() {
  const W = 3350, H = 1790;
  canvas(W, H);
  const g = [];

  const LPX = 560, LPW = 390;           // left process column   560 .. 950
  const SX = 1560, SW = 390;            // store column         1560 .. 1950
  const RPX = 2230, RPW = 390;          // right process column 2230 .. 2620
  const CH_L = channel(1000, 1500, 56); // left process  -> store
  const CH_R = channel(1960, 2212, 42); // right process -> store (6 concurrent)
  const CH_E = channel(320, 540, 44);   // left entities
  const CH_F = channel(2650, 2990, 56); // right entities

  const P1 = B(LPX, 250, LPW, 150);
  const P2 = B(LPX, 490, LPW, 150);
  const P4 = B(LPX, 730, LPW, 150);
  const P5 = B(LPX, 970, LPW, 150);
  const P3 = B(RPX, 250, RPW, 150);
  const P6 = B(RPX, 700, RPW, 150);
  const P7 = B(RPX, 1010, RPW, 150);
  const P8 = B(RPX, 1320, RPW, 150);

  const E1 = B(40, 250, 250, 130);
  const E2 = B(40, 740, 250, 130);
  const E3 = B(40, 980, 250, 130);
  const K1 = B(40, 1320, 250, 130);     // kiosk administrator
  const K2 = B(40, 1600, 250, 130);     // attendance-review administrator
  const A1 = B(3020, 250, 250, 130);
  const A2 = B(3020, 1560, 250, 130);
  const G = B(600, 50, 340, 100);
  const M = B(2230, 50, 390, 100);

  const n = noteBox('Notes', [
    'Roles — super_admin reaches every process. The admin role is limited to 5.0 Verify Identity',
    'plus the ongoing-event list, and may only OCR-scan and face-match at the kiosk.',
    '',
    'Auditing — D7 is written by every process (login, verify, import, rating, certificate, status',
    'override); D14 keeps a durable MySQL copy of every uploaded image so photos survive an',
    'ephemeral host disk. Those edges are omitted to keep the diagram readable.',
    '',
    '6.0 reads the open sessions written by 4.0 through D8 rather than being wired to it directly.',
    '',
    'There is no scheduler. Rating generation and attendance settling (80% presence rule, auto',
    'time-out) run lazily on the next attendance / reports / ratings read. The office-network',
    'allowlist (GET /api/network/check) reads D6 through 3.0; both are omitted here.'
  ], 40, 1790, 2100);

  // ---- data stores
  const defs = [
    ['D1', 'Admin Accounts & OTPs'], ['D2', 'Employees & Departments'],
    ['D3', 'Mobile Devices'], ['D4', 'Face & OCR Records'],
    ['D5', 'Events & Geo-fences'], ['D6', 'System Settings'],
    ['D7', 'Audit Logs'], ['D8', 'Attendance & Sessions'],
    ['D9', 'Geo Anomalies'], ['D10', 'Notifications & Alerts'],
    ['D11', 'Employee Ratings'], ['D12', 'Certificates'],
    ['D13', 'Device Verification Attempts'], ['D14', 'Stored Uploads (Photos)']
  ];
  const S = {};
  defs.forEach(([id, name], i) => {
    S[id] = B(SX, 230 + i * 108, SW, 80);
    g.push(storeBox(id, name, S[id]));
  });
  const sc = id => S[id].y + S[id].h / 2;
  const storeHits = {};                              // keep a store's ports distinct
  const sPort = id => {
    const k = storeHits[id] = (storeHits[id] || 0) + 1;
    return sc(id) + ((k - 1) % 5 - 2) * 11;    // 5 distinct ports, 11px apart
  };

  // ---- process <-> store flows: unique port per process, private lane
  function fan(flows, ch, connect) {
    const seen = {};
    for (const [proc, sid, lbl] of flows) {
      const k = (seen[proc.y] = (seen[proc.y] || 0) + 1) - 1;
      const total = flows.filter(f => f[0].y === proc.y).length;
      const portY = Math.round(proc.y + 24 + (total > 1
        ? k * ((proc.h - 48) / (total - 1)) : 30));
      const storeY = sPort(sid);
      g.push(connect(proc, portY, S[sid], storeY, ch.take(portY, storeY), lbl));
    }
  }
  fan([
    [P1, 'D1', 'login / OTP verification'], [P1, 'D2', 'employee credentials'],
    [P1, 'D3', 'device binding check'],
    [P2, 'D2', 'pending / existing employee'], [P2, 'D3', 'device record'],
    [P2, 'D4', 'enrolled face embedding'], [P2, 'D13', 'DoubleSafe attempt log'],
    [P4, 'D5', 'active events & geo-fences'], [P4, 'D3', 'device status'],
    [P4, 'D2', 'employee record'], [P4, 'D8', 'attendance & session rows'],
    [P4, 'D9', 'co-location anomaly'], [P4, 'D10', 'status & alerts'],
    [P5, 'D4', 'enrolled faces / verification record'], [P5, 'D2', 'employee record'],
    [P5, 'D8', 'verified attendance'], [P5, 'D9', 'anomaly resolution']
  ], CH_L, east);
  const rightFlows = [
    [P3, 'D2', 'employee & department data'], [P3, 'D5', 'events & geo-fences'],
    [P3, 'D3', 'device decisions'], [P3, 'D6', 'allowed network IPs'],
    [P6, 'D8', 'open attendance sessions'], [P6, 'D9', 'anomaly record'],
    [P6, 'D10', 'employee & admin alerts'],
    [P7, 'D8', 'settled attendance'], [P7, 'D11', 'employee ratings'],
    [P7, 'D2', 'employee & department data'],
    [P8, 'D12', 'certificate record'], [P8, 'D2', 'employee name'],
    [P8, 'D6', 'certificate template']
  ];
  const seenR = {};
  for (const [proc, sid, lbl] of rightFlows) {
    const k = (seenR[proc.y] = (seenR[proc.y] || 0) + 1) - 1;
    const total = rightFlows.filter(f => f[0].y === proc.y).length;
    const portY = Math.round(proc.y + 24 + (total > 1
      ? k * ((proc.h - 48) / (total - 1)) : 30));
    const storeY = sPort(sid);
    const lane = CH_R.take(portY, storeY);
    g.push(west(proc, portY, S[sid], storeY, lane, lbl));
  }

  // ---- entities (left)
  g.push(flow([[E1.x2, 288], [P1.x, 288]], 'credentials / Google ID token', { at: [425, 262] }));
  g.push(flow([[P1.x, 322], [E1.x2, 322]], 'employee session token', { at: [425, 348] }));
  g.push(entProc(E1, 356, P2, 528, CH_E.take(356, 528),
    'registration details, ID photo,\nface selfie & liveness result'));
  g.push(procEnt(P2, 606, E1, 372, CH_E.take(606, 372), 'device approval status'));

  g.push(flow([[E2.x2, 782], [P4.x, 782]], 'GPS location & heartbeats', { at: [425, 756] }));
  g.push(procEnt(P4, 800, E2, 850, CH_E.take(800, 850),
    'time-in / time-out confirmation,\nface-verification prompt'));
  g.push(flow([[E2.x2, 862], [P4.x, 862]], 'attendance history', { at: [425, 884] }));

  g.push(entProc(E3, 1012, P5, 1042, CH_E.take(1012, 1042), 're-verification selfie'));
  g.push(procEnt(P5, 1108, E3, 1082, CH_E.take(1108, 1082), 'verification result'));

  g.push(entProc(K1, 1352, P5, 990, CH_E.take(1352, 990), 'kiosk ID-card / selfie scan'));
  g.push(entProc(K2, 1628, P4, 872, CH_E.take(1628, 872), 'manual status override'));
  g.push(procEnt(P4, 838, K2, 1672, CH_E.take(838, 1672), 'attendance records & sessions'));

  // ---- entities (right)
  g.push(flow([[A1.x1, 288], [P3.x2, 288]], 'employee, department, event,\ngeo-fence, device & settings data',
    { at: [2825, 248] }));
  g.push(flow([[P3.x2, 322], [A1.x1, 322]], 'record lists & dashboard states', { at: [2825, 362] }));
  g.push(procEntR(P6, 744, A1, 356, CH_F.take(744, 356), 'alerts & notifications'));
  g.push(entProcR(A1, 374, P6, 796, CH_F.take(374, 796), 'anomaly resolution'));

  g.push(entProcR(A2, 1592, P7, 1058, CH_F.take(1592, 1058), 'report filters\n& rating edits'));
  g.push(procEntR(P7, 1116, A2, 1626, CH_F.take(1116, 1626), 'reports, exports\n& insights'));
  g.push(entProcR(A2, 1656, P8, 1372, CH_F.take(1656, 1372), 'certificate request\n& template text'));
  g.push(procEntR(P8, 1432, A2, 1686, CH_F.take(1432, 1686), 'certificate PDF'));

  // ---- external services, entering/leaving through the process tops
  g.push(flow([[660, P1.y], [660, 196], [700, 196], [700, G.y2]], 'Google ID token', { at: [790, 182] }));
  g.push(flow([[870, G.y2], [870, 216], [720, 216], [720, P1.y]], 'verified identity', { at: [800, 234] }));
  g.push(flow([[2300, P3.y], [2300, 196], [2340, 196], [2340, M.y2]], 'admin account OTP', { at: [2430, 182] }));
  g.push(flow([[2500, M.y2], [2500, 216], [2360, 216], [2360, P3.y]], '', {}));

  // ---- shapes
  g.push(processBox('1.0', 'Authenticate Users', P1));
  g.push(processBox('2.0', 'Register Employee & Device', P2));
  g.push(processBox('4.0', 'Record Attendance', P4));
  g.push(processBox('5.0', 'Verify Identity', P5));
  g.push(processBox('3.0', 'Manage Master Data & Settings', P3));
  g.push(processBox('6.0', 'Detect Anomalies & Notify', P6));
  g.push(processBox('7.0', 'Rate Employees\n& Generate Reports', P7));
  g.push(processBox('8.0', 'Generate Certificates', P8));
  g.push(entityBox('Employee\n(Mobile App)', E1, { size: 15 }));
  g.push(entityBox('Employee\n(Mobile App)', E2, { size: 15 }));
  g.push(entityBox('Employee\n(Mobile App)', E3, { size: 15 }));
  g.push(entityBox('Administrator\n(verification kiosk)', K1, { size: 13 }));
  g.push(entityBox('Administrator\n(attendance review)', K2, { size: 13 }));
  g.push(entityBox('Administrator /\nSuper Admin', A1, { size: 15 }));
  g.push(entityBox('Administrator', A2, { size: 15 }));
  g.push(entityBox('Google Identity\nServices', G, { size: 14 }));
  g.push(entityBox('Email Service\n(Brevo / Apps Script)', M, { size: 14 }));

  return document_('Level 1 Data Flow Diagram',
    'Processes 1.0 – 8.0 · data stores D1 – D14', W, H + n.h + 30, g.join('') + n.svg);
}

// ==================================================================
// LEVEL 2 — 4.0 RECORD ATTENDANCE
// ==================================================================
// Column A (validation) sits left of the data stores and writes into them with
// east(); column B (recording) sits right of the stores and reads/writes them
// with west(). Keeping both columns on opposite sides of one store column is
// what lets the whole diagram stay free of crossing arrows.
function level2Attendance() {
  const W = 3020, H = 1700;
  canvas(W, H);
  const g = [];

  const emp = B(40, 295, 260, 130);          // 40 .. 300, centre 360
  const adm = B(2600, 1330, 300, 160);       // right of column B, ports 1360/1420/1470

  const q1 = B(520, 305, 420, 110);          // c 360
  const q2 = B(520, 465, 420, 110);          // c 520
  const q3 = B(520, 625, 420, 110);          // c 680
  const q4 = B(520, 785, 420, 110);          // c 840
  const q8 = B(520, 1010, 420, 120);         // c 1070

  const q5 = B(1900, 785, 440, 110);         // c 840
  const q6 = B(1900, 950, 440, 110);         // c 1005
  const q7 = B(1900, 1115, 440, 110);        // c 1170
  const q9 = B(1900, 1330, 440, 130);        // c 1395
  const q10 = B(1900, 1530, 440, 110);       // c 1585

  // store column, x 1150 .. 1550. The 815..865 gap carries the 4.4 -> 4.5 flow.
  const S = {};
  [['D2', 'Employees'], ['D3', 'Mobile Devices'], ['D5', 'Events & Geo-fences'],
   ['D8', 'Attendance, Sessions & Logs'], ['D9', 'Geo Anomalies'],
   ['D10', 'Notifications & Alerts'], ['D7', 'Audit Logs']].forEach(([id, name], i) => {
    S[id] = B(1150, 265 + i * 150, 400, 100);
    g.push(storeBox(id, name, S[id]));
  });

  const m = b => b.y + b.h / 2;
  const CH_A = channel(960, 1130, 42);   // column A -> stores   (940 .. 1150)
  const CH_B = channel(1570, 1840, 45);  // column B <-> stores  (1550 .. 1900)

  // The notes panel sits bottom-left; reserve it before any label is placed.
  const n = noteBox('Notes', [
    'Every gate in 4.1 – 4.4 is server-side and authoritative. The mobile app mirrors the',
    'containment maths only to drive its own UI; it cannot grant its own time-in.',
    '',
    '4.1 rejects mock-location providers (403), a GPS accuracy worse than 100 m, any employee_id',
    'other than the signed-in one, and any payload missing a required field.',
    '4.4 treats a reading as inside when it is within the reading\'s own GPS accuracy (max 20 m) of',
    'the boundary, so ordinary edge drift does not block a legitimate check-in.',
    '4.5 re-entry: leaving and returning while the event runs opens a new attendance_sessions row',
    'and folds its duration into attendance.total_duration_seconds.',
    '4.9 flips Present / Late to Absent once the event ends if less than 80% of the scheduled',
    'duration was accumulated inside the fence, and rejects any row still flagged for a face check.'
  ], 40, 1440, 1500);

  // ---- entity inputs
  g.push(flow([[emp.x2, m(emp)], [q1.x, m(q1)]],
    'check-in payload: employee id, event id,\ndevice uid, lat / lng, accuracy, mocked flag',
    { at: [410, 296] }));
  g.push(flow([[emp.x2, 404], [460, 404], [460, m(q3)], [q3.x, m(q3)]], 'attendance history request',
    { at: [460, 545] }));
  g.push(flow([[emp.x2, 382], [380, 382], [380, m(q8)], [q8.x, m(q8)]], 'GPS heartbeat (~25 s)',
    { at: [380, 730] }));

  // ---- validation spine
  g.push(vert(q1, q1.y2, q2, q2.y, 'valid, self-only,\nnot mock GPS'));
  g.push(vert(q2, q2.y2, q3, q3.y, 'device approved & bound'));
  g.push(vert(q3, q3.y2, q4, q4.y, 'inside the event window'));
  g.push(vert(q8, q8.y, q4, q4.y2, 're-check containment\non every ping'));

  // ---- column A -> stores (each flow owns a lane for its own y-range)
  g.push(east(q1, 340, S.D2, 305, CH_A.take(340, 305), 'employee record'));
  g.push(east(q1, 385, S.D7, 1215, CH_A.take(385, 1215), 'rejection reasons\n& audit trail'));
  g.push(east(q2, 490, S.D3, 465, CH_A.take(490, 465), 'device binding + status'));
  g.push(east(q2, 545, S.D10, 1035, CH_A.take(545, 1035),
    'alert admins: unregistered\nor blocked device'));
  g.push(east(q3, 650, S.D5, 605, CH_A.take(650, 605), 'event start / end'));
  g.push(east(q4, 800, S.D5, 635, CH_A.take(800, 635), 'fence shape + points'));
  g.push(east(q8, 1100, S.D8, 775, CH_A.take(1100, 775),
    'close session, accumulate duration'));

  // ---- spine -> recording column (through the gap between D8 and D9)
  g.push(across(q4, 840, q5, 840, 'containment confirmed'));
  g.push(vert(q5, q5.y2, q6, q6.y, 'open / re-enter session'));
  g.push(vert(q6, q6.y2, q7, q7.y, 'status + anomaly outcome'));

  // ---- column B <-> stores
  g.push(west(q5, 815, S.D8, 735, CH_B.take(815, 735), 'attendance row (insert / re-open)'));
  g.push(west(q5, 865, S.D8, 755, CH_B.take(865, 755), 'session row + event trail'));
  g.push(west(q6, 975, S.D9, 915, CH_B.take(975, 915), 'co-location anomaly flag'));
  g.push(west(q7, 1145, S.D10, 1055, CH_B.take(1145, 1055), 'confirmations & face prompts'));
  g.push(west(q9, 1360, S.D8, 795, CH_B.take(1360, 795), 'cap at event end ·\n80% presence rule'));
  g.push(west(q9, 1425, S.D10, 1075, CH_B.take(1425, 1075), 'admin alert: unverified\nexpired'));
  g.push(west(q10, 1560, S.D10, 1095, CH_B.take(1560, 1095), 'time-out notice'));
  g.push(west(q10, 1610, S.D2, 335, CH_B.take(1610, 335), 'attendance score\n& rating points'));

  // ---- monitoring -> settlement (down the A channel, under the store band)
  const settle = CH_A.take(1060, 1395);
  g.push(flow([[q8.x2, 1060], [settle, 1060], [settle, 1395], [q9.x, 1395]],
    'auto time-out after 2 consecutive pings outside', { at: [1560, 1372] }));
  const lazy = CH_B.take(1195, 1440);
  g.push(flow([[q7.x, 1195], [lazy, 1195], [lazy, 1440], [q9.x, 1440]],
    'settled lazily, on the next attendance /\nreports / ratings read',
    { at: [1700, 1310], dash: '7 5' }));
  g.push(vert(q9, q9.y2, q10, q10.y, ''));

  // ---- response back to the employee (dashed: it has to cross the store band)
  g.push(flow([[q7.x, 1170], [1880, 1170], [1880, 190], [660, 190], [660, q1.y]],
    '201 time-in: status, late minutes, face-verification prompt',
    { at: [1230, 174], dash: '6 5' }));
  g.push(flow([[q1.x, 330], [470, 330], [470, 150], [170, 150], [170, emp.y]], 'rejection reason',
    { at: [300, 134] }));

  // ---- administrator
  g.push(across(q9, 1360, adm, 1360, 'manual status override (sets status_finalized)'));
  g.push(across(q9, 1420, adm, 1420, 'attendance records & sessions'));
  g.push(flow([[q10.x2, 1585], [2470, 1585], [2470, 1470], [adm.x, 1470]], 'recalculated scores',
    { at: [2472, 1560] }));

  // ---- shapes
  g.push(processBox('4.1', 'Validate Check-in Request', q1));
  g.push(processBox('4.2', 'Verify Device Binding', q2));
  g.push(processBox('4.3', 'Validate Event Window', q3));
  g.push(processBox('4.4', 'Check Geo-fence Containment', q4));
  g.push(processBox('4.5', 'Open / Re-enter Session', q5));
  g.push(processBox('4.6', 'Compute Attendance Status', q6));
  g.push(processBox('4.7', 'Report Time-in Result', q7));
  g.push(processBox('4.8', 'Monitor Session & Auto Time-out', q8));
  g.push(processBox('4.9', 'Settle & Finalize Attendance', q9));
  g.push(processBox('4.10', 'Recalculate Employee Score', q10));
  g.push(entityBox('Employee\n(Mobile App)', emp, { size: 15 }));
  g.push(entityBox('Administrator /\nSuper Admin', adm, { size: 14 }));

  return document_('Level 2 — Process 4.0 Record Attendance',
    'Employee check-in / check-out, session monitoring and settlement', W, H, g.join('') + n.svg);
}

// ==================================================================
// LEVEL 2 — 5.0 VERIFY IDENTITY
// ==================================================================
// Same shape as the attendance diagram: the OCR branch sits left of the store
// column (east), the face branch sits right of it (west), and both converge on
// their own recording step at the bottom.
function level2Identity() {
  const W = 2900, H = 1560;
  canvas(W, H);
  const g = [];

  const kiosk = B(40, 560, 260, 130);       // 40 .. 300
  const staff = B(40, 1150, 260, 130);
  const emp = B(2420, 200, 300, 130);       // 2420 .. 2720
  const adm = B(2420, 980, 300, 130);
  const onnx = B(1120, 110, 400, 100);      // y 110..210, clear of the title band
  const tess = B(520, 110, 380, 100);

  // OCR branch (left of the store column, x 520 .. 940)
  const o1 = B(520, 290, 420, 110);         // c 345
  const o2 = B(520, 460, 420, 110);         // c 515
  const o3 = B(520, 630, 420, 110);         // c 685
  const s1 = B(520, 1090, 420, 120);        // c 1150
  // liveness + face branch (right of the store column, x 1900 .. 2340)
  const l1 = B(1900, 290, 440, 110);        // c 345
  const f1 = B(1900, 460, 440, 110);        // c 515
  const f2 = B(1900, 630, 440, 110);        // c 685
  const f3 = B(1900, 800, 440, 110);        // c 855
  const f4 = B(1900, 970, 440, 110);        // c 1025
  const s2 = B(1900, 1150, 440, 120);       // c 1210

  const S = {};
  [['D2', 'Employees & Departments'], ['D4', 'Face & OCR Records'],
   ['D14', 'Stored Uploads (Photos)'], ['D7', 'Audit Logs'],
   ['D8', 'Attendance & Sessions'], ['D9', 'Geo Anomalies'],
   ['D13', 'Device Verification Attempts']].forEach(([id, name], i) => {
    S[id] = B(1180, 265 + i * 150, 400, 100);
    g.push(storeBox(id, name, S[id]));
  });

  const m = b => b.y + b.h / 2;
  const CH_A = channel(960, 1160, 40);   // OCR branch  -> stores  (940 .. 1180)
  const CH_B = channel(1600, 1870, 45);  // face branch <-> stores  (1580 .. 1900)

  // Reserve the notes panel before any label is placed.
  const n = noteBox('Notes', [
    'The liveness challenge in 5.4 runs entirely on the client — YCbCr skin-blob tracking in the',
    'browser, ML Kit face detection in the app. The server only checks that the request carries',
    'liveness_verified=true; it never re-derives liveness from pixels.',
    '',
    '5.8 matches a kiosk scan against every enrolled face in the database, but an employee',
    're-verifying after an anomaly flag is matched only against their own enrolled faces.',
    '',
    'Both branches converge on the same sink: an attendance row with verification_method =',
    'ocr | face, time_in = time_out, no session row, and the verifying admin recorded.',
    '5.9 / 5.10 deliberately skip the geo-fence and time-window checks — the administrator is',
    'present in person. They also resolve an open anomaly flag instead of double-recording.'
  ], 40, 1310, 1460);

  // ---- external inputs
  g.push(flow([[kiosk.x2, 600], [430, 600], [430, m(o1)], [o1.x, m(o1)]], 'ID-card photo (JPEG)',
    { at: [430, 470] }));
  g.push(flow([[staff.x2, 1215], [470, 1215], [470, 720], [o3.x, 720]], 'ID presented for roll call',
    { at: [470, 960] }));
  g.push(flow([[kiosk.x2, 645], [390, 645], [390, 250], [2010, 250], [2010, l1.y]],
    'live selfie frame + client liveness claim', { at: [1150, 234] }));
  g.push(flow([[emp.x1, 240], [2360, 240], [2360, m(l1)], [l1.x2, m(l1)]],
    're-verification selfie after anomaly flag', { at: [2540, 172] }));
  g.push(flow([[s2.x2, 1250], [2380, 1250], [2380, 460], [2570, 460], [2570, emp.y2]],
    'verification result', { at: [2432, 600], dash: '6 5' }));

  // ---- OCR branch
  g.push(vert(tess, tess.y2, o1, o1.y, 'eng.traineddata', { at: [710, 246] }));
  g.push(vert(o1, o1.y2, o2, o2.y, 'raw recognised text'));
  g.push(vert(o2, o2.y2, o3, o3.y, 'employee number'));
  g.push(east(o1, 330, S.D14, 595, CH_A.take(330, 595), 'stored scan image'));
  g.push(east(o3, 655, S.D2, 345, CH_A.take(655, 345), 'employee_code + is_approved lookup'));
  g.push(east(o3, 710, S.D7, 775, CH_A.take(710, 775), 'OCR verify audit'));
  g.push(vert(o3, o3.y2, s1, s1.y, 'matched identity'));

  // ---- liveness + face branch (models enter the column through one shared lane each)
  g.push(east(onnx, 155, f1, 490, CH_B.take(155, 490),
    'det_500m.onnx — SCRFD detector (score ≥ 0.5, NMS 0.4)'));
  g.push(east(onnx, 195, f3, 855, CH_B.take(195, 855),
    'w600k_mbf.onnx — ArcFace recognizer'));
  g.push(vert(l1, l1.y2, f1, f1.y, 'frame, only if liveness passed'));
  g.push(vert(f1, f1.y2, f2, f2.y, 'largest box + 5 landmarks'));
  g.push(vert(f2, f2.y2, f3, f3.y, '112 × 112 aligned crop'));
  g.push(vert(f3, f3.y2, f4, f4.y, 'L2-normalized 512-d embedding'));
  g.push(west(f4, 1000, S.D4, 445, CH_B.take(1000, 445), 'enrolled face embeddings'));
  g.push(west(f4, 1050, S.D4, 475, CH_B.take(1050, 475), 'face_records row'));
  g.push(west(f4, 990, S.D14, 645, CH_B.take(990, 645), 'stored selfie'));

  // ---- recording steps
  g.push(east(s1, 1120, S.D4, 455, CH_A.take(1120, 455), 'ocr_records row'));
  g.push(east(s1, 1180, S.D8, 945, CH_A.take(1180, 945), 'attendance row (method = ocr)'));
  g.push(east(s1, 1145, S.D7, 745, CH_A.take(1145, 745), 'verification audit'));
  g.push(west(s2, 1175, S.D4, 505, CH_B.take(1175, 505), 'similarity + liveness actions'));
  g.push(west(s2, 1235, S.D9, 1065, CH_B.take(1235, 1065), 'resolve geo_anomalies'));
  g.push(west(s2, 1205, S.D13, 1215, CH_B.take(1205, 1215), 'device re-verification attempt'));
  g.push(west(s2, 1145, S.D8, 895, CH_B.take(1145, 895),
    'attendance row (method = face),\nclears the anomaly flag'));

  // ---- administrator
  g.push(flow([[adm.x1, 1010], [2400, 1010], [2400, 1050], [f4.x2, 1050]], 'match result',
    { at: [2404, 960] }));

  // ---- shapes
  g.push(processBox('5.1', 'Extract ID Text (OCR)', o1));
  g.push(processBox('5.2', 'Parse Employee Number', o2));
  g.push(processBox('5.3', 'Cross-check ID Record', o3));
  g.push(processBox('5.4', 'Run Liveness Challenge', l1));
  g.push(processBox('5.5', 'Detect Face & Landmarks', f1));
  g.push(processBox('5.6', 'Align Face to Canonical Crop', f2));
  g.push(processBox('5.7', 'Generate Face Embedding', f3));
  g.push(processBox('5.8', 'Match Against Enrolled Faces', f4));
  g.push(processBox('5.9', 'Record OCR Verification', s1));
  g.push(processBox('5.10', 'Record Face Verification', s2));
  g.push(entityBox('Administrator\n(verification kiosk)', kiosk, { size: 13 }));
  g.push(entityBox('Employee\n(in attendance hall)', staff, { size: 13 }));
  g.push(entityBox('Employee\n(Mobile App)', emp, { size: 15 }));
  g.push(entityBox('Administrator /\nSuper Admin', adm, { size: 13 }));
  g.push(entityBox('Face Recognition\nModels (ONNX)', onnx, { size: 14 }));
  g.push(entityBox('OCR Language Data\n(tessdata)', tess, { size: 14 }));

  return document_('Level 2 — Process 5.0 Verify Identity',
    'OCR ID-card scanning and live face verification', W, H, g.join('') + n.svg);
}

// ==================================================================
(async () => {
  console.log('Generating GeoAttend Pro DFD set ->', OUT_DIR);
  await emit('GeoAttend-DFD-Level0-Context', level0(), 2200);
  await emit('GeoAttend-DFD-Level1', level1(), 2700);
  await emit('GeoAttend-DFD-Level2-RecordAttendance', level2Attendance(), 2600);
  await emit('GeoAttend-DFD-Level2-VerifyIdentity', level2Identity(), 2600);
  console.log('Done.');
})().catch(e => { console.error(e); process.exit(1); });
