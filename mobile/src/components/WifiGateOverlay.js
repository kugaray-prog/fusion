import React from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, Platform, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { useWifiStatus } from '../context/WifiStatusContext';
import { useLocationStatus } from '../context/LocationStatusContext';
import { colors, radius, shadow } from '../theme';

// Rendered app-wide (see App.js), above the whole navigation stack, for as
// long as the employee is signed in AND Wi-Fi is off/disconnected -- mirrors
// LocationGateOverlay exactly, just for Wi-Fi instead of GPS. No close
// button, no swipe-to-dismiss, sits on top of every screen equally
// (including WifiCheckScreen itself, if Wi-Fi drops while that screen is
// still open). Disappears automatically the moment the periodic check in
// WifiStatusContext detects Wi-Fi is back on -- no manual "continue" step
// needed once it's actually on.
//
// If GPS is ALSO off, LocationGateOverlay is left to handle that alone
// (checked below) rather than stacking two full-screen blocking modals at
// once -- fix one thing at a time, GPS first since AttendanceTrackingContext
// already treats it as the more fundamental signal.
export default function WifiGateOverlay() {
  const { employee } = useAuth();
  const { wifiOn, checked, recheck } = useWifiStatus();
  const { locationEnabled } = useLocationStatus();

  if (!employee || !checked || wifiOn || !locationEnabled) return null;

  const openWifiSettings = async () => {
    try {
      if (Platform.OS === 'android') {
        // Opens the system Wi-Fi settings screen directly (a standard,
        // public Android intent action) -- same category of shortcut GPS
        // gets via Location.enableNetworkProviderAsync in
        // LocationGateOverlay.
        await Linking.sendIntent('android.settings.WIFI_SETTINGS');
        return;
      }
    } catch (e) {
      // Falls through to the general Settings app below.
    }
    try {
      if (Platform.OS === 'ios') {
        // Apple doesn't allow deep-linking straight to the Wi-Fi settings
        // pane via public API -- app-settings: (this app's own Settings
        // page) is the closest available, same fallback LocationGateOverlay
        // uses for GPS.
        await Linking.openURL('app-settings:');
      } else {
        await Linking.openSettings();
      }
    } catch (e) {
      // Nothing more we can do here — the "I've turned it on — Recheck"
      // button below still lets them confirm manually once they've
      // navigated to Settings themselves.
    }
  };

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={() => {}}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.iconWrap}>
            <Ionicons name="wifi-outline" size={38} color={colors.error} />
          </View>
          <Text style={styles.title}>Please turn on your Wi-Fi.</Text>
          <Text style={styles.subtitle}>
            GeoAttend Pro needs your device's Wi-Fi turned on and connected to verify your location and attendance. Wi-Fi-dependent features are unavailable until it's turned back on.
          </Text>
          <TouchableOpacity style={styles.btn} onPress={openWifiSettings}>
            <Text style={styles.btnText}>Turn On Wi-Fi</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.btnOutline} onPress={recheck}>
            <Text style={styles.btnOutlineText}>I've turned it on — Recheck</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.75)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { backgroundColor: colors.white, borderRadius: radius.lg, padding: 26, width: '100%', maxWidth: 360, alignItems: 'center', ...shadow },
  iconWrap: { width: 76, height: 76, borderRadius: 38, backgroundColor: colors.dangerBg, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  title: { fontSize: 17, fontWeight: '800', color: colors.cspcBlue, textAlign: 'center', marginBottom: 8 },
  subtitle: { fontSize: 13, color: colors.textSub, textAlign: 'center', lineHeight: 19, marginBottom: 22 },
  btn: { backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center', width: '100%', ...shadow, shadowColor: colors.primary, shadowOpacity: 0.3 },
  btnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  btnOutline: { paddingVertical: 12, alignItems: 'center', width: '100%', marginTop: 8 },
  btnOutlineText: { color: colors.textSub, fontWeight: '700', fontSize: 13 },
});
