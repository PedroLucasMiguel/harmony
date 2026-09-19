// Plays interleaved S16LE stereo PCM pushed in from the native capture.
//
// Runs on the audio thread, so it must never allocate unpredictably or block.
// The design is a plain chunk queue with a hard cap: audio arrives over IPC in
// bursts that do not line up with the 128-frame render quantum, so some
// buffering is unavoidable, but an unbounded queue would turn a momentary
// hiccup into permanent lip-sync drift. When the queue runs long we drop the
// oldest audio and keep latency bounded instead.

const MAX_QUEUED_FRAMES = 48000 * 0.4; // 400 ms at 48 kHz
const TARGET_QUEUED_FRAMES = 48000 * 0.1; // drain back to 100 ms

class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    /** @type {{left: Float32Array, right: Float32Array}[]} */
    this.chunks = [];
    this.readOffset = 0;
    this.queuedFrames = 0;
    this.closed = false;

    this.port.onmessage = (event) => {
      const { type, payload } = event.data;

      if (type === 'pcm') {
        this.push(payload);
      } else if (type === 'flush') {
        this.chunks.length = 0;
        this.readOffset = 0;
        this.queuedFrames = 0;
      } else if (type === 'close') {
        this.closed = true;
      }
    };
  }

  /** @param {ArrayBuffer} buffer interleaved S16LE stereo */
  push(buffer) {
    const samples = new Int16Array(buffer);
    const frames = samples.length >> 1;
    if (frames === 0) return;

    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let i = 0, j = 0; i < frames; i++, j += 2) {
      left[i] = samples[j] / 32768;
      right[i] = samples[j + 1] / 32768;
    }

    this.chunks.push({ left, right });
    this.queuedFrames += frames;

    // Too far behind: throw away the oldest audio rather than let the delay grow.
    while (this.queuedFrames > MAX_QUEUED_FRAMES && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.queuedFrames -= dropped.left.length - this.readOffset;
      this.readOffset = 0;
      if (this.queuedFrames <= TARGET_QUEUED_FRAMES) break;
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const outL = output[0];
    const outR = output[1] ?? output[0];
    const need = outL.length;

    let written = 0;
    while (written < need && this.chunks.length > 0) {
      const chunk = this.chunks[0];
      const available = chunk.left.length - this.readOffset;
      const take = Math.min(available, need - written);

      for (let i = 0; i < take; i++) {
        outL[written + i] = chunk.left[this.readOffset + i];
        outR[written + i] = chunk.right[this.readOffset + i];
      }

      written += take;
      this.readOffset += take;
      this.queuedFrames -= take;

      if (this.readOffset >= chunk.left.length) {
        this.chunks.shift();
        this.readOffset = 0;
      }
    }

    // Underrun: emit silence. Better a brief gap than a click or a stall.
    for (let i = written; i < need; i++) {
      outL[i] = 0;
      outR[i] = 0;
    }

    return !this.closed;
  }
}

registerProcessor('pcm-player', PcmPlayer);
