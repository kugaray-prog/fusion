import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import * as Location from 'expo-location';
import * as Device from 'expo-device';
import { useAuth } from './AuthContext';
import { useLocationStatus } from './LocationStatusContext';
import { getGeofences, registerDevice, submitAttendance, sendHeartbeat, getMyHistory } from '../api/client';
import { navigationRef } from '../navigation/navigationRef';
import { notify } from '../utils/notify';
import { getDeviceUid } from '../utils/device';
import { liveDurationSeconds } from '../utils/duration';

// Point-in-polygon test (ray-casting), mirroring the backend's geofenceService
// so the app can tell "inside/outside" locally without waiting on a round trip.
function isInsidePolygon(lat, lng, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].lat, yi = points[i].lng;
    const xj = points[j].lat, yj = points[j].lng;
    const intersect = (yi > lng) !== (yj > lng) && lat < ((xj - xi) * (lng - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// How often a session already checked-in pings the server with the current
// location so it can auto time-out once the device has left the geofence for
// a couple of consecutive pings (see config.attendance.autoEndOutsideStreakThreshold
// on the backend). Kept a little above the backend's own
// heartbeatMinIntervalSeconds (20s default) so pings aren't silently dropped.
const HEARTBEAT_INTERVAL_MS = 25000;
// How often the list of active event geofences is refreshed, so a
// newly-started event is picked up without an app restart.
const GEOFENCE_POLL_MS = 30000;
// Consecutive local GPS readings outside the geofence (while a session is
// open) required before the app treats itself as "exited" for its OWN
// purposes -- freezing the displayed duration and locking in the exact
// reading to keep retrying to the server. GPS keeps working without
// connectivity, so this can be detected instantly even with no signal/WiFi;
// it's a separate, smaller confirmation than the server's own
// autoEndOutsideStreakThreshold (used once a ping actually reaches it),
// purely so the on-screen timer stops accumulating fictitious time while
// offline rather than only catching up once connectivity returns.
const LOCAL_OUTSIDE_CONFIRM_READINGS = 2;

const AttendanceTrackingContext = createContext(null);

export function AttendanceTrackingProvider({ children }) {
  const { employee, deviceStatus } = useAuth();
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

  const watchRef = useRef(null);
  const heartbeatTimers = useRef({}); // attendanceId -> interval
  const locationRef = useRef(null);
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
    if (!attendanceId || promptedVerificationRef.current[attendanceId]) return;
    promptedVerificationRef.current[attendanceId] = true;
    if (navigationRef.isReady()) {
      navigationRef.navigate('FaceVerification', { attendanceId, eventTitle });
    }
  }, []);
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

  const deviceUid = useCallback(() => getDeviceUid(employee?.id), [employee]);

  const stopHeartbeat = (attendanceId) => {
    if (heartbeatTimers.current[attendanceId]) {
      clearInterval(heartbeatTimers.current[attendanceId]);
      delete heartbeatTimers.current[attendanceId];
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
    heartbeatTimers.current[attendanceId] = setInterval(async () => {
      const pending = pendingExitRef.current[eventId];
      const usingPending = pending && pending.attendanceId === attendanceId;
      const coords = usingPending
        ? { latitude: pending.latitude, longitude: pending.longitude }
        : locationRef.current;
      if (!coords) return;
      try {
        const result = await sendHeartbeat(
          attendanceId,
          coords.latitude,
          coords.longitude,
          usingPending ? pending.observedAt : undefined
        );
        if (result?.data?.ended) {
          if (usingPending) delete pendingExitRef.current[eventId];
          stopHeartbeat(attendanceId);
          await refreshSessionsFromHistoryRef.current?.();
          notify('Time-Out Recorded', 'You left the event area, so your session was automatically timed out. Your total time keeps accumulating if you come back.');
        }
      } catch (e) {
        // Non-fatal — a missed ping just retries on the next tick, still
        // using the same frozen pending-exit reading if one is set, so a
        // connectivity gap doesn't lose track of when the employee actually left.
      }
    }, HEARTBEAT_INTERVAL_MS);
  }, []);

  // Restores today's attendance state (open, completed, or in-between visits)
  // from the server — including the accumulated total_duration_seconds and
  // which session (if any) is currently open — so auto time-in doesn't fire
  // again for a session already open, and an already-open session resumes
  // its heartbeat immediately on app start, even if it was left open from a
  // previous app session.
  const refreshSessionsFromHistory = useCallback(async () => {
    try {
      const history = await getMyHistory();
      const today = new Date().toISOString().slice(0, 10);
      const todays = (history.data || []).filter((a) => a.attendance_date === today);
      const map = {};
      todays.forEach((a) => {
        map[a.event_id] = {
          id: a.id,
          time_in: a.time_in,
          time_out: a.time_out,
          total_duration_seconds: a.total_duration_seconds,
          open_session_time_in: a.open_session_time_in,
          session_count: a.session_count
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
      const stillFlagged = todays.find((a) => a.requires_face_verification);
      if (stillFlagged) {
        goToFaceVerification(stillFlagged.id, stillFlagged.event_title);
      }
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
    setAutoSubmitting((prev) => ({ ...prev, [eventId]: true }));
    try {
      const result = await submitAttendance({
        employee_id: employee.id,
        device_uid: deviceUid(),
        event_id: eventId,
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: acc
      });
      if (result?.data?.id) {
        const nowIso = new Date().toISOString();
        setSessions((prev) => ({
          ...prev,
          [eventId]: {
            ...(prev[eventId] || {}),
            id: result.data.id,
            time_in: prev[eventId]?.time_in || nowIso,
            time_out: null,
            open_session_time_in: nowIso,
            session_count: (prev[eventId]?.session_count || 0) + 1
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
          goToFaceVerification(result.data.id, geofence.title);
        }
      }
    } catch (err) {
      // Common, expected rejections (outside geofence by the time the request
      // lands, event window closed, GPS accuracy too low, a session already
      // open, device not yet approved) are silent — the next location update
      // or poll just tries again rather than nagging the user with an error
      // for something that isn't really actionable.
    } finally {
      setAutoSubmitting((prev) => ({ ...prev, [eventId]: false }));
    }
  }, [employee, deviceUid, startHeartbeat, goToFaceVerification]);

  // Core loop: whenever a fresh location comes in, check it against every
  // currently-active event geofence. Entering one with no OPEN session right
  // now -> auto time-in (which may be a first check-in or a re-entry after an
  // earlier auto time-out — either way the day's duration keeps accumulating).
  //
  // Leaving one with an OPEN session -> after LOCAL_OUTSIDE_CONFIRM_READINGS
  // consecutive outside readings, freeze that session's displayed duration
  // right here (pendingExitAt) and lock in this exact reading for the
  // heartbeat loop to keep retrying to the server (see startHeartbeat) —
  // this is what stops the on-screen/synced total from silently growing for
  // the entire time the device is outside the boundary with no connectivity
  // to report it. The server's own autoEndOutsideStreakThreshold still
  // decides when the session is actually closed (once a ping gets through);
  // this only prevents the CLOCK from running away in the meantime.
  const evaluateLocation = useCallback((coords, acc, observedAtMs) => {
    const activeGeofences = geofencesRef.current.filter((g) => g.computed_status === 'active');
    const nextPresence = {};
    activeGeofences.forEach((g) => {
      if (!g.points || g.points.length < 3) return;
      const inside = isInsidePolygon(coords.latitude, coords.longitude, g.points);
      nextPresence[g.event_id] = { inside, geofence: g };
      const existingSession = sessionsRef.current[g.event_id];
      // A session is already open for today when we have a record with no
      // time_out — that's the only case where we should NOT re-check-in.
      const hasOpenSession = existingSession && existingSession.id && !existingSession.time_out;
      if (inside && !hasOpenSession) {
        autoCheckIn(g, coords, acc);
      } else if (!inside && hasOpenSession) {
        const eventId = g.event_id;
        const streak = (localOutsideStreakRef.current[eventId] || 0) + 1;
        localOutsideStreakRef.current[eventId] = streak;
        if (streak >= LOCAL_OUTSIDE_CONFIRM_READINGS && !pendingExitRef.current[eventId]) {
          const observedAtIso = new Date(observedAtMs || Date.now()).toISOString();
          pendingExitRef.current[eventId] = {
            attendanceId: existingSession.id,
            observedAt: observedAtIso,
            latitude: coords.latitude,
            longitude: coords.longitude
          };
          setSessions((prev) => ({
            ...prev,
            [eventId]: { ...(prev[eventId] || {}), pendingExitAt: observedAtIso }
          }));
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

      try {
        await registerDevice({
          employee_id: employee.id,
          device_uid: deviceUid(),
          model: Device.modelName,
          brand: Device.brand,
          os: `${Device.osName} ${Device.osVersion}`
        });
      } catch (e) {
        // Non-fatal here — submitAttendance will surface a clear "device not
        // registered/approved" message if it turns out to matter.
      }

      await refreshSessionsFromHistory();
      await refreshGeofences();

      try {
        watchRef.current = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, timeInterval: 3000, distanceInterval: 2 },
          (loc) => {
            setLocation(loc.coords);
            locationRef.current = loc.coords;
            setAccuracy(loc.coords.accuracy);
            // loc.timestamp is when the GPS chip actually took this reading —
            // works fine offline (no WiFi/data needed) and is what lets a
            // "left the geofence" moment be captured accurately even before
            // there's any connectivity to report it (see evaluateLocation).
            evaluateLocation(loc.coords, loc.coords.accuracy, loc.timestamp);
          }
        );
      } catch (e) {
        // GPS could have been switched off in the instant between the last
        // LocationStatusContext poll and this call — LocationGateOverlay
        // will catch it on its own next poll tick either way, so there's
        // nothing more to do here than avoid an unhandled rejection.
      }
    })();

    const geofencePoll = setInterval(refreshGeofences, GEOFENCE_POLL_MS);

    return () => {
      cancelled = true;
      if (watchRef.current) watchRef.current.remove();
      clearInterval(geofencePoll);
      Object.keys(heartbeatTimers.current).forEach(stopHeartbeat);
    };
  }, [trackingEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-evaluate presence whenever the geofence list itself changes (e.g. a
  // new event just went active), using the last known location.
  useEffect(() => {
    if (locationRef.current) evaluateLocation(locationRef.current, accuracy);
  }, [geofences]); // eslint-disable-line react-hooks/exhaustive-deps

  const value = {
    location,
    accuracy,
    permissionDenied,
    geofences,
    presence, // event_id -> { inside, geofence }
    sessions, // event_id -> { id, time_in, time_out, total_duration_seconds, open_session_time_in, session_count }
    isAutoSubmitting: (eventId) => !!autoSubmitting[eventId],
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
