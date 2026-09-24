const { getClientIp } = require('../services/networkService');

// Shared options for every express-rate-limit limiter in the app.
//
// On Render, requests reach Express through Cloudflare and Render's own proxy,
// so the default key (req.ip, with `trust proxy` off) is the proxy's address:
// every employee and admin shared one bucket, and one busy moment (or one
// user retrying a login) could lock everyone out. Key each limiter on the
// real client IP instead -- the same one the office-network check uses (see
// networkService.getClientIp: CF-Connecting-IP, which Cloudflare overwrites so
// clients can't spoof it, then X-Forwarded-For, then the socket address).
//
// The xForwardedForHeader validation is off because this key deliberately
// reads that header itself instead of relying on Express's `trust proxy`.
const clientRateLimitOptions = {
  keyGenerator: (req) => getClientIp(req) || req.ip,
  validate: { xForwardedForHeader: false }
};

module.exports = { clientRateLimitOptions };
