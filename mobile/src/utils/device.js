import * as Application from 'expo-application';
import * as Device from 'expo-device';

// Single source of truth for "which physical device is this" across the app
// (registration, login, attendance submission, status polling). Keeping this
// in one place avoids the different screens ever disagreeing on the device's
// identity, which matters now that an employee can have several registered
// devices at once — the server tells devices apart by this uid.
export function getDeviceUid(fallbackSeed) {
  return (
    Application.androidId ||
    Device.osBuildId ||
    (fallbackSeed ? `device-${fallbackSeed}` : 'unknown-device')
  );
}
