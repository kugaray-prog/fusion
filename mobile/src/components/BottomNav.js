import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors, radius, shadow } from '../theme';

const ITEMS = [
  { key: 'Dashboard', label: 'Home', icon: '🏠' },
  { key: 'History', label: 'Logs', icon: '📋' },
  { key: 'Profile', label: 'Profile', icon: '👤' },
];

// Bottom tab bar rendered inside each main screen (Home / Logs / Profile).
// Active item mirrors the admin sidebar's .nav-item.active treatment: a
// solid indigo pill with white content, floating above a plain white bar.
export default function BottomNav({ active, navigation }) {
  return (
    <View style={styles.nav}>
      {ITEMS.map((item) => {
        const isActive = item.key === active;
        return (
          <TouchableOpacity
            key={item.key}
            style={[styles.navItem, isActive && styles.navItemActive]}
            onPress={() => navigation.navigate(item.key)}
            activeOpacity={0.8}
          >
            <Text style={[styles.icon, isActive && styles.iconActive]}>{item.icon}</Text>
            <Text style={[styles.label, isActive && styles.labelActive]}>{item.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  nav: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    backgroundColor: colors.white,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 10,
    paddingBottom: 22,
    paddingHorizontal: 12,
    gap: 8,
  },
  navItem: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
    paddingVertical: 8,
    borderRadius: radius.md,
  },
  navItemActive: {
    backgroundColor: colors.primary,
    ...shadow,
    shadowColor: colors.primary,
    shadowOpacity: 0.3,
  },
  icon: { fontSize: 17, marginBottom: 2 },
  iconActive: {},
  label: { fontSize: 10, fontWeight: '700', color: colors.textSub },
  labelActive: { color: '#fff', fontWeight: '800' },
});
