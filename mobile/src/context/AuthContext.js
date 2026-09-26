import React, { createContext, useState, useEffect, useContext, useRef } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import api, { googleLogin, linkDevice, getDeviceStatus, setStaleSessionHandler, setDeviceBlockedHandler } from '../api/client';
import { getDeviceUid } from '../utils/device';
import { alertDeviceBlocked } from '../utils/deviceBlockedAlert';

// How often a signed-in app re-checks whether an admin has blacklisted or
// rejected this device (also re-checked whenever the app comes back to the
// foreground, and on any request the server refuses with DEVICE_BLOCKED).
const DEVICE_CHECK_INTERVAL_MS = 60000;
const BLOCKED_STATUSES = ['blacklisted', 'rejected', 'removed'];
const DEFAULT_BLOCKED_MESSAGE = {
  blacklisted: 'This device has been blacklisted by your administrator, so it can no longer be used to sign in or record attendance. Contact your administrator if you think this is a mistake.',
  rejected: "This device's registration was rejected by your administrator, so it can't be used to sign in or record attendance. Contact your administrator.",
  removed: 'This device was removed by your administrator. Sign in again to register it.',
};

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [employee, setEmployee] = useState(null);
  const [loading, setLoading] = useState(true);
  // Mirrors mobile_devices.status for THIS device: 'pending' | 'approved' |
  // 'rejected' | null. An employee may have several registered devices with
  // different statuses, so this always reflects the one this app install is
  // running on. RootNavigator uses this to gate access to the Dashboard stack —
  // a signed-in employee whose device is still 'pending' is held on the
  // WaitingApproval screen until an admin approves it.
  const [deviceStatus, setDeviceStatus] = useState(null);
  // Set right after a Google sign-in that didn't match an existing employee yet —
  // consumed by RegistrationScreen to finish linking the device.
  const [pendingGoogle, setPendingGoogle] = useState(null); // { pendingToken, google, existingEmployee }
  // Set true when the server reports this device's cached employee record no
  // longer exists (e.g. deleted/recreated by an admin). LoginScreen reads
  // this to explain why the app suddenly returned to the login screen.
  const [staleSession, setStaleSession] = useState(false);
  // Whether WifiCheckScreen has already confirmed this device is on the
  // designated location Wi-Fi network THIS app session. Deliberately plain
  // React state (not persisted to AsyncStorage) — the check is meant to run
  // once per app open, not once ever. RootNavigator uses this the same way
  // it uses `deviceStatus`/`awaitingApproval`: as a state-driven branch
  // condition rather than an imperative cross-screen `navigation.replace()`,
  // so there's no chance of that action firing against a navigator whose
  // screen list has since changed (which is what caused the old "REPLACE
  // action ... not handled by any navigator. Do you have a screen named
  // Dashboard?" warning/crash).
  const [wifiVerified, setWifiVerified] = useState(false);
  const markWifiVerified = () => setWifiVerified(true);
  // Why the app just signed itself out because an admin blacklisted,
  // rejected or removed this device -- { text, status }, shown on the Login
  // screen. Null otherwise.
  const [deviceBlockedNotice, setDeviceBlockedNotice] = useState(null);
  const blockedHandledRef = useRef(false);

  useEffect(() => {
    (async () => {
      const stored = await AsyncStorage.getItem('employee_data');
      const storedStatus = await AsyncStorage.getItem('device_status');
      if (stored) {
        setEmployee(JSON.parse(stored));
        setDeviceStatus(storedStatus || null);
      }
      setLoading(false);
      // Re-check with the server in case the device was approved (or revoked)
      // while the app was closed.
      if (stored) refreshDeviceStatus();
    })();
  }, []);

  const persistDeviceStatus = async (status) => {
    setDeviceStatus(status);
    if (status) await AsyncStorage.setItem('device_status', status);
    else await AsyncStorage.removeItem('device_status');
  };

  // Polled by WaitingApprovalScreen — asks the server for this device's current
  // status so the app can automatically move on once an admin approves it.
  const refreshDeviceStatus = async () => {
    try {
      const data = await getDeviceStatus(getDeviceUid());
      if (BLOCKED_STATUSES.includes(data.deviceStatus)) {
        handleDeviceBlocked(DEFAULT_BLOCKED_MESSAGE[data.deviceStatus], data.deviceStatus);
        return data.deviceStatus;
      }
      await persistDeviceStatus(data.deviceStatus);
      return data.deviceStatus;
    } catch (err) {
      // Network hiccup or expired token — leave the current status alone and
      // let the next poll try again.
      return deviceStatus;
    }
  };

  // Step 1: exchange the Google ID token for either a full login -- only when
  // THIS device is already on file and approved/pending for this employee --
  // or a short-lived pendingToken to continue on to device registration
  // (server-side rule: controllers/employeeAuthController.js googleLogin()).
  // The latter also covers an existing employee signing in on a device
  // that's new to them: `existingEmployee` on the response lets
  // RegistrationScreen pre-fill their details instead of asking them to
  // retype an account they already have.
  const loginWithGoogle = async (idToken) => {
    const data = await googleLogin(idToken, getDeviceUid());
    setStaleSession(false);
    setDeviceBlockedNotice(null);
    blockedHandledRef.current = false;
    if (data.matched) {
      await AsyncStorage.setItem('employee_token', data.token);
      await AsyncStorage.setItem('employee_data', JSON.stringify(data.employee));
      setEmployee(data.employee);
      await persistDeviceStatus(data.deviceStatus || null);
      return { matched: true };
    }
    setPendingGoogle({ pendingToken: data.pendingToken, google: data.google, existingEmployee: data.existingEmployee || null });
    return { matched: false, google: data.google };
  };

  // Step 2 (first-time devices only): confirm the employee's admin-provisioned
  // identity (Employee ID + Surname + Given Name, plus optional Middle Name /
  // Suffix), register this device, AND enroll the captured face — all in one
  // request. `formData` is built by RegistrationScreen (step 1 fields + the
  // step 2 selfie under the "image" field); we just attach the pendingToken.
  // The device starts out 'pending' until an admin approves it — RootNavigator
  // holds the user on WaitingApproval until then.
  const completeRegistration = async (formData) => {
    if (!pendingGoogle) throw new Error('Your Google sign-in session expired. Please sign in again.');
    formData.append('pendingToken', pendingGoogle.pendingToken);
    const data = await linkDevice(formData);
    blockedHandledRef.current = false;
    // Persist first, then flip every piece of auth state in ONE synchronous
    // batch. Setting `employee` before `pendingGoogle`/`deviceStatus` (with
    // awaits in between) made RootNavigator swap stacks more than once while
    // RegistrationScreen was still mounted -- which could leave the app on a
    // blank white screen right after the face scan.
    await AsyncStorage.multiSet([
      ['employee_token', data.token],
      ['employee_data', JSON.stringify(data.employee)],
    ]);
    if (data.deviceStatus) await AsyncStorage.setItem('device_status', data.deviceStatus);
    else await AsyncStorage.removeItem('device_status');
    setDeviceBlockedNotice(null);
    setDeviceStatus(data.deviceStatus || null);
    setPendingGoogle(null);
    setEmployee(data.employee);
    return data;
  };

  const cancelRegistration = () => setPendingGoogle(null);

  const logout = async () => {
    await AsyncStorage.multiRemove(['employee_token', 'employee_data', 'device_status']);
    setEmployee(null);
    setDeviceStatus(null);
    setWifiVerified(false);
  };

  // An admin blacklisted or rejected this device: sign out, notify the
  // employee once, and leave the reason for the Login screen. Every request
  // from this device is refused from now on (server: requireEmployeeAuth),
  // so this can be reached from any API call.
  const handleDeviceBlocked = (message, status) => {
    const text = message || DEFAULT_BLOCKED_MESSAGE[status] || DEFAULT_BLOCKED_MESSAGE.blacklisted;
    setDeviceBlockedNotice({ text, status });
    if (blockedHandledRef.current) return;
    blockedHandledRef.current = true;
    logout();
    alertDeviceBlocked(text, status);
  };

  useEffect(() => {
    setDeviceBlockedHandler(handleDeviceBlocked);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // While signed in, re-check this device's status periodically and each
  // time the app returns to the foreground.
  useEffect(() => {
    if (!employee) return undefined;
    const interval = setInterval(refreshDeviceStatus, DEVICE_CHECK_INTERVAL_MS);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshDeviceStatus();
    });
    return () => {
      clearInterval(interval);
      sub.remove();
    };
  }, [employee]); // eslint-disable-line react-hooks/exhaustive-deps

  // Registered once so ANY API call (device registration, attendance submit,
  // heartbeat, etc.) can trigger this — see api/client.js's response
  // interceptor. Clears the stale local session and returns the user to
  // Login instead of leaving them stuck on a raw error screen.
  useEffect(() => {
    setStaleSessionHandler(() => {
      setStaleSession(true);
      logout();
    });
  }, []);

  return (
    <AuthContext.Provider value={{ employee, loading, deviceStatus, pendingGoogle, staleSession, deviceBlockedNotice, wifiVerified, markWifiVerified, loginWithGoogle, completeRegistration, cancelRegistration, refreshDeviceStatus, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
