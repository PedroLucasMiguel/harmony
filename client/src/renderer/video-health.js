// Is a picture we are receiving actually being drawn?
//
// A video subscription can be up -- connected, packets arriving -- and show
// black: the decoder never got started (it waits for a key frame that was lost),
// or it stopped decoding what it is handed. Nothing in the connection says so; the
// statistics do. `framesReceived` is what arrived, `framesDecoded` what was drawn.
// Packets and frames coming in with nothing decoded is the black tile, and the
// remedy a person finds is to stop and start everything. This finds it first.
//
// A still screen is not mistaken for it: a static share sends few frames, but what
// is sent is decoded, so decoding does not stand still while frames arrive.

/** Frames arriving, and none decoded, for this long: the decoder is stuck. */
export const VIDEO_STALL_MS = 5000;
/** Packets arriving for this long and not one frame ever decoded: it never started. */
export const VIDEO_START_MS = 9000;
/** A tile that was rebuilt this many times and is still black is left alone, not rebuilt for ever. */
export const VIDEO_MAX_REBUILDS = 3;

const fresh = (s, now, since = now) => ({
  at: now, since, framesReceived: s.framesReceived, framesDecoded: s.framesDecoded,
});

/**
 * @param {{at: number, since: number, framesReceived: number, framesDecoded: number}|null} prev  what the last look left
 * @param {{framesReceived: number, framesDecoded: number, packetsReceived: number}} stats  the video's inbound statistics now
 * @param {number} now
 * @returns {{verdict: 'ok'|'decoder-stuck'|'never-started', next: object}}
 */
export function judgeVideo(prev, stats, now) {
  if (!prev) return { verdict: 'ok', next: fresh(stats, now) };

  // Drawing something: the window starts again from here.
  if (stats.framesDecoded > prev.framesDecoded) return { verdict: 'ok', next: fresh(stats, now, prev.since) };

  const received = stats.framesReceived - prev.framesReceived;
  if (stats.framesDecoded === 0 && stats.packetsReceived > 30 && now - prev.since >= VIDEO_START_MS) {
    return { verdict: 'never-started', next: prev };
  }
  if (now - prev.at >= VIDEO_STALL_MS && received >= 3) return { verdict: 'decoder-stuck', next: prev };
  return { verdict: 'ok', next: prev };
}
