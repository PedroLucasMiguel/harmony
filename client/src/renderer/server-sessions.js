// The servers that are saved but not open, kept connected.
//
// Only one server is on screen at a time, and the whole interface is drawn from
// that one's state. The others are kept alive behind it for what a bubble on the
// rail can say: there is news (a dot), somebody named you (a count), it is not
// answering, or it wants you to sign in again. Nothing here draws anything and
// nothing here touches the page's own state -- every frame a server pushes says
// which server it came from, and the ones that are not the open one end up here
// instead of in the open one's lists.
//
// What "news" means comes from the server: its hello says, per channel, how many
// messages are newer than the last one you read there and how many of them name
// you. From then on the pushes keep the counts current, and reading the channel
// on any device clears them (channel:read).

import { serverKeyOf } from './server-key.js';
import { isCallRoom } from './calls-ui.js';

/** How often a connection nobody is looking at is touched, so an idle session is not swept as abandoned. */
export const KEEP_ALIVE_MS = 12 * 60 * 60 * 1000;

/** The people in a voice room, as much of them as a card needs. */
const peopleOf = (roster) => (Array.isArray(roster) ? roster : [])
  .map((m) => ({ userId: m.userId, nickname: m.nickname }));

/** What the rail needs to know of one background server. */
export function newSession(url) {
  return {
    url,
    key: serverKeyOf(url),
    /** connecting | up | down | locked */
    status: 'connecting',
    user: null,
    /** Do not disturb on that server: its mentions are counted and marked, and make no sound. */
    dnd: false,
    /** channelId -> {unread, mentions} */
    counts: new Map(),
    /** voice channelId -> how many people are in it (private calls are not channels, and are not here) */
    voice: new Map(),
    /** voice channelId -> who is in it ({userId, nickname}), the same channels */
    rosters: new Map(),
  };
}

/** Totals over every channel: how many messages are new, and how many name you. */
export function totals(session) {
  let unread = 0;
  let mentions = 0;
  for (const c of session.counts.values()) {
    unread += c.unread;
    mentions += c.mentions;
  }
  return { unread, mentions };
}

/** What the server said when the connection said hello: who you are and what is new. */
export function applyHello(session, hello) {
  session.user = hello.user ?? session.user;
  session.dnd = hello.status === 'dnd';
  // Who is in which voice channel: the hello says, and the rosters pushed after it keep it.
  session.voice = new Map(Object.entries(hello.occupancy ?? {})
    .map(([id, count]) => [Number(id), Number(count)])
    .filter(([id, count]) => !isCallRoom(id) && count > 0));
  session.rosters = new Map(Object.entries(hello.rosters ?? {})
    .map(([id, roster]) => [Number(id), peopleOf(roster)])
    .filter(([id, people]) => !isCallRoom(id) && people.length > 0));
  session.counts = new Map();
  for (const entry of hello.unread ?? []) {
    session.counts.set(entry.channelId, { unread: entry.unread, mentions: entry.mentions });
  }
  session.status = 'up';
}

/** The same test the open server's own channel list uses (app.js mentionsMe). */
export function namesYou(message, user) {
  if (!user) return false;
  return Boolean(
    message.mentionsEveryone || message.mentions?.includes(user.id)
    || (message.mentionRoles ?? []).some((id) => (user.roles ?? []).includes(id))
    // Answering somebody tells them, as the open server's list does.
    || (message.reply?.userId && message.reply.userId === user.id),
  );
}

/** A new message in some channel. Returns whether it names you. Your own is not news. */
export function applyMessage(session, message) {
  if (!session.user || message.userId === session.user.id) return false;
  const counts = session.counts.get(message.channelId) ?? { unread: 0, mentions: 0 };
  counts.unread += 1;
  const named = namesYou(message, session.user);
  if (named) counts.mentions += 1;
  session.counts.set(message.channelId, counts);
  return named;
}

/** Somebody deleted a message: what is new can only have shrunk. */
export function applyDeleted(session, channelId) {
  const counts = session.counts.get(channelId);
  if (counts?.unread > 0) counts.unread -= 1;
}

/** You read a channel somewhere (another device, or the app when it was open). */
export function applyRead(session, entry) {
  session.counts.set(entry.channelId, { unread: entry.unread ?? 0, mentions: entry.mentions ?? 0 });
}

/** The channel list changed: what is gone has nothing to count. */
export function applyChannels(session, channels) {
  const ids = new Set((channels ?? []).map((c) => c.id));
  for (const id of [...session.counts.keys()]) if (!ids.has(id)) session.counts.delete(id);
}

/**
 * @param {object} deps
 * @param {object} deps.harmony  the bridge: api.setCredentials / api.me, realtime.connect / disconnect
 * @param {() => void} deps.onChange  something a bubble shows has changed
 * @param {(url: string, message: object) => void} deps.onMention  a message in a background server names you
 * @param {(url: string) => void} deps.onRejected  the server no longer accepts the session
 */
