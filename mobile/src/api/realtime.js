import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE_URL } from '../config';
import { getDeviceUid } from '../utils/device';

// Live updates from the server's WebSocket (/ws, services/realtime.js). The
// server only says "something changed" ({ type: 'change', topic }); screens
// subscribe with useLiveUpdates and re-fetch through the normal API.
// Topics an employee receives:
//   events, geofences - an admin changed the schedule or event areas
//   attendance        - an admin edited/recorded this employee's attendance,
//                       or an ended event settled its final status
//   device            - this phone was approved, blocked or removed
// After a reconnect every listener is called with '*' to catch up on
// anything missed while disconnected.
// AuthContext starts this when an employee signs in and stops it on sign-out.

const WS_URL = API_BASE_URL.replace(/^http/, 'ws').replace(/\/api\/?$/, '/ws');
const MAX_RETRY_MS = 30000;

const listeners = new Set();
let socket = null;
let running = false;
let retryMs = 1000;
let retryTimer = null;
let missedWhileDisconnected = false;
// True while open() awaits the token, so a second caller (the retry timer
// and the AppState listener can fire together on resume) can't open a
// second, orphaned socket that would double-deliver every change.
let connecting = false;

function emit(topic) {
  listeners.forEach((listener) => listener(topic));
}

async function open() {
  if (!running || socket || connecting) return;
  connecting = true;
  let token;
  try {
    token = await AsyncStorage.getItem('employee_token');
  } finally {
    connecting = false;
  }
  if (!running || socket || !token) return;
  const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}&device=${encodeURIComponent(getDeviceUid())}`);
  socket = ws;
  ws.onopen = () => {
    retryMs = 1000;
    if (missedWhileDisconnected) emit('*');
    missedWhileDisconnected = false;
  };
  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    if (msg.type === 'change') emit(msg.topic);
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    missedWhileDisconnected = true;
    if (!running) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, retryMs);
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
  };
  ws.onerror = () => {}; // onclose follows and schedules the retry
}

// The OS may drop the socket while the app is in the background; reconnect
// straight away when it comes back instead of waiting out the backoff.
AppState.addEventListener('change', (state) => {
  if (state !== 'active' || !running || socket) return;
  clearTimeout(retryTimer);
  retryMs = 1000;
  open();
});

export function startLive() {
  if (running) return;
  running = true;
  open();
}

export function stopLive() {
  running = false;
  clearTimeout(retryTimer);
  missedWhileDisconnected = false;
  if (socket) {
    const ws = socket;
    socket = null;
    ws.close();
  }
}

// Calls `onChange(topic)` whenever one of `topics` changes (or '*' after a
// reconnect). Always uses the latest onChange without re-subscribing.
export function useLiveUpdates(topics, onChange) {
  const callbackRef = useRef(onChange);
  callbackRef.current = onChange;
  const key = topics.join(',');
  useEffect(() => {
    const wanted = new Set(key.split(','));
    const listener = (topic) => {
      if (topic === '*' || wanted.has(topic)) callbackRef.current(topic);
    };
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, [key]);
}
