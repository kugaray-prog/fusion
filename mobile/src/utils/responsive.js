import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// Layout breakpoints, in dp. A device counts as a tablet when its SHORT side
// is at least 600 (every iPad, 7"+ Android tablets), so it stays a tablet in
// both orientations. "Wide" describes the current window instead -- an iPad
// or tablet in landscape -- and is where screens switch to two columns.
// "Compact height" is a phone held in landscape, where vertical space is the
// scarce thing and tall heroes/camera frames have to shrink.
const TABLET_MIN_SHORT_SIDE = 600;
const WIDE_MIN_WIDTH = 900;
const COMPACT_MAX_HEIGHT = 500;

// Max width of a screen's content column (excluding gutters). Forms and
// single cards read badly stretched across a 1000dp+ iPad, so they get the
// narrowest column; list screens get more, and two-column layouts the most.
export const MAX_WIDTH = { form: 520, content: 720, wide: 1100 };

// React Native's <Modal> on iOS only allows portrait unless told otherwise --
// opening one while the app is in landscape would rotate the device UI.
// Every Modal in the app passes this.
export const MODAL_ORIENTATIONS = ['portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right'];

export function useResponsive() {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isLandscape = width > height;
  const isTablet = Math.min(width, height) >= TABLET_MIN_SHORT_SIDE;
  const isWide = width >= WIDE_MIN_WIDTH;
  const isCompactHeight = height < COMPACT_MAX_HEIGHT;
  const gutter = isTablet ? 32 : 20;

  // Centered, width-capped column for a screen's content. The side padding
  // also clears the notch / rounded corners of a phone held in landscape.
  const contentStyle = (maxWidth = MAX_WIDTH.content) => ({
    width: '100%',
    maxWidth: maxWidth + gutter * 2 + insets.left + insets.right,
    alignSelf: 'center',
    paddingLeft: gutter + insets.left,
    paddingRight: gutter + insets.right,
  });

  // Top padding for screens without a native header: clears the status bar
  // (the app draws edge-to-edge) while keeping the usual 20dp on phones.
  const topPad = Math.max(gutter, insets.top + 12);

  return { width, height, insets, isLandscape, isTablet, isWide, isCompactHeight, gutter, topPad, contentStyle };
}
