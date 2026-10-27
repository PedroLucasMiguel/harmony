// Shaping the byte stream a capture child process writes.
//
// The renderer's worklet wants whole frames -- interleaved stereo 16-bit is
// four bytes -- and a pipe makes no promise of that: a read can end anywhere.
// A frame split across two chunks is shifted by two bytes from then on, which
// swaps the channels and turns everything into noise.

const FRAME_BYTES = 4;

/** Wrap a chunk callback so it only ever sees whole frames. */
function alignFrames(onChunk) {
  let rest = Buffer.alloc(0);
  return (chunk) => {
    const all = rest.length ? Buffer.concat([rest, chunk]) : chunk;
    const whole = all.length - (all.length % FRAME_BYTES);
    rest = whole < all.length ? Buffer.from(all.subarray(whole)) : Buffer.alloc(0);
    if (whole > 0) onChunk(all.subarray(0, whole));
  };
}

/**
 * Drop the header a recorder may put in front of the samples.
 *
 * pw-record writes to stdout through libsndfile, and whether that is bare PCM
 * or a WAV with an unfinished header has varied between PipeWire versions. Both
 * are handled rather than depending on which one is installed: a WAV starts
 * with "RIFF", and the samples start 8 bytes after the "data" tag.
 */
function stripWavHeader(onChunk) {
  let pending = Buffer.alloc(0);
  let decided = false;
  return (chunk) => {
    if (decided) return onChunk(chunk);
    pending = Buffer.concat([pending, chunk]);
    if (pending.length < 4) return undefined;

    if (pending.toString('latin1', 0, 4) !== 'RIFF') {
      decided = true;
      const out = pending;
      pending = Buffer.alloc(0);
      return onChunk(out);
    }
    const data = pending.indexOf('data', 12, 'latin1');
    if (data < 0 || pending.length < data + 8) {
      // Header not complete yet -- unless it is not a header at all, and
      // nothing sane has one this long.
      if (pending.length <= 4096) return undefined;
      decided = true;
      const out = pending;
      pending = Buffer.alloc(0);
      return onChunk(out);
    }
    decided = true;
    const out = pending.subarray(data + 8);
    pending = Buffer.alloc(0);
    return out.length ? onChunk(out) : undefined;
  };
}

module.exports = { alignFrames, stripWavHeader, FRAME_BYTES };
