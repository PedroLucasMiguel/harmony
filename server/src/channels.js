// Channels: the durable list, and the live voice presence on top of it.
//
// Two halves that are deliberately kept apart:
//
//   Channels    -- durable. Rows in SQLite: name, kind, order, password.
//   VoiceRooms  -- live. Who is connected right now, derived from open
//                  WebSockets and never written to disk.
//
// That split is the README's "liveness is never tracked, only observed" applied
// to voice. A restart loses the presence and rebuilds it from reconnecting
// clients, instead of leaving a stale members table to be reconciled with
// reality -- which is the bug every "who is online" table eventually has.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { hashPassword, verifyPassword } from './accounts.js';


/** Media kinds a member can publish, and the letter each takes in a path. */
export const MEDIA_KINDS = { voice: 'v', cam: 'c', screen: 's' };

/**
 * MediaMTX path for a channel member's stream.
 *
 *   vc-<cid>-<mid>-<k>        e.g. vc-1-7-v        max 14 chars
 *
 * `cid` is the channel id and `mid` is a member SLOT -- not a user id. The
 * channel hands a slot out on join and keeps it for as long as that person is
 * in the channel, which buys three things: paths stay short and fixed-shape, a
 * reconnecting member reclaims the same slot so subscribers see "the path I was
 * watching came back" instead of needing a roster diff, and a force-mute sticks
 * to the slot across a reconnect.
 */
export const channelPath = (cid, mid, kind) =>
  `vc-${cid.toString(36)}-${mid.toString(36)}-${MEDIA_KINDS[kind] ?? kind}`;

const CHANNEL_PATH_RE = /^vc-([0-9a-z]{1,4})-([0-9a-z]{1,4})-([vcs])$/;

/**
 * Parse a MediaMTX path back into its parts, or null.
 *
 * This is the auth hook's parser and it must never be normalizeUsername():
 * channel paths satisfy USERNAME_RE, so sharing one function between "is this
 * valid user input" and "what does this path mean" is exactly how a user ends
 * up able to claim the username `vc-1-7-v` and publish into somebody's voice
 * channel. See the comment on normalizeUsername in rooms.js.
 */
export function parseChannelPath(path) {
  const match = CHANNEL_PATH_RE.exec(String(path ?? '').toLowerCase());
  if (!match) return null;
  const [, cid36, mid36, kind] = match;
  return {
    cid: Number.parseInt(cid36, 36),
    mid: Number.parseInt(mid36, 36),
    kind,
  };
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * A per-member, per-channel capability token.
 *
 *   h1.<cid36>.<mid36>.<flags>.<exp36>.<sig>
 *
 * One token serves both reading and publishing; the path comparison in the auth
 * hook is what distinguishes them. Reads only need the channel to match, so any
 * member can watch any other member. Publishing additionally requires the slot
 * to match, so nobody can publish into somebody else's path.
 *
 * The signing secret is PERSISTED rather than generated per process, which
 * fixes the weakness the flat `mediaToken` still has: today every restart
 * invalidates every outstanding WHEP URL.
 */
const TOKEN_TTL_MS = 10 * 60 * 1000;

/** Re-issued by the presence heartbeat once inside this window of expiry. */
export const TOKEN_REFRESH_MS = 5 * 60 * 1000;

export function channelSecret(metaStore) {
  let secret = metaStore.get('channel_token_secret');
  if (!secret) {
    secret = randomBytes(32).toString('base64url');
    metaStore.set('channel_token_secret', secret);
  }
  return secret;
}

const sign = (secret, body) =>
  createHmac('sha256', secret).update(body).digest('base64url').slice(0, 22);

export function mintChannelToken(secret, { cid, mid, flags = 'rw', ttlMs = TOKEN_TTL_MS }) {
  const exp = Math.floor((Date.now() + ttlMs) / 1000).toString(36);
  const body = `h1.${cid.toString(36)}.${mid.toString(36)}.${flags}.${exp}`;
  return `${body}.${sign(secret, body)}`;
}

/**
 * Verify a token and return its claim, or null.
 *
 * Returns null for everything -- bad shape, bad signature, expired -- because
 * the caller only ever turns this into a 204 or a 401 and a more specific
 * answer would only tell an attacker which part they got right.
 */
export function readChannelToken(secret, token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 6 || parts[0] !== 'h1') return null;

  const [, cid36, mid36, flags, exp36, offered] = parts;
  const body = `h1.${cid36}.${mid36}.${flags}.${exp36}`;
  const expected = sign(secret, body);
  const a = Buffer.from(offered);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const exp = Number.parseInt(exp36, 36);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return null;

  return {
    cid: Number.parseInt(cid36, 36),
    mid: Number.parseInt(mid36, 36),
    flags,
    expiresAt: exp * 1000,
  };
}