export function createBackgroundSessions({
  harmony, onChange, onMention = () => {}, onRejected = () => {}, onUp = () => {},
}) {
  /** @type {Map<string, ReturnType<typeof newSession>>} */
  const sessions = new Map();
  let timer = null;

  const find = (server) => sessions.get(serverKeyOf(server));

  async function start({ url, password = '', token }) {
    const key = serverKeyOf(url);
    if (!key || !token || sessions.has(key)) return;
    const session = newSession(url);
    sessions.set(key, session);
    onChange();
    // A connection that is not the current is only the current while this is still its record.
    const current = () => sessions.get(key) === session;
    try {
      await harmony.api.setCredentials(url, { password, token });
      const hello = await harmony.realtime.connect(url, token);
      if (!current()) return;
      applyHello(session, hello);
      // A connection that was already open answers with the hello it had at the
      // start, which is old by now: what is new is asked again.
      const fresh = await harmony.api.unread?.(url).catch(() => null);
      if (current() && fresh?.channels) {
        session.counts = new Map(fresh.channels.map((c) => [c.channelId, { unread: c.unread, mentions: c.mentions }]));
      }
      onUp(url, session.user);
    } catch {
      // Gave up: the server refused the session. (An unreachable one is retried by the connection itself.)
      if (!current()) return;
      session.status = 'locked';
      onRejected(url);
    }
    onChange();
    armTimer();
  }

  function stop(url) {
    const key = serverKeyOf(url);
    const session = sessions.get(key);
    if (!session) return;
    sessions.delete(key);
    harmony.realtime.disconnect(url).catch(() => {});
    if (!sessions.size) disarmTimer();
    onChange();
  }

  /**
   * Forget a server WITHOUT closing its connection: it is about to be the open
   * one, or a call is running on it, and its socket is what keeps the call.
   */
  function release(url) {
    if (!sessions.delete(serverKeyOf(url))) return;
    if (!sessions.size) disarmTimer();
    onChange();
  }

  function stopAll() {
    for (const session of [...sessions.values()]) stop(session.url);
  }

  /**
   * A frame from a server's connection.
   *
   * @returns {boolean} whether it was one of these servers' -- and so is not for
   *   the open server's lists
   */
  function handleEvent(msg) {
    const session = find(msg.server);
    if (!session) return false;

    switch (msg.type) {
      case 'realtime:up':
        applyHello(session, msg);
        onUp(session.url, session.user);
        break;
      case 'realtime:down':
        session.status = 'down';
        break;
      case 'realtime:rejected':
      case 'kicked':
        session.status = 'locked';
        onRejected(session.url);
        break;
      case 'message':
        // Counted either way; do not disturb only keeps it quiet.
        if (applyMessage(session, msg.message) && !session.dnd) onMention(session.url, msg.message);
        break;
      case 'presence:self':
        session.dnd = msg.status === 'dnd';
        break;
      case 'voice:roster':
        if (!isCallRoom(msg.channelId)) {
          const people = peopleOf(msg.roster);
          if (people.length > 0) {
            session.voice.set(msg.channelId, people.length);
            session.rosters.set(msg.channelId, people);
          } else {
            session.voice.delete(msg.channelId);
            session.rosters.delete(msg.channelId);
          }
        }
        // Falls out to onChange below: the bubble hears of it with the push itself, not at the rail's next redraw.
        break;
      case 'message:deleted':
        applyDeleted(session, msg.channelId);
        break;
      case 'channel:read':
        applyRead(session, msg);
        break;
      case 'channels':
        applyChannels(session, msg.channels);
        break;
      default:
        // Rosters, presence, soundpad...: nothing a bubble shows.
        return true;
    }
    onChange();
    return true;
  }

  async function touch() {
    for (const session of [...sessions.values()]) {
      if (session.status === 'locked') continue;
      try {
        await harmony.api.me(session.url);
      } catch (err) {
        if (err?.status === 401 || err?.code === 'login_required') {
          session.status = 'locked';
          onRejected(session.url);
          onChange();
        }
      }
    }
  }

  function armTimer() {
    if (timer) return;
    timer = setInterval(touch, KEEP_ALIVE_MS);
    timer.unref?.();
  }

  function disarmTimer() {
    clearInterval(timer);
    timer = null;
  }

  return {
    start,
    stop,
    release,
    stopAll,
    handleEvent,
    touch,
    has: (url) => sessions.has(serverKeyOf(url)),
    keys: () => [...sessions.keys()],
    /** Who you are on that server, or null if it is not kept live. */
    userOf: (url) => find(url)?.user ?? null,
    /** The servers with a connection that is up, by address: where a message to the server can go. */
    urls: () => [...sessions.values()].filter((s) => s.status === 'up').map((s) => s.url),
    /** Who is in the voice channels of a server kept live, by channel: [{channelId, userId, nickname}]. */
    voiceMembers(url) {
      const session = find(url);
      return session ? [...session.rosters].flatMap(([channelId, people]) => people.map((p) => ({ channelId, ...p }))) : [];
    },
    /** What the rail shows of one server, or null if it is not kept live. */
    summary(url) {
      const session = find(url);
      return session ? { status: session.status, voice: session.voice.size > 0, ...totals(session) } : null;
    },
  };
}
