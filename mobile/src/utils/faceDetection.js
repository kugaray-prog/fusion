import Constants, { ExecutionEnvironment } from 'expo-constants';

// @react-native-ml-kit/face-detection is a custom native module, so it isn't
// in Expo Go (iOS or Android) -- importing it there crashed the Registration
// and Face Verification screens. In Expo Go this stands in a fake detector
// instead: it always "sees" one face and flips the eyes between closed and
// open on every read, so the hold-steady and blink steps both pass and the
// rest of the flow (photo upload, server-side matching) can be developed.
// Real builds (APK, development build, TestFlight) use ML Kit as before.
const IS_EXPO_GO = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

let eyesOpen = true;
const expoGoStub = {
  detect: async () => {
    eyesOpen = !eyesOpen;
    const p = eyesOpen ? 0.99 : 0.01;
    return [{ leftEyeOpenProbability: p, rightEyeOpenProbability: p }];
  },
};

// eslint-disable-next-line global-require
const FaceDetection = IS_EXPO_GO ? expoGoStub : require('@react-native-ml-kit/face-detection').default;

export default FaceDetection;
