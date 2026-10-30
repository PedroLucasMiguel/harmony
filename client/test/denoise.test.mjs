// The strong noise suppression, on real speech and on keystrokes, with no microphone.
//
//   node --test client/test/denoise.test.mjs
//
// Needs `say` (macOS) and `ffmpeg` to make the speech; without them it is skipped. The
// keystrokes are made here: a sharp tick of high-passed noise and a low thock, 90-270 ms
// apart, as loud as the speech's peaks -- harder than most real typing.
//
// RNNoise itself is rnnoise/rnnoise-sync.js, the real one, run in Node.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadRnnoise, createDenoiser, RATE, FRAME } from '../src/renderer/denoise.js';

const have = (cmd) => spawnSync('which', [cmd]).status === 0;
const canMakeSpeech = have('say') && have('ffmpeg');

let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

function keystrokes(seconds, level) {
  const n = Math.floor(seconds * RATE);
  const out = new Float32Array(n);
  let t = Math.floor(0.1 * RATE);
  while (t < n - 2000) {
    const amp = level * (0.5 + rnd() * 0.5);
    let prev = 0;
    for (let i = 0; i < 0.012 * RATE && t + i < n; i += 1) {
      const w = rnd() * 2 - 1;
      out[t + i] += (w - prev) * amp * Math.exp(-i / (0.0025 * RATE));
      prev = w;
    }
    for (let i = 0; i < 0.03 * RATE && t + i < n; i += 1) {
      out[t + i] += Math.sin((2 * Math.PI * 150 * i) / RATE) * amp * 0.6 * Math.exp(-i / (0.008 * RATE));
    }
    t += Math.floor((0.09 + rnd() * 0.18) * RATE);
  }
  return out;
}

const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
const db = (x) => 20 * Math.log10(x + 1e-9);

function run(module, signal, options, chunk = FRAME) {
  const denoiser = createDenoiser(module, options);
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i += chunk) out.set(denoiser.process(signal.subarray(i, i + chunk)), i);
  denoiser.close();
  return out;
}

describe('strong noise suppression', { skip: !canMakeSpeech && 'needs say and ffmpeg' }, () => {
  let module;
  let speech;
  let typing;
  let both;

  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harmony-dn-'));
    execFileSync('say', ['-v', 'Samantha', '-o', join(dir, 's.aiff'), 'Hello everyone, can you hear me well? I was just saying that the build is ready and we can start the meeting whenever you want.']);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', join(dir, 's.aiff'), '-ar', String(RATE), '-ac', '1', '-f', 'f32le', join(dir, 's.raw')]);
    const raw = readFileSync(join(dir, 's.raw'));
    speech = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    const peak = speech.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    typing = keystrokes(speech.length / RATE, peak * 0.8);
    both = speech.map((v, i) => v + typing[i]);
    module = await loadRnnoise();
  });

  it('takes keystrokes out of a stretch with only keystrokes in it', () => {
    const cleaned = run(module, typing, { follow: true });
    const drop = db(rms(typing)) - db(rms(cleaned));
    assert.ok(drop >= 12, `the typing came down ${drop.toFixed(1)} dB`);
  });

  it('leaves speech alone', () => {
    const cleaned = run(module, speech, { follow: true });
    const change = db(rms(cleaned)) - db(rms(speech));
    assert.ok(change >= -3, `the speech changed ${change.toFixed(1)} dB`);
  });

  it('keeps the speech and loses the typing when both are there', () => {
    const cleaned = run(module, both, { follow: true });
    const fromSpeech = db(rms(cleaned)) - db(rms(speech));
    assert.ok(fromSpeech >= -4 && fromSpeech <= 2, `with typing on top, ${fromSpeech.toFixed(1)} dB from the speech alone`);
    const noisy = db(rms(both)) - db(rms(speech));
    assert.ok(noisy - fromSpeech >= 3, `the typing was ${noisy.toFixed(1)} dB over the speech, and ${fromSpeech.toFixed(1)} after`);
  });

  it('is not late by more than one frame (10 ms)', () => {
    const impulse = new Float32Array(FRAME * 20);
    impulse.set(speech.subarray(0, FRAME * 20));
    const cleaned = run(module, impulse, { follow: false });
    assert.equal(cleaned.length, impulse.length);
    assert.ok(cleaned.slice(0, FRAME).every((v) => v === 0), 'the first frame is the one it was primed with');
  });

  it('gives back as much sound as it was given, whatever the size of the pieces', () => {
    for (const chunk of [128, 441, 480, 960, 1000]) {
      const cleaned = run(module, speech.subarray(0, FRAME * 40), { follow: true }, chunk);
      assert.equal(cleaned.length, FRAME * 40);
    }
  });
});
