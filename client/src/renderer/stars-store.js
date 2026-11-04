// Starred messages: the ones a person keeps for themselves, as WhatsApp's are.
//
// A star is not a pin. A pin is the conversation's, the same for everybody and held on the server; a star is only
// here, on this computer, for this account, and nothing about it leaves. So a starred message is kept as a COPY, not
// as a pointer: the message may be deleted afterwards, and the copy is still what was said.
//
// Plain logic over two functions that say where the list is kept, so the page and the tests drive the same thing.
// What is kept is { [scope]: Entry[] }; a scope is one account on one server (`${serverKey}#${userId}`), and an entry
// is { kind: 'channel' | 'dm', id, savedAt, ...what that kind keeps }:
//
//   channel  { channelId, message }                      the message as the server sent it, trimmed
//   dm       { conversationId, peer, key, sealed }       the message sealed under the account's own key: see Vault.sealLocal

/** Stars one account can keep. It all sits in the settings file, which is read whole, so it has a limit. */
export const MAX_STARS = 500;

/** Why a star was refused, with a code for the page to say it in words. */
export class StarError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** The part of a channel message that a star keeps: what is drawn of it, not what is going on around it. */
export function channelSnapshot(message) {
  const keep = {
    id: message.id,
    channelId: message.channelId,
    userId: message.userId,
    nickname: message.nickname ?? null,
    body: message.body ?? '',
    createdAt: message.createdAt,
    editedAt: message.editedAt ?? null,
    attachmentHash: message.attachmentHash ?? null,
    attachmentName: message.attachmentName ?? null,
    attachmentBytes: message.attachmentBytes ?? null,
    mediaType: message.mediaType ?? null,
    // In a forum: the post it is written under (or that it is, with its title), so that a star can go back to it.
    threadId: message.threadId ?? null,
    title: message.title ?? null,
    postTitle: message.postTitle ?? null,
  };
  // What it answers is kept as the words it was shown with, so the copy reads on its own.
  if (message.reply) keep.reply = message.reply;
  return keep;
}

/** Lower case with the accents taken off, so "cafe" finds "Café". */
export function fold(text) {
  return String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Whether every word of `query` is somewhere in `haystack` (accents and case aside). An empty query matches all. */
export function matches(query, haystack) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = fold(haystack);
  return words.every((w) => text.includes(w));
}

const valid = (entry) => entry && typeof entry === 'object'
  && (entry.kind === 'channel' || entry.kind === 'dm') && entry.id != null;

/**
 * @param {{read: () => object, write: (next: object) => Promise<unknown>}} where  `read` is what is kept now; `write`
 *   keeps what it is given (and is what `read` returns from then on, at once: the next call sees it).
 */
export function createStarStore({ read, write }) {
  const listeners = new Set();

  const all = () => {
    const kept = read();
    return kept && typeof kept === 'object' ? kept : {};
  };
  const of = (scope) => {
    const entries = all()[scope];
    return Array.isArray(entries) ? entries.filter(valid) : [];
  };
  const put = (scope, entries) => {
    const next = { ...all() };
    if (entries.length) next[scope] = entries;
    else delete next[scope];
    const done = write(next);
    for (const fn of listeners) fn();
    return done;
  };
  const same = (kind, id) => (e) => e.kind === kind && e.id === id;

  return {
    /** An account's stars of one kind, the one starred last first. */
    list: (scope, kind) => of(scope).filter((e) => e.kind === kind).sort((a, b) => b.savedAt - a.savedAt),
    has: (scope, kind, id) => of(scope).some(same(kind, id)),
    count: (scope) => of(scope).length,
    /** Keeps `entry` (starred again, it is the newest). Refused, with a StarError, when there are too many. */
    add(scope, entry) {
      if (!valid(entry)) throw new StarError('invalid');
      const rest = of(scope).filter((e) => !same(entry.kind, entry.id)(e));
      if (rest.length >= MAX_STARS) throw new StarError('too_many');
      return put(scope, [...rest, { ...entry, savedAt: entry.savedAt ?? Date.now() }]);
    },
    remove(scope, kind, id) {
      const before = of(scope);
      const rest = before.filter((e) => !same(kind, id)(e));
      return rest.length === before.length ? Promise.resolve() : put(scope, rest);
    },
    /** Called after any change, from anywhere. Returns what stops it. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
