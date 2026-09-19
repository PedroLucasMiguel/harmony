// Harmony control server.
//
// Two jobs, nothing more:
//   * /api/*          -- the client asks "is this username free?" and gets back
//                        either a publish token or a watch URL.
//   * /mediamtx/auth  -- MediaMTX asks "may this connection publish/read?".
//
// No media touches this process.

import express from 'express';
import { config, iceServers, whepUrl, whipUrl } from './config.js';
import { MediaMtxMonitor } from './mediamtx-api.js';
import { Rooms, normalizeUsername } from './rooms.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // behind Caddy / Cloudflare Tunnel
app.use(express.json({ limit: '16kb' }));

const rooms = new Rooms({ claimTtlMs: config.claimTtlMs });
const monitor = new MediaMtxMonitor({
  apiUrl: config.mediamtxApi,
  intervalMs: config.pollIntervalMs,
});

monitor.on('paths', (paths) => rooms.syncFromPaths(paths));
monitor.on('down', (err) => console.warn(`[mediamtx] control API unreachable: ${err.message}`));
monitor.on('up', () => console.log('[mediamtx] control API connected'));

// The desktop client is not served from a browser origin, but allowing CORS
// keeps a plain browser usable for the read-only stream list.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------------------
// Client API
// ---------------------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({
    ok: monitor.reachable,
    mediamtx: monitor.reachable ? 'up' : 'down',
    signalingBase: config.signalingBase,
    liveStreams: rooms.listLive().length,
  });
});

/**
 * Everything needed to watch, without reserving anything.
 *
 * The mosaic opens several streams at once, and going through /api/session for
 * each would be a trap: a name that stops being live between the listing and
 * the call comes back as "free", and the viewer would silently claim someone
 * else's username. Watching is public, so the watch URL belongs here.
 */
app.get('/api/streams', (_req, res) => {
  res.json({
    streams: rooms.listLive().map((stream) => ({ ...stream, whepUrl: whepUrl(stream.username) })),
    iceServers: iceServers(),
  });
});

// The single entry point behind the username box. Always answers with a role.
app.post('/api/session', (req, res) => {
  const username = normalizeUsername(req.body?.username);
  if (!username) {
    return res.status(400).json({
      error: 'invalid_username',
      message: '2-24 characters: letters, digits, hyphen or underscore, starting with a letter or digit.',
    });
  }

  if (!monitor.reachable) {
    return res.status(503).json({
      error: 'media_server_down',
      message: 'The media server is not responding. Try again in a moment.',
    });
  }

  const result = rooms.claim(username, { token: req.body?.token, ip: req.ip });

  if (result.role === 'broadcaster') {
    return res.json({
      role: 'broadcaster',
      username,
      token: result.token,
      whipUrl: whipUrl(username, result.token),
      iceServers: iceServers(),
      heartbeatMs: Math.floor(config.claimTtlMs / 3),
    });
  }

  return res.json({
    role: 'viewer',
    username,
    pending: result.pending,
    whepUrl: whepUrl(username),
    iceServers: iceServers(),
  });
});

app.post('/api/session/heartbeat', (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const ok = username && rooms.heartbeat(username, req.body?.token);
  res.status(ok ? 200 : 404).json({ ok: Boolean(ok), live: username ? rooms.isLive(username) : false });
});

app.post('/api/session/release', (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const ok = username && rooms.release(username, req.body?.token);
  res.json({ ok: Boolean(ok) });
});

// ---------------------------------------------------------------------------
// MediaMTX auth hook
//
// MediaMTX POSTs { user, password, token, ip, action, path, protocol, id,
// query, userAgent } and reads only the status code: 2xx allows, anything else
// denies.
// ---------------------------------------------------------------------------

app.post('/mediamtx/auth', (req, res) => {
  const { action, path, query } = req.body ?? {};

  // api / metrics / pprof are already excluded in mediamtx.yml, but MediaMTX
  // will ask if that config is ever edited. Loopback only.
  if (action === 'api' || action === 'metrics' || action === 'pprof') {
    return res.sendStatus(204);
  }

  const username = normalizeUsername(path);
  if (!username) return res.sendStatus(401);

  // Watching is open to anyone who knows the name -- that is the design.
  if (action === 'read' || action === 'playback') {
    return res.sendStatus(204);
  }

  if (action === 'publish') {
    // MediaMTX forwards the raw query string from the WHIP URL.
    const token = new URLSearchParams(query ?? '').get('token');
    if (rooms.mayPublish(username, token)) {
      console.log(`[auth] publish accepted for "${username}"`);
      return res.sendStatus(204);
    }
    console.warn(`[auth] publish REJECTED for "${username}" (bad or expired token)`);
    return res.sendStatus(401);
  }

  return res.sendStatus(401);
});

// ---------------------------------------------------------------------------

monitor.start();

const server = app.listen(config.port, config.host, () => {
  console.log(`[harmony] control server on http://${config.host}:${config.port}`);
  console.log(`[harmony] clients will be sent to ${config.signalingBase}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n[harmony] ${signal} -- shutting down`);
    monitor.stop();
    server.close(() => process.exit(0));
  });
}
