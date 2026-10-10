// Live updates over a WebSocket at /ws, so open screens refresh the moment
// data changes instead of polling: the admin dashboard, the /mobile web app
// and the Expo mobile app all connect here.
//
// The socket only carries "something changed" signals ({ type: 'change',
// topic }) — never the data itself. Clients re-fetch through the normal
// authenticated REST API, so no permission logic is duplicated here.
//
// Who hears what:
//   - Admins: every topic. broadcastMutations announces each successful
//     POST/PUT/PATCH/DELETE under /api (topic = first path segment, e.g.
//     "attendance"), and notifyAdmins announces "notifications".
//   - Employees: schedule changes everyone needs (EMPLOYEE_TOPICS), plus
//     changes to their own records sent by notifyEmployee ("attendance" when
//     an admin edits/records their attendance, "device" when their phone is
//     approved/blocked/removed).
// Broadcasts are coalesced per topic: employees' heartbeats can hit
// /api/attendance every few seconds, and one refresh per burst is enough.
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const config = require('../config/config');
const pool = require('../config/db');
const { getBlockedStatus } = require('./deviceAccess');

const COALESCE_MS = 1500;
const PING_MS = 30000;

// /api/<segment> requests that don't change any screen's data.
const IGNORED_SEGMENTS = new Set(['auth', 'employee-auth', 'nav', 'health']);
// Admin changes every signed-in employee's app should pick up.
const EMPLOYEE_TOPICS = new Set(['events', 'geofences']);

let wss = null;
const pending = new Map(); // coalesce key -> timer

// Token from ?token= (browsers can't set headers on a WebSocket), checked the
// same way as middleware/authMiddleware.js. Employees also send ?device= so a
// blacklisted/rejected phone is refused here too.
async function authenticate(req) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const token = params.get('token');
  if (!token) return null;
  let decoded;
  try {
    decoded = jwt.verify(token, config.jwt.secret);
  } catch (err) {
    return null;
  }
  if (decoded.type === 'google_pending') return null;
  if (decoded.type === 'employee') {
    if (await getBlockedStatus(params.get('device'), decoded.id)) return null;
    const [rows] = await pool.query('SELECT id FROM employees WHERE id = ?', [decoded.id]);
    return rows[0] ? { role: 'employee', id: rows[0].id } : null;
  }
  const [rows] = await pool.query('SELECT id, is_active FROM admin_accounts WHERE id = ?', [decoded.id]);
  return rows[0] && rows[0].is_active ? { role: 'admin', id: rows[0].id } : null;
}

function attach(server) {
  wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    if (!req.url.startsWith('/ws')) return socket.destroy();
    // Node drops its own error listener from an upgrading socket, so a client
    // that disconnects while authenticate() awaits the database would emit an
    // unhandled 'error' and crash the process. ws adds its own in handleUpgrade.
    const onSocketError = () => socket.destroy();
    socket.on('error', onSocketError);
    try {
      const client = await authenticate(req);
      if (!client) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return socket.destroy();
      }
      socket.removeListener('error', onSocketError);
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.client = client;
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        ws.on('error', () => {});
      });
    } catch (err) {
      console.error('[realtime] Upgrade failed:', err.message);
      socket.destroy();
    }
  });

  // Drop connections that stopped answering (closed laptop, phone lost
  // signal) and keep idle ones from being cut by proxies.
  const pinger = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, PING_MS);
  wss.on('close', () => clearInterval(pinger));
}

function send(key, topic, shouldReceive) {
  if (!wss || pending.has(key)) return;
  pending.set(key, setTimeout(() => {
    pending.delete(key);
    const message = JSON.stringify({ type: 'change', topic });
    wss.clients.forEach((ws) => {
      if (ws.readyState === ws.OPEN && shouldReceive(ws.client)) ws.send(message);
    });
  }, COALESCE_MS));
}

// Sends right away instead of after COALESCE_MS, replacing any queued
// send for the same key. For changes the admin must see the instant they
// happen: 'attendance-status' = an employee was timed in or out (unlike the
// plain 'attendance' topic, which every heartbeat also announces).
function sendNow(key, topic, shouldReceive) {
  if (!wss) return;
  clearTimeout(pending.get(key));
  pending.delete(key);
  const message = JSON.stringify({ type: 'change', topic });
  wss.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN && shouldReceive(ws.client)) ws.send(message);
  });
}

function broadcastNow(topic) {
  sendNow(topic, topic, (client) => client.role === 'admin' || EMPLOYEE_TOPICS.has(topic));
}

// Admins hear every topic; employees only the shared schedule topics.
function broadcast(topic) {
  send(topic, topic, (client) => client.role === 'admin' || EMPLOYEE_TOPICS.has(topic));
}

// Tells one employee's open apps that their own records changed.
function notifyEmployee(employeeId, topic) {
  if (!employeeId) return;
  const id = Number(employeeId);
  send(`employee:${id}:${topic}`, topic, (client) => client.role === 'employee' && client.id === id);
}

// Express middleware (mount on /api): announces each successful write.
function broadcastMutations(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  // Read now: routers rewrite req.url/req.path before the response finishes.
  const segment = req.path.split('/')[1];
  if (!segment || IGNORED_SEGMENTS.has(segment)) return next();
  // A handler that only reads (e.g. a POST preview) sets res.locals.noBroadcast.
  res.on('finish', () => {
    if (res.statusCode < 400 && !res.locals.noBroadcast) broadcast(segment);
  });
  next();
}

module.exports = { attach, broadcast, broadcastNow, notifyEmployee, broadcastMutations };
