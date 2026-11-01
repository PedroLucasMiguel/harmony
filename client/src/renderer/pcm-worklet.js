// Plays interleaved S16LE stereo PCM pushed in from the native capture.
//
// Runs on the audio thread, so it must never allocate unpredictably or block.
// The design is a chunk queue: audio arrives over IPC in bursts that do not
// line up with the 128-frame render quantum, so some buffering is unavoidable.
//
// What the queue holds is delay on the sound, and nothing else takes it back
// out. A page that stalls for a moment (a game taking the processor) delivers
// the audio late and all at once; the audio that was waiting then plays out as
// a backlog that stays a backlog, because audio arrives in real time and is
// played in real time. Every stall longer than the backlog already there makes
// it longer, hour after hour, and the sound falls behind the picture by that
// much (measured on the file as it was: a 150 ms stall every ten minutes left
// the sound 160 ms behind for the rest of a three-hour run).
//
// So the queue is brought back down: while it holds more than it needs, the
// audio is played 3% faster -- interpolated, so there are no clicks and a
// pitch change of half a semitone -- until it is back near live (6% when the
// backlog is large). A backlog of 150 ms is gone in five seconds. The hard cap
// below is for the case where even that is too slow.
//
// And the first thing it does is forget what was waiting before it started. A
// share's audio is captured before the page's audio context is running (a
// context that starts suspended can stay so for seconds), and everything
// delivered meanwhile was queued: the sound then began a quarter of a second
// behind the picture and stayed there, some shares and not others, until the
// share was stopped and started again.

const MAX_QUEUED_FRAMES = 48000 * 0.25; // 250 ms at 48 kHz: past this, drop the oldest audio
const TARGET_QUEUED_FRAMES = 48000 * 0.04; // catching up ends, and a drop ends, at 40 ms
const CATCH_UP_FROM_FRAMES = 48000 * 0.08; // catching up starts above 80 ms: more than two chunks' worth
const CATCH_UP_RATE = 1.03;
const CATCH_UP_FAST_FROM_FRAMES = 48000 * 0.16; // a backlog this big is caught up with at twice the rate
const CATCH_UP_FAST_RATE = 1.06;

class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    /** @type {{left: Float32Array, right: Float32Array}[]} */
    this.chunks = [];
    /** Where the next sample comes from, in frames into the first chunk; fractional while catching up. */
    this.readPos = 0;
    /** Frames in all the chunks, whole, whatever has been read of the first. */
    this.totalFrames = 0;
    this.catchingUp = false;
    // Whether what was waiting when playing began has been put aside (see the top of the file).
    this.primed = false;
    this.closed = false;
    // What the debug log reads: how much audio has been thrown away to stay near live, how much has been
    // played faster to get there, how much silence was played because none had arrived. Counted in frames.
    this.started = false;
    this.droppedFrames = 0;
    this.catchUpFrames = 0;
    this.underrunFrames = 0;
    this.sinceReport = 0;

    this.port.onmessage = (event) => {
      const { type, payload } = event.data;

      if (type === 'pcm') {
        this.push(payload);
      } else if (type === 'flush') {
        this.chunks.length = 0;
        this.readPos = 0;
        this.totalFrames = 0;
        this.catchingUp = false;
      } else if (type === 'close') {
        this.closed = true;
      }
    };
  }

  /** How many frames are waiting to be played. */
  get queuedFrames() {
    return this.totalFrames - this.readPos;
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
    this.totalFrames += frames;
    this.started = true;

    // Too far behind even for catching up: throw away the oldest audio rather than let the delay grow.
    if (this.queuedFrames > MAX_QUEUED_FRAMES) this.trim();
  }

  /** Throw away the oldest audio until about the target is left (always keeping the newest piece). */
  trim() {
    while (this.queuedFrames > TARGET_QUEUED_FRAMES && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.droppedFrames += dropped.left.length - Math.floor(this.readPos);
      this.totalFrames -= dropped.left.length;
      this.readPos = 0;
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const outL = output[0];
    const outR = output[1] ?? output[0];
    const need = outL.length;

    // Faster while there is more than is needed, until there is not: two thresholds, so it does not
    // flutter on and off around one.
    if (!this.primed && this.chunks.length > 0) {
      this.primed = true;
      this.trim();
    }
    const queued = this.queuedFrames;
    if (queued > CATCH_UP_FROM_FRAMES) this.catchingUp = true;
    else if (queued <= TARGET_QUEUED_FRAMES) this.catchingUp = false;
    const rate = !this.catchingUp ? 1 : queued > CATCH_UP_FAST_FROM_FRAMES ? CATCH_UP_FAST_RATE : CATCH_UP_RATE;

    let written = 0;
    while (written < need && this.chunks.length > 0) {
      const chunk = this.chunks[0];
      const length = chunk.left.length;
      const at = Math.floor(this.readPos);
      const part = this.readPos - at;

      let l = chunk.left[at];
      let r = chunk.right[at];
      if (part > 0) {
        // Between two frames: the next one may be in the next chunk, or not there yet (hold this one).
        const next = at + 1 < length ? chunk : this.chunks[1];
        const index = at + 1 < length ? at + 1 : 0;
        const l2 = next ? next.left[index] : l;
        const r2 = next ? next.right[index] : r;
        l += (l2 - l) * part;
        r += (r2 - r) * part;
      }
      outL[written] = l;
      outR[written] = r;
      written++;

      this.readPos += rate;
      if (rate !== 1) this.catchUpFrames += rate - 1;
      while (this.chunks.length > 0 && this.readPos >= this.chunks[0].left.length) {
        this.readPos -= this.chunks[0].left.length;
        this.totalFrames -= this.chunks[0].left.length;
        this.chunks.shift();
      }
    }
    if (this.chunks.length === 0) {
      this.readPos = 0;
      this.totalFrames = 0;
    }

    // Underrun: emit silence. Better a brief gap than a click or a stall.
    for (let i = written; i < need; i++) {
      outL[i] = 0;
      outR[i] = 0;
    }
    if (this.started) this.underrunFrames += need - written;

    this.sinceReport += need;
    if (this.sinceReport >= sampleRate) {
      this.sinceReport = 0;
      const ms = (frames) => Math.round((frames / sampleRate) * 1000);
      this.port.postMessage({
        type: 'stats',
        queuedMs: ms(this.queuedFrames),
        droppedMs: ms(this.droppedFrames),
        catchUpMs: ms(this.catchUpFrames),
        underrunMs: ms(this.underrunFrames),
      });
    }

    return !this.closed;
  }
}

registerProcessor('pcm-player', PcmPlayer);
