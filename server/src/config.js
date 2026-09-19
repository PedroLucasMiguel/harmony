// Deployment configuration, read once at boot from the environment.
//
// Node loads .env natively (>=20.6) -- no dotenv dependency needed.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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

export const config = {
  // Harmony control server (this process).
  port: num(process.env.HARMONY_PORT, 8080),
  host: process.env.HARMONY_HOST ?? '0.0.0.0',

  // MediaMTX control API, loopback only.
  mediamtxApi: (process.env.HARMONY_MEDIAMTX_API ?? 'http://127.0.0.1:9997').replace(/\/+$/, ''),
  pollIntervalMs: num(process.env.HARMONY_POLL_INTERVAL_MS, 1000),

  signalingBase,

  // How long an unpublished username stays reserved. This only has to cover the
  // gap between "user picked a name" and "MediaMTX sees their publisher" --
  // source picking, permission prompts and the ICE handshake.
  claimTtlMs: num(process.env.HARMONY_CLAIM_TTL_MS, 30_000),

  // Handed to clients so their RTCPeerConnection can discover its own public
  // address. The server does not need STUN for itself; MTX_WEBRTCADDITIONALHOSTS
  // tells it what to advertise.
  iceServers: list(process.env.HARMONY_STUN_URLS, ['stun:stun.l.google.com:19302']).map(
    (urls) => ({ urls }),
  ),

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

export function whepUrl(username) {
  return `${config.signalingBase}/${encodeURIComponent(username)}/whep`;
}

export function iceServers() {
  return config.turn ? [...config.iceServers, config.turn] : config.iceServers;
}
