import React from 'react';
import { View, Text, Modal, TouchableOpacity, StyleSheet, Platform, Linking } from 'react-native';
import Constants from 'expo-constants';
import { colors, radius, shadow } from '../theme';

// react-native-maps has no web implementation, and this app's dev/browser
// preview runs on react-native-web — so only require it on native platforms
// and fall back to a simple coordinates card on web.
//
// Native builds need a real Maps API key configured at mobile/app.json →
// expo.android.config.googleMaps.apiKey (Android) / expo.ios.config.googleMapsApiKey
// (iOS). Reuse the same key set as GOOGLE_MAPS_API_KEY on the server (see
// server.js) if you'd like the admin dashboard and this map to share one
// key/project.
//
// Without a valid key, Google's Maps SDK doesn't just render a blank map —
// on Android it throws a fatal "API key not found" exception the moment a
// MapView mounts, which crashes the whole screen. So we check the configured
// key up front and only attempt to load react-native-maps when it looks like
// a real key is present; otherwise we fall through to the coordinates-card
// fallback below (same as the web preview) instead of crashing.
function looksLikeRealKey(key) {
  return !!key && !key.startsWith('YOUR_');
}

const expoConfig = Constants.expoConfig || Constants.manifest || {};
const androidMapsKey = expoConfig?.android?.config?.googleMaps?.apiKey;
const iosMapsKey = expoConfig?.ios?.config?.googleMapsApiKey;
const hasValidMapsKey =
  Platform.OS === 'android' ? looksLikeRealKey(androidMapsKey) :
  Platform.OS === 'ios' ? looksLikeRealKey(iosMapsKey) :
  false;

let MapView = null;
let Marker = null;
let Polygon = null;
if (Platform.OS !== 'web' && hasValidMapsKey) {
  // eslint-disable-next-line global-require
  const Maps = require('react-native-maps');
  MapView = Maps.default;
  Marker = Maps.Marker;
  Polygon = Maps.Polygon;
}

function centroid(points) {
  if (!points || points.length === 0) return null;
  const sum = points.reduce((acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }), { lat: 0, lng: 0 });
  return { latitude: sum.lat / points.length, longitude: sum.lng / points.length };
}