// ---------------------------------------------------------------------------
// Durable channels
// ---------------------------------------------------------------------------

/**
 * A channel name is kept as it was typed.
 *
 * It used to be folded the way a nickname is -- "Game Night" stored as
 * `gamenight` -- on the reasoning that one spelling per name is simpler.
 * That reasoning was borrowed from nicknames and does not survive the
 * move: a nickname is an IDENTIFIER. It is what @mentions match, what the
 * MediaMTX username namespace holds, and what one person is and another
 * is not, so two spellings of it would be two people.
 *
 * A channel name is a LABEL. Nothing matches on it, nothing is routed by
 * it -- voice paths are `vc-<cid>-<mid>-<k>` and never contain it -- and
 * the only thing it has to do is read well in a sidebar. Group names have
 * always been kept as typed, which made "Game Night" sit under "Hangouts"
 * as `gamenight`, in the same list, for no reason anybody could see.
 *
 * What is still refused: anything invisible. Control characters, and the
 * format characters too -- a right-to-left override in a sidebar reverses
 * the names around it, which is the same reason a display name and a
 * soundpad label refuse one.
 *
 * The two exceptions are U+200D and U+FE0F, which hold emoji together.
 * \p{C} would be the obvious one-line test and it takes both of those with
 * it, so an emoji in a channel name would silently come apart into its
 * pieces. The same hole, named for the same reason, as in reactionKey.
 *
 * Runs of whitespace collapse to one space so that two names cannot differ
 * by something nobody can see.
 */
