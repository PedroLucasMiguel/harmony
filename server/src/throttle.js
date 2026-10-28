// Per-person rate limits for things anybody signed in can do over and over.
//
// The login limiters in auth.js answer "is someone guessing?" and lock people
// out. This answers a different question -- "is someone flooding?" -- and must
// never lock anybody out: a burst is allowed, the excess is refused with a
// retry hint, and a moment later it works again. A friend pasting five
// messages in a row is not an attack, and a script sending five hundred is.

/**
 * A token bucket per key.
 *
 * `burst` tokens to start with, refilled at `perSecond`. Each action spends
 * one. That shape is the one that matches people: quiet most of the time,
 * then several things at once, so a fixed window would either refuse the
 * burst or wave the flood through at every window boundary.
 */
export class Throttle {
  /** @type {Map<string|number, {tokens: number, at: number}>} */
  #buckets = new Map();
  #burst;
  #perSecond;
  #now;

  constructor({ burst, perSecond, now = Date.now }) {
    this.#burst = burst;
    this.#perSecond = perSecond;
    this.#now = now;
  }

  /**
   * Spend one token for `key` -- or `cost` of them, for an action that is a
   * fraction (or a multiple) of the usual one, such as a piece of a file.
   *
   * @returns {{allowed: boolean, retryAfterSec: number}}
   */
  take(key, cost = 1) {
    const now = this.#now();
    const bucket = this.#buckets.get(key) ?? { tokens: this.#burst, at: now };
    bucket.tokens = Math.min(this.#burst, bucket.tokens + ((now - bucket.at) / 1000) * this.#perSecond);
    bucket.at = now;

    if (bucket.tokens < cost) {
      this.#buckets.set(key, bucket);
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((cost - bucket.tokens) / this.#perSecond)) };
    }
    bucket.tokens -= cost;
    this.#buckets.set(key, bucket);
    this.#sweep(now);
    return { allowed: true, retryAfterSec: 0 };
  }

  /**
   * Forget buckets that have refilled, now and then rather than on every call.
   * A full bucket is the same as no bucket, so the map only ever holds the
   * people who were busy recently and cannot grow without bound.
   */
  #sweep(now) {
    if (this.#buckets.size < 256) return;
    const full = this.#burst / this.#perSecond;
    for (const [key, bucket] of this.#buckets) {
      if ((now - bucket.at) / 1000 >= full) this.#buckets.delete(key);
    }
  }
}
