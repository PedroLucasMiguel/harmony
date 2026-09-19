// A rolling buffer of the last N seconds of a stream, saved on demand as MP4.
//
// The frames are taken with WebRTC's encoded transform, which hands over media
// that is *already* encoded: outgoing frames after the encoder, incoming frames
// before the decoder. Nothing is re-encoded, so the cost is a memcpy of roughly
// the stream's bitrate and the memory is exactly bitrate x duration. Recording
// the same thing with MediaRecorder would mean a full extra H.264 encode per
// feed, which is precisely what you cannot afford while watching four tiles and
// broadcasting at the same time.
//
// Frames arrive as Annex-B H.264 (start codes, SPS/PPS in-band on keyframes)
// and Opus; MP4 wants length-prefixed AVCC plus an avcC header, which is most of
// what this file does.

import { Muxer, ArrayBufferTarget } from './vendor/mp4-muxer/build/mp4-muxer.mjs';

export const CLIP_SECONDS = 30;

const VIDEO_CLOCK = 90000; // RTP units per second for H.264
const AUDIO_CLOCK = 48000; // ...and for Opus
const RTP_WRAP = 0x100000000;

/** Per stream, so one runaway feed cannot exhaust memory on its own. */
const MAX_BYTES = 192 * 1024 * 1024;

// ---------------------------------------------------------------------------
// H.264 Annex-B helpers
// ---------------------------------------------------------------------------

/** Yield [start, end) of each NAL unit payload, skipping 3- or 4-byte start codes. */
function* nalUnits(data) {
  let i = 0;
  const n = data.length;
  let start = -1;

  while (i + 3 <= n) {
    if (data[i] === 0 && data[i + 1] === 0 && (data[i + 2] === 1 || (data[i + 2] === 0 && data[i + 3] === 1))) {
      const codeLength = data[i + 2] === 1 ? 3 : 4;
      if (start >= 0) yield [start, i];
      start = i + codeLength;
      i += codeLength;
    } else {
      i++;
    }
  }
  if (start >= 0) yield [start, n];
}

const nalType = (byte) => byte & 0x1f;
const NAL_SPS = 7;
const NAL_PPS = 8;
const NAL_AUD = 9;

/** Build an AVCDecoderConfigurationRecord (the `avcC` box payload). */
function buildAvcC(sps, pps) {
  const out = new Uint8Array(7 + 2 + sps.length + 1 + 2 + pps.length);
  let o = 0;
  out[o++] = 1; // configurationVersion
  out[o++] = sps[1]; // AVCProfileIndication
  out[o++] = sps[2]; // profile_compatibility
  out[o++] = sps[3]; // AVCLevelIndication
  out[o++] = 0xff; // 6 bits reserved + lengthSizeMinusOne = 3 (4-byte lengths)
  out[o++] = 0xe1; // 3 bits reserved + numOfSequenceParameterSets = 1
  out[o++] = (sps.length >> 8) & 0xff;
  out[o++] = sps.length & 0xff;
  out.set(sps, o);
  o += sps.length;
  out[o++] = 1; // numOfPictureParameterSets
  out[o++] = (pps.length >> 8) & 0xff;
  out[o++] = pps.length & 0xff;
  out.set(pps, o);
  return out;
}

/**
 * Convert Annex-B to AVCC, dropping parameter sets and access-unit delimiters.
 *
 * SPS/PPS belong in the avcC header rather than repeated in every sample, and
 * an AUD carries no picture data.
 */
function annexBToAvcc(data) {
  const keep = [];
  let total = 0;
  for (const [start, end] of nalUnits(data)) {
    const type = nalType(data[start]);
    if (type === NAL_SPS || type === NAL_PPS || type === NAL_AUD) continue;
    keep.push([start, end]);
    total += 4 + (end - start);
  }

  const out = new Uint8Array(total);
  let o = 0;
  for (const [start, end] of keep) {
    const length = end - start;
    out[o++] = (length >>> 24) & 0xff;
    out[o++] = (length >>> 16) & 0xff;
    out[o++] = (length >>> 8) & 0xff;
    out[o++] = length & 0xff;
    out.set(data.subarray(start, end), o);
    o += length;
  }
  return out;
}

