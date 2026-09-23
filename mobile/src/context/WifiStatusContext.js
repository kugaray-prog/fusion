import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { AppState, Platform } from 'react-native';
import WifiManager from 'react-native-wifi-reborn';

// Mirrors LocationStatusContext, but for Wi-Fi. Tracks whether the device's
// Wi-Fi is actually turned on AND joined to a network, at the OS level --
// distinct from Wi-Fi PERMISSION and from being joined to the specific
// REQUIRED network (WifiCheckScreen already handles that one-time, at
// sign-in). An employee can flip the Wi-Fi toggle off, or walk out of range
// and get disconnected, at any point later in the day; this catches that
// everywhere in the app, not just at the initial WifiCheckScreen gate.
// Wi-Fi is a secondary location-verification signal alongside GPS (see
// WifiCheckScreen's own top-of-file comment), so losing it gets the same
// kind of app-wide, impossible-to-miss prompt GPS already gets via
// LocationStatusContext + LocationGateOverlay.
//
// Polled periodically (there's no push/event API for either of these) plus
// rechecked immediately whenever the app returns to the foreground, so
// coming back from the OS Settings screen after flipping Wi-Fi back on
// doesn't leave the employee waiting out a full poll interval.
const CHECK_INTERVAL_MS = 4000;

const WifiStatusContext = createContext(null);

export function WifiStatusProvider({ children }) {
  // Optimistic (true) until the first real check lands, so the app doesn't
  // flash a false "Wi-Fi is off" gate for the split second before that
  // check resolves -- same reasoning as LocationStatusContext.
  const [wifiOn, setWifiOn] = useState(true);
  const [checked, setChecked] = useState(false);
  const appState = useRef(AppState.currentState);

  const checkNow = useCallback(async () => {
    try {
      if (Platform.OS === 'android') {
        // Android exposes both the radio state ("naka-off") and whether
        // it's actually joined to a network ("na-disconnect") -- either
        // being false means Wi-Fi isn't usable right now.
        const [enabled, connected] = await Promise.all([
          WifiManager.isEnabled(),
          WifiManager.connectionStatus().catch(() => false),
        ]);
        setWifiOn(!!enabled && !!connected);
      } else {
        // iOS has no public API to read the Wi-Fi radio state directly
        // (Apple restricts this -- see WifiCheckScreen's own platform
        // note). The closest available signal is whether a connected
        // network name can be read at all, the same check WifiCheckScreen
        // already relies on for its own SSID match. This can't
        // distinguish "radio off" from "on but out of range of any
        // network", but both cases mean Wi-Fi isn't usable right now,
        // which is exactly what needs to be caught here.
        const ssid = await WifiManager.getCurrentWifiSSID();
        setWifiOn(!!ssid);
      }
    } catch (e) {
      // If the check itself can't run (e.g. unsupported in this preview
      // environment, or location permission not granted yet on iOS, which
      // getCurrentWifiSSID() also requires) -- don't block the whole app
      // on an unrelated failure. Any real Wi-Fi problem at sign-in still
      // surfaces through WifiCheckScreen's own error handling.
      setWifiOn(true);
    } finally {
      setChecked(true);
    }
  }, []);

  useEffect(() => {
    checkNow();
    const interval = setInterval(checkNow, CHECK_INTERVAL_MS);
    const sub = AppState.addEventListener('change', (next) => {
      if (appState.current.match(/inactive|background/) && next === 'active') {
        checkNow();
      }
      appState.current = next;
    });
    return () => {
      clearInterval(interval);
      sub.remove();
    };
  }, [checkNow]);

  return (
    <WifiStatusContext.Provider value={{ wifiOn, checked, recheck: checkNow }}>
      {children}
    </WifiStatusContext.Provider>
  );
}

// Falls back to "enabled" if the provider isn't mounted somewhere in the
// tree, so a screen rendered outside it (shouldn't normally happen) doesn't
// crash -- it just won't get the gating behavior.
export function useWifiStatus() {
  const ctx = useContext(WifiStatusContext);
  return ctx || { wifiOn: true, checked: true, recheck: () => {} };
}
