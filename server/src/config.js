// Deployment configuration, read once at boot from the environment.
//
// Node loads .env natively (>=20.6) -- no dotenv dependency needed.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { newMediaToken } from './auth.js';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(here, '..', '.env');
if (existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

const num = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

const list = (value, fallback) => {
  const items = (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : fallback;
};

// Where clients reach MediaMTX's WHIP/WHEP signaling endpoint. This is the one
// piece of Harmony that can sit behind a reverse proxy or Cloudflare Tunnel,
// because it is ordinary HTTP. Media never flows through it.
const signalingBase = (
  process.env.HARMONY_SIGNALING_URL ?? 'http://localhost:8889'
).replace(/\/+$/, '');

/**
 * The shared password, or '' for an open server.
 *
 * Empty means every existing deployment keeps working untouched, which is why
 * the default is open rather than a generated secret nobody would find.
 */
const password = process.env.HARMONY_PASSWORD ?? '';

// Generated per process, and only when it is actually needed. See auth.js.
const mediaToken = password ? newMediaToken() : '';

export const config = {
  password,
  mediaToken,

  // Wrong answers allowed before the lockout ladder starts.
  maxLoginAttempts: num(process.env.HARMONY_MAX_LOGIN_ATTEMPTS, 3),

  // Minutes locked out after each successive group of failures; the last value
  // repeats forever.
  lockoutMinutes: list(process.env.HARMONY_LOCKOUT_MINUTES, ['5', '10', '30', '60'])
    .map((m) => Number.parseInt(m, 10))
    .filter((m) => Number.isFinite(m) && m > 0),

  // Harmony control server (this process).
  port: num(process.env.HARMONY_PORT, 8080),
  host: process.env.HARMONY_HOST ?? '0.0.0.0',

  // MediaMTX control API, loopback only.
  mediamtxApi: (process.env.HARMONY_MEDIAMTX_API ?? 'http://127.0.0.1:9997').replace(/\/+$/, ''),
  pollIntervalMs: num(process.env.HARMONY_POLL_INTERVAL_MS, 1000),

  signalingBase,

  // Music Buddy (see music/). yt-dlp is looked up on the PATH unless told where it is; a cookies file is only for
  // when YouTube asks the server's address to sign in.
  ytdlpBin: process.env.HARMONY_YTDLP_BIN || 'yt-dlp',
  ytdlpCookies: process.env.HARMONY_YTDLP_COOKIES || null,
  musicMaxSeconds: num(process.env.HARMONY_MUSIC_MAX_SECONDS, 900),
  musicQueueMax: num(process.env.HARMONY_MUSIC_QUEUE_MAX, 200),

  // How long an unpublished username stays reserved. This only has to cover the
  // gap between "user picked a name" and "MediaMTX sees their publisher" --
  // source picking, permission prompts and the ICE handshake.
  claimTtlMs: num(process.env.HARMONY_CLAIM_TTL_MS, 30_000),
  /*
   * How long a channel media token is good for.
   *
   * Settable only so the renewal can be tested in seconds rather than in ten
   * minutes. MediaMTX consults the auth hook at session SETUP and never
   * again, so this does not cut anybody off mid-stream -- it decides how
   * stale a URL may be when it is first used.
   */
  channelTokenTtlMs: num(process.env.HARMONY_CHANNEL_TOKEN_TTL_MS, 10 * 60 * 1000),
  // How long a private call rings, and so waits for somebody to answer, before it is over.
  callRingMs: num(process.env.HARMONY_CALL_RING_MS, 45_000),

  // Where accounts, channels and uploads live. The one writable path Harmony
  // needs; see db.js for what happens when it is not writable.
  dataDir: process.env.HARMONY_DATA_DIR ?? '/var/lib/harmony',

  // Total bytes of uploads allowed before new ones are refused.
  //
  // Not a nicety on an SD-card host: once the filesystem is full EVERY SQLite
  // write throws, so an unbounded uploads directory does not degrade the
  // server, it stops it. 2 GB by default.
  maxDiskBytes: num(process.env.HARMONY_MAX_DISK_BYTES, 2 * 1024 * 1024 * 1024),

  // A session nobody has used in this long is dropped. Long enough that the
  // "remember me" box is worth ticking, short enough that an abandoned laptop
  // does not stay logged in forever.
  sessionIdleMs: num(process.env.HARMONY_SESSION_IDLE_MS, 30 * 24 * 60 * 60 * 1000),

  // STUN servers handed to clients. NONE by default, because nothing here
  // needs one.
  //
  // STUN tells a peer its own public address so that ANOTHER peer can reach
  // it. Every Harmony connection is client -> this server, never client ->
  // client: the server advertises its own address (MTX_WEBRTCADDITIONALHOSTS)
  // and learns each client's from the client's first packet. A STUN round
  // trip only delays the offer -- and, measured on a network with no public
  // IPv6, with Google's and Cloudflare's STUN servers ICE gathering NEVER
  // finished: the IPv6 lookups fail (ERR_NAME_NOT_RESOLVED) and the port
  // they belong to never reports done, so every connection sat out the
  // client's whole 4-second gathering timeout before sending its offer.
  // Without STUN, gathering takes ~140 ms.
  //
  // Still configurable, for anybody whose setup somehow needs it.
  iceServers: list(process.env.HARMONY_STUN_URLS, []).map((urls) => ({ urls })),

  // Optional: a TURN relay for clients on networks that block direct UDP.
  // Not required for the server itself -- it is reachable via the forwarded port.
  turn:
    process.env.HARMONY_TURN_URL && process.env.HARMONY_TURN_USERNAME
      ? {
          urls: process.env.HARMONY_TURN_URL,
          username: process.env.HARMONY_TURN_USERNAME,
          credential: process.env.HARMONY_TURN_PASSWORD ?? '',
        }
      : null,
};

export function whipUrl(username, token) {
  return `${config.signalingBase}/${encodeURIComponent(username)}/whip?token=${encodeURIComponent(token)}`;
}

/**
 * On a password-protected server the watch URL carries a token of its own,
 * because MediaMTX is reachable directly and would otherwise serve anyone who
 * guessed a username. On an open server it stays a plain URL.
 */
export function whepUrl(username) {
  const base = `${config.signalingBase}/${encodeURIComponent(username)}/whep`;
  return config.mediaToken ? `${base}?token=${encodeURIComponent(config.mediaToken)}` : base;
}

export function iceServers() {
  return config.turn ? [...config.iceServers, config.turn] : config.iceServers;
}
