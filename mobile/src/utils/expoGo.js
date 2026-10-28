import Constants, { ExecutionEnvironment } from 'expo-constants';
import { TurboModuleRegistry } from 'react-native';

// True when running inside Expo Go, which lacks this app's own native modules
// (vision-camera / Nitro, ML Kit, wifi-reborn, parts of expo-notifications).
// executionEnvironment alone isn't reliable -- some Expo Go installs don't
// report StoreClient -- so also treat a binary without the NitroModules native
// module (present in every APK / development build of this app) as Expo Go.
export const IS_EXPO_GO =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient ||
  Constants.appOwnership === 'expo' ||
  !TurboModuleRegistry.get('NitroModules');
