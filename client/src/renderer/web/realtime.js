// The WebSocket client, for the builds that have no main process.
//
// A port of src/main/realtime.js -- read that file for why each part is the
// way it is (the hello frame, the watchdog, the orphan-socket guard, never
// retrying a rejected session). The only differences are a small emitter in
// place of Node's EventEmitter, and no .unref() on timers, which a page does
// not have.

const BACKOFF_MS = [500, 1000, 2000, 5000, 10_000, 15_000];
const WATCHDOG_MS = 35_000;
const HEARTBEAT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;

class Emitter {
  #handlers = new Map();

  on(name, fn) {
    if (!this.#handlers.has(name)) this.#handlers.set(name, new Set());
    this.#handlers.get(name).add(fn);
    return () => this.#handlers.get(name)?.delete(fn);
  }

  once(name, fn) {
    const off = this.on(name, (...args) => {
      off();
      fn(...args);
    });
    return off;
  }

  emit(name, ...args) {
    for (const fn of [...(this.#handlers.get(name) ?? [])]) fn(...args);
  }
}

export class RealtimeClient extends Emitter {
  #url = '';
  #token = '';
  #ws = null;
  #pending = new Map();
  #nextRid = 1;
  #attempt = 0;
  #reconnectTimer = null;
  #watchdog = null;
  #heartbeat = null;
  #rejected = false;
  #wanted = false;
  /** What the server said when the current connection said hello. */
  #hello = null;

  get connected() {
    return this.#ws?.readyState === 1; // OPEN
  }

  connect(serverUrl, token) {
    const url = toWebSocketUrl(serverUrl);
    const wanted = String(token ?? '');
    // Asked again for what is already being kept: not a second socket, the same
    // connection's answer (see main/realtime.js).
    if (this.#wanted && !this.#rejected && url === this.#url && wanted === this.#token) {
      if (this.#hello && this.connected) return Promise.resolve(this.#hello);
      return new Promise((resolve, reject) => {
        this.once('hello', resolve);
        this.once('give-up', reject);
      });
    }
    this.#url = url;
    this.#token = wanted;
    this.#rejected = false;
    this.#wanted = true;
    this.#attempt = 0;

    return new Promise((resolve, reject) => {
      const offHello = this.once('hello', (reply) => {
        offGiveUp();
        resolve(reply);
      });
      const offGiveUp = this.once('give-up', (err) => {
        offHello();
        reject(err);
      });
      this.#open();
    });
  }

  disconnect() {
    this.#wanted = false;
    this.#hello = null;
    clearTimeout(this.#reconnectTimer);
    clearTimeout(this.#watchdog);
    clearInterval(this.#heartbeat);
    this.#reconnectTimer = null;
    this.#heartbeat = null;
    this.#failPending(new Error('disconnected'));
    try { this.#ws?.close(1000, 'client closing'); } catch { /* already gone */ }
    this.#ws = null;
  }

  #open() {
    if (!this.#wanted || this.#rejected) return;
    let ws;
    try {
      ws = new WebSocket(this.#url);
    } catch (err) {
      this.#scheduleReconnect(err);
      return;
    }
    this.#ws = ws;
    const current = () => this.#ws === ws;

    ws.addEventListener('open', () => {
      if (!current()) return;
      this.#armWatchdog();
      this.request('hello', { token: this.#token })
        .then((reply) => {
          if (!current()) return;
          if (reply.type !== 'hello-ok') throw new Error(reply.error ?? 'hello failed');
          this.#attempt = 0;
          this.#startHeartbeat();
          this.#hello = reply;
          this.emit('hello', reply);
          this.emit('event', { ...reply, type: 'realtime:up' });
        })
        .catch((err) => {
          if (!current() || this.#rejected) return;
          this.emit('event', { type: 'realtime:error', error: err.message });
        });
    });

    ws.addEventListener('message', (event) => {
      if (!current()) return;
      this.#armWatchdog();
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      const slot = msg.rid != null ? this.#pending.get(msg.rid) : null;
      if (slot) {
        this.#pending.delete(msg.rid);
        clearTimeout(slot.timer);
        slot.resolve(msg);
        return;
      }
      this.emit('event', msg);
    });

    ws.addEventListener('close', (event) => {
      if (!current()) return;
      this.#onClose(event);
    });
    ws.addEventListener('error', () => { /* 'close' always follows */ });
  }

  #onClose(event) {
    clearTimeout(this.#watchdog);
    clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    this.#failPending(new Error('socket closed'));
    this.#ws = null;
    if (event?.code === 4401) {
      this.#rejected = true;
      this.#wanted = false;
      this.emit('event', { type: 'realtime:rejected' });
      this.emit('give-up', new Error('the server rejected this session'));
      return;
    }
    this.emit('event', { type: 'realtime:down' });
    this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    if (!this.#wanted || this.#rejected || this.#reconnectTimer) return;
    const base = BACKOFF_MS[Math.min(this.#attempt, BACKOFF_MS.length - 1)];
    this.#attempt += 1;
    const delay = base + Math.floor(Math.random() * base * 0.5);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#open();
    }, delay);
  }

  /**
   * Try now rather than at the end of the backoff. Called when the page comes
   * back to the foreground or the network returns -- on a phone the usual
   * reasons a socket was lost -- so it does not sit out a 15-second wait.
   */
  nudge() {
    if (!this.#wanted || this.#rejected || this.#ws) return;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#attempt = 0;
    this.#open();
  }

  #startHeartbeat() {
    clearInterval(this.#heartbeat);
    this.#heartbeat = setInterval(() => {
      if (this.#ws?.readyState !== 1) return;
      this.request('ping').catch(() => { /* the watchdog decides */ });
    }, HEARTBEAT_MS);
  }

  #armWatchdog() {
    clearTimeout(this.#watchdog);
    this.#watchdog = setTimeout(() => {
      const dead = this.#ws;
      this.#ws = null;
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
      this.#failPending(new Error('socket stopped responding'));
      try { dead?.close(4000, 'watchdog'); } catch { /* already gone */ }
      this.emit('event', { type: 'realtime:down' });
      this.#scheduleReconnect();
    }, WATCHDOG_MS);
  }

  #failPending(err) {
    for (const slot of this.#pending.values()) {
      clearTimeout(slot.timer);
      slot.reject(err);
    }
    this.#pending.clear();
  }

  request(type, payload = {}) {
    if (this.#ws?.readyState !== 1) {
      return Promise.reject(new Error('Not connected to the server.'));
    }
    const rid = String(this.#nextRid++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(rid);
        reject(new Error(`The server did not answer "${type}" in time.`));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(rid, { resolve, reject, timer });
      try {
        this.#ws.send(JSON.stringify({ ...payload, type, rid }));
      } catch (err) {
        this.#pending.delete(rid);
        clearTimeout(timer);
        reject(err);
      }
    });
  }
}

/** http://host:8080 -> ws://host:8080/ws, https -> wss. */
export function toWebSocketUrl(serverUrl) {
  const trimmed = String(serverUrl ?? '').trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(withScheme);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  return url.toString();
}

/**
 * One connection per server, every frame tagged with the server it came from --
 * the same as main/realtime-hub.js.
 */
export class RealtimeHub extends Emitter {
  /** @type {Map<string, RealtimeClient>} */
  #clients = new Map();
  #keyOf;

  constructor(keyOf) {
    super();
    this.#keyOf = keyOf;
  }

  connect(server, token) {
    const key = this.#keyOf(server);
    let client = this.#clients.get(key);
    if (!client) {
      client = new RealtimeClient();
      client.on('event', (payload) => this.emit('event', { ...payload, server: key }));
      this.#clients.set(key, client);
    }
    return client.connect(server, token);
  }

  request(server, type, payload) {
    const client = this.#clients.get(this.#keyOf(server));
    if (!client) return Promise.reject(new Error('Not connected to the server.'));
    return client.request(type, payload);
  }

  /** One server's connection, or every one when no server is named. */
  disconnect(server) {
    const keys = server === undefined || server === null ? [...this.#clients.keys()] : [this.#keyOf(server)];
    for (const key of keys) {
      this.#clients.get(key)?.disconnect();
      this.#clients.delete(key);
    }
  }

  connected(server) {
    return this.#clients.get(this.#keyOf(server))?.connected ?? false;
  }

  /** Back on the network or the screen: every connection that gave up waiting tries now. */
  nudge() {
    for (const client of this.#clients.values()) client.nudge();
  }
}
