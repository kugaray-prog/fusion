import React from 'react';
import { Text, StyleSheet } from 'react-native';
import { colors } from '../theme';

// Mirrors the admin dashboard's .badge / .badge-success / .badge-warning /
// .badge-info treatment: a tinted pill background with a matching solid
// text color, bold + uppercase.
const VARIANTS = {
  default: { bg: colors.primaryLight, text: colors.primary },
  waiting: { bg: colors.warningBg, text: colors.warningText },
  soon: { bg: colors.infoBg, text: colors.infoText },
  success: { bg: colors.successBg, text: colors.successText },
  danger: { bg: colors.dangerBg, text: colors.dangerText },
};

export default function StatusPill({ label, variant = 'default' }) {
  const v = VARIANTS[variant] || VARIANTS.default;
  return (
    <Text style={[styles.pill, { backgroundColor: v.bg, color: v.text }]}>{label}</Text>
  );
}

const styles = StyleSheet.create({
  pill: {
    fontSize: 9,
    fontWeight: '800',
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
    overflow: 'hidden',
  },
});
