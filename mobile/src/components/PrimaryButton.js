import React, { useRef } from 'react';
import { Animated, Text, TouchableWithoutFeedback, ActivityIndicator, StyleSheet } from 'react-native';
import { colors, radius, shadow } from '../theme';

// Consistent "brand" button used across Login/Registration/Dashboard confirm
// actions — adds a subtle press-scale animation and a built-in spinner swap
// for the loading state, so every primary action in the app feels the same
// rather than each screen hand-rolling its own TouchableOpacity + spinner.
export default function PrimaryButton({
  title,
  onPress,
  loading = false,
  disabled = false,
  variant = 'solid', // 'solid' | 'light' (white button used on colored surfaces, e.g. camera footer)
  style,
  textStyle,
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const isDisabled = disabled || loading;

  const pressIn = () => {
    if (isDisabled) return;
    Animated.spring(scale, { toValue: 0.97, useNativeDriver: true, speed: 40, bounciness: 0 }).start();
  };
  const pressOut = () => {
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 20, bounciness: 6 }).start();
  };

  return (
    <TouchableWithoutFeedback
      onPress={isDisabled ? undefined : onPress}
      onPressIn={pressIn}
      onPressOut={pressOut}
    >
      <Animated.View
        style={[
          styles.base,
          variant === 'light' ? styles.light : styles.solid,
          isDisabled && styles.disabled,
          { transform: [{ scale }] },
          style,
        ]}
      >
        {loading ? (
          <ActivityIndicator color={variant === 'light' ? colors.primary : '#fff'} />
        ) : (
          <Text style={[variant === 'light' ? styles.lightText : styles.solidText, textStyle]}>{title}</Text>
        )}
      </Animated.View>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  base: { borderRadius: radius.md, padding: 16, alignItems: 'center', justifyContent: 'center' },
  solid: { backgroundColor: colors.primary, ...shadow, shadowColor: colors.primary, shadowOpacity: 0.3 },
  solidText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  light: { backgroundColor: '#fff' },
  lightText: { color: colors.primary, fontWeight: '800', fontSize: 14 },
  disabled: { opacity: 0.5 },
});
