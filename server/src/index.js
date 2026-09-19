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
import { LoginLimiter, secretsMatch } from './auth.js';
import { MediaMtxMonitor } from './mediamtx-api.js';
import { Rooms, normalizeUsername } from './rooms.js';

const app = express();
app.disable('x-powered-by');

/**
 * Trust only a proxy on this machine -- Caddy, or a Cloudflare Tunnel connector.
 *
 * `true` would trust the whole X-Forwarded-For chain, and every entry in that
 * header except the one our own proxy appends is written by the client. With a
 * password to guess that is not academic: the rate limiter is keyed on the
 * address, so a spoofable address is a rate limiter that can be stepped around
 * by changing one header. 'loopback' makes Express walk back only through
 * proxies it actually trusts, landing on the address Caddy observed.
 */
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '16kb' }));

const rooms = new Rooms({ claimTtlMs: config.claimTtlMs });
const limiter = new LoginLimiter({
  maxAttempts: config.maxLoginAttempts,
  lockoutMinutes: config.lockoutMinutes,
});
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
  res.set('Access-Control-Allow-Headers', 'Content-Type, X-Harmony-Password');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/**
 * Gate for everything except /api/health.
 *
 * On an open server this is a no-op, so the un-passworded deployment keeps
 * exactly the behaviour it had. The password may arrive as a header or in the
 * JSON body; the header is what the client uses, the body form is there so the
 * endpoint can be exercised with curl.
 */
function requirePassword(req, res, next) {
  if (!config.password) return next();

  const key = req.ip ?? 'unknown';
  const gate = limiter.check(key);
  if (!gate.allowed) {
    res.set('Retry-After', String(gate.retryAfterSec));
    return res.status(429).json({
      error: 'locked_out',
      retryAfterSec: gate.retryAfterSec,
      message: `Too many wrong passwords. Try again in ${formatWait(gate.retryAfterSec)}.`,
    });
  }

  const offered = req.get('x-harmony-password') ?? req.body?.password;

  // Offering nothing is not a guess, and must not burn an attempt. The client
  // asks for the stream list as soon as it opens, before the user has typed
  // anything -- counting that would let someone lock themselves out of their
  // own server in three refreshes without ever getting a password wrong.
  if (!offered) {
    return res.status(401).json({
      error: 'password_required',
      message: 'This server needs a password.',
    });
  }

  if (secretsMatch(offered, config.password)) {
    limiter.succeed(key);
    return next();
  }

  const result = limiter.fail(key);
  console.warn(
    `[auth] wrong password from ${key}` +
      (result.locked ? ` -- locked out for ${formatWait(result.retryAfterSec)}` : ''),
  );
  if (result.locked) {
    res.set('Retry-After', String(result.retryAfterSec));
    return res.status(429).json({
      error: 'locked_out',
      retryAfterSec: result.retryAfterSec,
      message: `Too many wrong passwords. Try again in ${formatWait(result.retryAfterSec)}.`,
    });
  }
  return res.status(401).json({
    error: 'bad_password',
    attemptsLeft: result.attemptsLeft,
    message: `Wrong password. ${result.attemptsLeft} ${result.attemptsLeft === 1 ? 'try' : 'tries'} left before a lockout.`,
  });
}

function formatWait(seconds) {
  if (seconds < 90) return `${seconds} seconds`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

// ---------------------------------------------------------------------------
// Client API
// ---------------------------------------------------------------------------

/**
 * Deliberately outside the password gate: the client has to be able to ask
 * "does this server want a password?" before it can sensibly prompt for one.
 * It gives away nothing but that answer until the caller authenticates.
 */
app.get('/api/health', (req, res) => {
  const authed =
    !config.password || secretsMatch(req.get('x-harmony-password'), config.password);
  res.json({
    ok: monitor.reachable,
    mediamtx: monitor.reachable ? 'up' : 'down',
    passwordRequired: Boolean(config.password),
    authenticated: authed,
    ...(authed
      ? { signalingBase: config.signalingBase, liveStreams: rooms.listLive().length }
      : {}),
  });
});

app.use('/api', requirePassword);

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

  // On an open server, watching is open to anyone who knows the name -- that is
  // the design. With a password configured it must not be: MediaMTX listens on
  // its own port, so a reader who never touched the control server would other-
  // wise walk straight past the password. The watch URLs handed out by
  // /api/streams carry the token that proves the holder got them from us.
  if (action === 'read' || action === 'playback') {
    if (!config.mediaToken) return res.sendStatus(204);
    const token = new URLSearchParams(query ?? '').get('token');
    if (secretsMatch(token, config.mediaToken)) return res.sendStatus(204);
    console.warn(`[auth] read REJECTED for "${username}" (missing or stale watch token)`);
    return res.sendStatus(401);
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
  console.log(
    config.password
      ? `[harmony] password required — ${config.maxLoginAttempts} tries, then ${config.lockoutMinutes.join('/')} minute lockouts`
      : '[harmony] NO PASSWORD SET — anyone who can reach this server can use it',
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n[harmony] ${signal} -- shutting down`);
    monitor.stop();
    server.close(() => process.exit(0));
  });
}
