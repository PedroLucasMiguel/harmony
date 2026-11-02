// How loud a track is, so that every track can be played as loud as the one before it.
//
// Songs are mastered to very different levels (a modern pop track is easily 6 dB louder than an older one, which is
// twice as loud to the ear), so with one volume setting for the whole queue somebody is always reaching for it. The
// server measures each track once, when it is fetched, the way broadcasters do (ITU-R BS.1770 / EBU R128 "integrated
// loudness", in LUFS), keeps the number next to the file, and sends every client the gain that brings the track to a
// common level. Nothing here changes the file: the client applies the gain as it plays, under the listener's own volume.
//
// The file is WebM holding Opus. Node cannot decode Opus, so the packets are taken out of the container (a small
// reader of just the parts of Matroska that matter here) and given to a WebAssembly build of libopus. Decoding goes a
// second of sound at a time with a turn for everything else in between, so a track being measured never holds up the
// voice channel's messages. Anything unexpected is "not measured" (null): the track is then played as it is.

import { readFile } from 'node:fs/promises';

import { OpusDecoder } from 'opus-decoder';

/** The level every track is brought to, in LUFS. Streaming services use -14 to -16; this keeps what was heard before. */
export const TARGET_LUFS = -14;
/** How far a track is turned down or up at most, in dB. */
const MAX_CUT_DB = 15;
const MAX_BOOST_DB = 9;
/** A boost never takes the loudest sample closer to full scale than this, in dB: past it the sound would clip. */
const HEADROOM_DB = 1.5;

const RATE = 48_000;

// --------------------------------------------------------------------------------------------------- the container

// The elements that hold others, which are stepped into rather than over: Segment, Tracks, TrackEntry, Audio, Cluster
// and BlockGroup. (Stepping into them, instead of tracking where each ends, also copes with one whose size is not
// written down, which is allowed for a stream.)
const CONTAINERS = new Set([0x18538067, 0x1654ae6b, 0xae, 0xe1, 0x1f43b675, 0xa0]);
const SIMPLE_BLOCK = 0xa3;
const BLOCK = 0xa1;
const CODEC_PRIVATE = 0x63a2;
const CHANNELS = 0x9f;

/** A variable-length integer at `at`: its length, its value, and whether it was the "unknown" all-ones value. */
function vint(bytes, at, keepMarker) {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (!(first & (0x80 >> (length - 1)))) length += 1;
  if (at + length > bytes.length || length > 8) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let ones = (first & (0xff >> length)) === (0xff >> length);
  for (let i = 1; i < length; i += 1) {
    value = value * 256 + bytes[at + i];
    if (bytes[at + i] !== 0xff) ones = false;
  }
  return { length, value, unknown: !keepMarker && ones };
}

/**
 * The Opus packets of a WebM file, in order, and how many channels it has.
 * @param {Uint8Array} bytes
 * @returns {{frames: Uint8Array[], channels: number}|null}  null: not something this can read
 */
export function opusFramesOf(bytes) {
  const frames = [];
  let channels = 0;
  let at = 0;
  while (at < bytes.length) {
    const id = vint(bytes, at, true);
    if (!id) return frames.length ? { frames, channels } : null;
    const size = vint(bytes, at + id.length, false);
    if (!size) return frames.length ? { frames, channels } : null;
    const start = at + id.length + size.length;
    if (CONTAINERS.has(id.value)) {
      at = start;
      continue;
    }
    if (size.unknown) return null;
    const end = start + size.value;
    if (end > bytes.length) break;
    if (id.value === CODEC_PRIVATE && size.value >= 19 && String.fromCharCode(...bytes.subarray(start, start + 8)) === 'OpusHead') {
      // Channel mapping family 0 is mono or stereo, which is all that is read.
      if (bytes[start + 18] !== 0) return null;
      channels = bytes[start + 9];
    } else if (id.value === CHANNELS && !channels) {
      channels = bytes[start];
    } else if (id.value === SIMPLE_BLOCK || id.value === BLOCK) {
      const track = vint(bytes, start, false);
      if (track) {
        const flags = bytes[start + track.length + 2];
        // Laced blocks (several packets in one) do not occur in what YouTube serves.
        if (flags & 0x06) return null;
        frames.push(bytes.subarray(start + track.length + 3, end));
      }
    }
    at = end;
  }
  return frames.length ? { frames, channels } : null;
}

// ----------------------------------------------------------------------------------------------------- the meter

/** BS.1770's K-weighting: a shelf that lifts the highs a little, then a high-pass, at 48 kHz. */
const SHELF = { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [-1.69065929318241, 0.73248077421585] };
const HIGH_PASS = { b: [1, -2, 1], a: [-1.99004745483398, 0.99007225036621] };

