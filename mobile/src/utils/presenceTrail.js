import AsyncStorage from '@react-native-async-storage/async-storage';

// Proof that the phone stayed inside while it couldn't reach the server
// (Wi-Fi off, no mobile data). With no internet the server hears nothing and
// times the session out at the last ping (closeSilentSessions), even though
// GPS -- which needs no internet -- shows the employee never left. So for
// each open session this keeps:
//   ackAt   -- when the server last heard from the phone (a counted ping or
//              the time-in)
//   lastAt  -- the latest GPS reading since then
//   broken  -- whether that run of readings had a gap (Location off, app or
//              phone stopped) or a mock (Fake GPS) reading
// Leaving the area doesn't need tracking here: the exit reading itself is
// held and resent until the server takes it (pendingExits). Once back online,
// each ping carries offlineInsideSeconds() and the server reopens a session it
// timed out for silence if the run reaches back to that time-out
// (attendanceController.resumeAfterOffline).
//
// Shared by the open app's tracker and the background task, which run in the
// same JS runtime while the app is alive; saved to storage so a background
// task restarted after the app was closed carries on from it.

const STORAGE_KEY = 'presence_trail';
// Readings come every 1-3 s; a longer silence means Location went off or
// tracking stopped, so presence for that stretch can't be vouched for.
const MAX_GAP_MS = 30000;
const SAVE_EVERY_MS = 5000;
const FORGET_AFTER_MS = 24 * 60 * 60 * 1000;

let trails = null; // attendanceId -> { ackAt, lastAt, broken }
let loading = null;
let lastSavedAt = 0;

async function load() {
  if (trails) return trails;
  if (!loading) {
    loading = AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => { trails = (raw && JSON.parse(raw)) || {}; })
      .catch(() => { trails = {}; });
  }
  await loading;
  return trails;
}

function save(force) {
  const now = Date.now();
  if (!force && now - lastSavedAt < SAVE_EVERY_MS) return;
  lastSavedAt = now;
  Object.keys(trails).forEach((id) => {
    if (now - trails[id].ackAt > FORGET_AFTER_MS) delete trails[id];
  });
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(trails)).catch(() => {});
}

// The server just heard from the phone about this session: a fresh run starts.
export async function noteServerHeard(attendanceId) {
  if (!attendanceId) return;
  const all = await load();
  const now = Date.now();
  all[attendanceId] = { ackAt: now, lastAt: now, broken: false };
  save(true);
}

// A GPS reading, applied to every open session's run.
export async function noteReading({ at = Date.now(), mocked = false } = {}) {
  const all = await load();
  Object.values(all).forEach((t) => {
    if (mocked || at - t.lastAt > MAX_GAP_MS) t.broken = true;
    if (at > t.lastAt) t.lastAt = at;
  });
  save(false);
}

// Seconds since the server last heard from this phone, all spent inside
// with an unbroken run of readings up to `untilMs` (the exit / Location-off
// moment for a held reading, otherwise now) -- or undefined if that can't be
// vouched for.
export async function offlineInsideSeconds(attendanceId, untilMs = Date.now()) {
  if (!attendanceId) return undefined;
  const t = (await load())[attendanceId];
  if (!t || t.broken || untilMs - t.lastAt > MAX_GAP_MS) return undefined;
  return Math.max(1, Math.ceil((Date.now() - t.ackAt) / 1000));
}

// The session is closed for good (server confirmed): nothing left to vouch for.
export async function forgetTrail(attendanceId) {
  const all = await load();
  if (!all[attendanceId]) return;
  delete all[attendanceId];
  save(true);
}

export async function clearTrails() {
  trails = {};
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    // ignore
  }
}
