// The microphone's strong noise suppression: RNNoise, and a gate that follows its idea of
// whether somebody is talking.
//
// RNNoise takes 10 ms of 48 kHz sound at a time and gives it back with what is not a
// voice taken out -- a keyboard, a mouse, a fan, a room -- and says how sure it is that
// there was a voice in it. What it takes out of a keystroke is not always all of it, so the
// answer is used a second time: a stretch it is sure has no voice in it is turned down, and
// turned back up before the first word is lost.
//
// No audio context, no thread of its own: the frames of the track pass through here in
// the microphone worker (gate-worker.js), and the answer is as late as 10 ms.
//
// RNNoise itself is rnnoise/rnnoise-sync.js, loaded only when this is asked for.

/** RNNoise works on 480 samples at a time, which at 48 kHz is 10 ms. */
export const FRAME = 480;
export const RATE = 48000;

/** Below this a frame has no voice in it as far as the gate is concerned; above HIGH there is one. */
const VOICE_LOW = 0.2;
const VOICE_HIGH = 0.5;
/** A voice's end stays through this many frames (10 ms each): the tail of a word is not a voice to RNNoise. */
const HOLD_FRAMES = 12;
/** How fast the gate opens and closes, as the share of the way it goes in each frame. */
const OPEN_SHARE = 0.7;
const CLOSE_SHARE = 0.12;
/** What is left of a stretch with no voice: not silence, which a listener hears as the line dying. */
const FLOOR = 0.02;
/** Int16's range: what RNNoise's network was trained on. */
const SCALE = 32768;

/** Load RNNoise: its module, with the memory it needs. Rejects if it cannot run here. */
export async function loadRnnoise() {
  const { default: create } = await import('./rnnoise/rnnoise-sync.js');
  const module = create();
  if (module?.ready) await module.ready;
  if (typeof module?._rnnoise_process_frame !== 'function') throw new Error('RNNoise did not load');
  return module;
}

/** What is quieter than this, all through a frame, is silence: a muted microphone's frames are exactly that. */
const SILENT = 1e-6;
const RING = 16384;

/**
 * @param {object} module  from loadRnnoise()
 * @param {{follow?: boolean}} [options]  `follow`: also turn down what RNNoise says has no voice (the default)
 * @returns {{process: (mono: Float32Array, out?: Float32Array) => Float32Array, voice: number, close: () => void}}
 */
export function createDenoiser(module, { follow = true } = {}) {
  const state = module._rnnoise_create(0);
  const pointer = module._malloc(FRAME * 4);
  const at = pointer >> 2;

  const pending = new Float32Array(FRAME);
  const cleaned = new Float32Array(FRAME);
  let filled = 0;

  // What has been processed and not yet handed back, in a ring: nothing is allocated per frame. Primed
  // with one frame of silence so that a piece that is not a multiple of 480 samples is never short.
  const ring = new Float32Array(RING);
  let readAt = 0;
  let writeAt = FRAME;
  let queued = FRAME;

  // Not following the voice is no gate at all: the sound goes through as RNNoise left it.
  let gain = follow ? 0 : 1;
  let hold = 0;
  let voice = 0;

  function enqueue(frame) {
    const first = Math.min(FRAME, RING - writeAt);
    ring.set(first === FRAME ? frame : frame.subarray(0, first), writeAt);
    if (first < FRAME) ring.set(frame.subarray(first), 0);
    writeAt = (writeAt + FRAME) % RING;
    queued += FRAME;
  }

  function dequeue(out) {
    const take = Math.min(out.length, queued);
    const first = Math.min(take, RING - readAt);
    out.set(ring.subarray(readAt, readAt + first), 0);
    if (first < take) out.set(ring.subarray(0, take - first), first);
    if (take < out.length) out.fill(0, take);
    readAt = (readAt + take) % RING;
    queued -= take;
  }

  function frame() {
    // A frame with nothing in it -- a muted microphone sends exactly that, all day -- is not worth the
    // network: it comes out as it went in, and RNNoise carries on from where it was.
    let peak = 0;
    for (let i = 0; i < FRAME; i += 1) {
      const v = pending[i] < 0 ? -pending[i] : pending[i];
      if (v > peak) peak = v;
    }
    if (peak < SILENT) {
      voice = 0;
      hold = 0;
      gain = follow ? 0 : 1;
      cleaned.fill(0);
      enqueue(cleaned);
      return;
    }

    const heap = module.HEAPF32;
    for (let i = 0; i < FRAME; i += 1) heap[at + i] = pending[i] * SCALE;
    voice = module._rnnoise_process_frame(state, pointer, pointer);

    let target = 1;
    if (follow) {
      if (voice >= VOICE_HIGH) hold = HOLD_FRAMES;
      else if (hold > 0) hold -= 1;
      const wanted = hold > 0 ? 1 : Math.min(1, Math.max(0, (voice - VOICE_LOW) / (VOICE_HIGH - VOICE_LOW)));
      target = Math.max(FLOOR, wanted);
    }
    const from = gain;
    if (follow) gain += (target - gain) * (target > gain ? OPEN_SHARE : CLOSE_SHARE);

    // Read the heap again: growing the module's memory replaces the array.
    const out = module.HEAPF32;
    const step = (gain - from) / FRAME;
    let g = from;
    for (let i = 0; i < FRAME; i += 1) {
      g += step;
      cleaned[i] = (out[at + i] / SCALE) * g;
    }
    enqueue(cleaned);
  }

  return {
    /** The latest answer of RNNoise to "is there a voice": 0 to 1. */
    get voice() {
      return voice;
    },
    /**
     * @param {Float32Array} mono  the sound, mono, at 48 kHz, in -1..1
     * @param {Float32Array} [out]  where to put the answer, the same length (made if not given)
     */
    process(mono, out = new Float32Array(mono.length)) {
      let i = 0;
      while (i < mono.length) {
        const take = Math.min(FRAME - filled, mono.length - i);
        pending.set(take === mono.length ? mono : mono.subarray(i, i + take), filled);
        filled += take;
        i += take;
        if (filled === FRAME) {
          filled = 0;
          frame();
        }
      }
      // Always enough: one frame was queued at the start and each frame in adds one out.
      dequeue(out);
      return out;
    },
    close() {
      module._free?.(pointer);
      module._rnnoise_destroy?.(state);
    },
  };
}
