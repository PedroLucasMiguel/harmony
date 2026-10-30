// The WebSocket client, in the main process.
//
// It lives here for the same reason every other network call does: the
// renderer is served over a custom scheme with `default-src 'self'` and no
// `connect-src`, so it cannot open a socket at all. Main owns the connection
// and forwards frames over IPC.
//
// Node's global WebSocket (Node 22+, and Electron 44 bundles Node 24) means
// this needs no dependency. It is browser-shaped, which has one consequence
// worth stating because it drives the protocol: it cannot set request headers,
// so the session token cannot travel in an Authorization header. It goes in a
// `hello` frame instead and the server accepts nothing else until it arrives.

const { EventEmitter } = require('node:events');

/** Backoff schedule. The last value repeats. */
const BACKOFF_MS = [500, 1000, 2000, 5000, 10_000, 15_000];

/**
 * A socket that has produced no traffic at all in this long is presumed dead.
 *
 * The classic LAN failure is not an error event -- it is a socket that stays
 * open forever and simply stops delivering, after a laptop sleeps or a Wi-Fi
 * roam drops the NAT entry. Nothing fires, so without this the client sits
 * looking connected and silently misses every roster change.
 *
 * The first version of this counted on the server's 15-second protocol ping
 * to keep it fed, which it never could: a ping frame is answered by the
 * WebSocket implementation itself and does NOT raise a `message` event. A
 * quiet channel sends no application frames at all -- rosters and channel
 * lists are only pushed on change -- so a perfectly healthy connection was
 * torn down and rebuilt every 35 seconds, which is what put "Reconnecting..."
 * on screen over and over. Hence HEARTBEAT_MS below: the client asks, and the
 * answer is an ordinary message that re-arms this.
 */
const WATCHDOG_MS = 35_000;

/**
 * How often to ask the server whether it is still there.
 *
 * An application-level round trip rather than a protocol ping, deliberately:
 * it proves the whole path -- socket, server event loop, and our own message
 * handling -- rather than just the TCP connection. That is the failure the
 * watchdog exists for.
 */
const HEARTBEAT_MS = 15_000;

const REQUEST_TIMEOUT_MS = 10_000;

class RealtimeClient extends EventEmitter {
  #url = '';
  #token = '';
  #ws = null;
  #pending = new Map();
  #nextRid = 1;
  #attempt = 0;
  #reconnectTimer = null;
  #watchdog = null;
  #heartbeat = null;
  /** Set when the server rejected our credentials; stops all retrying. */
  #rejected = false;
  #wanted = false;
  /** What the server said when the current connection said hello. */
  #hello = null;

  get connected() {
    return this.#ws?.readyState === 1; // OPEN
  }

  /**
   * Connect, and keep connecting. Resolves on the first successful hello.
   */
  connect(serverUrl, token) {
    const url = toWebSocketUrl(serverUrl);
    const wanted = String(token ?? '');
    // Asked again for what is already being kept: not a second socket (the first
    // would be left open with nobody holding it), the same connection's answer.
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
      this.once('hello', resolve);
      this.once('give-up', reject);
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
      return this.#scheduleReconnect(err);
    }
    this.#ws = ws;

    /*
     * Every handler below checks that THIS socket is still the current one.
     *
     * Without it, a socket we have already given up on can finish closing
     * after its replacement is connected, and its close handler then nulls
     * `this.#ws` -- the new socket -- fails its pending hello, and emits
     * `realtime:down`. The connection is live and the UI says "Reconnecting"
     * forever, with the roster and channel list still updating underneath
     * because the orphan's listeners are also still attached. That is not a
     * rare race: the watchdog case is precisely a socket whose close takes a
     * long time, because it is the one that has stopped responding.
     */
    const current = () => this.#ws === ws;

    ws.addEventListener('open', () => {
      if (!current()) return;
      this.#armWatchdog();
      // Authenticate before announcing anything: a socket that is open but has
      // not said hello cannot do anything, so it is not yet "connected" as far
      // as the rest of the app is concerned.
      this.request('hello', { token: this.#token })
        .then((reply) => {
          if (!current()) return;
          if (reply.type !== 'hello-ok') throw new Error(reply.error ?? 'hello failed');
          this.#attempt = 0;
          this.#startHeartbeat();
          this.#hello = reply;
          this.emit('hello', reply);
          /*
           * The spread goes FIRST. `reply` carries its own `type` --
           * 'hello-ok' -- so spreading it last overwrote the one that
           * matters, and the renderer's `case 'realtime:up'` never ran once.
           *
           * That case is what clears "Reconnecting...", reloads the channel
           * list, and rejoins the voice channel after a drop. Without it a
           * client that lost its socket came back fully connected, sat
           * showing "Reconnecting..." for ever, and was no longer in any
           * voice channel as far as the server was concerned -- because
           * presence IS the socket, and nothing told it to rejoin.
           */
          this.emit('event', { ...reply, type: 'realtime:up' });
        })
        .catch((err) => {
          // A hello that fails on credentials closes the socket server-side
          // with 4401, which #onClose turns into a permanent give-up.
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
      // An orphan finishing its close says nothing about the live socket.
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

    // 4401 is the server saying the token is no good. Retrying that is not
    // just useless, it is harmful: every attempt is another failed credential
    // against the login limiter, so a backgrounded client could lock its own
    // account out while nobody is watching.
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
    // Jitter, so a server restart does not bring every client back in the same
    // millisecond and knock it over again.
    const delay = base + Math.floor(Math.random() * base * 0.5);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#open();
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  /**
   * Keep the connection proved, and the watchdog fed.
   *
   * The reply is an ordinary message, so the message handler re-arms the
   * watchdog for free; nothing here has to know about it. A failure is
   * ignored on purpose -- the request's own timeout and the watchdog are
   * what decide a socket is dead, and doing it in two places would mean two
   * opinions about when.
   */
  #startHeartbeat() {
    clearInterval(this.#heartbeat);
    this.#heartbeat = setInterval(() => {
      if (this.#ws?.readyState !== 1) return;
      this.request('ping').catch(() => { /* the watchdog decides */ });
    }, HEARTBEAT_MS);
    this.#heartbeat.unref?.();
  }

  #armWatchdog() {
    clearTimeout(this.#watchdog);
    this.#watchdog = setTimeout(() => {
      const dead = this.#ws;
      // Dropped BEFORE closing, so the close event that follows is recognised
      // as an orphan's and cannot tear down whatever replaces it.
      this.#ws = null;
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
      this.#failPending(new Error('socket stopped responding'));
      try { dead?.close(4000, 'watchdog'); } catch { /* already gone */ }
      this.emit('event', { type: 'realtime:down' });
      this.#scheduleReconnect();
    }, WATCHDOG_MS);
    this.#watchdog.unref?.();
  }

  #failPending(err) {
    for (const slot of this.#pending.values()) {
      clearTimeout(slot.timer);
      slot.reject(err);
    }
    this.#pending.clear();
  }

  /**
   * One envelope for everything.
   *
   * Every channel operation goes through this rather than its own IPC channel
   * and HTTP route: one correlation scheme, one timeout, one error path.
   */
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
      timer.unref?.();
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
function toWebSocketUrl(serverUrl) {
  const trimmed = String(serverUrl ?? '').trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(withScheme);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = '';
  return url.toString();
}

module.exports = { RealtimeClient, toWebSocketUrl };
