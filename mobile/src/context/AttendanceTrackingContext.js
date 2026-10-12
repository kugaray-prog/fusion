import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { AppState, Platform } from 'react-native';
import * as Location from 'expo-location';
import { useAuth } from './AuthContext';
import { useLocationStatus } from './LocationStatusContext';
import { getGeofences, registerDevice, submitAttendance, sendHeartbeat, getMyHistory } from '../api/client';
import { navigationRef } from '../navigation/navigationRef';
import { notify } from '../utils/notify';
import { getDeviceUid, getDeviceInfo } from '../utils/device';
import { liveDurationSeconds } from '../utils/duration';
import { useLiveUpdates } from '../api/realtime';
import { alertFaceVerificationRequired, clearFaceVerificationAlert } from '../utils/faceVerificationAlert';
import Notifications from '../utils/notificationsModule';
import { distanceToEdgeMeters, distanceMeters, isInsideGeofence, isEventActiveNow, localDateString } from '../utils/geofence';
import {
  saveBackgroundState,
  clearBackgroundState,
  startBackgroundAttendance,
  stopBackgroundAttendance,
  ensureBackgroundPermission
} from '../tasks/backgroundAttendance';
import { noteServerHeard, noteReading, offlineInsideSeconds, forgetTrail, clearTrails } from '../utils/presenceTrail';

// When the employee actually crossed the boundary, between the last reading
// inside (prev) and the first one outside (now): assuming a steady walk, the
// crossing happened in proportion to how far each reading is from the edge.
// Falls back to the outside reading's own time if prev is missing or stale.
function estimateExitTimeMs(prev, now, points) {
  if (!prev || !(now.at > prev.at) || now.at - prev.at > 30000) return now.at;
  const dIn = distanceToEdgeMeters(prev.latitude, prev.longitude, points);
  const dOut = distanceToEdgeMeters(now.latitude, now.longitude, points);
  if (!(dIn + dOut > 0)) return now.at;
  return Math.round(prev.at + (now.at - prev.at) * (dIn / (dIn + dOut)));
}

// How often the last known location is re-checked against the geofences
// even when no new GPS reading arrives. Android only reports a new reading
// after the phone moves (distanceInterval), so someone already standing
// inside when an event starts would otherwise wait for the next poll.
const REEVALUATE_MS = 5000;
// After a rejected time-in, wait this long before trying again, instead of
// resending on every GPS reading (every ~1s).
const CHECK_IN_RETRY_MS = 2000;

// How often a session already checked-in pings the server with the current
// location. Leaving the geofence doesn't wait for this: evaluateLocation sends
// the exit reading immediately (see config.attendance.autoEndOutsideStreakThreshold
// on the backend). Kept a little above the backend's own
// heartbeatMinIntervalSeconds (10s default) so pings aren't silently dropped,
// and frequent enough that the backend's "same location as another
// employee" check -- which compares against positions from the last 30s and
// asks again every 30s (anomalyWindowSeconds / anomalyRecheckSeconds) --
// always has a fresh position for this phone.
// Also well inside the server's 30 s silence window
// (silentSessionSeconds), so a phone that goes quiet -- Location switched
// off with the app closed -- is timed out within about half a minute.
const HEARTBEAT_INTERVAL_MS = 12000;
// Between heartbeats, a GPS reading this far (meters) from the last position
// sent is pushed to the server right away, at most once per LIVE_POSITION_MIN_MS,
// so the admin sees the employee's latitude/longitude move as they move.
const LIVE_POSITION_MIN_METERS = 3;
const LIVE_POSITION_MIN_MS = 3000;
// How often the list of active event geofences is refreshed, so a
// newly-started event is picked up without an app restart.
const GEOFENCE_POLL_MS = 30000;
// Consecutive local GPS readings outside the geofence (while a session is
// open) required before the app treats itself as "exited": it freezes the
// displayed duration, locks in that exact reading (coordinates + the GPS
// timestamp) and sends it to the server right away so the time-out lands in
// real time. 1 = the first reading outside the polygon. GPS keeps working
// without connectivity, so this is detected instantly even with no
// signal/WiFi; the heartbeat keeps retrying the same reading until the
// server acknowledges it.
const LOCAL_OUTSIDE_CONFIRM_READINGS = 1;

const AttendanceTrackingContext = createContext(null);

