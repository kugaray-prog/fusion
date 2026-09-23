import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ScrollView,
  Platform, TextInput, Modal
} from 'react-native';
import * as Location from 'expo-location';
import WifiManager from 'react-native-wifi-reborn';
import { getGeofences } from '../api/client';
import { colors, radius, shadow } from '../theme';
import { REQUIRED_WIFI_SSID } from '../config';
import { notify } from '../utils/notify';
import { useAuth } from '../context/AuthContext';

// Runs right after Google login / device registration, before the Dashboard is
// reached (see App.js — this is the only screen in the authenticated stack
// until it's satisfied). It confirms the employee's device is joined to the
// location's designated Wi-Fi network, used as a second signal (alongside GPS
// geofencing in AttendanceScreen) that the user is physically in the located
// area. Once matched, it calls markWifiVerified() (AuthContext) rather than
// navigating anywhere itself — App.js's RootNavigator reacts to that state
// and swaps this screen out for the Dashboard stack on its own, the same
// state-driven pattern already used for the WaitingApproval gate.
//
// Platform note: reading the currently-connected SSID and scanning nearby
// networks requires the native `react-native-wifi-reborn` module, which only
// works in a custom dev-client / prebuilt app — NOT in Expo Go. On iOS, Apple
// does not allow listing nearby networks at all; only a direct join of a known
// SSID is possible (no picker), so the "Search Wi-Fi Networks" list is
// Android-only and iOS uses the "Connect to <SSID>" button instead.
export default function WifiCheckScreen() {
  const { markWifiVerified } = useAuth();
  const [expectedSsid, setExpectedSsid] = useState(REQUIRED_WIFI_SSID);
  const [currentSsid, setCurrentSsid] = useState(null);
  const [phase, setPhase] = useState('checking'); // checking | matched | mismatch | scanning | networks | connecting
  const [networks, setNetworks] = useState([]);
  const [selectedNetwork, setSelectedNetwork] = useState(null);
  const [password, setPassword] = useState('');
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  // If the active event's geofence record exposes its own `wifi_ssid` (venue-
  // specific network), prefer that over the app-wide default from config.js.
  const loadExpectedSsid = useCallback(async () => {
    try {
      const res = await getGeofences();
      const active = (res.data || []).find((g) => g.computed_status === 'active');
      if (active?.wifi_ssid) {
        setExpectedSsid(active.wifi_ssid);
        return active.wifi_ssid;
      }
    } catch (e) {
      // Non-fatal — fall back to the default configured SSID.
    }
    return REQUIRED_WIFI_SSID;
  }, []);

  const checkCurrentWifi = useCallback(async (targetSsid) => {
    setPhase('checking');
    setErrorMsg('');
    try {
      const { status: permStatus } = await Location.requestForegroundPermissionsAsync();
      if (permStatus !== 'granted') {
        setErrorMsg('Location permission is required to detect the connected Wi-Fi network.');
        setPhase('mismatch');
        return;
      }
      const ssid = await WifiManager.getCurrentWifiSSID();
      const cleanSsid = (ssid || '').replace(/^"|"$/g, ''); // some OSes wrap SSIDs in quotes
      setCurrentSsid(cleanSsid || null);
      if (cleanSsid && cleanSsid === targetSsid) {
        setPhase('matched');
        notify('Connected', `Connected to Wi-Fi: ${cleanSsid}`, [
          { text: 'Continue', onPress: () => markWifiVerified() }
        ]);
      } else {
        setPhase('mismatch');
      }
    } catch (e) {
      setErrorMsg(
        Platform.OS === 'web'
          ? 'Wi-Fi detection needs a native device build — not available in the web/Expo Go preview.'
          : (e.message || 'Could not read the current Wi-Fi network.')
      );
      setPhase('mismatch');
    }
  }, [markWifiVerified]);

  useEffect(() => {
    (async () => {
      const target = await loadExpectedSsid();
      checkCurrentWifi(target);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scanNetworks = async () => {
    setPhase('scanning');
    setErrorMsg('');
    try {
      if (Platform.OS !== 'android') {
        throw new Error('Scanning nearby networks is only available on Android. Use "Connect to network" below instead.');
      }
      const list = await WifiManager.loadWifiList();
      const sorted = [...list].sort((a, b) =>
        a.SSID === expectedSsid ? -1 : b.SSID === expectedSsid ? 1 : 0
      );
      setNetworks(sorted);
      setPhase('networks');
    } catch (e) {
      setErrorMsg(e.message || 'Could not scan for Wi-Fi networks.');
      setPhase('mismatch');
    }
  };

  const connectToNetwork = (ssid, isSecure) => {
    setSelectedNetwork(ssid);
    if (isSecure) {
      setShowPasswordModal(true);
    } else {
      doConnect(ssid, null);
    }
  };

  const doConnect = async (ssid, pwd) => {
    setPhase('connecting');
    setShowPasswordModal(false);
    setErrorMsg('');
    try {
      if (pwd) {
        await WifiManager.connectToProtectedSSID(ssid, pwd, false, false);
      } else {
        await WifiManager.connectToSSID(ssid);
      }
      setPassword('');
      setTimeout(() => checkCurrentWifi(expectedSsid), 1500);
    } catch (e) {
      setErrorMsg(e.message || `Could not connect to ${ssid}.`);
      setPhase('mismatch');
    }
  };

  const connectDirectly = () => {
    setSelectedNetwork(expectedSsid);
    setShowPasswordModal(true);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 20, flexGrow: 1, justifyContent: 'center' }}>
      <View style={styles.card}>
        <Text style={styles.title}>Verifying Location Network</Text>
        <Text style={styles.subtitle}>
          To confirm you're within the designated area, connect to the official Wi-Fi network before continuing.
        </Text>

        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Required network</Text>
          <Text style={styles.infoValue}>{expectedSsid || '—'}</Text>
        </View>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Currently connected</Text>
          <Text style={styles.infoValue}>{currentSsid || 'Not connected'}</Text>
        </View>

        {phase === 'checking' && (
          <View style={styles.centerRow}>
            <ActivityIndicator color={colors.cspcBlue} />
            <Text style={styles.statusText}>Checking Wi-Fi connection…</Text>
          </View>
        )}

        {phase === 'matched' && (
          <View style={[styles.statusBanner, { backgroundColor: colors.successBg }]}>
            <Text style={[styles.statusBannerText, { color: colors.success }]}>✅ Connected to {currentSsid}</Text>
          </View>
        )}

        {['mismatch', 'scanning', 'networks', 'connecting'].includes(phase) && (
          <View style={[styles.statusBanner, { backgroundColor: '#FEE2E2' }]}>
            <Text style={[styles.statusBannerText, { color: colors.error }]}>
              Please connect to "{expectedSsid}" to continue.
            </Text>
          </View>
        )}

        {!!errorMsg && <Text style={styles.errorText}>{errorMsg}</Text>}

        {phase === 'mismatch' && (
          <>
            {Platform.OS === 'android' && (
              <TouchableOpacity style={styles.btnGold} onPress={scanNetworks}>
                <Text style={styles.btnGoldText}>Search Wi-Fi Networks</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.btnOutline} onPress={connectDirectly}>
              <Text style={styles.btnOutlineText}>Connect to "{expectedSsid}"</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.btnPlain} onPress={() => checkCurrentWifi(expectedSsid)}>
              <Text style={styles.btnPlainText}>I've connected — Recheck</Text>
            </TouchableOpacity>
          </>
        )}

        {phase === 'scanning' && (
          <View style={styles.centerRow}>
            <ActivityIndicator color={colors.cspcBlue} />
            <Text style={styles.statusText}>Searching nearby Wi-Fi networks…</Text>
          </View>
        )}

        {phase === 'connecting' && (
          <View style={styles.centerRow}>
            <ActivityIndicator color={colors.cspcBlue} />
            <Text style={styles.statusText}>Connecting to {selectedNetwork}…</Text>
          </View>
        )}

        {phase === 'networks' && (
          <View style={styles.networkList}>
            {networks.length === 0 && <Text style={styles.emptyText}>No networks found nearby.</Text>}
            {networks.map((n) => (
              <TouchableOpacity
                key={n.BSSID || n.SSID}
                style={[styles.networkItem, n.SSID === expectedSsid && styles.networkItemHighlight]}
                onPress={() => connectToNetwork(n.SSID, !!(n.capabilities && n.capabilities.includes('WPA')))}
              >
                <Text style={styles.networkName}>{n.SSID || '(hidden network)'}</Text>
                {n.SSID === expectedSsid && <Text style={styles.networkTag}>Required</Text>}
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={styles.btnPlain} onPress={scanNetworks}>
              <Text style={styles.btnPlainText}>Rescan</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      <Modal visible={showPasswordModal} transparent animationType="fade" onRequestClose={() => setShowPasswordModal(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Connect to {selectedNetwork}</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="Wi-Fi password"
              placeholderTextColor="#94A3B8"
              secureTextEntry
              value={password}
              onChangeText={setPassword}
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={[styles.btnOutline, { flex: 1 }]} onPress={() => setShowPasswordModal(false)}>
                <Text style={styles.btnOutlineText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.btnGold, { flex: 1 }]} onPress={() => doConnect(selectedNetwork, password)}>
                <Text style={styles.btnGoldText}>Connect</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  card: {
    backgroundColor: colors.white, borderRadius: radius.lg, padding: 22,
    borderWidth: 1, borderColor: colors.border, ...shadow,
  },
  title: { fontSize: 18, fontWeight: '800', color: colors.cspcBlue, textAlign: 'center' },
  subtitle: { color: colors.textSub, fontSize: 13, textAlign: 'center', marginTop: 8, marginBottom: 18, lineHeight: 18 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  infoLabel: { fontSize: 11, color: colors.textSub, fontWeight: '700', textTransform: 'uppercase' },
  infoValue: { fontSize: 13, color: colors.textMain, fontWeight: '700' },
  centerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 20 },
  statusText: { color: colors.textSub, fontSize: 13 },
  statusBanner: { borderRadius: radius.sm, padding: 14, marginTop: 16 },
  statusBannerText: { fontWeight: '700', fontSize: 13, textAlign: 'center' },
  errorText: { color: colors.error, fontSize: 12, marginTop: 10, textAlign: 'center' },
  btnGold: { backgroundColor: colors.primary, borderRadius: radius.md, padding: 14, alignItems: 'center', marginTop: 16, ...shadow, shadowColor: colors.primary, shadowOpacity: 0.3 },
  btnGoldText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  btnOutline: { borderWidth: 2, borderColor: colors.border, borderRadius: radius.md, padding: 14, alignItems: 'center', marginTop: 12 },
  btnOutlineText: { color: colors.primary, fontWeight: '700', fontSize: 14 },
  btnPlain: { padding: 12, alignItems: 'center', marginTop: 6 },
  btnPlainText: { color: colors.textSub, fontWeight: '700', fontSize: 13 },
  networkList: { marginTop: 16 },
  networkItem: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 12, paddingHorizontal: 14, borderRadius: radius.sm,
    borderWidth: 1, borderColor: colors.border, marginBottom: 8,
  },
  networkItemHighlight: { borderColor: colors.primary, backgroundColor: colors.primaryLight },
  networkName: { color: colors.textMain, fontWeight: '600', fontSize: 13 },
  networkTag: { color: colors.cspcBlue, fontWeight: '800', fontSize: 10, textTransform: 'uppercase' },
  emptyText: { color: colors.textSub, fontSize: 12, textAlign: 'center', paddingVertical: 12 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.5)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modalCard: { backgroundColor: colors.white, borderRadius: radius.md, padding: 20, width: '100%', ...shadow },
  modalTitle: { fontSize: 15, fontWeight: '800', color: colors.cspcBlue, marginBottom: 12 },
  modalInput: { borderWidth: 2, borderColor: colors.border, borderRadius: radius.sm, padding: 12, fontSize: 14, color: colors.textMain },
  modalActions: { flexDirection: 'row', gap: 10, marginTop: 14 },
});
