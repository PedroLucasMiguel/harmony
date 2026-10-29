// The push side: one WebSocket per client, mounted on the existing HTTP server.
//
// Harmony polled for everything until this existed. Polling is fine for "who is
// live" at 3-second granularity; it is not fine for "who just spoke", "you have
// been moved" or "somebody muted you" -- the last of which has a hard
// requirement behind it. The Phase 0 spike measured that a force-muted client's
// RTCPeerConnection stays `connected` for about nine seconds after its session
// is killed, so a roster push is the ONLY thing that can tell that person their
// microphone stopped working. Connection state will not, in time to matter.
//
// Every message is {type, ...}. Requests carry an `rid` and get exactly one
// reply with the same `rid`; everything else is a server-initiated event.

import { WebSocketServer } from 'ws';

import { publicChannel, publicGroup, VOICE_HARD_CAP } from './channels.js';
import { publicUser } from './accounts.js';
import { publicBadge } from './badges.js';
import { channelViewFor, publicRole } from './roles.js';

/** A socket that has not answered a ping in this long is assumed dead. */
const HEARTBEAT_MS = 15_000;

export class Realtime {
  #wss;
  #deps;
  /** @type {Map<import('ws').WebSocket, {user: object, alive: boolean}>} */
  #clients = new Map();
  #timer = null;

  /**
   * @param {object} deps
   * @param {import('node:http').Server} deps.server
   * @param {import('./accounts.js').Accounts} deps.accounts
   * @param {import('./channels.js').Channels} deps.channels
   * @param {import('./channels.js').VoiceRooms} deps.voice
   * @param {import('./roles.js').Roles} deps.roles
   * @param {import('./badges.js').Badges} deps.badges
   * @param {(channelId: number, userId: number, mid: number) => object} deps.issueTokens
   * @param {(channelId: number, mid: number) => Promise<void>} deps.kickMember
   */
  constructor(deps) {
    this.#deps = deps;

    // noServer: Express owns the HTTP server, and we only want to take over
    // sockets asking for /ws. Letting ws attach to the server directly would
    // have it answer upgrades on every path.
    this.#wss = new WebSocketServer({ noServer: true });

    deps.server.on('upgrade', (req, socket, head) => {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname !== '/ws') {
        socket.destroy();
        return;
      }
      this.#wss.handleUpgrade(req, socket, head, (ws) => this.#onConnection(ws));
    });

