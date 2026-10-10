#!/usr/bin/env node
'use strict';
/**
 * Lints the generated DFD SVGs in docs/dfd/.
 *
 *   DIAG   a flow with a diagonal (non-orthogonal) segment
 *   OVL    two flow labels overlapping each other
 *   BOX    a flow label sitting on top of a shape
 *   OVER   a line drawn on top of a label (lines must stay under label halos)
 *   CROSS  a line cutting through the interior of a shape
 *
 * Run:  node scripts/lint-dfds.js          (exit 1 when anything is found)
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'docs', 'dfd');
const BOX_FILLS = new Set(['#EAF1FF', '#F3F4F6', '#FFF3D6', '#E2CFA4', '#FBFCFE']);

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.svg'));
let bad = 0;

for (const file of files) {
  const svg = fs.readFileSync(path.join(DIR, file), 'utf8');
  const items = [];                       // {order, kind, ...}
  const re = /<(path|rect|text)\b([^>]*)\/?>/g;
  let m, order = 0;
  const attr = (s, k) =>
    (s.match(new RegExp('(?:^|\\s)' + k + '="([^"]*)"')) || [, undefined])[1];
  const num = (s, k) => { const v = attr(s, k); return v === undefined ? NaN : parseFloat(v); };

  while ((m = re.exec(svg))) {
    const tag = m[1], a = m[2];
    order++;
    if (tag === 'rect') {
      const r = {
        order, kind: 'rect',
        x: num(a, 'x'), y: num(a, 'y'),
        w: num(a, 'width'), h: num(a, 'height'),
        fill: attr(a, 'fill'), label: attr(a, 'opacity') === '0.93',
        text: ''
      };
      r.x2 = r.x + r.w; r.y2 = r.y + r.h;
      if (r.label) items.push(r);
      else if (BOX_FILLS.has(r.fill) && attr(a, 'stroke') &&
        attr(a, 'stroke') !== 'none') items.push(r);   // skip un-stroked shadows
    } else if (tag === 'text') {
      // attribute the text to the box/label it falls inside
      const tx = num(a, 'x'), ty = num(a, 'y');
      const end = svg.indexOf('</text>', re.lastIndex);
      const body = end > -1 ? svg.slice(re.lastIndex, end).trim() : '';
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind !== 'rect') continue;
        if (tx >= it.x - 2 && tx <= it.x2 + 2 && ty >= it.y - 2 && ty <= it.y2 + 2) {
          it.text = (it.text ? it.text + ' | ' : '') + body;
          break;
        }
      }
    } else if (tag === 'path') {
      const d = attr(a, 'd') || '';
      if (!/^M[\d.-]/.test(d) || !a.includes('stroke=')) continue;
      const pts = d.match(/-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?/g);
      if (!pts) continue;
      const p = pts.map(s => s.split(',').map(Number));
      const segs = [];
      let diag = false;
      for (let i = 1; i < p.length; i++) {
        const [x1, y1] = p[i - 1], [x2, y2] = p[i];
        segs.push([x1, y1, x2, y2]);
        if (Math.abs(x2 - x1) > 0.5 && Math.abs(y2 - y1) > 0.5) diag = true;
      }
      items.push({ order, kind: 'path', segs, diag, d: d.slice(0, 40) });
    }
  }

  const labels = items.filter(i => i.kind === 'rect' && i.label);
  const boxes = items.filter(i => i.kind === 'rect' && !i.label);
  const paths = items.filter(i => i.kind === 'path');
  const out = [];
  const hit = (a, b) => a.x < b.x2 - 1 && a.x2 > b.x + 1 && a.y < b.y2 - 1 && a.y2 > b.y + 1;
  const at = r => `(${Math.round(r.x)},${Math.round(r.y)}) ${Math.round(r.w)}x${Math.round(r.h)}` +
    ` "${(r.text || '').replace(/\s+/g, ' ').slice(0, 58)}"`;

  for (const p of paths.filter(p => p.diag)) out.push(`DIAG  diagonal segment at ${p.d}`);

  for (let i = 0; i < labels.length; i++)
    for (let j = i + 1; j < labels.length; j++)
      if (hit(labels[i], labels[j]))
        out.push(`OVL   labels overlap  ${at(labels[i])}  vs  ${at(labels[j])}`);

  for (const l of labels)
    for (const b of boxes)
      if (hit(l, b)) out.push(`BOX   label on a shape  ${at(l)}  over box ${at(b)}`);

  // segment vs rectangle
  const crossesBox = (s, b) => {
    const [x1, y1, x2, y2] = s;
    const eps = 2;
    const inside = (x, y) => x > b.x + eps && x < b.x2 - eps && y > b.y + eps && y < b.y2 - eps;
    if (inside(x1, y1) || inside(x2, y2)) return true;
    // sample along the segment
    const n = Math.max(2, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 10));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      if (inside(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)) return true;
    }
    return false;
  };

  for (const p of paths)
    for (const b of boxes) {
      for (const s of p.segs)
        if (crossesBox(s, b)) {
          out.push(`CROSS line runs through a shape  seg [${s.map(Math.round)}] box ${at(b)}`);
          break;
        }
    }

  // an arrowhead buried inside a shape is an arrow nobody can see
  for (const p of paths) {
    const last = p.segs[p.segs.length - 1];
    if (!last) continue;
    const ex = last[2], ey = last[3];
    for (const b of boxes)
      if (ex > b.x + 3 && ex < b.x2 - 3 && ey > b.y + 3 && ey < b.y2 - 3) {
        out.push(`ARRW  arrowhead hidden inside a shape at (${Math.round(ex)},${Math.round(ey)}) ` +
          `box ${at(b)}`);
        break;
      }
  }

  // two different flows sharing a stretch of lane become one unreadable line
  for (let i = 0; i < paths.length; i++)
    for (let j = i + 1; j < paths.length; j++)
      for (const a of paths[i].segs)
        for (const b of paths[j].segs) {
          const av = Math.abs(a[0] - a[2]) < 1, bv = Math.abs(b[0] - b[2]) < 1;
          const ah = Math.abs(a[1] - a[3]) < 1, bh = Math.abs(b[1] - b[3]) < 1;
          if (av && bv && Math.abs(a[0] - b[0]) < 3) {
            const lo = Math.max(Math.min(a[1], a[3]), Math.min(b[1], b[3]));
            const hi = Math.min(Math.max(a[1], a[3]), Math.max(b[1], b[3]));
            if (hi - lo > 12)
              out.push(`MERGE two flows share the lane x=${Math.round(a[0])} over y ` +
                `${Math.round(lo)}..${Math.round(hi)}`);
          }
          if (ah && bh && Math.abs(a[1] - b[1]) < 3) {
            const lo = Math.max(Math.min(a[0], a[2]), Math.min(b[0], b[2]));
            const hi = Math.min(Math.max(a[0], a[2]), Math.max(b[0], b[2]));
            if (hi - lo > 12)
              out.push(`MERGE two flows share the lane y=${Math.round(a[1])} over x ` +
                `${Math.round(lo)}..${Math.round(hi)}`);
          }
        }

  for (const l of labels)
    for (const p of paths) {
      if (p.order < l.order) continue;          // drawn before the halo: fine
      for (const s of p.segs) {
        const [x1, y1, x2, y2] = s;
        const seg = { x: Math.min(x1, x2), y: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2) };
        if (hit(seg, l)) {
          out.push(`OVER  line on top of label  label ${at(l)}  seg [${s.map(Math.round)}]`);
          break;
        }
      }
    }

  const svgW = parseFloat((svg.match(/<svg[^>]*width="([\d.]+)"/) || [, 0])[1]);
  const svgH = parseFloat((svg.match(/<svg[^>]*height="([\d.]+)"/) || [, 0])[1]);
  for (const l of labels)
    if (l.x < 8 || l.y < 8 || l.x2 > svgW - 8 || l.y2 > svgH - 8)
      out.push(`BND   label outside the canvas  ${at(l)}`);

  if (out.length) {
    bad += out.length;
    console.log(`\n${file}`);
    [...new Set(out)].sort().forEach(s => console.log('  ' + s));
  }
}
console.log(bad ? `\n${bad} problem(s)` : '\nall clean');
process.exit(bad ? 1 : 0);
