import { Alert, Platform } from 'react-native';

// react-native-web's Alert.alert implementation is incomplete — on web it can
// silently no-op (especially with a `buttons` array), which is why actions
// like "Submit Attendance" can appear to do nothing in a browser preview even
// though the native app would show a proper dialog. This helper guarantees
// the user always sees the result on every platform.
export function notify(title, message, buttons) {
  if (Platform.OS === 'web') {
    window.alert(message ? `${title}\n\n${message}` : title);
    const okButton = (buttons || []).find((b) => b.onPress);
    if (okButton) okButton.onPress();
    return;
  }
  Alert.alert(title, message, buttons);
}

export default notify;
