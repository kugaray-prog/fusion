const net = require('net');
const pool = require('../config/db');

// Office-network check for the mobile app (replaces the old Wi-Fi SSID
// match). Every device on the office connection -- the main router AND any
// extender / repeater / secondary router behind it -- reaches the internet
// through the same provider line, so the server sees the same public IP
// (or, over IPv6, the same provider-assigned prefix) no matter which access
// point the phone joined or what that access point's SSID is.
//
// The allow-list lives in settings.allowed_network_ips (editable from the
// admin dashboard's Settings page), falling back to the ALLOWED_NETWORK_IPS
// env var. Entries are separated by commas or new lines; each is either an
// exact address ("112.198.10.25", "2001:db8::1") or a CIDR range
// ("112.198.0.0/16", "2001:db8:1200::/56") -- a range covers a provider that
// hands out a different public IP after each router restart.
const SETTING_KEY = 'allowed_network_ips';

function normalizeIp(ip) {
  if (!ip) return '';
  let v = String(ip).trim();
  if (v.startsWith('::ffff:') && net.isIPv4(v.slice(7))) v = v.slice(7); // IPv4-mapped IPv6
  return v;
}

// The phone's real public IP. On Render the request arrives through
// Cloudflare and Render's own proxy, so req.socket is a proxy, not the phone.
// CF-Connecting-IP is set (and overwritten, so it can't be spoofed by the
// client) by Cloudflare itself; True-Client-IP / X-Forwarded-For are
// fallbacks for other hosting setups, and the socket address for local dev.
function getClientIp(req) {
  const candidates = [
    req.headers['cf-connecting-ip'],
    req.headers['true-client-ip'],
    (req.headers['x-forwarded-for'] || '').split(',')[0],
    req.socket && req.socket.remoteAddress
  ];
  for (const c of candidates) {
    const ip = normalizeIp(c);
    if (net.isIP(ip)) return ip;
  }
  return '';
}

function splitEntries(raw) {
  return String(raw || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Returns an error message for an invalid entry, or null if it's valid.
function validateEntry(entry) {
  const [addr, bits, extra] = entry.split('/');
  const family = net.isIP(addr);
  if (!family || extra !== undefined) return `"${entry}" is not a valid IP address or CIDR range.`;
  if (bits !== undefined) {
    const n = Number(bits);
    const max = family === 4 ? 32 : 128;
    if (!/^\d+$/.test(bits) || n < 8 || n > max) {
      return `"${entry}" has an invalid prefix length (use /8 to /${max}).`;
    }
  }
  return null;
}

function buildBlockList(entries) {
  const list = new net.BlockList();
  for (const entry of entries) {
    if (validateEntry(entry)) continue;
    const [addr, bits] = entry.split('/');
    const type = net.isIP(addr) === 4 ? 'ipv4' : 'ipv6';
    if (bits !== undefined) list.addSubnet(addr, Number(bits), type);
    else list.addAddress(addr, type);
  }
  return list;
}

function isAllowed(ip, entries) {
  const family = net.isIP(ip);
  if (!family) return false;
  return buildBlockList(entries).check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

async function getAllowedEntries() {
  const [rows] = await pool.query('SELECT setting_value FROM settings WHERE setting_key = ?', [SETTING_KEY]);
  const raw = rows[0] ? rows[0].setting_value : process.env.ALLOWED_NETWORK_IPS;
  return splitEntries(raw);
}

async function saveAllowedEntries(entries) {
  await pool.query(
    `INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
    [SETTING_KEY, entries.join('\n')]
  );
}

module.exports = { getClientIp, splitEntries, validateEntry, isAllowed, getAllowedEntries, saveAllowedEntries };
