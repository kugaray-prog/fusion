import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, Image, ScrollView, Animated } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as Google from 'expo-auth-session/providers/google';
import { useAuth } from '../context/AuthContext';
import { colors, radius, shadow, CSPC_LOGO_URL } from '../theme';
import { GOOGLE_WEB_CLIENT_ID, GOOGLE_IOS_CLIENT_ID, GOOGLE_ANDROID_CLIENT_ID, isGoogleConfigured } from '../config';
import { notify } from '../utils/notify';
import FadeIn from '../components/FadeIn';

WebBrowser.maybeCompleteAuthSession();

const GOOGLE_G_ICON_URL = 'https://upload.wikimedia.org/wikipedia/commons/5/53/Google_%22G%22_Logo.svg';

// Mirrors the #screen-login → #screen-choice flow from the CSPC GeoAttend web
// prototype, but using real Google Sign-In (expo-auth-session) instead of the
// browser-only Google Identity Services script.
export default function LoginScreen({ navigation }) {
  const { loginWithGoogle, staleSession } = useAuth();
  const [authenticating, setAuthenticating] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const btnScale = useRef(new Animated.Value(1)).current;

  const [request, response, promptAsync] = Google.useIdTokenAuthRequest({
    clientId: GOOGLE_WEB_CLIENT_ID,
    iosClientId: GOOGLE_IOS_CLIENT_ID || undefined,
    androidClientId: GOOGLE_ANDROID_CLIENT_ID || undefined,
  });

  useEffect(() => {
    if (response?.type === 'success') {
      const idToken = response.authentication?.idToken || response.params?.id_token;
      if (idToken) handleGoogleToken(idToken);
      else {
        setAuthenticating(false);
        setErrorMsg('Could not retrieve a Google identity token. Please try again.');
      }
    } else if (response?.type === 'error') {
      setAuthenticating(false);
      setErrorMsg('Google sign-in was cancelled or failed.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [response]);

  const handleGoogleToken = async (idToken) => {
    setErrorMsg('');
    setAuthenticating(true);
    try {
      const result = await loginWithGoogle(idToken);
      if (!result.matched) {
        // No employee is linked to this Google account yet — proceed to device registration,
        // matching the web prototype's "Register this Device" step.
        navigation.replace('Registration');
      }
      // If matched, RootNavigator swaps to the Dashboard stack automatically.
    } catch (err) {
      if (err.response?.data?.message) {
        // Server reached and rejected the request — show its explanation.
        setErrorMsg(err.response.data.message);
      } else if (err.request) {
        // Google auth succeeded (we have an idToken) but the app couldn't reach
        // the backend at all — almost always a wrong/stale apiBaseUrl in
        // mobile/app.json (extra.apiBaseUrl) rather than a Google problem.
        setErrorMsg('Could not reach the server. Check that the app is connected to the same network as the server and that apiBaseUrl in app.json is correct.');
      } else {
        setErrorMsg('Google sign-in failed. Please try again.');
      }
    } finally {
      setAuthenticating(false);
    }
  };

  const handlePress = () => {
    if (!isGoogleConfigured()) {
      notify(
        'Google Sign-In not configured',
        'Set googleWebClientId in mobile/app.json (extra) to the same OAuth Client ID used as GOOGLE_CLIENT_ID on the server.'
      );
      return;
    }
    setErrorMsg('');
    promptAsync();
  };

  const btnPressIn = () => Animated.spring(btnScale, { toValue: 0.97, useNativeDriver: true, speed: 40, bounciness: 0 }).start();
  const btnPressOut = () => Animated.spring(btnScale, { toValue: 1, useNativeDriver: true, speed: 20, bounciness: 6 }).start();

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ flexGrow: 1 }}>
      {/* Brand section — mirrors .brand-section in the CSPC GeoAttend web prototype */}
      <FadeIn delay={0}>
        <View style={styles.brandSection}>
          <View style={styles.logoContainer}>
            <Image source={{ uri: CSPC_LOGO_URL }} style={styles.logoImage} resizeMode="contain" />
          </View>
          <Text style={styles.brandTitle}>CSPC GeoAttend</Text>
          <Text style={styles.brandSubtitle}>Institutional Identity Access</Text>
        </View>
      </FadeIn>

      <FadeIn delay={120}>
        <View style={styles.body}>
          <View style={styles.card}>
            <Text style={styles.cardLead}>Sign in with your official CSPC Google Account.</Text>

            <Animated.View style={{ width: '100%', transform: [{ scale: btnScale }] }}>
              <TouchableOpacity
                style={styles.googleBtn}
                onPress={handlePress}
                onPressIn={btnPressIn}
                onPressOut={btnPressOut}
                disabled={!request || authenticating}
                activeOpacity={0.85}
              >
                {authenticating ? (
                  <ActivityIndicator color={colors.cspcBlue} />
                ) : (
                  <>
                    <Image source={{ uri: GOOGLE_G_ICON_URL }} style={styles.googleIcon} />
                    <Text style={styles.googleBtnText}>Continue with Google</Text>
                  </>
                )}
              </TouchableOpacity>
            </Animated.View>

            {!!errorMsg && <Text style={styles.errorText}>{errorMsg}</Text>}
            {!errorMsg && staleSession && (
              <Text style={styles.errorText}>Your session ended because your account record changed. Please sign in again.</Text>
            )}

            {__DEV__ && !!request?.redirectUri && (
              <TouchableOpacity
                onPress={() =>
                  notify(
                    'Redirect URI (dev only)',
                    request.redirectUri +
                      '\n\nCopy this exactly into Google Cloud Console → your OAuth Client → Authorized redirect URIs.'
                  )
                }
              >
                <Text style={styles.debugText}>DEV: tap to view redirect URI</Text>
              </TouchableOpacity>
            )}
          </View>
          <Text style={styles.secureTag}>● SECURE ENCLAVE</Text>
        </View>
      </FadeIn>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  brandSection: {
    backgroundColor: colors.primary,
    paddingTop: 70,
    paddingBottom: 50,
    paddingHorizontal: 24,
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
    alignItems: 'center',
  },
  logoContainer: {
    width: 85, height: 85, borderRadius: 43,
    backgroundColor: '#fff', padding: 10,
    borderWidth: 3, borderColor: 'rgba(255,255,255,0.5)',
    marginBottom: 16, alignItems: 'center', justifyContent: 'center',
  },
  logoImage: { width: '100%', height: '100%' },
  brandTitle: { color: '#fff', fontSize: 22, fontWeight: '800' },
  brandSubtitle: { color: 'rgba(255,255,255,0.8)', fontSize: 12, marginTop: 4 },
  body: { paddingHorizontal: 20, marginTop: -30 },
  card: {
    backgroundColor: colors.white,
    padding: 24,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    ...shadow,
  },
  cardLead: { color: colors.textSub, fontSize: 14, marginBottom: 22, textAlign: 'center', fontWeight: '600' },
  googleBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12,
    backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border,
    paddingVertical: 16, borderRadius: radius.md, width: '100%',
  },
  googleIcon: { width: 20, height: 20 },
  googleBtnText: { fontWeight: '700', color: colors.textMain, fontSize: 15 },
  errorText: { color: colors.error, fontSize: 12, marginTop: 12, textAlign: 'center' },
  debugText: { color: colors.textSub, fontSize: 10, marginTop: 14, textAlign: 'center', textDecorationLine: 'underline' },
  secureTag: { textAlign: 'center', color: colors.textSub, fontSize: 10, fontWeight: '800', marginTop: 24, letterSpacing: 0.5 },
});
