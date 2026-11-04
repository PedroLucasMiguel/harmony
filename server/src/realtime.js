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
import { Throttle } from './throttle.js';
import { publicBadge } from './badges.js';
import { channelViewFor, publicRole } from './roles.js';
import { publicDmMessage } from './dms.js';
import { isCallRoom, roomOf } from './calls.js';

/** A socket that has not answered a ping in this long is assumed dead. */
const HEARTBEAT_MS = 15_000;

export class Realtime {
  #wss;
  #deps;
  /** @type {Map<import('ws').WebSocket, {user: object, alive: boolean, away: boolean}>} */
  #clients = new Map();
  #timer = null;
  /** Music Buddy's controls, per person: pressing them is cheap to do and not cheap to serve (a track is fetched). */
  #musicThrottle = new Throttle({ burst: 60, perSecond: 5 });
  /** "Is typing": a person's keystrokes, a few a second at most, and the client sends one every few seconds. */
  #typingThrottle = new Throttle({ burst: 8, perSecond: 1 });
  /** Ringing somebody: a person pressing it again and again is not calling, they are ringing a bell. */
  #callThrottle = new Throttle({ burst: 10, perSecond: 0.5 });

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
    this.#clients.set(ws, { user: null, alive: true, away: false });

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
    const before = client?.user ? this.#statusOf(client.user.id) : null;
    this.#clients.delete(ws);
    if (!client?.user) return;

    // Presence is derived from this socket existing, so closing it IS leaving.
    // Nothing has to be reconciled, and a server restart rebuilds the whole
    // picture from whoever reconnects.
    const stillOnline = this.#isOnline(client.user.id);
    if (stillOnline) {
      // The window that closed may have been the only one in use: the person is idle now.
      if (this.#statusOf(client.user.id) !== before) this.broadcastPresence();
      return;
    }

    for (const { channelId } of this.#deps.voice.leaveAll(client.user.id)) {
      this.#broadcastRoster(channelId);
    }
    this.#deps.calls?.leaveAll(client.user.id);
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
    return this.presenceView().online;
  }

