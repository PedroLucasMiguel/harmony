// Polls MediaMTX's control API so the rest of the server always knows who is
// actually on air.
//
// Deriving liveness from MediaMTX rather than tracking it ourselves means the
// reservation table can never drift out of sync with reality: if a broadcaster's
// laptop sleeps, their connection drops, MediaMTX forgets the path, and the
// username frees itself on the next poll. There is no state to leak.

import { EventEmitter } from 'node:events';

export class MediaMtxMonitor extends EventEmitter {
  #apiUrl;
  #intervalMs;
  #timer = null;
  #paths = new Map();
  #reachable = false;
  #warned = false;

  constructor({ apiUrl, intervalMs = 1000 }) {
    super();
    this.#apiUrl = apiUrl;
    this.#intervalMs = intervalMs;
  }

  get paths() {
    return this.#paths;
  }

  get reachable() {
    return this.#reachable;
  }

  start() {
    if (this.#timer) return;
    const tick = () => {
      this.#poll().finally(() => {
        this.#timer = setTimeout(tick, this.#intervalMs);
        this.#timer.unref?.();
      });
    };
    tick();
  }

  stop() {
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  async #poll() {
    try {
      // itemsPerPage is generous: one entry per concurrent stream.
      const res = await fetch(`${this.#apiUrl}/v3/paths/list?itemsPerPage=1000`, {
        signal: AbortSignal.timeout(Math.max(2000, this.#intervalMs * 2)),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();

      const next = new Map();
      for (const item of body.items ?? []) {
        next.set(item.name, {
          name: item.name,
          ready: Boolean(item.ready),
          readyTime: item.readyTime ?? null,
          tracks: item.tracks ?? [],
          viewers: Array.isArray(item.readers) ? item.readers.length : 0,
          bytesReceived: item.bytesReceived ?? 0,
          bytesSent: item.bytesSent ?? 0,
        });
      }

      this.#paths = next;
      if (!this.#reachable) {
        this.#reachable = true;
        this.#warned = false;
        this.emit('up');
      }
      this.emit('paths', next);
    } catch (err) {
      this.#paths = new Map();
      if (this.#reachable || !this.#warned) {
        this.#reachable = false;
        this.#warned = true;
        this.emit('down', err);
      }
    }
  }
}
