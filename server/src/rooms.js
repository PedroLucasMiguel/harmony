// Username reservation.
//
// A username is reserved in one of two ways:
//
//   1. LIVE      -- MediaMTX reports a ready publisher on that path. This is the
//                   authoritative state and it is owned entirely by MediaMTX;
//                   we only mirror it. `overridePublisher: no` in mediamtx.yml
//                   means a second publisher is refused by the media server,
//                   whatever this file decides.
//
//   2. CLAIMED   -- somebody typed the name and is on their way to publishing,
//                   but no packets have arrived yet. A short TTL covers that
//                   window. Without it two people could pick the same name in
//                   the seconds it takes to choose a window and finish ICE.
//
// Everything else -- who may watch, who may publish -- falls out of those two.

import { randomBytes } from 'node:crypto';

// Lowercase, starts alphanumeric, 2-24 chars. Deliberately narrow: the username
// becomes a MediaMTX path segment and part of a URL.
const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{1,23}$/;

/**
 * Names that cannot be usernames because something else already means them.
 *
 * `all_others` is MediaMTX's catch-all path key. The rest are path segments a
 * reverse proxy in front of Harmony may route on -- a deployment that sends
 * `/api/*` to the control server and everything else to MediaMTX would send a
 * user named "api" to the wrong place.
 */
const RESERVED = new Set([
  'all_others',
  'api',
  'admin',
  'harmony',
  'mediamtx',
  'health',
  'streams',
  'session',
  'whip',
  'whep',
  'static',
]);

export function normalizeUsername(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!USERNAME_RE.test(value)) return null;
  return RESERVED.has(value) ? null : value;
}

export class Rooms {
  /** @type {Map<string, {token: string, expiresAt: number, ip: string}>} */
  #claims = new Map();
  /** @type {Map<string, {viewers: number, since: string|null, tracks: string[]}>} */
  #live = new Map();
  #ttlMs;

  constructor({ claimTtlMs }) {
    this.#ttlMs = claimTtlMs;
  }

  /** Mirror the latest MediaMTX path list. */
  syncFromPaths(paths) {
    const live = new Map();
    for (const [name, path] of paths) {
      if (!path.ready) continue;
      live.set(name, { viewers: path.viewers, since: path.readyTime, tracks: path.tracks });
    }
    this.#live = live;

    // Keep the claim alive for as long as the stream is up, so a broadcaster who
    // briefly drops can reconnect with the token they already hold instead of
    // being told their own name is taken.
    const until = Date.now() + this.#ttlMs;
    for (const name of live.keys()) {
      const claim = this.#claims.get(name);
      if (claim) claim.expiresAt = until;
    }
    this.#sweep();
  }

  #sweep() {
    const now = Date.now();
    for (const [name, claim] of this.#claims) {
      if (claim.expiresAt <= now) this.#claims.delete(name);
    }
  }

  isLive(username) {
    return this.#live.has(username);
  }

  listLive() {
    return [...this.#live.entries()]
      .map(([username, info]) => ({ username, ...info }))
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  /**
   * Decide what a user gets when they enter a name.
   * Broadcaster if the name is free, viewer otherwise -- never an error, which
   * is the whole point of the single-input UX.
   *
   * `presentedToken` lets a client that already holds a claim reclaim it (the
   * user clicked twice, or the app restarted mid-setup). Identity is proved by
   * the token and nothing else: keying this off the client's IP instead would
   * mean a spoofed X-Forwarded-For could collect somebody else's publish token.
   */
  claim(username, { token: presentedToken, ip } = {}) {
    this.#sweep();

    if (this.#live.has(username)) {
      return { role: 'viewer', pending: false };
    }

    const existing = this.#claims.get(username);
    if (existing) {
      if (presentedToken && existing.token === presentedToken) {
        existing.expiresAt = Date.now() + this.#ttlMs;
        return { role: 'broadcaster', token: existing.token };
      }
      // Someone else is mid-handshake on this name. They are about to be live,
      // so treat the newcomer as a viewer waiting for the stream to appear.
      return { role: 'viewer', pending: true };
    }

    const token = randomBytes(24).toString('base64url');
    this.#claims.set(username, { token, expiresAt: Date.now() + this.#ttlMs, ip });
    return { role: 'broadcaster', token };
  }

  /** Called by the MediaMTX auth hook before a publisher is accepted. */
  mayPublish(username, token) {
    this.#sweep();
    const claim = this.#claims.get(username);
    if (!claim || !token) return false;
    // Not timing-safe on purpose: the token is a 192-bit random value with a
    // 30s lifetime, so there is nothing to learn from response timing.
    return claim.token === token;
  }

  /** Extend a claim while the broadcaster is still setting up or streaming. */
  heartbeat(username, token) {
    const claim = this.#claims.get(username);
    if (!claim || claim.token !== token) return false;
    claim.expiresAt = Date.now() + this.#ttlMs;
    return true;
  }

  /** Give the name back immediately when a broadcaster stops on purpose. */
  release(username, token) {
    const claim = this.#claims.get(username);
    if (!claim || claim.token !== token) return false;
    this.#claims.delete(username);
    return true;
  }
}
