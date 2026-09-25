import React, { useState } from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, radius, CSPC_LOGO } from '../theme';

// App identity mark (the CSPC seal, the same image already used on the
// Login screen) paired with the app name, in the upper-left corner of every
// main screen -- mirrors the admin web dashboard's sidebar header
// (views/dashboard.ejs: a colored badge icon + "GeoAttend" wordmark) so the
// mobile app and the admin portal read as the same product, and gives every
// screen the same consistent header instead of each one styling its own
// title independently.
//
// Falls back to a plain globe-icon badge if the remote logo image can't be
// reached (no connectivity, the hosted image moves) -- branding stays
// visible either way instead of leaving a blank gap.
export default function AppHeader({ title }) {
  const [logoFailed, setLogoFailed] = useState(false);
  return (
    <View style={styles.row}>
      <View style={styles.mark}>
        {!logoFailed ? (
          <Image
            source={CSPC_LOGO}
            style={styles.logoImage}
            resizeMode="contain"
            onError={() => setLogoFailed(true)}
          />
        ) : (
          <Ionicons name="school-outline" size={20} color={colors.primary} />
        )}
      </View>
      <View style={styles.textCol}>
        <Text style={styles.appName}>GeoAttend</Text>
        {title ? <Text style={styles.screenTitle}>{title}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 20 },
  mark: {
    width: 40, height: 40, borderRadius: radius.pill, backgroundColor: colors.white,
    borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  logoImage: { width: 32, height: 32 },
  textCol: { flex: 1, minWidth: 0 },
  appName: { fontSize: 11, fontWeight: '700', color: colors.textSub, textTransform: 'uppercase', letterSpacing: 0.8 },
  screenTitle: { fontSize: 20, fontWeight: '700', color: colors.textMain, marginTop: 1, letterSpacing: -0.3 },
});