function fmtDate(dateStr) {
  if (!dateStr) return '--';
  return new Date(dateStr).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function fmtTime(dateStr) {
  if (!dateStr) return '--';
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Shown when an employee taps an item in the Upcoming Schedule list — surfaces
// the venue on a map (with the geofence boundary, when available) alongside
// the event's scheduled date and time.
export default function ScheduleMapModal({ visible, schedule, onClose }) {
  if (!schedule) return null;

  const points = schedule.points || [];
  const center = centroid(points);
  const region = center
    ? { ...center, latitudeDelta: 0.006, longitudeDelta: 0.006 }
    : null;

  const openInMaps = () => {
    if (!center) return;
    const label = encodeURIComponent(schedule.venue || schedule.title || 'Event location');
    const url = Platform.select({
      ios: `maps:0,0?q=${label}@${center.latitude},${center.longitude}`,
      android: `geo:0,0?q=${center.latitude},${center.longitude}(${label})`,
      default: `https://www.google.com/maps/search/?api=1&query=${center.latitude},${center.longitude}`,
    });
    Linking.openURL(url).catch(() => {});
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.handle} />

          <View style={styles.mapWrap}>
            {MapView && region ? (
              <MapView style={styles.map} initialRegion={region} pointerEvents="auto">
                {points.length >= 3 && Polygon && (
                  <Polygon
                    coordinates={points.map((p) => ({ latitude: p.lat, longitude: p.lng }))}
                    strokeColor={colors.primary}
                    fillColor="rgba(13, 0, 165, 0.15)"
                    strokeWidth={2}
                  />
                )}
                {Marker && <Marker coordinate={center} title={schedule.venue || schedule.title} />}
              </MapView>
            ) : (
              <View style={styles.mapFallback}>
                <Text style={styles.mapFallbackIcon}>📍</Text>
                <Text style={styles.mapFallbackText}>
                  {center
                    ? `${center.latitude.toFixed(5)}, ${center.longitude.toFixed(5)}`
                    : 'Location not yet set for this event.'}
                </Text>
                {Platform.OS === 'web' && (
                  <Text style={styles.mapFallbackHint}>Map preview is available on the mobile app.</Text>
                )}
                {Platform.OS !== 'web' && !hasValidMapsKey && (
                  <Text style={styles.mapFallbackHint}>
                    Map view needs a Google Maps API key configured in app.json.
                  </Text>
                )}
              </View>
            )}
            <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
              <Text style={styles.closeBtnText}>✕</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.body}>
            <Text style={styles.title}>{schedule.title}</Text>
            <Text style={styles.venue}>📍 {schedule.venue || 'Venue TBA'}</Text>

            <View style={styles.metaRow}>
              <View style={styles.metaItem}>
                <Text style={styles.metaLabel}>Date</Text>
                <Text style={styles.metaValue}>{fmtDate(schedule.start_datetime)}</Text>
              </View>
              <View style={styles.metaDivider} />
              <View style={styles.metaItem}>
                <Text style={styles.metaLabel}>Time</Text>
                <Text style={styles.metaValue}>
                  {fmtTime(schedule.start_datetime)}{schedule.end_datetime ? ` – ${fmtTime(schedule.end_datetime)}` : ''}
                </Text>
              </View>
            </View>

            <View style={styles.actionsRow}>
              <TouchableOpacity style={styles.btnOutline} onPress={onClose}>
                <Text style={styles.btnOutlineText}>Close</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.btnPrimary, !center && styles.btnDisabled]} onPress={openInMaps} disabled={!center}>
                <Text style={styles.btnPrimaryText}>Open in Maps</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const MAP_HEIGHT = 220;

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(27, 37, 89, 0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    overflow: 'hidden',
    ...shadow,
  },
  handle: {
    alignSelf: 'center', width: 44, height: 5, borderRadius: 3,
    backgroundColor: colors.border, marginTop: 10, marginBottom: 4,
  },
  mapWrap: { height: MAP_HEIGHT, marginTop: 8 },
  map: { width: '100%', height: '100%' },
  mapFallback: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.primaryLight, paddingHorizontal: 24,
  },
  mapFallbackIcon: { fontSize: 30, marginBottom: 8 },
  mapFallbackText: { color: colors.primary, fontWeight: '700', fontSize: 13, textAlign: 'center' },
  mapFallbackHint: { color: colors.textSub, fontSize: 11, marginTop: 6, textAlign: 'center' },
  closeBtn: {
    position: 'absolute', top: 14, right: 14, width: 34, height: 34, borderRadius: 17,
    backgroundColor: 'rgba(27, 37, 89, 0.55)', alignItems: 'center', justifyContent: 'center',
  },
  closeBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  body: { padding: 24, paddingTop: 20 },
  title: { fontSize: 18, fontWeight: '800', color: colors.textMain },
  venue: { fontSize: 13, color: colors.textSub, marginTop: 4, fontWeight: '600' },
  metaRow: {
    flexDirection: 'row', alignItems: 'center', marginTop: 18,
    backgroundColor: colors.primaryLight, borderRadius: radius.md, padding: 16,
  },
  metaItem: { flex: 1 },
  metaDivider: { width: 1, height: '100%', backgroundColor: colors.border, marginHorizontal: 14 },
  metaLabel: { fontSize: 10, fontWeight: '800', color: colors.primary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  metaValue: { fontSize: 13, fontWeight: '700', color: colors.textMain },
  actionsRow: { flexDirection: 'row', gap: 12, marginTop: 22 },
  btnOutline: {
    flex: 1, borderWidth: 2, borderColor: colors.border, borderRadius: radius.md,
    paddingVertical: 14, alignItems: 'center',
  },
  btnOutlineText: { color: colors.textSub, fontWeight: '700', fontSize: 13 },
  btnPrimary: { flex: 1, backgroundColor: colors.primary, borderRadius: radius.md, paddingVertical: 14, alignItems: 'center' },
  btnPrimaryText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  btnDisabled: { opacity: 0.4 },
});