  /**
   * What somebody is, to everybody else: null when they have no socket open, else one of PRESENCE_STATUSES.
   *
   * What they chose, except that a person who chose "online" and whose every window says it has not been touched
   * (`presence:away`) is idle. Like the rest of presence it is derived, not stored.
   */
  #statusOf(userId) {
    let open = false;
    let active = false;
    for (const client of this.#clients.values()) {
      if (client.user?.id !== userId) continue;
      open = true;
      if (!client.away) active = true;
    }
    if (!open) return null;
    const chosen = this.#deps.accounts.byId(userId)?.presence_status ?? 'online';
    if (chosen === 'online') return active ? 'online' : 'idle';
    return chosen;
  }

  /**
   * Who is on, and who of them is not plain "online": `online` lists everybody but the invisible (who are, as far as
   * anybody else can tell, offline), `statuses` says idle or dnd for those that are.
   *
   * @returns {{online: number[], statuses: Object<number, 'idle'|'dnd'>}}
   */
  presenceView() {
    const ids = new Set();
    for (const client of this.#clients.values()) if (client.user) ids.add(client.user.id);
    const online = [];
    const statuses = {};
    for (const id of ids) {
      const status = this.#statusOf(id);
      if (status === 'invisible') continue;
      online.push(id);
      if (status === 'idle' || status === 'dnd') statuses[id] = status;
    }
    return { online, statuses };
  }

  /** Tell everybody who is on. Sent whenever that set changes. */
  broadcastPresence() {
    this.broadcast({ type: 'presence', ...this.presenceView() });
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
        ...this.presenceView(),
        // What this person chose to be, which is theirs alone to know (an invisible person is missing from `online`).
        status: user.presence_status ?? 'online',
        roles: this.#deps.roles.list().map(publicRole),
        badges: this.#deps.badges.list().map(publicBadge),
        // What is new in each channel, so a client that was away starts from the truth.
        unread: this.#deps.unreadFor?.(user) ?? [],
        // The calls going on in the conversations they are in, so a call somebody is being rung for is not missed
        // for having been away when it began.
        calls: this.#deps.calls?.activeFor(user.id) ?? [],
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
      typing: this.#typing,
      'presence:set': this.#presenceSet,
      'presence:away': this.#presenceAway,
      'call:start': this.#callStart,
      'call:join': this.#callJoin,
      'call:decline': this.#callDecline,
      'soundpad:play': this.#soundpadPlay,
      'soundpad:stop': this.#soundpadStop,
      'music:add': this.#musicAdd,
      'music:control': this.#musicControl,
      'music:sync': this.#musicSync,
      'music:clock': this.#musicClock,
      'admin:force-mute': this.#adminForceMute,
      'admin:move': this.#adminMove,
    };
  }

  // ---------------------------------------------------------- presence

  /** A person chooses what to be on this server: every window of theirs is told, and everybody else's list follows. */
  #presenceSet(user, msg) {
    const result = this.#deps.accounts.setPresenceStatus(user.id, msg.status);
    if (!result.ok) return { type: 'presence:error', error: result.error };
    this.toUser(user.id, { type: 'presence:self', status: result.user.presence_status });
    this.broadcastPresence();
    return { type: 'presence:ok', status: result.user.presence_status };
  }

  /**
   * One window saying it has not been touched for a while (or has been, again). Several windows count as one person:
   * they are idle when all of them are. Only a change of what everybody sees is worth a broadcast.
   */
  #presenceAway(user, msg, ws) {
    const client = this.#clients.get(ws);
    if (!client) return undefined;
    const before = this.#statusOf(user.id);
    client.away = msg.away === true;
    if (this.#statusOf(user.id) !== before) this.broadcastPresence();
    return { type: 'presence:ok' };
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
    // true without the client having to sequence two requests. A call is one too.
    for (const { channelId: left } of this.#deps.voice.leaveAll(user.id)) {
      if (left !== channelId) this.#broadcastRoster(left);
    }
    this.#deps.calls?.leaveAll(user.id);

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
      // Where the music is, so somebody who joins in the middle of a song is in the middle of it too.
      music: this.#deps.music?.snapshot(channelId) ?? null,
    };
  }

  /**
   * The rooms a room id lives in. A private call's is not a channel's, and is kept apart so that nothing that lists
   * channels ever meets it -- but muting, publishing and leaving it are the same requests, with its id.
   */
  #roomsFor(roomId) {
    return isCallRoom(roomId) ? this.#deps.calls?.rooms : this.#deps.voice;
  }

  #voiceLeave(user, msg) {
    const channelId = Number(msg.channelId);
    const mid = isCallRoom(channelId)
      ? this.#deps.calls?.leave(channelId, user.id)
      : this.#deps.voice.leave(channelId, user.id);
    if (mid === false || mid === undefined) return { type: 'voice:error', error: 'not_in_channel' };
    this.#broadcastRoster(channelId);
    return { type: 'voice:left', channelId };
  }

  #voiceMute(user, msg) {
    const channelId = Number(msg.channelId);
    if (!this.#roomsFor(channelId)?.setMuted(channelId, user.id, msg.muted, msg.deafened)) {
      return { type: 'voice:error', error: 'not_in_channel' };
    }
    this.#broadcastRoster(channelId);
    return { type: 'voice:ok' };
  }

  /** The client telling us which of its paths are actually publishing. */
  #voicePublishing(user, msg) {
    const channelId = Number(msg.channelId);
    const rooms = this.#roomsFor(channelId);
    const found = rooms?.find(channelId, user.id);
    if (!found) return { type: 'voice:error', error: 'not_in_channel' };
    rooms.trackPublish(channelId, found.mid, String(msg.kind), Boolean(msg.on));
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
    const found = this.#roomsFor(channelId)?.find(channelId, user.id);
    if (!found) return { type: 'voice:error', error: 'not_in_channel' };
    return {
      type: 'voice:tokens',
      channelId,
      ...this.#deps.issueTokens(channelId, user.id, found.mid),
    };
  }

  // ------------------------------------------------------------ typing

  /**
   * Somebody is writing in a text channel or a private conversation: told, for a few seconds, to those who can see
   * it. Nothing is kept and nothing is said about what is typed; a person who stops simply stops being told.
   * Refused quietly: a typing notice is never worth an error.
   */
  #typing(user, msg) {
    const ok = { type: 'typing:ok' };
    if (!this.#typingThrottle.take(user.id).allowed) return ok;
    const id = Number(msg.id);
    // "Stopped": they paused, or emptied the box. Told too, so that nobody is shown typing who is not.
    const stopped = msg.stopped === true;
    if (msg.scope === 'channel') {
      const channel = this.#deps.channels.get(id);
      if (!channel || (channel.kind !== 'text' && channel.kind !== 'forum') || !this.#canSeeChannel(user, channel)) return ok;
      const groups = new Map(this.#deps.channels.groups().map((g) => [g.id, g]));
      // In a forum, the post it is being written under: somebody reading another post is not told.
      const thread = channel.kind === 'forum' && Number.isSafeInteger(Number(msg.thread)) ? Number(msg.thread) : null;
      this.broadcastWhere({
        type: 'typing', scope: 'channel', id, userId: user.id, stopped, ...(thread ? { thread } : {}),
      }, (other) => other.id !== user.id && this.#deps.roles.canSee(
        this.#deps.roles.context(this.#deps.accounts.byId(other.id) ?? other), channel, groups,
      ));
    } else if (msg.scope === 'dm') {
      const dms = this.#deps.dms;
      const conversation = dms?.forUser(user.id, id);
      if (!conversation) return ok;
      const members = dms.members(conversation);
      // Nothing passes between two who have blocked one another, and that includes this.
      if (conversation.kind !== 'group' && dms.isBlocked(members[0], members[1])) return ok;
      for (const other of members) {
        if (other !== user.id) this.toUser(other, { type: 'typing', scope: 'dm', id, userId: user.id, stopped });
      }
    }
    return ok;
  }

  // ------------------------------------------------------------- calls

  /**
   * Everything a call request has to clear: the conversation is theirs, and they are not ringing it like a bell.
   * @returns {{conversation: object}|{error: object}}
   */
  #callGate(user, msg, { throttled = false } = {}) {
    const conversation = this.#deps.dms?.forUser(user.id, Number(msg.conversationId));
    if (!conversation || !this.#deps.calls) return { error: { type: 'call:error', error: 'no_such_conversation' } };
    if (throttled && !this.#callThrottle.take(user.id).allowed) return { error: { type: 'call:error', error: 'slow_down' } };
    return { conversation };
  }

  /** Put somebody in a call: out of every other room they are in, then in this, and the answer a client needs. */
  #enterCall(user, conversation, joined) {
    if (!joined.ok) return { type: 'call:error', error: joined.error, cap: VOICE_HARD_CAP };
    return {
      type: 'call:joined',
      conversationId: conversation.id,
      channelId: joined.roomId,
      mid: joined.mid,
      ...this.#deps.issueTokens(joined.roomId, user.id, joined.mid),
      roster: this.#deps.calls.rooms.roster(joined.roomId),
      call: this.#deps.calls.state(conversation.id),
      // Where the music is, so somebody who joins in the middle of a song is in the middle of it too.
      music: this.#deps.music?.snapshot(joined.roomId) ?? null,
    };
  }

  /** One room at a time: a channel they are in, and any other call, are left first. */
  #leaveOtherRooms(user, keepRoom) {
    for (const { channelId } of this.#deps.voice.leaveAll(user.id)) this.#broadcastRoster(channelId);
    this.#deps.calls.leaveAll(user.id, keepRoom);
  }

  /** Call the people of a conversation -- or, if there is a call going, join it. */
  #callStart(user, msg) {
    const gate = this.#callGate(user, msg, { throttled: true });
    if (gate.error) return gate.error;
    const { conversation } = gate;
    this.#leaveOtherRooms(user, roomOf(conversation.id));
    const joined = this.#deps.calls.start(conversation, user);
    if (joined.ok && joined.started) {
      const state = this.#deps.calls.state(conversation.id);
      for (const id of state.ringing) {
        this.toUser(id, {
          type: 'call:ring',
          conversationId: conversation.id,
          roomId: state.roomId,
          from: { id: user.id, nickname: user.nickname },
          title: conversation.title ?? null,
          group: conversation.kind === 'group',
          startedAt: state.startedAt,
        });
      }
    }
    return this.#enterCall(user, conversation, joined);
  }

  #callJoin(user, msg) {
    const gate = this.#callGate(user, msg);
    if (gate.error) return gate.error;
    const { conversation } = gate;
    this.#leaveOtherRooms(user, roomOf(conversation.id));
    return this.#enterCall(user, conversation, this.#deps.calls.join(conversation, user));
  }

  /** Turn down a call that is ringing. The ring stops on every one of their windows. */
  #callDecline(user, msg) {
    const gate = this.#callGate(user, msg);
    if (gate.error) return gate.error;
    this.#deps.calls.decline(gate.conversation, user.id);
    this.toUser(user.id, { type: 'call:ring-stopped', conversationId: gate.conversation.id });
    return { type: 'voice:ok' };
  }

  /**
   * Something about a conversation's call changed: everybody in the conversation is told how it stands (who is in
   * it, who is being rung), and those in it have their roster.
   */
  callChanged(conversationId) {
    const calls = this.#deps.calls;
    const conversation = this.#deps.dms.get(conversationId);
    if (!calls || !conversation) return;
    const call = calls.state(conversationId);
    for (const id of this.#deps.dms.members(conversation)) {
      this.toUser(id, { type: 'call:state', conversationId, call });
    }
    if (call) this.#broadcastRoster(call.roomId);
  }

  /**
   * A call is over. The line it left in the conversation goes to the conversation, as a message does; those who
   * were still in it are told to hang up, and everybody that it is not going on any more.
   */
  callEnded(conversation, line, stillIn = []) {
    const dms = this.#deps.dms;
    const view = dms.view(conversation);
    for (const id of dms.members(conversation)) {
      this.toUser(id, { type: 'call:state', conversationId: conversation.id, call: null });
      this.toUser(id, { type: 'call:ring-stopped', conversationId: conversation.id });
      this.toUser(id, { type: 'dm:message', message: publicDmMessage(line, [], id), conversation: view });
    }
    for (const id of stillIn) {
      this.toUser(id, { type: 'call:ended', conversationId: conversation.id, roomId: roomOf(conversation.id) });
    }
    // The call is over, and so is its music.
    this.#deps.music?.onRoster(roomOf(conversation.id), []);
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

  /**
   * Stop what the soundpad is playing, for everyone in the channel. An admin's call: a clip is played by every
   * client from its own copy, so there is no one stream to cut, only everybody to tell. Anything that was
   * started after this plays as normal.
   */
  #soundpadStop(user, msg) {
    if (!this.#deps.roles.context(user).admin) return { type: 'voice:error', error: 'forbidden' };
    const channelId = Number(msg.channelId);
    if (!this.#deps.voice.find(channelId, user.id)) return { type: 'voice:error', error: 'not_in_channel' };

    for (const member of this.#deps.voice.roster(channelId)) {
      this.toUser(member.userId, { type: 'soundpad:stop', channelId, by: user.nickname });
    }
    return { type: 'voice:ok' };
  }

  // ------------------------------------------------------------- music

  /**
   * Everything a Music Buddy request has to clear before it is served: the feature is on, the person is in that voice
   * channel (the music is that channel's), they hold the permission (read again for every message, like all of them),
   * and they are not pressing faster than it can be served.
   * @returns {{channelId: number}|{error: object}}
   */
  #musicGate(user, msg, { needsPermission = true } = {}) {
    const fail = (error) => ({ error: { type: 'voice:error', error } });
    if (!this.#deps.music || !this.#deps.musicEnabled?.()) return fail('music_off');
    const channelId = Number(msg.channelId);
    // The music of a private call is the call's, in the same way: whoever is in it hears it.
    if (!this.#roomsFor(channelId)?.find(channelId, user.id)) return fail('not_in_channel');
    if (needsPermission && !this.#deps.roles.context(user).can('music.control')) return fail('forbidden');
    if (!this.#musicThrottle.take(user.id).allowed) return fail('slow_down');
    return { channelId };
  }

  #musicAdd(user, msg) {
    const gate = this.#musicGate(user, msg);
    if (gate.error) return gate.error;
    const result = this.#deps.music.add(gate.channelId, user, msg.items, { next: msg.next === true });
    return result.ok ? { type: 'voice:ok', added: result.added } : { type: 'voice:error', error: result.error };
  }

  #musicControl(user, msg) {
    const gate = this.#musicGate(user, msg);
    if (gate.error) return gate.error;
    const result = this.#deps.music.control(gate.channelId, String(msg.action), msg);
    return result.ok ? { type: 'voice:ok' } : { type: 'voice:error', error: result.error };
  }

  /** What is playing, asked for by anybody in the channel: no permission, it is only to listen. */
  #musicSync(user, msg) {
    const gate = this.#musicGate(user, msg, { needsPermission: false });
    if (gate.error) return gate.error;
    return { type: 'music:sync', channelId: gate.channelId, music: this.#deps.music.snapshot(gate.channelId) };
  }

  /**
   * The server's clock, and nothing else. A listener asks, times the round trip, and so knows how long a push takes to
   * arrive: which is what puts it at the same place in the track as the one who pressed Play.
   */
  #musicClock(user, msg) {
    const gate = this.#musicGate(user, msg, { needsPermission: false });
    if (gate.error) return gate.error;
    return { type: 'music:clock', serverNow: this.#deps.music.now() };
  }

  /** To everyone in a voice channel, and nobody else: what is playing is for the people hearing it. */
  toChannel(channelId, payload) {
    for (const member of this.#roomsFor(channelId)?.roster(channelId) ?? []) this.toUser(member.userId, payload);
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
    // A call's roster is for the people on the call, and for nobody who merely has the conversation open.
    if (isCallRoom(channelId)) {
      const roster = this.#deps.calls?.rooms.roster(channelId) ?? [];
      // Nobody left on the call: the music is over, and lets go of its files.
      this.#deps.music?.onRoster(channelId, roster);
      for (const member of roster) this.toUser(member.userId, { type: 'voice:roster', channelId, roster, occupiedFor: null });
      return undefined;
    }
    const channel = this.#deps.channels.get(channelId);
    const roster = this.#deps.voice.roster(channelId);
    // The last person leaving ends the music, and lets go of its files.
    this.#deps.music?.onRoster(channelId, roster);
    const payload = {
      type: 'voice:roster',
      channelId,
      roster,
      // null once the last person has left: the timer stops.
      occupiedFor: this.#deps.voice.occupiedFor(channelId),
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
