import { Platform } from 'react-native';
import { IS_EXPO_GO } from './expoGo';

// Expo Go on Android (SDK 53+) throws as soon as expo-notifications is loaded
// ("push notifications ... removed from Expo Go" / "Cannot find native module
// 'ExpoTopicSubscriptionModule'"), which crashed the whole app at startup.
// There it's simply not loaded and this exports null; every helper that posts
// a notification checks for that and skips it. Real builds (APK, development
// build) and iOS Expo Go load it normally.
const unsupported = IS_EXPO_GO && Platform.OS === 'android';

const Notifications = unsupported ? null : require('expo-notifications');

export default Notifications;
