// The framing of the strong noise suppression -- 480 samples at a time, a frame late, silence
// skipped, the gate that follows the voice -- against a stand-in for RNNoise that hands the
// sound back as it got it. Nothing of RNNoise runs here; test/denoise.test.mjs has the real one.
//
//   node --test client/test/denoise-framing.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createDenoiser, FRAME } from '../src/renderer/denoise.js';

/** What the module of RNNoise offers, with the sound handed back unchanged and a voice as sure as it is told to be. */
function standIn({ voice = 1 } = {}) {
  const heap = new Float32Array(FRAME * 4);
  const module = {
    HEAPF32: heap,
    calls: 0,
    voice,
    _rnnoise_create: () => 1,
    _rnnoise_destroy: () => {},
    _malloc: () => FRAME * 4, // byte offset 1920: element 480
    _free: () => {},
    _rnnoise_process_frame: () => {
      module.calls += 1;
      return module.voice;
    },
  };
  return module;
}

const ramp = (n, from = 1) => Float32Array.from({ length: n }, (_, i) => ((i + from) % 997) / 1000 + 0.01);

function through(denoiser, signal, chunk) {
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i += chunk) out.set(denoiser.process(signal.subarray(i, i + chunk)), i);
  return out;
}

describe('the framing of the noise suppression', () => {
  it('gives the sound back one frame late, whatever the size of the pieces it came in', () => {
    const signal = ramp(FRAME * 12);
    for (const chunk of [1, 128, 441, 480, 960, 1000, FRAME * 12]) {
      const denoiser = createDenoiser(standIn(), { follow: false });
      const out = through(denoiser, signal, chunk);
      assert.equal(out.length, signal.length);
      for (let i = 0; i < FRAME; i += 1) assert.equal(out[i], 0, `chunk ${chunk}: the first frame is the silence it was primed with`);
      for (let i = FRAME; i < signal.length; i += 1) {
        assert.ok(Math.abs(out[i] - signal[i - FRAME]) < 1e-6, `chunk ${chunk}: sample ${i} is the one from a frame before`);
      }
    }
  });

  it('can write the answer where it is told to', () => {
    const denoiser = createDenoiser(standIn(), { follow: false });
    const out = new Float32Array(FRAME);
    const back = denoiser.process(ramp(FRAME), out);
    assert.equal(back, out);
  });

  it('does not ask RNNoise about a frame with nothing in it', () => {
    const module = standIn();
    const denoiser = createDenoiser(module, { follow: false });
    through(denoiser, new Float32Array(FRAME * 50), FRAME);
    assert.equal(module.calls, 0);
    through(denoiser, ramp(FRAME * 3), FRAME);
    assert.equal(module.calls, 3);
  });

  it('turns down what RNNoise says has no voice in it, and not the first words after', () => {
    const module = standIn({ voice: 0 });
    const denoiser = createDenoiser(module, { follow: true });
    const loud = ramp(FRAME * 30);
    const quiet = through(denoiser, loud, FRAME);
    const tail = quiet.slice(FRAME * 25);
    assert.ok(Math.max(...tail.map(Math.abs)) < 0.03, 'no voice: down to the floor');

    module.voice = 1;
    const back = through(denoiser, loud, FRAME);
    // A frame later it is on its way up, and well up soon after: nothing of the first word is lost.
    assert.ok(back.slice(FRAME * 2, FRAME * 3).some((v) => Math.abs(v) > 0.3), 'the voice comes back in two frames');
  });

  it('holds a voice open for a little after it stops saying so', () => {
    const module = standIn({ voice: 1 });
    const denoiser = createDenoiser(module, { follow: true });
    through(denoiser, ramp(FRAME * 10), FRAME);
    module.voice = 0;
    const out = through(denoiser, ramp(FRAME * 8), FRAME);
    // Eight frames after it stopped: still through (the hold is twelve).
    assert.ok(out.slice(FRAME * 6, FRAME * 7).some((v) => Math.abs(v) > 0.3), 'the end of a word is not cut');
  });

  it('keeps no memory of what it was asked to forget: close releases what it took', () => {
    const module = standIn();
    let freed = 0;
    let destroyed = 0;
    module._free = () => { freed += 1; };
    module._rnnoise_destroy = () => { destroyed += 1; };
    createDenoiser(module).close();
    assert.deepEqual([freed, destroyed], [1, 1]);
  });
});
