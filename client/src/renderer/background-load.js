// How the camera's background effect backs off when the machine cannot keep up,
// with nothing from the browser in it so that it can be tested with numbers.
//
// The effect runs on the page's main thread, and a machine that cannot do it at
// the camera's rate does not just get a slow picture: the main thread is what
// everything else in the call is waiting on, and a CPU kept at its limit starves
// the threads that encode and send the voice. So it gives ground in steps, and
// the last step is to stop and say so.
//
//   1. segment only some frames, reusing the last outline between      (stride)
//   2. render only some frames at all, which is a lower frame rate     (renderStride)
//   3. stop for this call and send the plain camera                    (LoadWatch)
//
// "Work" below is the milliseconds one frame costs the main thread, smoothed.

/** One segmentation costs more than this: reuse its mask on some frames. */
export const SLOW_SEGMENT_MS = 28;
/** A frame's whole work above this: some frames are dropped outright. */
export const SLOW_FRAME_MS = 60;
/** A frame's whole work above this, for OVERLOAD_FOR_MS: stop the effect. */
export const OVERLOAD_MS = 100;
export const OVERLOAD_FOR_MS = 4000;

/** Segment one frame in this many (the rest reuse the last mask). */
export function segmentStride(segmentMs) {
  if (segmentMs > 70) return 4;
  if (segmentMs > 45) return 3;
  if (segmentMs > SLOW_SEGMENT_MS) return 2;
  return 1;
}

/** Render one frame in this many (the rest are not drawn or sent). */
export function renderStride(workMs) {
  if (workMs > 85) return 3;
  if (workMs > SLOW_FRAME_MS) return 2;
  return 1;
}

/**
 * Says, once, when the work has been over the limit for long enough that
 * nothing short of stopping will help. A single slow stretch -- the camera
 * waking up, the window moving -- must not do it, so it has to last, and a good
 * moment starts the count again.
 */
export class LoadWatch {
  #since = null;
  #told = false;

  /** @returns {boolean} true the one time the effect should give up */
  update(workMs, now) {
    if (this.#told) return false;
    if (workMs <= OVERLOAD_MS) {
      this.#since = null;
      return false;
    }
    this.#since ??= now;
    if (now - this.#since < OVERLOAD_FOR_MS) return false;
    this.#told = true;
    return true;
  }
}