    this.#timer = setInterval(() => this.#sweep(), HEARTBEAT_MS);
    this.#timer.unref();
  }

  // -------------------------------------------------------------------------

  #onConnection(ws) {
    // Unauthenticated until the first frame. Node's global WebSocket client --
    // which is what the Electron main process uses -- is browser-shaped and
    // cannot set request headers, so the token cannot travel in an
    // Authorization header. It arrives in a `hello` frame instead, and nothing
    // else is accepted until it does.
    this.#clients.set(ws, { user: null, alive: true });

    ws.on('pong', () => {
      const client = this.#clients.get(ws);
      if (client) client.alive = true;
    });

    ws.on('message', (data) => {
      /*
       * Any frame at all proves this client is alive.
       *
       * The sweep below relies on pong frames, which assumes the client's
       * WebSocket answers protocol pings. Every browser-shaped one does, but
       * leaning on it is an unnecessary bet: a client that talks to us is
       * plainly not dead, whatever its ping handling looks like. Without
       * this a quiet-but-chatty client could be terminated on a technicality.
       */
      const alive = this.#clients.get(ws);
      if (alive) alive.alive = true;

      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return this.#send(ws, { type: 'error', error: 'bad_json' });
      }
      this.#onMessage(ws, msg).catch((err) => {
        console.warn(`[ws] handler failed: ${err.message}`);
        this.#send(ws, { type: 'error', rid: msg?.rid, error: 'server_error' });
      });
    });

    ws.on('close', () => this.#onClose(ws));
    ws.on('error', () => this.#onClose(ws));

    // A client that never says hello is a port scanner or a bug, either way not
    // worth a socket.
    setTimeout(() => {
      if (this.#clients.get(ws)?.user == null) ws.close(4401, 'no hello');
    }, 10_000).unref();
  }

  #onClose(ws) {
    const client = this.#clients.get(ws);
    this.#clients.delete(ws);
    if (!client?.user) return;

    // Presence is derived from this socket existing, so closing it IS leaving.
    // Nothing has to be reconciled, and a server restart rebuilds the whole
    // picture from whoever reconnects.
    const stillOnline = this.#isOnline(client.user.id);
    if (stillOnline) return;

    for (const { channelId } of this.#deps.voice.leaveAll(client.user.id)) {
      this.#broadcastRoster(channelId);
    }
    // After leaveAll, so a client redrawing on this gets a roster that has
    // already lost them rather than one that still has them in a channel.
    this.broadcastPresence();
  }

  /**
   * Who has a socket open, by user id.
   *
   * Derived, never stored -- the same rule as voice presence, and for the
   * same reason: a restart rebuilds the whole picture from whoever
   * reconnects instead of leaving a stale table to be reconciled with
   * reality, which is the bug every "who is online" table eventually has.
   *
   * A Set, so two windows count once.
   */
  onlineUserIds() {
    const out = new Set();
    for (const client of this.#clients.values()) {
      if (client.user) out.add(client.user.id);
    }
    return [...out];
  }

  /** Tell everybody who is on. Sent whenever that set changes. */
  broadcastPresence() {
    this.broadcast({ type: 'presence', online: this.onlineUserIds() });
  }

  /** True if this user has another socket open (a second window, say). */
  #isOnline(userId) {
    for (const client of this.#clients.values()) {
      if (client.user?.id === userId) return true;
    }
    return false;
  }

  #sweep() {
    for (const [ws, client] of this.#clients) {
      if (!client.alive) {
        ws.terminate();
        continue;
      }
      client.alive = false;
      try { ws.ping(); } catch { /* closing */ }
    }
  }

  // -------------------------------------------------------------------------

  async #onMessage(ws, msg) {
    const client = this.#clients.get(ws);
    if (!client) return;

    /*
     * An application-level liveness check, answered before the hello gate.
     *
     * The client cannot feed its own watchdog from protocol pings -- those
     * are answered by the WebSocket implementation and never surface as a
     * message -- and a quiet server sends nothing for minutes at a time,
     * because rosters and channel lists are only pushed on change. So the
     * client asks, and this is the answer. It is deliberately the cheapest
     * handler here and deliberately needs no session: proving the socket
     * works is not privileged.
     */
    if (msg.type === 'ping') {
      return this.#send(ws, { type: 'pong', rid: msg.rid });
    }

    if (msg.type === 'hello') {
      const user = this.#deps.accounts.resolveSession(msg.token);
      if (!user) {
        // Close rather than reply-and-wait: the client must NOT retry a
        // credential rejection, and a close code says so unambiguously.
        this.#send(ws, { type: 'hello-failed', rid: msg.rid, error: 'bad_token' });
        return ws.close(4401, 'bad token');
      }
      client.user = user;
      // Before the reply, so the arriving client's own hello already
      // contains them -- otherwise the one person guaranteed to be online
      // is missing from the list until somebody else connects.
      this.broadcastPresence();
      return this.#send(ws, {
        type: 'hello-ok',
        rid: msg.rid,
        user: publicUser(user),
        ...this.channelView(user),
        voiceCap: VOICE_HARD_CAP,
        online: this.onlineUserIds(),
        roles: this.#deps.roles.list().map(publicRole),
        badges: this.#deps.badges.list().map(publicBadge),
      });
    }

    if (!client.user) return this.#send(ws, { type: 'error', rid: msg.rid, error: 'no_hello' });

    const handler = this.#handlers[msg.type];
    if (!handler) return this.#send(ws, { type: 'error', rid: msg.rid, error: 'unknown_type' });

    // Read again for every request: a socket authenticates once, and what the
    // person behind it may do can change -- or end -- at any time after.
    const user = this.#deps.accounts.byId(client.user.id);
    if (!user || user.banned_at) return ws.close(4403, 'not allowed');
    client.user = user;

    const reply = await handler.call(this, user, msg, ws);
    if (reply) this.#send(ws, { ...reply, rid: msg.rid });
    return undefined;
  }

  get #handlers() {
    return {
      'voice:join': this.#voiceJoin,
      'voice:leave': this.#voiceLeave,
      'voice:mute': this.#voiceMute,
      'voice:publishing': this.#voicePublishing,
      'voice:refresh': this.#voiceRefresh,
      'soundpad:play': this.#soundpadPlay,
      'admin:force-mute': this.#adminForceMute,
      'admin:move': this.#adminMove,
    };
  }

  // ------------------------------------------------------------- voice

  async #voiceJoin(user, msg) {
    const channelId = Number(msg.channelId);
    const channel = this.#deps.channels.get(channelId);
    if (!channel || channel.kind !== 'voice') return { type: 'voice:error', error: 'no_such_channel' };

    // A channel somebody may not see does not exist, as far as they can tell.
    if (!this.#canSeeChannel(user, channel)) return { type: 'voice:error', error: 'no_such_channel' };

    const verdict = await this.#deps.channels.admit(channelId, user.id, msg.password, {
      bypass: this.#deps.roles.context(user).admin,
    });
    if (verdict !== 'ok') return { type: 'voice:error', error: verdict };

    // Leaving the previous channel first keeps "one voice channel at a time"
    // true without the client having to sequence two requests.
    for (const { channelId: left } of this.#deps.voice.leaveAll(user.id)) {
      if (left !== channelId) this.#broadcastRoster(left);
    }

    const joined = this.#deps.voice.join(channelId, user);
    if (!joined.ok) {
      return { type: 'voice:error', error: joined.error, cap: VOICE_HARD_CAP };
    }

    this.#broadcastRoster(channelId);
    return {
      type: 'voice:joined',
      channelId,
      mid: joined.mid,
      ...this.#deps.issueTokens(channelId, user.id, joined.mid),
      roster: this.#deps.voice.roster(channelId),
    };
  }

  #voiceLeave(user, msg) {
    const channelId = Number(msg.channelId);
    const mid = this.#deps.voice.leave(channelId, user.id);
    if (mid === false) return { type: 'voice:error', error: 'not_in_channel' };
    this.#broadcastRoster(channelId);
    return { type: 'voice:left', channelId };
  }

  #voiceMute(user, msg) {
    const channelId = Number(msg.channelId);
    if (!this.#deps.voice.setMuted(channelId, user.id, msg.muted, msg.deafened)) {
      return { type: 'voice:error', error: 'not_in_channel' };
    }
    this.#broadcastRoster(channelId);
    return { type: 'voice:ok' };
  }

  /** The client telling us which of its paths are actually publishing. */
  #voicePublishing(user, msg) {
    const channelId = Number(msg.channelId);
    const found = this.#deps.voice.find(channelId, user.id);
    if (!found) return { type: 'voice:error', error: 'not_in_channel' };
    this.#deps.voice.trackPublish(channelId, found.mid, String(msg.kind), Boolean(msg.on));
    this.#broadcastRoster(channelId);
    return { type: 'voice:ok' };
  }

  /**
   * Re-issue media tokens before they expire.
   *
   * Tokens last 10 minutes and MediaMTX only consults the auth hook at session
   * SETUP, so an expired token never drops a live stream -- it only stops a new
   * subscription being opened. Which is exactly what happens when somebody new
   * joins the channel an hour in, hence this.
   */
  #voiceRefresh(user, msg) {
    const channelId = Number(msg.channelId);
    const found = this.#deps.voice.find(channelId, user.id);
    if (!found) return { type: 'voice:error', error: 'not_in_channel' };
    return {
      type: 'voice:tokens',
      channelId,
      ...this.#deps.issueTokens(channelId, user.id, found.mid),
    };
  }

  // --------------------------------------------------------- soundpad

  /**
   * Fan out "play this clip" to everyone in the clicker's voice channel.
   *
   * Everyone plays their own locally cached copy. The server never touches
   * audio -- see the comment on Soundpad in chat.js for why mixing it into the
   * clicker's uplink is the wrong design.
   */
  #soundpadPlay(user, msg) {
    const channelId = Number(msg.channelId);
    const found = this.#deps.voice.find(channelId, user.id);
    if (!found) return { type: 'voice:error', error: 'not_in_channel' };

    const clip = this.#deps.soundpad?.get(Number(msg.clipId));
    if (!clip) return { type: 'voice:error', error: 'no_such_clip' };

    for (const member of this.#deps.voice.roster(channelId)) {
      this.toUser(member.userId, {
        type: 'soundpad:play',
        channelId,
        clipId: clip.id,
        hash: clip.file_hash,
        name: clip.name,
        by: user.nickname,
      });
    }
    return { type: 'voice:ok' };
  }

  // ------------------------------------------------------------- admin

  /**
   * May this person do something TO that person? The permission, and a higher
   * rank: two moderators of the same rank cannot mute each other.
   */
  #mayModerate(user, targetId, permission) {
    const actor = this.#deps.roles.context(user);
    if (!actor.can(permission)) return false;
    const target = this.#deps.accounts.byId(targetId);
    if (!target) return true;
    return this.#deps.roles.outranks(actor, this.#deps.roles.context(target));
  }

  async #adminForceMute(user, msg) {
    const channelId = Number(msg.channelId);
    const mid = Number(msg.mid);
    // The permission first: whether a slot exists is not for the unauthorised to learn.
    if (!this.#deps.roles.context(user).can('users.mute')) {
      return { type: 'voice:error', error: 'forbidden' };
    }
    const slot = this.#deps.voice.slot(channelId, mid);
    if (!slot) return { type: 'voice:error', error: 'no_such_member' };
    if (!this.#mayModerate(user, slot.userId, 'users.mute')) {
      return { type: 'voice:error', error: 'forbidden' };
    }
    if (!this.#deps.voice.setForceMuted(channelId, mid, msg.muted)) {
      return { type: 'voice:error', error: 'no_such_member' };
    }

    // Order matters. Send the roster BEFORE the kick: the kicked client will
    // not notice the dropped session for about nine seconds (measured), so this
    // event is the only thing that tells them -- and if it arrived after the
    // kick they would read the whole thing as a network error instead.
    this.#broadcastRoster(channelId);

    if (msg.muted) await this.#deps.kickMember(channelId, mid);
    return { type: 'voice:ok' };
  }

  /** Move somebody out of a voice channel, or into one. */
  async #adminMove(user, msg) {
    const targetId = Number(msg.userId);
    const toId = msg.toChannelId == null ? null : Number(msg.toChannelId);
    if (!this.#mayModerate(user, targetId, 'users.kick')) {
      return { type: 'voice:error', error: 'forbidden' };
    }

    if (toId != null) {
      const channel = this.#deps.channels.get(toId);
      const target = this.#deps.accounts.byId(targetId);
      // Where they are being sent has to be somewhere they may go.
      if (!channel || channel.kind !== 'voice' || !target || !this.#canSeeChannel(target, channel)) {
        return { type: 'voice:error', error: 'no_such_channel' };
      }
    }

    const left = this.#deps.voice.leaveAll(targetId);
    for (const { channelId } of left) this.#broadcastRoster(channelId);

    // The target does the actual join, because only their client can open the
    // peer connections. Telling them where to go keeps every WHIP/WHEP session
    // owned by the machine that has the microphone.
    this.toUser(targetId, { type: 'voice:moved', channelId: toId, by: user.nickname });
    return { type: 'voice:ok' };
  }

  // ------------------------------------------------------------- sending

  #send(ws, payload) {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(JSON.stringify(payload)); } catch { /* closing */ }
  }

  /** Send to every socket a user has open. */
  toUser(userId, payload) {
    for (const [ws, client] of this.#clients) {
      if (client.user?.id === userId) this.#send(ws, payload);
    }
  }

  /**
   * Hang up on somebody, everywhere they are connected.
   *
   * A socket authenticates once, at hello, and is trusted for its lifetime
   * -- which is the right design for a push channel and exactly wrong for
   * an account that has just been deleted. Their sessions are gone, so the
   * next HTTP request fails, but the socket would go on receiving every
   * message on the server until they closed the app.
   */
  kickUser(userId, reason = 'account removed') {
    for (const [ws, client] of this.#clients) {
      if (client.user?.id !== userId) continue;
      this.#send(ws, { type: 'kicked', reason });
      try { ws.close(4403, reason); } catch { /* already going */ }
    }
  }

  /** Send to everyone authenticated. */
  broadcast(payload) {
    for (const [ws, client] of this.#clients) {
      if (client.user) this.#send(ws, payload);
    }
  }

  /**
   * Send to everyone authenticated who passes a test.
   *
   * The test is supplied by the caller rather than evaluated here, because
   * the only thing worth narrowing on so far is whether somebody may read a
   * channel, and that question belongs with the routes that already ask it.
   */
  broadcastWhere(payload, allow) {
    for (const [ws, client] of this.#clients) {
      if (client.user && allow(client.user)) this.#send(ws, payload);
    }
  }

  /** The user rows of everybody connected, for deciding who a push is for. */
  get connectedUsers() {
    return [...this.#clients.values()].map((c) => c.user).filter(Boolean);
  }

  #canSeeChannel(user, channel) {
    const groups = new Map(this.#deps.channels.groups().map((g) => [g.id, g]));
    return this.#deps.roles.canSee(this.#deps.roles.context(user), channel, groups);
  }

  /**
   * The roster goes to the people who can see the channel, and nobody else:
   * who is talking in a room is as much a part of its existence as its name.
   */
  #broadcastRoster(channelId) {
    const channel = this.#deps.channels.get(channelId);
    const payload = {
      type: 'voice:roster',
      channelId,
      roster: this.#deps.voice.roster(channelId),
    };
    if (!channel) return this.broadcast(payload);
    const groups = new Map(this.#deps.channels.groups().map((g) => [g.id, g]));
    return this.broadcastWhere(payload, (user) => this.#deps.roles.canSee(
      this.#deps.roles.context(this.#deps.accounts.byId(user.id) ?? user), channel, groups,
    ));
  }

  /**
   * What one person is shown of the channels: only the ones they may know
   * about, with who is in each. The same shape the `channels` push and the
   * hello carry, so a client draws all three the same way.
   */
  channelView(user) {
    return channelViewFor(this.#deps, user);
  }

  /** The channel list changed: everyone needs the new one -- the part of it they may see. */
  broadcastChannels() {
    for (const [ws, client] of this.#clients) {
      if (!client.user) continue;
      const user = this.#deps.accounts.byId(client.user.id);
      if (!user) continue;
      client.user = user;
      const { channels, groups } = this.channelView(user);
      this.#send(ws, { type: 'channels', channels, groups });
    }
  }

  /**
   * Somebody's roles changed, or a channel's did: everything that was decided
   * from them has to be decided again.
   *
   * Every connected person is sent the list they may now see, and anybody
   * sitting in a voice channel they may no longer see is taken out of it --
   * a hidden room with somebody still in it is the one way a restriction
   * would quietly not apply.
   */
  refreshAccess() {
    this.broadcastChannels();
    for (const client of new Set(this.#clients.values())) {
      if (!client.user) continue;
      const { ids } = this.#deps.roles.visibleTo(
        this.#deps.roles.context(client.user), this.#deps.channels,
      );
      for (const roomId of Object.keys(this.#deps.voice.occupancy()).map(Number)) {
        if (ids.has(roomId) || !this.#deps.voice.find(roomId, client.user.id)) continue;
        this.#deps.voice.leave(roomId, client.user.id);
        this.#broadcastRoster(roomId);
        this.toUser(client.user.id, { type: 'voice:moved', channelId: null, by: null });
      }
    }
  }

  /** Who is live on the flat username namespace, replacing the 3s poll. */
  broadcastStreams(streams) {
    this.broadcast({ type: 'streams', streams });
  }

  get clientCount() {
    return this.#clients.size;
  }

  close() {
    clearInterval(this.#timer);
    for (const ws of this.#clients.keys()) {
      try { ws.close(1001, 'server shutting down'); } catch { /* already gone */ }
    }
    this.#clients.clear();
    this.#wss.close();
  }
}
