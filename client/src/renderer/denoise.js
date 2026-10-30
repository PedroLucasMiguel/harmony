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

/**
 * @param {object} module  from loadRnnoise()
 * @param {{follow?: boolean}} [options]  `follow`: also turn down what RNNoise says has no voice (the default)
 * @returns {{process: (mono: Float32Array) => Float32Array, voice: number, close: () => void}}
 */
export function createDenoiser(module, { follow = true } = {}) {
  const state = module._rnnoise_create(0);
  const bytes = FRAME * 4;
  const pointer = module._malloc(bytes);
  const at = pointer >> 2;

  const pending = new Float32Array(FRAME);
  let filled = 0;
  // What has been processed and not yet handed back. Primed with one frame of silence so that
  // a chunk that is not a multiple of 480 samples is never short.
  let fifo = new Float32Array(FRAME * 16);
  let read = 0;
  let write = FRAME;
  let gain = 0;
  let hold = 0;
  let voice = 0;

  const push = (value) => {
    if (write >= fifo.length) {
      // Wrapped by moving what is left to the front.
      fifo.copyWithin(0, read, write);
      write -= read;
      read = 0;
      if (write >= fifo.length) {
        const bigger = new Float32Array(fifo.length * 2);
        bigger.set(fifo.subarray(0, write));
        fifo = bigger;
      }
    }
    fifo[write] = value;
    write += 1;
  };

  function frame() {
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
    gain += (target - gain) * (target > gain ? OPEN_SHARE : CLOSE_SHARE);

    // Read the heap again: growing the module's memory replaces the array.
    const out = module.HEAPF32;
    for (let i = 0; i < FRAME; i += 1) {
      const g = from + ((gain - from) * (i + 1)) / FRAME;
      push((out[at + i] / SCALE) * g);
    }
  }

  return {
    /** The latest answer of RNNoise to "is there a voice": 0 to 1. */
    get voice() {
      return voice;
    },
    /** @param {Float32Array} mono  the sound, mono, at 48 kHz, in -1..1 */
    process(mono) {
      const out = new Float32Array(mono.length);
      for (let i = 0; i < mono.length; i += 1) {
        pending[filled] = mono[i];
        filled += 1;
        if (filled === FRAME) {
          filled = 0;
          frame();
        }
      }
      // Always enough: one frame was queued at the start and each frame in adds one out.
      for (let i = 0; i < out.length; i += 1) out[i] = read < write ? fifo[read++] : 0;
      return out;
    },
    close() {
      module._free?.(pointer);
      module._rnnoise_destroy?.(state);
    },
  };
}
