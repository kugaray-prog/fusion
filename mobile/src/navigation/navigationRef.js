import { createNavigationContainerRef } from '@react-navigation/native';

// Lets code outside of any screen component (AttendanceTrackingContext,
// specifically -- it needs to jump straight to FaceVerificationScreen the
// moment a geo-anomaly flags an attendance record, from inside a background
// location callback, not a button press) trigger navigation without needing
// the `navigation` prop. Standard React Navigation pattern: attach this same
// ref to <NavigationContainer ref={navigationRef}> in App.js, and call
// navigationRef.navigate(...) anywhere else once navigationRef.isReady().
//
// Lives in its own file (not exported from App.js) so both App.js and
// AttendanceTrackingContext.js can import it without either importing the
// other.
export const navigationRef = createNavigationContainerRef();