function findParameterSets(data) {
  let sps = null;
  let pps = null;
  for (const [start, end] of nalUnits(data)) {
    const type = nalType(data[start]);
    if (type === NAL_SPS && !sps) sps = data.slice(start, end);
    else if (type === NAL_PPS && !pps) pps = data.slice(start, end);
  }
  return sps && pps ? { sps, pps } : null;
}

/** Opus packs its channel layout into the first byte of every packet. */
const opusIsStereo = (data) => (data.length > 0 ? (data[0] & 0x04) !== 0 : false);

// ---------------------------------------------------------------------------

export class ClipBuffer {
  #video = [];
  #audio = [];
  #videoBytes = 0;
  #audioBytes = 0;
  #detachers = [];
  #size = { width: 0, height: 0 };
  #unwrap = { video: { last: null, offset: 0 }, audio: { last: null, offset: 0 } };

  constructor(label = 'clip') {
    this.label = label;
  }

  get attached() {
    return this.#detachers.length > 0;
  }

  /** Seconds of footage currently held, counted from the oldest usable keyframe. */
  get seconds() {
    const first = this.#video.find((f) => f.type === 'key');
    if (!first || !this.#video.length) return 0;
    return (this.#video[this.#video.length - 1].wall - first.wall) / 1000;
  }

  get ready() {
    return this.#video.some((f) => f.type === 'key');
  }

  get bytes() {
    return this.#videoBytes + this.#audioBytes;
  }

  /**
   * Tap a sender or receiver. The frame MUST be passed through unchanged --
   * dropping one here would drop it from the actual stream.
   */
  attach(target, kind) {
    if (!target || typeof target.createEncodedStreams !== 'function') return false;

    let streams;
    try {
      streams = target.createEncodedStreams();
    } catch {
      // Already tapped, or the connection was not created with
      // encodedInsertableStreams.
      return false;
    }

    const self = this;
    const transform = new TransformStream({
      transform(frame, controller) {
        try {
          self.#push(kind, frame);
        } catch {
          // Never let a buffering fault interrupt the media path.
        }
        controller.enqueue(frame);
      },
    });

    streams.readable.pipeThrough(transform).pipeTo(streams.writable).catch(() => {});
    this.#detachers.push(() => {});
    return true;
  }

  #push(kind, frame) {
    const data = new Uint8Array(frame.data.byteLength);
    data.set(new Uint8Array(frame.data));

    const meta = frame.getMetadata?.() ?? {};
    const rtp = this.#unwrapTimestamp(kind, meta.rtpTimestamp ?? frame.timestamp);
    const entry = { data, rtp, wall: performance.now(), type: frame.type ?? 'key' };

    if (kind === 'video') {
      if (meta.width) this.#size = { width: meta.width, height: meta.height };
      this.#video.push(entry);
      this.#videoBytes += data.byteLength;
    } else {
      this.#audio.push(entry);
      this.#audioBytes += data.byteLength;
    }
    this.#prune();
  }

  /** RTP timestamps are 32-bit and wrap; make them monotonic. */
  #unwrapTimestamp(kind, value) {
    const state = this.#unwrap[kind];
    if (state.last != null && value < state.last - RTP_WRAP / 2) state.offset += RTP_WRAP;
    state.last = value;
    return value + state.offset;
  }

  #prune() {
    const cutoff = performance.now() - CLIP_SECONDS * 1000;

    while (this.#video.length && this.#video[0].wall < cutoff) {
      this.#videoBytes -= this.#video.shift().data.byteLength;
    }
    while (this.#audio.length && this.#audio[0].wall < cutoff) {
      this.#audioBytes -= this.#audio.shift().data.byteLength;
    }

