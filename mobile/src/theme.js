// Shared design tokens — mirrors the admin dashboard's CSS variables
// (views/dashboard.ejs :root) so the mobile app and the admin web portal
// read as the same product: indigo primary, soft blue-tinted neutrals,
// pill-rounded cards, and the same badge/status color language.
export const colors = {
  // Brand
  primary: '#0D00A5',
  primaryHover: '#09007A',
  primaryLight: '#F0F2FF',
  secondary: '#2B3674',
  accent: '#4318FF',

  // Legacy aliases kept so existing styles referencing these keep working —
  // both now resolve to the same indigo brand color instead of the old
  // navy/gold pairing.
  cspcBlue: '#0D00A5',
  cspcBlueLight: '#2B3674',
  cspcGold: '#0D00A5',

  // Status
  success: '#05CD99',
  successBg: '#DCFCE7',
  successText: '#04946F',
  error: '#EE5D50',
  danger: '#EE5D50',
  dangerBg: '#FEE2E2',
  dangerText: '#C0392B',
  warning: '#FFB547',
  warningBg: '#FFF4E5',
  warningText: '#B25E00',
  info: '#4338CA',
  infoBg: '#E0E7FF',
  infoText: '#4338CA',

  // Legacy status aliases
  waitingBg: '#FFF4E5',
  waitingText: '#B25E00',
  soonBg: '#E0E7FF',
  soonText: '#4338CA',

  // Neutrals
  bg: '#F4F7FE',
  white: '#FFFFFF',
  textMain: '#1B2559',
  textSub: '#A3AED0',
  border: '#E9EDF7',
};

export const radius = {
  xl: 30,
  lg: 24,
  md: 16,
  sm: 10,
};

// Mirrors --shadow-sm: 0px 10px 30px rgba(112, 144, 176, 0.15)
export const shadow = {
  shadowColor: '#7090B0',
  shadowOffset: { width: 0, height: 10 },
  shadowOpacity: 0.15,
  shadowRadius: 20,
  elevation: 4,
};

// CSPC logo image used across the login screen and profile avatar fallback.
export const CSPC_LOGO_URL =
  'https://upload.wikimedia.org/wikipedia/en/thumb/0/08/Camarines_Sur_Polytechnic_Colleges_Logo.png/220px-Camarines_Sur_Polytechnic_Colleges_Logo.png';

export default { colors, radius, shadow, CSPC_LOGO_URL };
