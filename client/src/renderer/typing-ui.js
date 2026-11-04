// "Is typing", from the page's side: who has been seen typing where, the line that says so, and sending one's own.
//
// What is sent is only "I am typing here", at most once every few seconds while somebody is typing; what is
// received is kept for a few seconds and then forgotten, so a person who stops, or whose message arrives, stops
// being shown without anybody having to say so.

/**
 * How long somebody is shown as typing after the last word that they were -- only for when the word that they
 * stopped never arrives (a dropped connection): it covers the gap between two announcements, and no more.
 */
export const SHOWN_MS = 5000;
/** How often one's own typing is announced. */
export const SEND_EVERY_MS = 3000;
/** How long without a key before one says one has stopped. */
export const IDLE_MS = 2000;

/** The most names the line spells out; more than that is "several". */
const MAX_NAMES = 3;

/**
 * @param {object} deps
 * @param {(key: string, vars?: object) => string} deps.t
 * @param {(userId: number) => string} deps.nameOf  the name shown for somebody: their display name
 * @param {(key: string) => void} deps.changed  who is typing in `key` changed
 * @param {() => number} [deps.now]
 */
export function createTyping({ t, nameOf, changed, now = Date.now }) {
  /** key -> Map(userId -> timer) */
  const typing = new Map();
  /** key -> when one's own was last sent */
  const sent = new Map();
  /** key -> the timer that says one has stopped, running while keys are being pressed */
  const idle = new Map();

  function remove(key, userId) {
    const who = typing.get(key);
    if (!who?.has(userId)) return;
    clearTimeout(who.get(userId));
    who.delete(userId);
    if (!who.size) typing.delete(key);
    changed(key);
  }

  /** Somebody was just seen typing in `key`. */
  function note(key, userId) {
    let who = typing.get(key);
    if (!who) {
      who = new Map();
      typing.set(key, who);
    }
    const fresh = !who.has(userId);
    clearTimeout(who.get(userId));
    const timer = setTimeout(() => remove(key, userId), SHOWN_MS);
    timer.unref?.();
    who.set(userId, timer);
    if (fresh) changed(key);
  }

  /** The people typing in `key`, the one who started first first. */
  const people = (key) => [...(typing.get(key)?.keys() ?? [])];

  /** The line that says who is typing in `key`, or '' when nobody is. */
  function text(key) {
    const names = people(key).map(nameOf);
    if (!names.length) return '';
    if (names.length > MAX_NAMES) return t('typing.many');
    if (names.length === 1) return t('typing.one', { a: names[0] });
    if (names.length === 2) return t('typing.two', { a: names[0], b: names[1] });
    return t('typing.three', { a: names[0], b: names[1], c: names[2] });
  }

  const quietly = (fn) => Promise.resolve(fn()).catch(() => { /* a typing notice is never worth an error */ });

  /**
   * One's own keystroke in `key`: tells the server, unless it was told a moment ago -- and says that one has
   * stopped once the keys have been still for a moment, so nobody is shown typing who is not.
   * @param {() => Promise<unknown>} send
   * @param {() => Promise<unknown>} [stop]
   */
  function ping(key, send, stop) {
    const at = now();
    if (at - (sent.get(key) ?? -Infinity) >= SEND_EVERY_MS) {
      sent.set(key, at);
      quietly(send);
    }
    clearTimeout(idle.get(key));
    if (!stop) return;
    const timer = setTimeout(() => {
      idle.delete(key);
      sent.delete(key);
      quietly(stop);
    }, IDLE_MS);
    timer.unref?.();
    idle.set(key, timer);
  }

  /** The box was emptied: that is stopping, said at once, if anything was said of typing in it. */
  function quiet(key, stop) {
    const had = idle.has(key);
    clearTimeout(idle.get(key));
    idle.delete(key);
    sent.delete(key);
    if (had && stop) quietly(stop);
  }

  /** What was typed was sent: the next keystroke announces itself again at once, and there is nothing to stop. */
  function rest(key) {
    clearTimeout(idle.get(key));
    idle.delete(key);
    sent.delete(key);
  }

  function clearAll() {
    for (const timer of idle.values()) clearTimeout(timer);
    idle.clear();
    for (const who of typing.values()) for (const timer of who.values()) clearTimeout(timer);
    const keys = [...typing.keys()];
    typing.clear();
    sent.clear();
    keys.forEach(changed);
  }

  return {
    note, remove, text, ping, quiet, rest, people, clearAll,
  };
}
