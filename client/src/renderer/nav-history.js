// Where you have been, for the back and forward arrows in the title bar: the channels and the forum posts you opened,
// in order, with a cursor on the one you are at. Going back and then somewhere new drops what was ahead, as a
// browser's history does; opening the place you are already at changes nothing.
//
// Pure bookkeeping: what an entry is, and how to go to it, is the app's.

export function createNavHistory({ limit = 100 } = {}) {
  /** @type {{key: string}[]} */
  let entries = [];
  let at = -1;

  return {
    /** Record that somebody went to `entry` (an object with a `key` that names the place). */
    push(entry) {
      if (entries[at]?.key === entry.key) {
        entries[at] = entry;
        return;
      }
      entries = entries.slice(0, at + 1);
      entries.push(entry);
      if (entries.length > limit) entries = entries.slice(entries.length - limit);
      at = entries.length - 1;
    },
    /** The entry before this one, which is now the one at; null at the start. */
    back() {
      if (at <= 0) return null;
      at -= 1;
      return entries[at];
    },
    forward() {
      if (at >= entries.length - 1) return null;
      at += 1;
      return entries[at];
    },
    get canBack() { return at > 0; },
    get canForward() { return at >= 0 && at < entries.length - 1; },
    /** What is gone from the list, for places that no longer exist: it is skipped over by going on. */
    drop(key) {
      const before = entries.length;
      const current = entries[at]?.key;
      entries = entries.filter((e) => e.key !== key);
      if (entries.length === before) return;
      at = Math.max(-1, Math.min(entries.findIndex((e) => e.key === current), entries.length - 1));
      if (at === -1 && entries.length) at = entries.length - 1;
    },
    clear() {
      entries = [];
      at = -1;
    },
    get current() { return entries[at] ?? null; },
    get size() { return entries.length; },
  };
}
