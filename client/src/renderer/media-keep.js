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
//
// A page playing in a frame (a video from a link's card) is kept the same way, but
// a frame that leaves the page starts over however quickly it comes back. Only
// moveBefore() -- a move that is not a removal -- keeps it, so it goes to a holder
// that is on the page, and from there to the slot the new row has for it
// (data-keep-slot). Where there is no moveBefore the frame is simply drawn again.

/** @type {Map<string, HTMLMediaElement>} */
const parked = new Map();
/** @type {Map<string, HTMLIFrameElement>} */
const parkedFrames = new Map();
/** @type {HTMLElement|null} */
let holder = null;

const canMove = () => typeof Element.prototype.moveBefore === 'function';

function frameHolder() {
  if (!holder) {
    holder = document.createElement('div');
    holder.hidden = false;
    // On the page, but out of the way: a hidden one would not keep a frame running.
    holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:480px;height:270px;overflow:hidden;pointer-events:none';
    holder.setAttribute('aria-hidden', 'true');
  }
  if (!holder.isConnected) document.body.append(holder);
  return holder;
}

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
  parkedFrames.clear();
  if (!canMove()) return;
  for (const frame of root.querySelectorAll('iframe[data-keep]')) {
    parkedFrames.set(frame.dataset.keep, frame);
    frameHolder().moveBefore(frame, null);
  }
}

/** Whether a frame is being kept for this key, to be put into the slot the row makes for it. */
export function hasParkedFrame(key) {
  return parkedFrames.has(key);
}

/** The parked element for this key, or null: the row makes a new one. */
export function takeMedia(key) {
  const media = parked.get(key) ?? null;
  parked.delete(key);
  return media;
}

/** What nobody took -- its message is gone -- is stopped. */
export function dropParked() {
  // A frame goes where its row left a slot; one with no slot has no message any more.
  for (const slot of document.querySelectorAll('[data-keep-slot]')) {
    const frame = parkedFrames.get(slot.dataset.keepSlot);
    if (!frame) continue;
    parkedFrames.delete(slot.dataset.keepSlot);
    try {
      slot.moveBefore(frame, null);
    } catch {
      continue; // drawn again from its address when asked
    }
    slot.removeAttribute('data-keep-slot');
  }
  for (const frame of parkedFrames.values()) frame.remove();
  parkedFrames.clear();
  for (const media of parked.values()) {
    try { media.pause(); } catch { /* already gone */ }
  }
  parked.clear();
}