function cleanChannelName(raw) {
  return String(raw ?? '')
    .replace(/[\p{Cc}\p{Cs}]/gu, '')
    .replace(/[\p{Cf}]/gu, (c) => (c === '\u200d' ? c : ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
}

export class Channels {
  #db;
  #q;

  constructor(db) {
    this.#db = db;
    this.#q = {
      all: db.prepare('SELECT * FROM channels ORDER BY position, id'),
      setGroup: db.prepare('UPDATE channels SET group_id = ?, position = ? WHERE id = ?'),

      groups: db.prepare('SELECT * FROM channel_groups ORDER BY position, id'),
      groupById: db.prepare('SELECT * FROM channel_groups WHERE id = ?'),
      insertGroup: db.prepare(
        'INSERT INTO channel_groups (name, position, created_at) VALUES (?, ?, ?)',
      ),
      // One sequence for groups and channels alike: see arrange().
      nextGroupPosition: db.prepare(
        'SELECT MAX(COALESCE((SELECT MAX(position) FROM channels), -1),'
        + ' COALESCE((SELECT MAX(position) FROM channel_groups), -1)) + 1 AS p',
      ),
      renameGroup: db.prepare('UPDATE channel_groups SET name = ? WHERE id = ?'),
      setGroupPosition: db.prepare('UPDATE channel_groups SET position = ? WHERE id = ?'),
      removeGroup: db.prepare('DELETE FROM channel_groups WHERE id = ?'),
      byId: db.prepare('SELECT * FROM channels WHERE id = ?'),
      insert: db.prepare(
        'INSERT INTO channels (kind, name, position, password_hash, created_at) '
        + 'VALUES (?, ?, ?, ?, ?)',
      ),
      nextPosition: db.prepare(
        'SELECT MAX(COALESCE((SELECT MAX(position) FROM channels), -1),'
        + ' COALESCE((SELECT MAX(position) FROM channel_groups), -1)) + 1 AS p',
      ),
      rename: db.prepare('UPDATE channels SET name = ? WHERE id = ?'),
      setPassword: db.prepare('UPDATE channels SET password_hash = ? WHERE id = ?'),
      setPosition: db.prepare('UPDATE channels SET position = ? WHERE id = ?'),
      remove: db.prepare('DELETE FROM channels WHERE id = ?'),

      grant: db.prepare(
        'INSERT INTO channel_grants (channel_id, user_id, granted_at) VALUES (?, ?, ?) '
        + 'ON CONFLICT DO NOTHING',
      ),
      hasGrant: db.prepare(
        'SELECT 1 AS ok FROM channel_grants WHERE channel_id = ? AND user_id = ?',
      ),
      clearGrants: db.prepare('DELETE FROM channel_grants WHERE channel_id = ?'),
    };
  }

  list() {
    return this.#q.all.all();
  }

  get(id) {
    return this.#q.byId.get(id) ?? null;
  }

  async create({ kind, name, password }) {
    if (kind !== 'voice' && kind !== 'text') return { ok: false, error: 'invalid_kind' };
    const clean = cleanChannelName(name);
    if (!clean) return { ok: false, error: 'invalid_name' };

    const hash = password ? await hashPassword(password) : null;
    const position = this.#q.nextPosition.get().p;
    this.#q.insert.run(kind, clean, position, hash, Date.now());
    return { ok: true, channel: this.#q.all.all().find((c) => c.position === position) };
  }

  async update(id, { name, password }) {
    const channel = this.get(id);
    if (!channel) return { ok: false, error: 'no_such_channel' };

    if (name !== undefined) {
      const clean = cleanChannelName(name);
      if (!clean) return { ok: false, error: 'invalid_name' };
      this.#q.rename.run(clean, id);
    }
    if (password !== undefined) {
      // An empty string means "remove the password", which must also drop the
      // grants -- otherwise re-adding a password later would silently let
      // everyone who was once admitted straight back in.
      const hash = password ? await hashPassword(password) : null;
      this.#q.setPassword.run(hash, id);
      this.#q.clearGrants.run(id);
    }
    return { ok: true, channel: this.get(id) };
  }

  remove(id) {
    if (!this.get(id)) return { ok: false, error: 'no_such_channel' };
    this.#q.remove.run(id);
    return { ok: true };
  }

  // ------------------------------------------------------------- groups

  groups() {
    return this.#q.groups.all();
  }

  createGroup(name) {
    const clean = cleanChannelName(name);
    if (!clean) return { ok: false, error: 'invalid_name' };
    const position = this.#q.nextGroupPosition.get().p;
    const info = this.#q.insertGroup.run(clean, position, Date.now());
    return { ok: true, group: this.#q.groupById.get(Number(info.lastInsertRowid)) };
  }

  renameGroup(id, name) {
    if (!this.#q.groupById.get(id)) return { ok: false, error: 'no_such_group' };
    const clean = cleanChannelName(name);
    if (!clean) return { ok: false, error: 'invalid_name' };
    this.#q.renameGroup.run(clean, id);
    return { ok: true, group: this.#q.groupById.get(id) };
  }

  /**
   * Delete a group. Its channels survive, ungrouped.
   *
   * That is the schema's ON DELETE SET NULL doing the work, and it is the
   * behaviour people expect from a folder: emptying the folder is a
   * separate decision from deleting what was in it.
   */
  removeGroup(id) {
    if (!this.#q.groupById.get(id)) return { ok: false, error: 'no_such_group' };
    this.#q.removeGroup.run(id);
    return { ok: true };
  }

  /**
   * Write the whole sidebar at once: which group each channel is in, where
   * everything sits, and where each group is among the ungrouped channels.
   *
   * The WHOLE tree, not "move channel X into group Y at index N". Drag and
   * drop produces a new arrangement, not a diff, and sending the
   * arrangement means two admins dragging at the same time cannot
   * interleave into an order neither of them chose.
   *
   * `order` is that arrangement as one list, in the order the sidebar draws
   * it: `{ group: id }` for a heading and `{ id, groupId }` for a channel,
   * ungrouped channels and headings in any mixture. Its index IS the
   * position, for groups and channels alike -- one sequence, which is what
   * lets a group sit above a channel that belongs to none.
   *
   * Older clients send `groups` (the heading order) and `channels` instead,
   * and cannot say more than "ungrouped channels first": that is read as the
   * list it describes, so they keep working. Whatever a list leaves out stays
   * where it was, after what it names.
   */
  arrange({ groups, channels, order }) {
    const currentGroups = this.groups();
    const currentChannels = this.list();
    const knownGroups = new Set(currentGroups.map((g) => g.id));
    const knownChannels = new Map(currentChannels.map((c) => [c.id, c]));

    const toGroupId = (value) => (value == null ? null : Number(value));
    let flat = [];

    if (Array.isArray(order)) {
      flat = order.map((entry) => (entry && entry.group != null
        ? { group: Number(entry.group) }
        : { id: Number(entry?.id), groupId: toGroupId(entry?.groupId) }));
    } else {
      const moves = Array.isArray(channels) ? channels : [];
      const submitted = moves.map((m) => ({ id: Number(m?.id), groupId: toGroupId(m?.groupId) }));
      const named = new Set(submitted.map((m) => m.id));
      const sequence = [
        ...submitted,
        ...currentChannels
          .filter((c) => !named.has(c.id))
          .map((c) => ({ id: c.id, groupId: c.group_id ?? null })),
      ];
      const headings = Array.isArray(groups)
        ? [...new Set(groups.map(Number))].filter((id) => knownGroups.has(id))
        : [];
      const groupOrder = [
        ...headings,
        ...currentGroups.map((g) => g.id).filter((id) => !headings.includes(id)),
      ];
      flat = sequence.filter((m) => m.groupId === null || !knownGroups.has(m.groupId));
      for (const id of groupOrder) {
        flat.push({ group: id }, ...sequence.filter((m) => m.groupId === id));
      }
    }

    // Everything named has to exist, and nothing may be named twice.
    const seenChannels = new Set();
    const seenGroups = new Set();
    for (const entry of flat) {
      if ('group' in entry) {
        if (!knownGroups.has(entry.group)) return { ok: false, error: 'no_such_group' };
        seenGroups.add(entry.group);
        continue;
      }
      if (!knownChannels.has(entry.id)) return { ok: false, error: 'no_such_channel' };
      if (entry.groupId !== null && !knownGroups.has(entry.groupId)) {
        return { ok: false, error: 'no_such_group' };
      }
      seenChannels.add(entry.id);
    }
    // What the list does not mention goes after what it does, as it was.
    const dropRepeats = new Set();
    flat = flat.filter((entry) => {
      const key = 'group' in entry ? `g${entry.group}` : `c${entry.id}`;
      if (dropRepeats.has(key)) return false;
      dropRepeats.add(key);
      return true;
    });
    for (const g of currentGroups) if (!seenGroups.has(g.id)) flat.push({ group: g.id });
    for (const c of currentChannels) {
      if (!seenChannels.has(c.id)) flat.push({ id: c.id, groupId: c.group_id ?? null });
    }

    this.#db.exec('BEGIN');
    try {
      // The index in the submitted list IS the position. The client sends
      // everything in the order it is drawn, so there is nothing to compute
      // and no way for the two to disagree.
      flat.forEach((entry, i) => {
        if ('group' in entry) this.#q.setGroupPosition.run(i, entry.group);
        else this.#q.setGroup.run(entry.groupId, i, entry.id);
      });
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    return { ok: true, channels: this.list(), groups: this.groups() };
  }

  /**
   * Reorder channels to exactly the given id order.
   *
   * Takes the whole list rather than "move channel X to index N" so that two
   * admins dragging at once cannot interleave into an order neither of them
   * chose. One transaction, last writer wins, and the result is always a
   * permutation someone actually asked for.
   */
  reorder(ids) {
    const existing = this.list().map((c) => c.id);
    const wanted = [...new Set(ids.map((n) => Number(n)))];
    if (wanted.length !== existing.length || wanted.some((id) => !existing.includes(id))) {
      return { ok: false, error: 'bad_order' };
    }
    // The positions already in use are handed out again, in the new order, so
    // that the channels still sit where the groups are among them (see arrange).
    const slots = this.list().map((c) => c.position);
    this.#db.exec('BEGIN');
    try {
      wanted.forEach((id, index) => this.#q.setPosition.run(slots[index], id));
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    return { ok: true, channels: this.list() };
  }

  /**
   * May this user enter? Returns 'ok', 'password_required' or 'bad_password'.
   *
   * A correct password is remembered as a grant, so it is asked once per person
   * rather than once per join.
   */
  async admit(channelId, userId, password) {
    const channel = this.get(channelId);
    if (!channel) return 'no_such_channel';
    if (!channel.password_hash) return 'ok';
    if (this.#q.hasGrant.get(channelId, userId)) return 'ok';
    if (password == null || password === '') return 'password_required';
    if (!(await verifyPassword(String(password), channel.password_hash))) return 'bad_password';
    this.#q.grant.run(channelId, userId, Date.now());
    return 'ok';
  }

  hasGrant(channelId, userId) {
    return Boolean(this.#q.hasGrant.get(channelId, userId));
  }
}

export const publicChannel = (c) => (c ? {
  id: c.id,
  kind: c.kind,
  name: c.name,
  position: c.position,
  groupId: c.group_id ?? null,
  locked: Boolean(c.password_hash),
} : null);

export const publicGroup = (g) => (g ? {
  id: g.id,
  name: g.name,
  position: g.position,
} : null);

// ---------------------------------------------------------------------------
// Live voice presence
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on a voice channel.
 *
 * Phase 0 measured a client handling 16 audio subscriptions for 7.3% of one
 * core with zero loss, so this is not a client limit -- it is the relay's. The
 * N-th joiner opens N-1 subscriptions, so the cost at the server is quadratic:
 * 16 people is 240 concurrent WHEP sessions. Raising this is a decision about
 * the server's upload bandwidth, not about the app.
 */
export const VOICE_HARD_CAP = 16;

export class VoiceRooms {
  /** @type {Map<number, Map<number, {userId: number, nickname: string, muted: boolean, forceMuted: boolean, publishing: Set<string>}>>} */
  #rooms = new Map();

  #room(channelId) {
    let room = this.#rooms.get(channelId);
    if (!room) {
      room = new Map();
      this.#rooms.set(channelId, room);
    }
    return room;
  }

  /**
   * Put a user in a channel and give them a slot.
   *
   * Reclaiming: if this user is already in the room they keep their slot. That
   * is what makes a reconnect invisible to everyone else -- the path they were
   * publishing to is the same one they come back on.
   */
  join(channelId, user) {
    const room = this.#room(channelId);

    for (const [mid, member] of room) {
      if (member.userId === user.id) return { ok: true, mid, member, rejoined: true };
    }
    if (room.size >= VOICE_HARD_CAP) return { ok: false, error: 'channel_full' };

    // Lowest free slot, so paths stay short and a leaver's slot is reused
    // rather than the counter climbing forever.
    let mid = 1;
    while (room.has(mid)) mid += 1;

    const member = {
      userId: user.id,
      nickname: user.nickname,
      muted: false,
      /*
       * Deafened is DIFFERENT from muted and worth its own flag.
       *
       * Muted means nobody can hear you; deafened means you cannot hear
       * anybody, which is the one people actually need to know before they
       * start talking to you. Folding it into `muted` -- which deafening
       * implies -- would show a mic icon for somebody who simply is not
       * listening, and there is no way to tell those apart afterwards.
       */
      deafened: false,
      forceMuted: false,
      publishing: new Set(),
    };
    room.set(mid, member);
    return { ok: true, mid, member, rejoined: false };
  }

  leave(channelId, userId) {
    const room = this.#rooms.get(channelId);
    if (!room) return false;
    for (const [mid, member] of room) {
      if (member.userId === userId) {
        room.delete(mid);
        if (room.size === 0) this.#rooms.delete(channelId);
        return mid;
      }
    }
    return false;
  }

  /** Drop a user from every channel. Called when their socket closes. */
  leaveAll(userId) {
    const left = [];
    for (const channelId of [...this.#rooms.keys()]) {
      const mid = this.leave(channelId, userId);
      if (mid !== false) left.push({ channelId, mid });
    }
    return left;
  }

  find(channelId, userId) {
    const room = this.#rooms.get(channelId);
    if (!room) return null;
    for (const [mid, member] of room) {
      if (member.userId === userId) return { mid, member };
    }
    return null;
  }

  slot(channelId, mid) {
    return this.#rooms.get(channelId)?.get(mid) ?? null;
  }

  roster(channelId) {
    const room = this.#rooms.get(channelId);
    if (!room) return [];
    return [...room.entries()]
      .map(([mid, m]) => ({
        mid,
        userId: m.userId,
        nickname: m.nickname,
        muted: m.muted,
        deafened: m.deafened,
        forceMuted: m.forceMuted,
        publishing: [...m.publishing],
      }))
      .sort((a, b) => a.mid - b.mid);
  }

  /** Every channel with somebody in it, for the initial state push. */
  occupancy() {
    const out = {};
    for (const [channelId, room] of this.#rooms) out[channelId] = room.size;
    return out;
  }

  /**
   * Every channel's full roster, keyed by channel id.
   *
   * The counts in occupancy() are enough to put a number beside a channel;
   * they are not enough to show WHO is in it, which is what a sidebar wants.
   * A client learns about changes from the voice:roster broadcast, but a
   * client that has just connected has missed every one of those, so it needs
   * the whole picture once.
   *
   * Still derived, never stored: this is read out of the live sockets each
   * time it is asked for, so there is nothing to reconcile after a restart.
   */
  allRosters() {
    const out = {};
    for (const channelId of this.#rooms.keys()) out[channelId] = this.roster(channelId);
    return out;
  }

  /**
   * Mute, deafen, or both.
   *
   * `deafened` is optional and only written when it is actually sent, so an
   * older client that knows nothing about it does not silently un-deafen
   * somebody every time they toggle their microphone.
   */
  setMuted(channelId, userId, muted, deafened) {
    const found = this.find(channelId, userId);
    if (!found) return false;
    found.member.muted = Boolean(muted);
    if (deafened !== undefined) found.member.deafened = Boolean(deafened);
    return true;
  }

  /**
   * Admin force-mute.
   *
   * Measured in the Phase 0 spike: kicking the live MediaMTX session stops the
   * audio reaching anyone within about 3 seconds, but the kicked path is
   * immediately re-publishable -- so the kick alone keeps nobody muted. THIS
   * flag is the enforcement: the auth hook refuses the publish while it is set.
   * The kick is only how the session already in flight is ended.
   */
  setForceMuted(channelId, mid, forceMuted) {
    const member = this.slot(channelId, mid);
    if (!member) return false;
    member.forceMuted = Boolean(forceMuted);
    return true;
  }

  isForceMuted(channelId, mid) {
    return Boolean(this.slot(channelId, mid)?.forceMuted);
  }

  trackPublish(channelId, mid, kind, on) {
    const member = this.slot(channelId, mid);
    if (!member) return;
    if (on) member.publishing.add(kind);
    else member.publishing.delete(kind);
  }
}
