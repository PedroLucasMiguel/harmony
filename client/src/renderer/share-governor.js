// Lowers a share's frame rate and size by itself when this computer cannot encode it as fast as it is asked to, and
// raises them again when it can.
//
// Why it exists. WebRTC has its own limiter, and `qualityLimitationReason` says "cpu" when it fires. It does not fire
// for a GPU encoder that the game has starved: sharing a heavy game at 1080p60, the encoder (a hardware one: AMD's
// MediaFoundation encoder, in the log this was written from) took 30 to 800 ms for each frame where a healthy one takes
// 3, the capture behind it was held back to 1-14 frames a second, and the reason stayed "none" for the whole two minutes.
// The viewers got a slideshow, a long way behind. The same pipeline, with the game out of the way, did 49 fps at 32 ms.
// The remedy is to ask for less: a game that leaves the encoder a fraction of the GPU still gets 30 fps at 720p through it,
// and that is a far better stream than 8 fps at 1080p.
//
// Pure: it is given a sample every second or so and says what to apply, if anything. It touches nothing itself.
//
// What counts as being starved: behind by a lot on frames (under 70% of what was asked for), the encoder slow to the
// frame (over 25 ms: hardware ones take 1-5), and the link not the reason (a link that holds the picture back is the
// bandwidth limiter's to deal with, and says so). Six seconds of that steps down; half a minute of the encoder keeping up
// with room to spare steps up one, and a step up that is followed at once by being starved again is not tried again for
// a while, which doubles each time, so a game that really does need the lower setting does not flicker between two.

/** The ceiling's frame rate and size, divided by this, at each rung. 1 is what was asked for. */
const RUNGS = [
  { fps: 1, shrink: 1 },
  { fps: 0.5, shrink: 1 },
  { fps: 0.5, shrink: 1.5 },
  { fps: 0.34, shrink: 2 },
];

/** A frame rate is never taken below this, nor a picture below this height. */
const MIN_FPS = 15;
const MIN_HEIGHT = 360;

/** Behind by this much is behind: below this share of the frames asked for. */
const BEHIND = 0.7;
/** The encoder is slow to the frame beyond this: milliseconds. A hardware encoder is 1-5; the log had 30-800. */
const SLOW_ENCODE_MS = 25;
/** Keeping up, for stepping back up: this share of the frames, and this fast. */
const KEEPING_UP = 0.9;
const FAST_ENCODE_MS = 12;
/**
 * The link is what holds the picture back when its estimate is no more than this much above what is being sent. (It is
 * normally above it: the estimate probes ahead of the stream, so being a little over is not the same as being at it.)
 */
const LINK_ROOM = 1.05;

/** In samples (about a second each). */
const STEP_DOWN_AFTER = 6;
const STEP_UP_AFTER = 30;
/** Samples ignored after a change: the encoder is being set up again, and says nothing true meanwhile. */
const SETTLE = 3;
/** A step up that is met by being starved again within this many samples was a mistake. */
const PROBE = 12;
const HOLD_FIRST = 60;
const HOLD_MAX = 600;

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

/**
 * @param {{fps: number, width?: number, height?: number}} ask  what the person chose: the ceiling. width and height are
 *   0 or missing for "native", and are then taken from what the stream reports
 */
export function createShareGovernor(ask) {
  let rung = 0;
  let last = null;
  let behind = 0;
  let keeping = 0;
  let settling = 0;
  let hold = 0;
  let holdFor = HOLD_FIRST;
  /** Samples left in which being starved again means the last step up was a mistake. */
  let probing = 0;
  let ceiling = { ...ask };
  /** The stream's own size, learned from its first samples, for a share that is native. */
  let seen = { width: ask.width || 0, height: ask.height || 0 };

  const plan = () => {
    const step = RUNGS[rung];
    // What was asked for, as it was asked: a native share is left to be native, not pinned to the size it was seen at.
    if (rung === 0) return { rung, fps: ceiling.fps, width: ceiling.width || 0, height: ceiling.height || 0, lowered: false };
    const fps = Math.max(Math.min(MIN_FPS, ceiling.fps), Math.round(ceiling.fps * step.fps));
    const base = { width: ceiling.width || seen.width, height: ceiling.height || seen.height };
    const shrink = base.height && base.height / step.shrink < MIN_HEIGHT ? Math.max(1, base.height / MIN_HEIGHT) : step.shrink;
    return {
      rung,
      fps,
      width: base.width ? even(base.width / shrink) : 0,
      height: base.height ? even(base.height / shrink) : 0,
      lowered: rung > 0,
    };
  };

  const move = (to, reason) => {
    rung = to;
    behind = 0;
    keeping = 0;
    settling = SETTLE;
    return { ...plan(), reason };
  };

  return {
    /** The person changed what they ask for: it is the new ceiling, and what was learned is let go. */
    ask(next) {
      ceiling = { ...next };
      seen = { width: next.width || seen.width, height: next.height || seen.height };
      rung = 0;
      behind = 0;
      keeping = 0;
      settling = SETTLE;
      last = null;
      return plan();
    },

    get plan() { return plan(); },

    /**
     * One reading of the stream.
     *
     * @param {{at: number, framesEncoded: number, totalEncodeTime: number, limitedBy?: string|null, kbps?: number,
     *   availableKbps?: number|null, width?: number, height?: number}} sample  `at` in ms; `totalEncodeTime` in seconds,
     *   as getStats() gives them (running totals)
     * @returns {null|{rung: number, fps: number, width: number, height: number, lowered: boolean, reason: 'starved'|'recovered'}}
     *   what to apply, or null for no change
     */
    sample(sample) {
      // The size of a native share, from the stream while it is at what was asked for (lowered, it would be the lowered one).
      if (rung === 0 && sample.width && sample.height) seen = { width: sample.width, height: sample.height };
      const before = last;
      last = sample;
      if (!before || sample.at <= before.at) return null;
      hold = Math.max(0, hold - 1);
      probing = Math.max(0, probing - 1);
      if (settling > 0) {
        settling -= 1;
        return null;
      }

      const seconds = (sample.at - before.at) / 1000;
      const frames = sample.framesEncoded - before.framesEncoded;
      if (frames < 0) return null;
      const fps = frames / seconds;
      const encodeMs = frames > 0 ? ((sample.totalEncodeTime - before.totalEncodeTime) / frames) * 1000 : 0;
      const asked = plan().fps;
      const linkLimited = sample.limitedBy === 'bandwidth'
        || (sample.availableKbps != null && sample.kbps != null && sample.availableKbps < sample.kbps * LINK_ROOM);

      const starved = !linkLimited && fps < asked * BEHIND
        && (encodeMs > SLOW_ENCODE_MS || sample.limitedBy === 'cpu');
      const easy = fps >= asked * KEEPING_UP && encodeMs < FAST_ENCODE_MS;

      if (starved) {
        keeping = 0;
        behind += 1;
        if (behind >= STEP_DOWN_AFTER && rung < RUNGS.length - 1) {
          // Starved again straight after a step up: that was too soon, and the next is further off.
          if (probing > 0) {
            hold = holdFor;
            holdFor = Math.min(HOLD_MAX, holdFor * 2);
          }
          probing = 0;
          return move(rung + 1, 'starved');
        }
        return null;
      }
      behind = 0;
      if (rung > 0 && easy && hold === 0) {
        keeping += 1;
        if (keeping >= STEP_UP_AFTER) {
          const to = move(rung - 1, 'recovered');
          probing = PROBE + SETTLE;
          return to;
        }
      } else {
        keeping = 0;
      }
      return null;
    },
  };
}
