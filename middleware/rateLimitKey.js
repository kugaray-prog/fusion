const jwt = require('jsonwebtoken');
const config = require('../config/config');
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

// Signed-in requests are keyed per ACCOUNT instead of per IP. Every phone on
// the institutional Wi-Fi reaches the server through the same public IP, and
// each one's background location pings alone use ~70 requests per 15
// minutes -- keyed per IP, one campus shared a single bucket and everyone got
// "Too many requests" at once. The token is verified (not just decoded) so a
// forged token can't be used to mint fresh buckets; anything without a valid
// token falls back to the client IP.
function accountOrClientKey(req) {
  const header = req.headers.authorization;
  const token = (header && header.startsWith('Bearer ') ? header.slice(7) : null) || (req.cookies && req.cookies.token);
  if (token) {
    try {
      const decoded = jwt.verify(token, config.jwt.secret);
      if (decoded && decoded.id != null) return `${decoded.type || 'admin'}:${decoded.id}`;
    } catch (e) {
      // Invalid/expired token -- rate-limit by IP like any anonymous request.
    }
  }
  return getClientIp(req) || req.ip;
}

const accountRateLimitOptions = {
  keyGenerator: accountOrClientKey,
  validate: { xForwardedForHeader: false }
};

module.exports = { clientRateLimitOptions, accountRateLimitOptions };