export function AttendanceTrackingProvider({ children }) {
  const { employee, deviceStatus, loading: authLoading } = useAuth();
  const { locationEnabled } = useLocationStatus();
  // Tracking (auto time-in/out) is a location-dependent feature, so it's
  // gated on Location/GPS actually being on at the OS level, not just on
  // being signed in — see LocationStatusContext + LocationGateOverlay, which
  // blocks the UI the same moment this stops running.
  const trackingEnabled = !!employee && deviceStatus === 'approved' && locationEnabled;

  const [location, setLocation] = useState(null);
  const [accuracy, setAccuracy] = useState(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [geofences, setGeofences] = useState([]);
  // event_id -> { inside, geofence }
  const [presence, setPresence] = useState({});
  // event_id -> attendance record { id, time_in, time_out, total_duration_seconds,
  // open_session_time_in, session_count }, for anything open or completed
  // today — restored from the server on mount so tracking (and the
  // accumulated duration) survives an app restart, not just an in-memory submit.
  const [sessions, setSessions] = useState({});
  const [autoSubmitting, setAutoSubmitting] = useState({}); // event_id -> bool, guards against double-submits
  // event_id -> the server's reason for the last rejected auto time-in (e.g.
  // "GPS accuracy too low"), shown on the Attendance screen so a failed
  // check-in isn't indistinguishable from one that's still in progress.
  const [checkInErrors, setCheckInErrors] = useState({});

  const watchRef = useRef(null);
  const heartbeatTimers = useRef({}); // attendanceId -> interval
  const heartbeatTicks = useRef({}); // attendanceId -> that session's heartbeat function
  const heartbeatInFlight = useRef({}); // attendanceId -> true while a ping is awaiting the server
  const heartbeatRerun = useRef({}); // attendanceId -> true when a ping was requested while one was in flight
  const lastSentPositionRef = useRef({}); // attendanceId -> { latitude, longitude, at } last sent to the server
  const locationRef = useRef(null);
  const lastInsideRef = useRef({}); // event_id -> last GPS reading inside its geofence { latitude, longitude, at }
  // Android's mock-location flag for the latest reading (Fake GPS apps set
  // it); sent with every time-in and heartbeat so the server can refuse it.
  const mockedRef = useRef(false);
  const lastCheckInFailureRef = useRef({}); // event_id -> ms of the last rejected time-in
  // attendanceId -> true, once FaceVerificationScreen has been opened for it
  // this app session -- stops a still-pending anomaly from re-navigating
  // there on every periodic history refresh while the employee has
  // deliberately backed out of it and is doing something else in the app.
  // It's still re-checked (and will navigate again) on every fresh mount
  // (app open/resume), since that ref itself is reset by a remount.
  const promptedVerificationRef = useRef({});

  // Sends the employee straight to FaceVerificationScreen -- called both
  // right after a time-in that comes back flagged, and from
  // refreshSessionsFromHistory below for a flag that's still open from
  // earlier (app was closed/backgrounded before it got resolved).
  const goToFaceVerification = useCallback((attendanceId, eventTitle) => {
    if (!attendanceId) return;
    // Sound + vibration so an employee with the phone in their pocket still
    // notices; throttled internally, so it repeats while still flagged.
    alertFaceVerificationRequired(attendanceId, eventTitle);
    if (promptedVerificationRef.current[attendanceId]) return;
    // FaceVerification is only registered once the employee is past the
    // WaitingApproval / WifiCheck gates (see App.js RootNavigator). Tracking
    // can flag a record before that -- e.g. right after an app reload, while
    // WifiCheck is still showing -- so hold it and navigate as soon as the
    // screen exists (see the navigationRef 'state' listener below).
    const routeNames = navigationRef.isReady() ? navigationRef.getRootState()?.routeNames : null;
    if (!routeNames || !routeNames.includes('FaceVerification')) {
      pendingVerificationNavRef.current = { attendanceId, eventTitle };
      return;
    }
    pendingVerificationNavRef.current = null;
    promptedVerificationRef.current[attendanceId] = true;
    navigationRef.navigate('FaceVerification', { attendanceId, eventTitle });
  }, []);
  // A flagged record waiting for the FaceVerification screen to become
  // available -- { attendanceId, eventTitle } or null.
  const pendingVerificationNavRef = useRef(null);
  useEffect(() => {
    const unsubscribe = navigationRef.addListener('state', () => {
      const pending = pendingVerificationNavRef.current;
      if (!pending) return;
      // Deferred so it doesn't navigate in the middle of the navigator's
      // own screen-list swap.
      setTimeout(() => goToFaceVerification(pending.attendanceId, pending.eventTitle), 0);
    });
    return unsubscribe;
  }, [goToFaceVerification]);
  const sessionsRef = useRef({});
  const geofencesRef = useRef([]);
  const autoSubmittingRef = useRef({});
  const localOutsideStreakRef = useRef({}); // event_id -> consecutive local "outside" GPS readings while a session is open
  // event_id -> { attendanceId, observedAt (ISO), latitude, longitude } for a
  // confirmed-outside reading that hasn't been acknowledged by the server
  // yet (offline, or just hasn't gotten a heartbeat through). The heartbeat
  // loop below keeps retrying THIS exact frozen reading -- not whatever the
  // live location happens to be by the time connectivity returns -- so the
  // session is eventually closed using the moment the employee actually
  // left, not the moment the retry finally landed.
  const pendingExitRef = useRef({});

  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  useEffect(() => { geofencesRef.current = geofences; }, [geofences]);
  useEffect(() => { autoSubmittingRef.current = autoSubmitting; }, [autoSubmitting]);

  const deviceUid = useCallback(() => getDeviceUid(), []);

  const stopHeartbeat = (attendanceId) => {
    if (heartbeatTimers.current[attendanceId]) {
      clearInterval(heartbeatTimers.current[attendanceId]);
      delete heartbeatTimers.current[attendanceId];
      delete heartbeatTicks.current[attendanceId];
      delete heartbeatRerun.current[attendanceId];
    }
  };

  // Pings the server periodically for an open session so it can auto time-out
  // (set time_out) once the device has been outside the geofence for a
  // couple of consecutive pings. Runs regardless of which screen is focused —
  // this is what fixes sessions getting stuck "on-going" just because the
  // user navigated away from the Attendance screen. When the server reports
  // the session ended, this just stops the timer and refreshes from the
  // server's own totals — re-entering the geofence later (evaluateLocation
  // below) is what opens the NEXT session and its own heartbeat.
  //
  // If a local exit was detected while offline (pendingExitRef), this keeps
  // resending THAT frozen reading every tick -- not the live location, which
  // may already show the device back inside by the time connectivity
  // returns -- until the server acknowledges the session closed. Sending the
  // original captured coordinates/time repeatedly also naturally rebuilds
  // the server's own outside-streak the same way real-time pings would have.
  const startHeartbeat = useCallback((eventId, attendanceId) => {
    stopHeartbeat(attendanceId);
    const tick = async () => {
      if (heartbeatInFlight.current[attendanceId]) {
        // A ping is already on its way (e.g. a live-position push) -- send
        // this one as soon as it returns instead of dropping it, so an exit
        // detected mid-request still reaches the server immediately.
        heartbeatRerun.current[attendanceId] = true;
        return;
      }
      heartbeatInFlight.current[attendanceId] = true;
      const pending = pendingExitRef.current[eventId];
      const usingPending = pending && pending.attendanceId === attendanceId;
      const coords = usingPending
        ? { latitude: pending.latitude, longitude: pending.longitude, accuracy: pending.accuracy }
        : locationRef.current;
      if (!coords && !(usingPending && pending.locationOff)) {
        delete heartbeatInFlight.current[attendanceId];
        return;
      }
      if (!usingPending && coords) lastSentPositionRef.current[attendanceId] = { ...coords, at: Date.now() };
      try {
        const result = await sendHeartbeat(
          attendanceId,
          coords?.latitude,
          coords?.longitude,
          usingPending ? pending.observedAt : undefined,
          {
            accuracy: coords?.accuracy,
            mocked: usingPending ? pending.mocked : mockedRef.current,
            locationOff: usingPending && pending.locationOff,
            offlineInsideSeconds: await offlineInsideSeconds(attendanceId, usingPending ? Date.parse(pending.observedAt) : Date.now())
          }
        );
        if (result?.data && !result.data.ended && !result.data.ignored) noteServerHeard(attendanceId);
        if (result?.data?.ended) {
          forgetTrail(attendanceId);
          if (usingPending) delete pendingExitRef.current[eventId];
          stopHeartbeat(attendanceId);
          // Closed locally right away (ref too, since the state -> ref sync
          // waits for a re-render), so walking back in times in again on the
          // next GPS reading instead of after the history refresh below. The
          // displayed duration stays frozen at the exit until that refresh
          // brings the server's own total.
          const endedAt = usingPending ? pending.observedAt : new Date().toISOString();
          const closeLocally = (all) => {
            const s = all[eventId];
            if (!s || s.id !== attendanceId || s.time_out) return all;
            return { ...all, [eventId]: { ...s, time_out: endedAt, pendingExitAt: s.pendingExitAt || endedAt } };
          };
          sessionsRef.current = closeLocally(sessionsRef.current);
          setSessions(closeLocally);
          await refreshSessionsFromHistoryRef.current?.();
          // A local exit already told the employee when it was detected.
          if (!usingPending) {
            notify('Time-Out Recorded', 'You left the event area, so your session was automatically timed out. Your total time keeps accumulating if you come back.');
          }
        } else if (result?.data?.requiresFaceVerification) {
          // The server flagged this session mid-way (another employee's
          // device is reporting the same location) -- see detectGeoAnomaly.
          // It also stopped the duration clock, so re-sync to show the
          // paused total instead of a still-ticking one.
          if (!sessionsRef.current[eventId]?.requires_face_verification) {
            refreshSessionsFromHistoryRef.current?.();
          }
          const geofence = geofencesRef.current.find((g) => g.event_id === eventId);
          goToFaceVerification(attendanceId, geofence?.title);
        } else if (result?.data && result.data.requiresFaceVerification === false) {
          clearFaceVerificationAlert(attendanceId);
          // Verified -- a later re-flag (still at the same spot as another
          // phone after another 30s) must open the screen again.
          delete promptedVerificationRef.current[attendanceId];
          // Verified elsewhere (e.g. admin-assisted) -- pick up the resumed session.
          if (sessionsRef.current[eventId]?.requires_face_verification) {
            refreshSessionsFromHistoryRef.current?.();
          }
        }
      } catch (e) {
        // Non-fatal — a missed ping just retries on the next tick, still
        // using the same frozen pending-exit reading if one is set, so a
        // connectivity gap doesn't lose track of when the employee actually left.
      } finally {
        delete heartbeatInFlight.current[attendanceId];
        if (heartbeatRerun.current[attendanceId]) {
          delete heartbeatRerun.current[attendanceId];
          if (heartbeatTicks.current[attendanceId] === tick) tick();
        }
      }
    };
    heartbeatTicks.current[attendanceId] = tick;
    heartbeatTimers.current[attendanceId] = setInterval(tick, HEARTBEAT_INTERVAL_MS);
  }, [goToFaceVerification]);

  // Sends the new position straight away when the employee moves, instead
  // of waiting for the next 25s heartbeat, so the admin's attendance view
  // follows them live. Skipped for a session with a frozen exit reading --
  // the heartbeat keeps resending that one instead.
  const pushLivePosition = (coords) => {
    Object.entries(sessionsRef.current).forEach(([eventId, s]) => {
      if (!s?.id || s.time_out || pendingExitRef.current[eventId]) return;
      const tick = heartbeatTicks.current[s.id];
      if (!tick) return;
      const last = lastSentPositionRef.current[s.id];
      if (last) {
        if (Date.now() - last.at < LIVE_POSITION_MIN_MS) return;
        // A move smaller than the reading's own accuracy radius is just GPS
        // jitter -- a phone lying still indoors drifts several meters -- and
        // would otherwise send a ping every few seconds without anyone moving.
        const minMeters = Math.max(LIVE_POSITION_MIN_METERS, Number(coords.accuracy) || 0);
        if (distanceMeters(last.latitude, last.longitude, coords.latitude, coords.longitude) < minMeters) return;
      }
      tick();
    });
  };

  // Restores today's attendance state (open, completed, or in-between visits)
  // from the server — including the accumulated total_duration_seconds and
  // which session (if any) is currently open — so auto time-in doesn't fire
  // again for a session already open, and an already-open session resumes
  // its heartbeat immediately on app start, even if it was left open from a
  // previous app session.
  const refreshSessionsFromHistory = useCallback(async () => {
    try {
      let history = await getMyHistory();
      const today = localDateString();
      // Timed out by the server while this phone was offline but stayed
      // inside (see utils/presenceTrail.js): ask for it back before taking
      // the time-out as final, or the next reading inside would just time in
      // afresh and lose the offline stretch.
      const heldExitFor = (a) => {
        const p = pendingExitRef.current[a.event_id];
        return p && p.attendanceId === a.id ? p : null;
      };
      const resumable = [];
      for (const a of (history.data || []).filter((r) => r.attendance_date === today && r.time_out)) {
        const p = heldExitFor(a);
        const claim = await offlineInsideSeconds(a.id, p ? Date.parse(p.observedAt) : Date.now());
        if (claim) resumable.push({ a, p, claim });
      }
      if (resumable.length) {
        await Promise.all(resumable.map(async ({ a, p, claim }) => {
          const coords = p || locationRef.current;
          try {
            const result = await sendHeartbeat(a.id, coords?.latitude, coords?.longitude, p?.observedAt, {
              accuracy: coords?.accuracy,
              mocked: p ? p.mocked : mockedRef.current,
              locationOff: !!p?.locationOff,
              offlineInsideSeconds: claim
            });
            if (result?.data?.ended) {
              forgetTrail(a.id);
              if (p) delete pendingExitRef.current[a.event_id];
            } else if (result?.data && !result.data.ignored) {
              noteServerHeard(a.id);
            }
          } catch (e) {
            // Still offline -- tried again on the next refresh or heartbeat.
          }
        }));
        history = await getMyHistory();
      }
      const todays = (history.data || []).filter((a) => a.attendance_date === today);
      const map = {};
      todays.forEach((a) => {
        map[a.event_id] = {
          id: a.id,
          time_in: a.time_in,
          time_out: a.time_out,
          total_duration_seconds: a.total_duration_seconds,
          open_session_time_in: a.open_session_time_in,
          session_count: a.session_count,
          // While set, the server has the duration clock stopped until the
          // employee passes face verification.
          requires_face_verification: !!a.requires_face_verification
        };
      });
      // A confirmed-but-not-yet-acknowledged local exit (see evaluateLocation)
      // must keep freezing its event's displayed duration even across this
      // refresh -- otherwise a history sync while still offline would let the
      // figure start climbing again with the true wall clock.
      Object.entries(pendingExitRef.current).forEach(([eventId, pending]) => {
        const session = map[eventId];
        if (session && session.id === pending.attendanceId && !session.time_out) {
          session.pendingExitAt = pending.observedAt;
        } else {
          // Either already closed server-side or no longer matches this
          // session — nothing left for this pending reading to do.
          delete pendingExitRef.current[eventId];
        }
      });
      setSessions(map);
      todays.forEach((a) => {
        if (!a.time_out) startHeartbeat(a.event_id, a.id);
      });
      // A record flagged by anomaly detection (requires_face_verification)
      // that's still unresolved -- e.g. the employee backed out of
      // FaceVerificationScreen, or closed the app before completing it --
      // gets re-prompted here rather than staying silently unconfirmed.
      // goToFaceVerification's own promptedVerificationRef guards against
      // this firing again for a record already shown this session, so it
      // only actually re-navigates on a fresh mount (app open/resume).
      // Once the event has ended, verification is closed server-side
      // (faceVerify answers 410), so an ended event never brings the screen up.
      const eventEnded = (a) => !!a.event_end && new Date(a.event_end) <= new Date();
      const stillFlagged = todays.find((a) => a.requires_face_verification && !eventEnded(a));
      if (stillFlagged) {
        goToFaceVerification(stillFlagged.id, stillFlagged.event_title);
      }
      todays.forEach((a) => {
        if (!a.requires_face_verification || eventEnded(a)) {
          clearFaceVerificationAlert(a.id);
          delete promptedVerificationRef.current[a.id];
        }
      });
    } catch (e) {
      // Non-fatal — worst case auto time-in re-evaluates from a blank slate
      // and the backend's own duplicate check still protects against double entries.
    }
  }, [startHeartbeat, goToFaceVerification]);

  // startHeartbeat needs to call refreshSessionsFromHistory (to re-sync the
  // total after an auto-end), but refreshSessionsFromHistory also calls
  // startHeartbeat — a ref sidesteps the circular dependency without
  // re-creating the interval callback on every history refresh.
  const refreshSessionsFromHistoryRef = useRef(null);
  useEffect(() => { refreshSessionsFromHistoryRef.current = refreshSessionsFromHistory; }, [refreshSessionsFromHistory]);

  const refreshGeofences = useCallback(async () => {
    try {
      const res = await getGeofences();
      setGeofences(res.data || []);
    } catch (e) {
      // Non-fatal — next poll tries again.
    }
  }, []);

  // Automatically records a time-in the moment the device is detected inside
  // an active event's geofence — no button tap required. Also fires on a
  // RE-entry (the employee left and came back while the event is still
  // running): the backend opens a new session and keeps adding to the same
  // day's accumulated total rather than starting over.
  const autoCheckIn = useCallback(async (geofence, coords, acc) => {
    const eventId = geofence.event_id;
    if (autoSubmittingRef.current[eventId]) return;
    if (Date.now() - (lastCheckInFailureRef.current[eventId] || 0) < CHECK_IN_RETRY_MS) return;
    // Set synchronously: the state -> ref sync below only lands after a
    // re-render, and a second GPS reading can arrive before that.
    autoSubmittingRef.current = { ...autoSubmittingRef.current, [eventId]: true };
    setAutoSubmitting((prev) => ({ ...prev, [eventId]: true }));
    try {
      const result = await submitAttendance({
        employee_id: employee.id,
        device_uid: deviceUid(),
        event_id: eventId,
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: acc,
        ...(mockedRef.current ? { mocked: true } : {})
      });
      delete lastCheckInFailureRef.current[eventId];
      setCheckInErrors((prev) => ({ ...prev, [eventId]: null }));
      if (result?.data?.id) {
        noteServerHeard(result.data.id);
        const nowIso = new Date().toISOString();
        // A flagged time-in has its clock stopped server-side until face
        // verification passes, so it must not start ticking here either.
        const paused = !!result.data.requiresFaceVerification;
        setSessions((prev) => ({
          ...prev,
          [eventId]: {
            ...(prev[eventId] || {}),
            id: result.data.id,
            time_in: prev[eventId]?.time_in || nowIso,
            time_out: null,
            open_session_time_in: paused ? null : nowIso,
            session_count: (prev[eventId]?.session_count || 0) + (paused ? 0 : 1),
            requires_face_verification: paused
          }
        }));
        startHeartbeat(eventId, result.data.id);
        notify(
          result.data.action === 're_time_in' ? 'Time-In Recorded Again' : 'Time-In Recorded',
          result.data.action === 're_time_in'
            ? `Welcome back to "${geofence.title}" — you were automatically timed in again.`
            : `You entered "${geofence.title}" and were automatically timed in.`
        );
        // Unusual location activity was detected on this time-in (see
        // detectGeoAnomaly on the backend) -- send the employee straight
        // into on-device Face Verification. This is never something an
        // admin does on the employee's behalf; the attendance stays
        // unconfirmed until this employee proves it's them, right here.
        if (result.data.requiresFaceVerification) {
          refreshSessionsFromHistoryRef.current?.();
          goToFaceVerification(result.data.id, geofence.title);
        }
      }
    } catch (err) {
      // Expected rejections (outside geofence by the time the request lands,
      // event window closed, GPS accuracy too low, device not yet approved)
      // don't pop up an alert — the next location update just tries again —
      // but the reason is kept so the Attendance screen can show it.
      lastCheckInFailureRef.current[eventId] = Date.now();
      if (err?.response?.status === 409) {
        // The server already has a session open for this event (e.g. timed
        // in before an app restart and the history refresh failed). Sync
        // instead of retrying a time-in that can never succeed.
        await refreshSessionsFromHistoryRef.current?.();
        setCheckInErrors((prev) => ({ ...prev, [eventId]: null }));
        return;
      }
      const message = err?.response?.data?.message
        || (err?.request ? 'Could not reach the server to record your time-in. Retrying…' : 'Time-in failed. Retrying…');
      setCheckInErrors((prev) => ({ ...prev, [eventId]: message }));
    } finally {
      autoSubmittingRef.current = { ...autoSubmittingRef.current, [eventId]: false };
      setAutoSubmitting((prev) => ({ ...prev, [eventId]: false }));
    }
  }, [employee, deviceUid, startHeartbeat, goToFaceVerification]);

  // Core loop: whenever a fresh location comes in, check it against every
  // currently-active event geofence. Entering one with no OPEN session right
  // now -> auto time-in (which may be a first check-in or a re-entry after an
  // earlier auto time-out — either way the day's duration keeps accumulating).
  //
  // Leaving one with an OPEN session -> after LOCAL_OUTSIDE_CONFIRM_READINGS
  // consecutive outside readings (1 by default), freeze that session's
  // displayed duration right here (pendingExitAt), lock in this exact
  // reading and send it to the server immediately; the heartbeat loop keeps
  // retrying it if there's no connectivity (see startHeartbeat). The server
  // closes the session at that reading's own GPS timestamp, so the time-out
  // is exact even if the request lands late.
  //
  // `recheck` marks a re-evaluation of the last reading rather than a new
  // one: it can time in, but doesn't count toward the outside streak, which
  // must be made of separate GPS readings.
  const evaluateLocation = useCallback((coords, acc, observedAtMs, { recheck = false } = {}) => {
    const activeGeofences = geofencesRef.current.filter((g) => isEventActiveNow(g));
    const nextPresence = {};
    activeGeofences.forEach((g) => {
      if (!g.points || g.points.length < 3) return;
      const inside = isInsideGeofence(coords.latitude, coords.longitude, g.points, acc);
      nextPresence[g.event_id] = { inside, geofence: g };
      const readingAt = observedAtMs || Date.now();
      if (inside && !recheck) {
        lastInsideRef.current[g.event_id] = { latitude: coords.latitude, longitude: coords.longitude, at: readingAt };
      }
      const existingSession = sessionsRef.current[g.event_id];
      // A session is already open for today when we have a record with no
      // time_out — that's the only case where we should NOT re-check-in.
      const hasOpenSession = existingSession && existingSession.id && !existingSession.time_out;
      if (inside && !hasOpenSession) {
        autoCheckIn(g, coords, acc);
      } else if (!inside && hasOpenSession) {
        if (recheck) return;
        const eventId = g.event_id;
        const streak = (localOutsideStreakRef.current[eventId] || 0) + 1;
        localOutsideStreakRef.current[eventId] = streak;
        if (streak >= LOCAL_OUTSIDE_CONFIRM_READINGS && !pendingExitRef.current[eventId]) {
          // The moment they crossed the edge, not just when the first
          // outside reading came in -- but never before this session opened.
          let exitAtMs = estimateExitTimeMs(
            lastInsideRef.current[eventId],
            { latitude: coords.latitude, longitude: coords.longitude, at: readingAt },
            g.points
          );
          const openedAt = new Date(existingSession.open_session_time_in || existingSession.time_in || 0).getTime();
          if (!(exitAtMs >= openedAt)) exitAtMs = readingAt;
          const observedAtIso = new Date(exitAtMs).toISOString();
          pendingExitRef.current[eventId] = {
            attendanceId: existingSession.id,
            observedAt: observedAtIso,
            latitude: coords.latitude,
            longitude: coords.longitude,
            accuracy: acc,
            mocked: mockedRef.current
          };
          setSessions((prev) => ({
            ...prev,
            [eventId]: { ...(prev[eventId] || {}), pendingExitAt: observedAtIso }
          }));
          // Tell the server now rather than on the next scheduled heartbeat,
          // so the time-out is recorded the moment they leave the polygon.
          // The employee is told right away too, even before the server
          // answers (or with no connectivity at all).
          heartbeatTicks.current[existingSession.id]?.();
          notify('Time-Out Recorded', `You left "${g.title}", so you were automatically timed out. Your total time keeps accumulating if you come back.`);
        }
      } else if (inside) {
        localOutsideStreakRef.current[g.event_id] = 0;
        // Note: pendingExitRef is intentionally NOT cleared here — that
        // outside period still needs to reach the server so the session
        // closes with the correct duration before a fresh re-entry session
        // can open (see startHeartbeat/refreshSessionsFromHistory).
      }
    });
    setPresence(nextPresence);
  }, [autoCheckIn]);

  // Admin changes arrive live: new/edited events and event areas, and edits
  // to this employee's attendance. The polls above/below remain for changes
  // that only depend on the clock (an event starting or ending).
  // 'attendance' also arrives the instant the server flags this employee for
  // face verification (and pauses their duration), so the history refresh
  // below opens FaceVerificationScreen right away rather than on the next
  // heartbeat.
  useLiveUpdates(['events', 'geofences', 'attendance'], (topic) => {
    if (!trackingEnabled) return;
    if (topic === 'attendance' || topic === '*') refreshSessionsFromHistory();
    if (topic !== 'attendance') refreshGeofences();
  });

  // Tapping the "Face verification required" notification opens the screen,
  // even if the employee backed out of it earlier this app session.
  useEffect(() => {
    if (!Notifications || !trackingEnabled) return undefined;
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response?.notification?.request?.content?.data;
      if (data?.type !== 'face_verification_required' || !data.attendanceId) return;
      delete promptedVerificationRef.current[data.attendanceId];
      goToFaceVerification(data.attendanceId, data.eventTitle);
    });
    return () => sub.remove();
  }, [trackingEnabled, goToFaceVerification]);

  // Back in the foreground: re-sync, so a flag raised while the app was in
  // the background brings up Face Verification as soon as it's opened.
  useEffect(() => {
    if (!trackingEnabled) return undefined;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshSessionsFromHistoryRef.current?.();
    });
    return () => sub.remove();
  }, [trackingEnabled]);

  // One-time setup: permissions, device registration, initial history/geofence
  // load, and the continuous location watch. Everything below keeps running
  // for as long as the app is in the foreground, regardless of which screen
  // the employee is looking at.
  useEffect(() => {
    if (!trackingEnabled) return;
    let cancelled = false;

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        if (!cancelled) setPermissionDenied(true);
        return;
      }
      if (!cancelled) setPermissionDenied(false);

      // GPS starts first so the phone already has a fix by the time the
      // server calls below finish (a sleeping server can take ~50s to answer).
      // Nothing is evaluated until refreshGeofences loads the event list,
      // which happens after today's sessions are restored, so this can't
      // cause a duplicate time-in.
      try {
        // A reading every second, moving or not, so stepping out of the
        // polygon is noticed within about a second.
        const sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 },
          (loc) => {
            setLocation(loc.coords);
            locationRef.current = loc.coords;
            mockedRef.current = !!loc.mocked;
            noteReading({ at: loc.timestamp || Date.now(), mocked: !!loc.mocked });
            setAccuracy(loc.coords.accuracy);
            // loc.timestamp is when the GPS chip actually took this reading —
            // works fine offline (no WiFi/data needed) and is what lets a
            // "left the geofence" moment be captured accurately even before
            // there's any connectivity to report it (see evaluateLocation).
            evaluateLocation(loc.coords, loc.coords.accuracy, loc.timestamp);
            pushLivePosition(loc.coords);
          }
        );
        if (cancelled) sub.remove();
        else watchRef.current = sub;
      } catch (e) {
        // GPS could have been switched off in the instant between the last
        // LocationStatusContext poll and this call — LocationGateOverlay
        // will catch it on its own next poll tick either way, so there's
        // nothing more to do here than avoid an unhandled rejection.
      }
      if (cancelled) return;

      // All three requests go out together rather than one after another --
      // auto time-in can't happen until they're all back. The event list is
      // only applied once today's sessions are restored, so it still can't
      // cause a duplicate time-in.
      // Same values the registration form showed and submitted.
      const device = getDeviceInfo();
      const registering = registerDevice({
        employee_id: employee.id,
        device_uid: device.uid,
        model: device.model,
        brand: device.brand,
        os: device.os
      }).catch(() => {
        // Non-fatal here — submitAttendance will surface a clear "device not
        // registered/approved" message if it turns out to matter.
      });
      const loadingGeofences = getGeofences().catch(() => null);

      await refreshSessionsFromHistory();
      const geofenceRes = await loadingGeofences;
      if (cancelled) return;
      if (geofenceRes) setGeofences(geofenceRes.data || []);
      else await refreshGeofences();
      await registering;
    })();

    const geofencePoll = setInterval(refreshGeofences, GEOFENCE_POLL_MS);
    const reevaluate = setInterval(() => {
      const coords = locationRef.current;
      if (coords) evaluateLocation(coords, coords.accuracy, undefined, { recheck: true });
    }, REEVALUATE_MS);

    return () => {
      cancelled = true;
      if (watchRef.current) watchRef.current.remove();
      watchRef.current = null;
      clearInterval(geofencePoll);
      clearInterval(reevaluate);
      Object.keys(heartbeatTimers.current).forEach(stopHeartbeat);
    };
  }, [trackingEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Location/GPS switched off while a session is open: the app can no longer
  // show the employee is inside, so the duration must stop right now and
  // only resume once Location is back on (a fresh auto time-in). Every open
  // session is frozen at this moment (pendingExitAt) and the server is told
  // to close it at that same time -- retried here, since the main tracking
  // loop and its heartbeats are stopped while Location is off. If it still
  // hasn't gone through when Location returns, the restarted heartbeat keeps
  // resending the same frozen location-off reading.
  useEffect(() => {
    if (!employee || deviceStatus !== 'approved' || locationEnabled) return;
    const offAt = new Date().toISOString();
    const last = locationRef.current;
    const frozen = {};
    Object.entries(sessionsRef.current).forEach(([eventId, s]) => {
      if (!s?.id || s.time_out) return;
      const existing = pendingExitRef.current[eventId];
      if (existing && existing.attendanceId === s.id) {
        // Already left the geofence earlier -- keep that earlier exit time.
        existing.locationOff = true;
        return;
      }
      pendingExitRef.current[eventId] = {
        attendanceId: s.id,
        observedAt: offAt,
        latitude: last?.latitude,
        longitude: last?.longitude,
        accuracy: last?.accuracy,
        mocked: mockedRef.current,
        locationOff: true
      };
      frozen[eventId] = offAt;
    });
    if (Object.keys(frozen).length) {
      setSessions((prev) => {
        const next = { ...prev };
        Object.entries(frozen).forEach(([eventId, at]) => {
          next[eventId] = { ...(next[eventId] || {}), pendingExitAt: at };
        });
        return next;
      });
    }

    let stopped = false;
    const flush = async () => {
      let anyEnded = false;
      for (const [eventId, pending] of Object.entries(pendingExitRef.current)) {
        if (stopped || !pending.locationOff) continue;
        try {
          const result = await sendHeartbeat(pending.attendanceId, pending.latitude, pending.longitude, pending.observedAt, {
            accuracy: pending.accuracy,
            mocked: pending.mocked,
            locationOff: true,
            offlineInsideSeconds: await offlineInsideSeconds(pending.attendanceId, Date.parse(pending.observedAt))
          });
          if (result?.data?.ended) {
            forgetTrail(pending.attendanceId);
            delete pendingExitRef.current[eventId];
            anyEnded = true;
          }
        } catch (e) {
          // No connectivity -- retried on the next tick (or by the heartbeat
          // once Location is back on), still with the original off time.
        }
      }
      if (anyEnded && !stopped) {
        await refreshSessionsFromHistoryRef.current?.();
        notify('Time-Out Recorded', 'Your Location was turned off, so your session was timed out. Turn Location back on to continue your attendance.');
      }
    };
    flush();
    const retry = setInterval(flush, HEARTBEAT_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(retry);
    };
  }, [locationEnabled, employee, deviceStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hand-off to the background task (tasks/backgroundAttendance.js), which
  // keeps attendance running -- time-in, keep-alive pings, and time-out the
  // moment the phone leaves the area -- once the app is in the background or
  // swiped closed. It works from whatever this tracker last knew.
  useEffect(() => {
    if (!employee || deviceStatus !== 'approved') return;
    const bgSessions = {};
    Object.entries(sessions).forEach(([eventId, s]) => {
      if (s?.id) bgSessions[eventId] = { id: s.id, open: !s.time_out };
    });
    const bgExits = {};
    Object.entries(pendingExitRef.current).forEach(([eventId, p]) => {
      if (p.locationOff) return; // the server is told about these directly
      bgExits[eventId] = {
        attendanceId: p.attendanceId, observedAt: p.observedAt,
        latitude: p.latitude, longitude: p.longitude, accuracy: p.accuracy, mocked: p.mocked
      };
    });
    saveBackgroundState({ employeeId: employee.id, geofences, sessions: bgSessions, pendingExits: bgExits });
  }, [employee, deviceStatus, geofences, sessions]);

  // Starts the background task while there's an event to track (the list
  // only holds active and upcoming events) or a session still open. It
  // needs Location set to "Allow all the time"; that's asked for once per
  // app launch, with the reason, and the app keeps working in the foreground
  // only if it's declined. Signing out stops it.
  const askedBackgroundRef = useRef(false);
  useEffect(() => {
    // Still restoring the signed-in employee: don't mistake that for a sign-out.
    if (authLoading) return;
    if (!employee || deviceStatus !== 'approved') {
      stopBackgroundAttendance();
      clearBackgroundState();
      clearTrails();
      return;
    }
    if (!trackingEnabled) return; // Location off: left as is, it resumes when Location is back
    const needed = geofences.length > 0 || Object.values(sessions).some((s) => s?.id && !s.time_out);
    if (!needed) return;
    let cancelled = false;
    (async () => {
      if (await startBackgroundAttendance()) return;
      if (cancelled || askedBackgroundRef.current || Platform.OS === 'web') return;
      askedBackgroundRef.current = true;
      notify(
        'Keep attendance running when the app is closed',
        'To keep your attendance running after you close GeoAttend -- and time you out as soon as you leave the event area -- set Location to "Allow all the time" on the next screen.',
        [
          { text: 'Not now', style: 'cancel' },
          {
            text: 'Continue',
            onPress: async () => {
              if (await ensureBackgroundPermission(true)) startBackgroundAttendance();
            }
          }
        ]
      );
    })();
    return () => { cancelled = true; };
  }, [authLoading, employee, deviceStatus, trackingEnabled, geofences, sessions]);

  // Re-evaluate presence whenever the geofence list itself changes (e.g. a
  // new event just went active), using the last known location.
  useEffect(() => {
    if (locationRef.current) evaluateLocation(locationRef.current, locationRef.current.accuracy, undefined, { recheck: true });
  }, [geofences]); // eslint-disable-line react-hooks/exhaustive-deps

  const value = {
    location,
    accuracy,
    permissionDenied,
    geofences,
    presence, // event_id -> { inside, geofence }
    sessions, // event_id -> { id, time_in, time_out, total_duration_seconds, open_session_time_in, session_count, requires_face_verification }
    isAutoSubmitting: (eventId) => !!autoSubmitting[eventId],
    checkInErrors, // event_id -> last server rejection message for auto time-in, or null
    // Live accumulated duration in seconds for an event's session today —
    // keeps ticking upward while a session is open, across however many
    // separate time-in/time-out dips have happened so far.
    getDurationSeconds: (eventId) => liveDurationSeconds(sessions[eventId]),
    refreshGeofences,
    refreshSessionsFromHistory,
    // Used by FaceVerificationScreen: refreshAfterVerification re-syncs
    // session state once a verification succeeds (so the Dashboard/
    // Attendance screens immediately reflect the now-confirmed record).
    refreshAfterVerification: refreshSessionsFromHistory,
    // clearPendingVerification resets that attendance id's "already
    // prompted" guard, called on both success (tidy, though moot since a
    // resolved record's requires_face_verification is 0 and won't match
    // again) and on Cancel -- clearing it there means the very next
    // meaningful history refresh (refreshSessionsFromHistory only runs at
    // specific moments: app mount, and a session auto-ending -- not a tight
    // poll) re-surfaces the prompt rather than only ever trying again on a
    // full app restart.
    clearPendingVerification: (attendanceId) => {
      if (attendanceId) delete promptedVerificationRef.current[attendanceId];
    }
  };

  return (
    <AttendanceTrackingContext.Provider value={value}>
      {children}
    </AttendanceTrackingContext.Provider>
  );
}

export const useAttendanceTracking = () => useContext(AttendanceTrackingContext);