    // Hard ceiling, for a stream whose bitrate is higher than expected.
    while (this.bytes > MAX_BYTES && this.#video.length > 1) {
      this.#videoBytes -= this.#video.shift().data.byteLength;
      if (this.#audio.length) this.#audioBytes -= this.#audio.shift().data.byteLength;
    }
  }

  clear() {
    this.#video = [];
    this.#audio = [];
    this.#videoBytes = 0;
    this.#audioBytes = 0;
  }

  detach() {
    this.#detachers.forEach((fn) => fn());
    this.#detachers = [];
    this.clear();
  }

  /**
   * Mux what is buffered into an MP4.
   * @returns {{data: Uint8Array, seconds: number, width: number, height: number}}
   */
  build() {
    const video = this.#video.slice();
    const audio = this.#audio.slice();

    // A clip can only begin at a keyframe -- everything before the first one is
    // undecodable on its own.
    const firstKey = video.findIndex((f) => f.type === 'key');
    if (firstKey < 0) throw new Error('No keyframe buffered yet; give it a few seconds.');

    const frames = video.slice(firstKey);
    const params = frames.map((f) => findParameterSets(f.data)).find(Boolean);
    if (!params) throw new Error('Could not read the video parameters from this stream.');

    const width = this.#size.width || 1280;
    const height = this.#size.height || 720;

    const target = new ArrayBufferTarget();
    const hasAudio = audio.length > 1;
    const muxer = new Muxer({
      target,
      fastStart: 'in-memory',
      video: { codec: 'avc', width, height },
      ...(hasAudio
        ? {
            audio: {
              codec: 'opus',
              numberOfChannels: opusIsStereo(audio[0].data) ? 2 : 1,
              sampleRate: AUDIO_CLOCK,
            },
          }
        : {}),
    });

    const avcC = buildAvcC(params.sps, params.pps);
    const videoStartRtp = frames[0].rtp;
    const videoStartWall = frames[0].wall;

    frames.forEach((frame, i) => {
      const next = frames[i + 1];
      const timestamp = ((frame.rtp - videoStartRtp) / VIDEO_CLOCK) * 1e6;
      const duration = next
        ? ((next.rtp - frame.rtp) / VIDEO_CLOCK) * 1e6
        : 1e6 / 30;
      muxer.addVideoChunkRaw(
        annexBToAvcc(frame.data),
        frame.type === 'key' ? 'key' : 'delta',
        timestamp,
        Math.max(duration, 0),
        i === 0 ? { decoderConfig: { codec: 'avc1', description: avcC } } : undefined,
      );
    });

    if (hasAudio) {
      // Audio and video carry independent RTP clocks, so they can only be
      // aligned by when their frames arrived; RTP then gives exact timing
      // within each track, without inheriting network jitter.
      //
      // MP4 requires the first sample of every track to sit at timestamp zero,
      // so rather than carrying a sub-packet offset we start from whichever
      // audio packet landed closest to the first video frame. Opus packets are
      // 20 ms, so that costs at most ~10 ms of A/V offset -- far below the
      // ~45 ms where anyone starts to notice.
      let startIndex = 0;
      let closest = Infinity;
      audio.forEach((frame, i) => {
        const delta = Math.abs(frame.wall - videoStartWall);
        if (delta < closest) {
          closest = delta;
          startIndex = i;
        }
      });

      const use = audio.slice(startIndex);
      const audioStartRtp = use[0].rtp;

      use.forEach((frame, i) => {
        const next = use[i + 1];
        const timestamp = ((frame.rtp - audioStartRtp) / AUDIO_CLOCK) * 1e6;
        const duration = next ? ((next.rtp - frame.rtp) / AUDIO_CLOCK) * 1e6 : 20_000;
        muxer.addAudioChunkRaw(frame.data, 'key', Math.max(timestamp, 0), Math.max(duration, 0));
      });
    }

    muxer.finalize();
    const last = frames[frames.length - 1];
    return {
      data: new Uint8Array(target.buffer),
      seconds: (last.rtp - videoStartRtp) / VIDEO_CLOCK,
      width,
      height,
    };
  }
}
