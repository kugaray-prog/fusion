import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import * as Location from 'expo-location';
import { AppState } from 'react-native';

// Distinct from LOCATION PERMISSION (has the employee allowed this app to
// use location at all) -- this tracks whether the device's Location/GPS
// SERVICE itself is turned on at the OS level (Settings -> Location). An
// employee can have granted permission ages ago and still simply switch GPS
// off from the quick-settings toggle at any point during the day; permission
// alone doesn't catch that.
//
// Polled periodically (there's no push/event API for this in expo-location)
// plus rechecked immediately whenever the app returns to the foreground, so
// coming back from the OS Settings screen after flipping GPS on doesn't
// leave the employee waiting out a full poll interval.
const CHECK_INTERVAL_MS = 4000;

const LocationStatusContext = createContext(null);

export function LocationStatusProvider({ children }) {
  // Optimistic (true) until the first real check lands, so the app doesn't
  // flash a false "GPS is off" gate for the split second before that check
  // resolves.
  const [locationEnabled, setLocationEnabled] = useState(true);
  const [checked, setChecked] = useState(false);
  const appState = useRef(AppState.currentState);

  const checkNow = useCallback(async () => {
    try {
      const enabled = await Location.hasServicesEnabledAsync();
      setLocationEnabled(enabled);
    } catch (e) {
      // If the check itself can't run (e.g. unsupported in this preview
      // environment), don't block the whole app on an unrelated failure --
      // any real location problem still surfaces through the normal
      // permission/GPS-read error paths elsewhere.
      setLocationEnabled(true);
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
    <LocationStatusContext.Provider value={{ locationEnabled, checked, recheck: checkNow }}>
      {children}
    </LocationStatusContext.Provider>
  );
}

// Falls back to "enabled" if the provider isn't mounted somewhere in the
// tree, so a screen rendered outside it (shouldn't normally happen) doesn't
// crash -- it just won't get the gating behavior.
export function useLocationStatus() {
  const ctx = useContext(LocationStatusContext);
  return ctx || { locationEnabled: true, checked: true, recheck: () => {} };
}
