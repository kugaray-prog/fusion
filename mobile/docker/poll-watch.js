// Makes Metro notice edits saved from Windows.
//
// Docker Desktop doesn't forward file-change events from a Windows folder
// into the container, so Metro never sees an edit made in VS Code and the
// phone keeps the old bundle. This polls the project for changed mtimes and
// re-touches each changed file from inside the container, which does raise a
// Linux event, so Metro rebuilds and Expo Go Fast Refreshes on its own.
//
//   node docker/poll-watch.js [interval ms, default 500]

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INTERVAL = Number(process.argv[2]) || 500;
const SKIP = new Set(['node_modules', '.expo', '.git', 'android', 'ios', 'docker']);

let known = new Map();

function scan(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scan(full, out);
    } else if (entry.isFile()) {
      try {
        const st = fs.statSync(full);
        out.set(full, `${st.mtimeMs}:${st.size}`);
      } catch (e) {
      }
    }
  }
  return out;
}

function tick() {
  const current = scan(ROOT, new Map());
  for (const [file, stamp] of current) {
    const before = known.get(file);
    if (before === stamp) continue;
    try {
      const now = new Date();
      fs.utimesSync(file, now, now);
      const st = fs.statSync(file);
      current.set(file, `${st.mtimeMs}:${st.size}`);
      console.log(`[poll-watch] changed: ${path.relative(ROOT, file)}`);
    } catch (e) {
    }
  }
  known = current;
  setTimeout(tick, INTERVAL);
}

known = scan(ROOT, new Map());
console.log(`[poll-watch] watching ${ROOT} every ${INTERVAL}ms`);
setTimeout(tick, INTERVAL);
