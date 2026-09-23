import Constants from 'expo-constants';

const extra = Constants.expoConfig?.extra || {};

// These must match the OAuth Client IDs you create in Google Cloud Console
// (APIs & Services > Credentials) and the GOOGLE_CLIENT_ID already set in the
// server's .env. The Web Client ID is required; iOS/Android are optional but
// recommended for a native (non-browser) Google Sign-In experience.
export const GOOGLE_WEB_CLIENT_ID = extra.googleWebClientId || '';
export const GOOGLE_IOS_CLIENT_ID = extra.googleIosClientId || '';
export const GOOGLE_ANDROID_CLIENT_ID = extra.googleAndroidClientId || '';

export const isGoogleConfigured = () =>
  !!GOOGLE_WEB_CLIENT_ID && !GOOGLE_WEB_CLIENT_ID.startsWith('your_');

// Fallback Wi-Fi network name used by WifiCheckScreen to confirm the employee is
// on the designated location network before reaching the Dashboard. If the
// active event's geofence record from the API includes its own `wifi_ssid`
// field, that value takes priority over this default (see WifiCheckScreen.js).
export const REQUIRED_WIFI_SSID = extra.requiredWifiSsid || 'CSPC Student Wi-Fi';

// Backend API base URL. Set `apiBaseUrl` under "extra" in mobile/app.json to your
// machine's current LAN IP (or deployed URL) — e.g. "http://192.168.1.20:3000/api".
// 'localhost' only works when running in a simulator on the same machine as the
// server; a physical device needs the actual LAN IP. Falls back to a placeholder
// so misconfiguration is obvious instead of silently pointing at a stale IP.
export const API_BASE_URL = extra.apiBaseUrl || 'http://172.16.81.79:3000/api';

// Same host as API_BASE_URL, without the /api suffix -- for building full
// URLs to static assets (uploaded face photos, etc.), which server.js
// serves under /uploads as a sibling of /api, not underneath it.
export const ASSET_BASE_URL = API_BASE_URL.replace(/\/api\/?$/, '');

// Turns a relative path returned by the API (e.g. "/uploads/faces/xxx.jpg")
// into a full URL an <Image> component can load. Returns null unchanged if
// there's no path, so callers can fall back to a placeholder avatar.
export function assetUrl(path) {
  if (!path) return null;
  if (/^https?:\/\//.test(path)) return path; // already absolute
  return `${ASSET_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}
