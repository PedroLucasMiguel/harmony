// A video or a sound that is playing is not stopped by the chat being drawn again.
//
// A conversation is drawn from scratch whenever anything in it changes -- somebody
// writes, a message is read, a key is confirmed -- and a <video> that is rebuilt is
// a video that starts over, stopped, at the beginning. So before the rows are
// rebuilt, the media elements that have begun are parked, and the new row for the
// same message takes its own back instead of making another.
//
//   parkMedia(log)            before the rows are built
//   takeMedia(key)            where a row makes its <video> or <audio>
//   dropParked()              after the log is replaced: what nothing took is let go
//
// Taking one out of the old row and into the new one happens in a single run of
// script, so the engine never sees it leave the page (it would pause it).

/** @type {Map<string, HTMLMediaElement>} */
const parked = new Map();

/** Mark an element as one that can be kept, by something that is the same after a redraw. */
export function keepable(media, key) {
  media.dataset.keep = key;
  return media;
}

/** The elements in `root` that have started and are not over. Call before the rows are rebuilt. */
export function parkMedia(root) {
  parked.clear();
  for (const media of root.querySelectorAll('video[data-keep], audio[data-keep]')) {
    if (media.ended || (media.paused && media.currentTime === 0)) continue;
    parked.set(media.dataset.keep, media);
  }
}

/** The parked element for this key, or null: the row makes a new one. */
export function takeMedia(key) {
  const media = parked.get(key) ?? null;
  parked.delete(key);
  return media;
}

/** What nobody took -- its message is gone -- is stopped. */
export function dropParked() {
  for (const media of parked.values()) {
    try { media.pause(); } catch { /* already gone */ }
  }
  parked.clear();
}
