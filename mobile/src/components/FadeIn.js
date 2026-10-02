import React, { useEffect, useRef, useState } from 'react';
import { Animated } from 'react-native';

// Lightweight entrance animation used to give screens and cards a polished
// "settle into place" feel on mount, without pulling in a new animation
// dependency (react-native's built-in Animated API only — no reanimated).
// Wrap any block of content: <FadeIn><Card /></FadeIn>. `delay` lets a list
// of cards stagger in one after another for a nicer cascading effect.
//
// The content starts at opacity 0, so it must never be left there. On some
// Android phones (New Architecture, a screen mounted while the navigator is
// swapping stacks -- e.g. right after face registration) a native-driven
// animation can stay stuck at its first frame, which showed up as a blank
// white screen. Once the animation should be over (finished callback or a
// timer, whichever comes first) the animated style is dropped entirely, so
// the content is plainly visible no matter what the animation did. The same
// Animated.View stays mounted, so children keep their state.
export default function FadeIn({ children, delay = 0, duration = 380, distance = 14, style }) {
  const progress = useRef(new Animated.Value(0)).current;
  const [done, setDone] = useState(false);

  useEffect(() => {
    let mounted = true;
    const finish = () => { if (mounted) setDone(true); };
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration,
      delay,
      useNativeDriver: true,
    });
    anim.start(finish);
    const fallback = setTimeout(finish, delay + duration + 150);
    return () => {
      mounted = false;
      clearTimeout(fallback);
      anim.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Animated.View
      style={
        done
          ? style
          : [
              style,
              {
                opacity: progress,
                transform: [
                  {
                    translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] }),
                  },
                ],
              },
            ]
      }
    >
      {children}
    </Animated.View>
  );
}
