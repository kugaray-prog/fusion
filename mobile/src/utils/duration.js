// Formats a whole-seconds duration as "1h 24m" (or "42m" / "0m" for short
// durations). Used everywhere a Duration column needs to show accumulated
// time across possibly-multiple time-in/time-out sessions.
export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

// A record's live accumulated duration in seconds: total_duration_seconds
// from every already-closed session, plus (if a session is currently open)
// the time elapsed since that session's time_in — so the figure keeps
// ticking upward while attendance is on-going, not just after time-out.
//
// `pendingExitAt` (set locally the moment the device detects, via GPS alone,
// that it has left the geofence while a session is still open — see
// AttendanceTrackingContext) caps the ticking at that timestamp instead of
// the true wall clock. Without this, the displayed (and eventually synced)
// duration would keep climbing for as long as the device is outside the
// boundary with no connectivity to tell the server, crediting the entire
// offline-and-outside gap as attendance once the ping finally lands.
export function liveDurationSeconds(record, nowMs = Date.now()) {
  const base = Number(record?.total_duration_seconds) || 0;
  if (!record?.open_session_time_in) return base;
  const openSince = new Date(record.open_session_time_in).getTime();
  if (Number.isNaN(openSince)) return base;
  let effectiveNowMs = nowMs;
  if (record.pendingExitAt) {
    const exitMs = new Date(record.pendingExitAt).getTime();
    if (!Number.isNaN(exitMs)) effectiveNowMs = Math.min(nowMs, exitMs);
  }
  return base + Math.max(0, (effectiveNowMs - openSince) / 1000);
}
