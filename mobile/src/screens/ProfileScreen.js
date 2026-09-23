import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Image } from 'react-native';
import * as Device from 'expo-device';
import { useAuth } from '../context/AuthContext';
import { colors, radius, shadow } from '../theme';
import BottomNav from '../components/BottomNav';
import { getDeviceUid } from '../utils/device';
import { assetUrl } from '../config';
import FadeIn from '../components/FadeIn';
import AppHeader from '../components/AppHeader';

// Mirrors the #screen-profile card from the CSPC GeoAttend web prototype:
// avatar circle, name/employee id, and a monospace device-info block.
export default function ProfileScreen({ navigation }) {
  const { employee, logout } = useAuth();
  const [deviceId, setDeviceId] = useState('--');
  // Starts true whenever there's a photo path to try; a load failure (bad
  // network, file removed from the server, etc.) flips this back to the
  // placeholder avatar instead of showing a broken-image icon.
  const [photoFailed, setPhotoFailed] = useState(false);
  const photoUrl = assetUrl(employee?.face_photo_url);

  useEffect(() => {
    setDeviceId(getDeviceUid(employee?.id) || 'N/A');
  }, [employee]);

  useEffect(() => {
    setPhotoFailed(false);
  }, [photoUrl]);

  const handleLogout = () => logout();

  return (
    <View style={styles.flex}>
      <ScrollView contentContainerStyle={{ padding: 20 }}>
        <AppHeader title="My Profile" />

        <FadeIn>
          <View style={styles.card}>
            <View style={styles.avatarWrap}>
              <View style={styles.avatar}>
                {photoUrl && !photoFailed ? (
                  <Image
                    source={{ uri: photoUrl }}
                    style={styles.avatarPhoto}
                    onError={() => setPhotoFailed(true)}
                  />
                ) : (
                  <Text style={styles.avatarText}>👤</Text>
                )}
              </View>
              <Text style={styles.name}>{employee?.full_name || 'User'}</Text>
              <Text style={styles.empId}>{employee?.employee_code || 'N/A'}</Text>
            </View>

            <View style={styles.divider} />

            <View style={styles.infoBlock}>
              <Text style={styles.infoLine}><Text style={styles.infoLabel}>DEPARTMENT: </Text>{employee?.department || '--'}</Text>
              <Text style={styles.infoLine}><Text style={styles.infoLabel}>DEVICE MODEL: </Text>{Device.modelName || 'Unknown'}</Text>
              <Text style={styles.infoLine}><Text style={styles.infoLabel}>DEVICE ID: </Text>{deviceId}</Text>
            </View>
          </View>

          <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout} activeOpacity={0.85}>
            <Text style={styles.logoutText}>Logout from Device</Text>
          </TouchableOpacity>
        </FadeIn>
      </ScrollView>
      <BottomNav active="Profile" navigation={navigation} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  header: { fontSize: 20, fontWeight: '800', color: colors.textMain, marginBottom: 16 },
  card: {
    backgroundColor: colors.white, borderRadius: radius.lg, padding: 18,
    borderWidth: 1, borderColor: colors.border, ...shadow, marginBottom: 16,
  },
  avatarWrap: { alignItems: 'center', marginBottom: 15 },
  avatar: {
    width: 60, height: 60, borderRadius: 30, backgroundColor: colors.cspcBlue,
    alignItems: 'center', justifyContent: 'center', marginBottom: 10, overflow: 'hidden',
  },
  avatarPhoto: { width: '100%', height: '100%' },
  avatarText: { fontSize: 24 },
  name: { color: colors.cspcBlue, fontWeight: '800', fontSize: 16 },
  empId: { color: colors.textSub, fontSize: 12, marginTop: 2 },
  divider: { borderTopWidth: 1, borderTopColor: '#EEE', marginTop: 5, marginBottom: 15 },
  infoBlock: { gap: 8 },
  infoLine: { fontSize: 13, color: colors.textMain, fontFamily: 'monospace' },
  infoLabel: { fontWeight: '800' },
  logoutBtn: { backgroundColor: colors.dangerBg, borderRadius: radius.md, padding: 16, alignItems: 'center' },
  logoutText: { color: colors.error, fontWeight: '700', fontSize: 15 },
});