class Biquad {
  #c;
  #z1 = 0;
  #z2 = 0;

  constructor(c) {
    this.#c = c;
  }

  next(x) {
    const { b, a } = this.#c;
    const y = b[0] * x + this.#z1;
    this.#z1 = b[1] * x - a[0] * y + this.#z2;
    this.#z2 = b[2] * x - a[1] * y;
    return y;
  }
}

const BLOCK_SAMPLES = RATE / 10; // 100 ms: four of them make a 400 ms gating block, overlapping by 75%

/** Integrated loudness and the loudest sample, from channels of samples fed in as they are decoded. */
export class Meter {
  #filters;
  #sum = 0;
  #count = 0;
  #blocks = []; // the mean square of each 100 ms, summed over the channels
  #peak = 0;

  constructor(channels) {
    this.#filters = Array.from({ length: channels }, () => [new Biquad(SHELF), new Biquad(HIGH_PASS)]);
  }

  /** @param {Float32Array[]} channelData */
  push(channelData) {
    const n = channelData[0].length;
    for (let i = 0; i < n; i += 1) {
      for (let c = 0; c < this.#filters.length; c += 1) {
        const x = channelData[c][i];
        const abs = Math.abs(x);
        if (abs > this.#peak) this.#peak = abs;
        const y = this.#filters[c][1].next(this.#filters[c][0].next(x));
        this.#sum += y * y;
      }
      this.#count += 1;
      if (this.#count === BLOCK_SAMPLES) {
        this.#blocks.push(this.#sum / BLOCK_SAMPLES);
        this.#sum = 0;
        this.#count = 0;
      }
    }
  }

  /** @returns {{lufs: number, peakDb: number}|null}  null: nothing was loud enough to measure */
  result() {
    const energy = (e) => -0.691 + 10 * Math.log10(e);
    const gating = [];
    for (let i = 0; i + 4 <= this.#blocks.length; i += 1) {
      gating.push((this.#blocks[i] + this.#blocks[i + 1] + this.#blocks[i + 2] + this.#blocks[i + 3]) / 4);
    }
    // Below -70 LUFS is silence, and is not counted at all.
    const heard = gating.filter((e) => e > 0 && energy(e) > -70);
    if (!heard.length) return null;
    // And what is more than 10 LU under the average of what is left is a quiet passage that would drag the number down.
    const relative = energy(heard.reduce((a, e) => a + e, 0) / heard.length) - 10;
    const kept = heard.filter((e) => energy(e) > relative);
    if (!kept.length) return null;
    return {
      lufs: energy(kept.reduce((a, e) => a + e, 0) / kept.length),
      peakDb: this.#peak > 0 ? 20 * Math.log10(this.#peak) : -Infinity,
    };
  }
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Measure a track.
 * @param {string} path  a WebM file holding Opus
 * @returns {Promise<{lufs: number, peakDb: number}|null>}  null: it could not be measured
 */
export async function measureFile(path) {
  let decoder;
  try {
    const found = opusFramesOf(await readFile(path));
    if (!found || ![1, 2].includes(found.channels)) return null;
    decoder = new OpusDecoder({ channels: found.channels, sampleRate: RATE, streamCount: 1, coupledStreamCount: found.channels - 1 });
    await decoder.ready;
    const meter = new Meter(found.channels);
    for (let i = 0; i < found.frames.length; i += 1) {
      const out = decoder.decodeFrame(found.frames[i]);
      if (out.samplesDecoded > 0) meter.push(out.channelData);
      // About a second of sound between turns for the rest of the server.
      if (i % 50 === 49) await turn(); // eslint-disable-line no-await-in-loop
    }
    return meter.result();
  } catch {
    return null;
  } finally {
    try { decoder?.free(); } catch { /* already gone */ }
  }
}

/**
 * The gain, in dB, that brings a measured track to the common level -- or null for a track that was not measured.
 * A quiet track is only turned up as far as its loudest sample allows.
 * @param {{lufs: number, peakDb: number}|null} loudness
 */
export function gainDbFor(loudness) {
  if (!loudness || !Number.isFinite(loudness.lufs)) return null;
  let gain = TARGET_LUFS - loudness.lufs;
  if (gain > 0 && Number.isFinite(loudness.peakDb)) gain = Math.min(gain, Math.max(0, -HEADROOM_DB - loudness.peakDb));
  gain = Math.max(-MAX_CUT_DB, Math.min(MAX_BOOST_DB, gain));
  return Math.round(gain * 10) / 10;
}
