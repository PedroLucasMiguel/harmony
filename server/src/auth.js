// Optional server password, and the lockout that makes it worth having.
//
// Harmony has no accounts. A single shared password is the whole access control
// story: know it and you are in, do not and you cannot reach the API or the
// media. That is a deliberately small feature, but a small feature guarding a
// 10-character secret still has to survive someone trying every 10-character
// secret -- hence the lockout below.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Compare two secrets without leaking their contents through response timing.
 *
 * Hashing first is what makes this safe for arbitrary input: timingSafeEqual
 * throws when the two buffers differ in length, and that throw would itself be
 * an oracle for the password's length. SHA-256 digests are always 32 bytes.
 */
export function secretsMatch(a, b) {
  if (!a || !b) return false;
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Escalating lockout for password attempts.
 *
 * Three wrong answers buys a 5-minute wait, the next three 10 minutes, then 30,
 * then 60 and it stays there. The ladder matters more than any single rung: a
 * fixed 5-minute penalty still allows ~860 guesses a day, while this reaches an
 * hour after twelve failures and caps a determined attacker at 72 attempts a
 * day from one address.
 *
 * Keyed by client IP, which is only as trustworthy as the `trust proxy` setting
 * -- see the note in index.js. An attacker with many source addresses is not
 * stopped by this; a shared password is not the right control for that threat,
 * and Harmony says so in its README.
 */
export class LoginLimiter {
  /** @type {Map<string, {fails: number, stage: number, until: number, seen: number}>} */
  #entries = new Map();
  #maxAttempts;
  #ladderMs;
  #now;

  constructor({ maxAttempts = 3, lockoutMinutes = [5, 10, 30, 60], now = Date.now } = {}) {
    this.#maxAttempts = maxAttempts;
    this.#ladderMs = lockoutMinutes.map((m) => m * 60_000);
    this.#now = now;
  }

  /** @returns {{allowed: boolean, retryAfterSec: number}} */
  check(key) {
    const entry = this.#entries.get(key);
    if (!entry) return { allowed: true, retryAfterSec: 0 };
    const remaining = entry.until - this.#now();
    if (remaining > 0) return { allowed: false, retryAfterSec: Math.ceil(remaining / 1000) };
    return { allowed: true, retryAfterSec: 0 };
  }

  /**
   * Record a wrong password.
   * @returns {{locked: boolean, retryAfterSec: number, attemptsLeft: number}}
   */
  fail(key) {
    const now = this.#now();
    const entry = this.#entries.get(key) ?? { fails: 0, stage: 0, until: 0, seen: now };
    entry.fails += 1;
    entry.seen = now;

    if (entry.fails >= this.#maxAttempts) {
      const ms = this.#ladderMs[Math.min(entry.stage, this.#ladderMs.length - 1)];
      entry.until = now + ms;
      entry.stage += 1;
      entry.fails = 0;
      this.#entries.set(key, entry);
      this.#sweep(now);
      return { locked: true, retryAfterSec: Math.ceil(ms / 1000), attemptsLeft: 0 };
    }

    this.#entries.set(key, entry);
    this.#sweep(now);
    return { locked: false, retryAfterSec: 0, attemptsLeft: this.#maxAttempts - entry.fails };
  }

  /** A correct password wipes the slate, including the escalation stage. */
  succeed(key) {
    this.#entries.delete(key);
  }

  /**
   * Drop entries that are past their lockout and have gone quiet, so a flood of
   * one-shot attempts from many addresses cannot grow this map without bound.
   */
  #sweep(now) {
    if (this.#entries.size < 64) return;
    const idleCutoff = now - this.#ladderMs[this.#ladderMs.length - 1];
    for (const [key, entry] of this.#entries) {
      if (entry.until <= now && entry.seen <= idleCutoff) this.#entries.delete(key);
    }
  }

  /** Test seam. */
  get size() {
    return this.#entries.size;
  }
}

/**
 * The secret appended to WHEP URLs when a password is configured.
 *
 * Without this the password would guard the control API and nothing else: the
 * media server is reachable on its own port, so anyone who guessed a username
 * could still watch by going straight to WHEP. It is generated per process --
 * restarting the server invalidates outstanding watch URLs, which costs a
 * reconnect and is the correct trade.
 */
export function newMediaToken() {
  return randomBytes(24).toString('base64url');
}
