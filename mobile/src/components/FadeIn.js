import React, { useEffect, useRef } from 'react';
import { Animated } from 'react-native';

// Lightweight entrance animation used to give screens and cards a polished
// "settle into place" feel on mount, without pulling in a new animation
// dependency (react-native's built-in Animated API only — no reanimated).
// Wrap any block of content: <FadeIn><Card /></FadeIn>. `delay` lets a list
// of cards stagger in one after another for a nicer cascading effect.
export default function FadeIn({ children, delay = 0, duration = 380, distance = 14, style }) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration,
      delay,
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [
            {
              translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] }),
            },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}
