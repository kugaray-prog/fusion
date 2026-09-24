/**
 * Summarizes a JMeter .jtl (CSV) results file per request label.
 *
 *   node loadtest/cases/summarize.js results.jtl [--per-minute] [--split-at=SECONDS]
 *
 * --per-minute   p95 per minute of the run (LT-04 stability)
 * --split-at=N   separate stats for samples before/after N s from the start
 *                (LT-03: probe latency before vs during report generation)
 */
const fs = require('fs');

const [file, ...flags] = process.argv.slice(2);
const perMinute = flags.includes('--per-minute');
const splitAt = Number((flags.find((f) => f.startsWith('--split-at=')) || '').split('=')[1]) || null;

// JMeter CSV: failure messages can contain commas, quotes and even line
// breaks inside a quoted field, so parse the whole file, not line by line.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.length > 1) rows.push(row);
      row = [];
    } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); if (row.length > 1) rows.push(row); }
  return rows;
}

const table = parseCsv(fs.readFileSync(file, 'utf8'));
const head = table[0];
const col = (n) => head.indexOf(n);
const rows = table.slice(1).map((r) => ({
  t: Number(r[col('timeStamp')]),
  ms: Number(r[col('elapsed')]),
  label: r[col('label')],
  code: r[col('responseCode')],
  ok: r[col('success')] === 'true',
  msg: r[col('failureMessage')] || r[col('responseMessage')]
}));
const t0 = Math.min(...rows.map((r) => r.t));
const t1 = Math.max(...rows.map((r) => r.t + r.ms));

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
function stats(rs) {
  const e = rs.map((r) => r.ms).sort((a, b) => a - b);
  const codes = {};
  rs.forEach((r) => { codes[r.code] = (codes[r.code] || 0) + 1; });
  const errors = {};
  rs.filter((r) => !r.ok).forEach((r) => { const k = `${r.code} ${r.msg}`.slice(0, 140); errors[k] = (errors[k] || 0) + 1; });
  return {
    n: rs.length,
    avg: Math.round(e.reduce((a, b) => a + b, 0) / e.length),
    p50: pct(e, 0.5), p90: pct(e, 0.9), p95: pct(e, 0.95), max: e[e.length - 1],
    errors: rs.filter((r) => !r.ok).length,
    codes,
    ...(Object.keys(errors).length ? { error_detail: errors } : {})
  };
}

const byLabel = {};
rows.forEach((r) => { (byLabel[r.label] = byLabel[r.label] || []).push(r); });

const out = {
  file,
  duration_s: Math.round((t1 - t0) / 1000),
  total: stats(rows),
  throughput_per_s: +(rows.length / ((t1 - t0) / 1000)).toFixed(2),
  by_request: Object.fromEntries(Object.entries(byLabel).map(([k, v]) => [k, stats(v)]))
};

if (perMinute) {
  const mins = {};
  rows.forEach((r) => { const m = Math.floor((r.t - t0) / 60000); (mins[m] = mins[m] || []).push(r); });
  out.per_minute = Object.entries(mins).map(([m, rs]) => {
    const s = stats(rs);
    return { minute: Number(m) + 1, n: s.n, avg: s.avg, p95: s.p95, max: s.max, errors: s.errors };
  });
}

if (splitAt) {
  out.split = {};
  for (const [k, v] of Object.entries(byLabel)) {
    const before = v.filter((r) => r.t - t0 < splitAt * 1000);
    const after = v.filter((r) => r.t - t0 >= splitAt * 1000);
    out.split[k] = {
      before: before.length ? stats(before) : null,
      after: after.length ? stats(after) : null
    };
  }
}

console.log(JSON.stringify(out, null, 2));
