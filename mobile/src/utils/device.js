import * as Application from 'expo-application';
import * as Device from 'expo-device';

// Single source of truth for "which physical device is this" across the app
// (registration, login, attendance submission, status polling). Keeping this
// in one place avoids the different screens ever disagreeing on the device's
// identity, which matters now that an employee can have several registered
// devices at once — the server tells devices apart by this uid.
//
// Takes no arguments on purpose: an earlier version accepted a per-caller
// fallback seed (the employee id), so on a phone without an Android ID the
// registration form saved 'unknown-device' while attendance sent
// 'device-<id>', and the server saw two different devices.
export function getDeviceUid() {
  return Application.androidId || Device.osBuildId || 'unknown-device';
}

// The exact device details shown on the registration form and submitted with
// it (mobile_devices.model / brand / os). Every other screen or request that
// shows or sends device info uses this too, so they always match what the
// employee saw when registering.
export function getDeviceInfo() {
  return {
    uid: getDeviceUid(),
    model: Device.modelName || 'Unknown',
    brand: Device.brand || 'Unknown',
    os: `${osName()} ${Device.osVersion || ''}`.trim() || 'Unknown'
  };
}

// On Android, Device.osName is Build.VERSION.BASE_OS when set, and some
// vendors (e.g. Xiaomi/HyperOS) fill that with a whole build fingerprint like
// "Xiaomi/garnet_global/garnet:14/UKQ1.../V816...:user/release-keys" -- too
// long to store or show. Fall back to a plain "Android" in that case.
function osName() {
  const name = (Device.osName || '').trim();
  if (/[/:]/.test(name)) return 'Android';
  return name;
}
