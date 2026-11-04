// What a person is on a server: online, idle, do not disturb, or invisible. The server keeps what was chosen and tells
// everybody else; this is the vocabulary the screen shares, and the watch that says when the app has not been touched.

/** In the order the menu lists them. */
export const STATUSES = ['online', 'idle', 'dnd', 'invisible'];

export const isStatus = (value) => STATUSES.includes(value);

/** How long without a touch before the app counts as idle. */
export const IDLE_AFTER_MS = 5 * 60 * 1000;

/**
 * What to show for somebody on the list of members: their status when they are on, null when they are not (and an
 * invisible person is, to everybody else, not).
 *
 * @param {Set<number>} online
 * @param {Object<number, string>} statuses  idle and dnd, for those who are
 */
export function listedStatus(userId, online, statuses) {
  if (!online.has(userId)) return null;
  return statuses?.[userId] === 'idle' || statuses?.[userId] === 'dnd' ? statuses[userId] : 'online';
}

/**
 * What to show for yourself: what you chose, except that "online" with the app untouched is idle, as it is for
 * everybody else. Not when you are in a call on that server: somebody on a channel is not idling.
 */
export function ownStatus(chosen, { away, inCall }) {
  if (chosen === 'online' && away && !inCall) return 'idle';
  return isStatus(chosen) ? chosen : 'online';
}

/**
 * Whether the app has been left alone for `after` ms. Touching it is a pointer, a key, a wheel or a touch; where it
 * listens is the page's to say (`touch()` is what it calls).
 *
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {number} [options.after]
 */
export function createIdleWatch({ now = () => Date.now(), after = IDLE_AFTER_MS } = {}) {
  let last = now();
  return {
    /** Something was touched. */
    touch() {
      last = now();
    },
    /** Left alone long enough. */
    get away() {
      return now() - last >= after;
    },
  };
}
