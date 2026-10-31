// How far behind the native-audio player runs, hour after hour.
//
//   node client/test/pcm-worklet.test.mjs
//
// A broadcast's sound comes from the machine's audio in small pieces over IPC, and a busy page delivers them
// late and then all at once. The player (renderer/pcm-worklet.js) is run here as the browser runs it -- its own
// file, with the audio worklet's few globals stood in for -- fed what a stalling page would feed it, for hours
// of simulated time, and asked how much older than live the sound it plays is.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { reporter } from './cdp.mjs';

const { check, summary } = reporter();
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'src', 'renderer', 'pcm-worklet.js'), 'utf8');

const RATE = 48000;
const QUANTUM = 128;
const CHUNK = RATE * 0.02; // 20 ms a piece, which is what the native capture hands over

/** A player, loaded the way the audio thread loads it. */
function load() {
  let Player = null;
  class AudioWorkletProcessor {
    constructor() { this.port = { onmessage: null, postMessage: () => {} }; }
  }
  const messages = [];
  vm.runInNewContext(source, { AudioWorkletProcessor, registerProcessor: (_, cls) => { Player = cls; }, sampleRate: RATE, currentFrame: 0 });
  const player = new Player();
  player.port.postMessage = (m) => messages.push(m);
  return { player, messages };
}

/** One 20 ms piece of a rising ramp, so that where in time a played sample came from can be read back. */
let produced = 0;
function piece() {
  const samples = new Int16Array(CHUNK * 2);
  for (let i = 0; i < CHUNK; i += 1) {
    const v = ((produced + i) % 30000) - 15000;
    samples[2 * i] = v; samples[2 * i + 1] = v;
  }
  produced += CHUNK;
  return samples.buffer;
}

/**
 * Plays `seconds` of live sound through a player, delivering a piece every 20 ms except while the page
 * is stalled: pieces wait, then all arrive at once. Returns, once a minute, how old the sound being played is
 * in milliseconds (the sound's age is how far its position in the live stream is behind where live has got to).
 */
function simulate(seconds, stalls) {
  const { player, messages } = load();
  produced = 0;
  const out = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
  const ages = [];
  let held = [];
  let nextPiece = 0;
  const quanta = Math.round((seconds * RATE) / QUANTUM);
  let stallIndex = 0;
  let lastValue = null;

  for (let q = 0; q < quanta; q += 1) {
    const t = (q * QUANTUM) / RATE;
    while (nextPiece <= t) {
      const buffer = piece();
      nextPiece += 0.02;
      const stalled = stalls[stallIndex] && t >= stalls[stallIndex][0] && t < stalls[stallIndex][0] + stalls[stallIndex][1];
      if (stalled) { held.push(buffer); continue; }
      if (stalls[stallIndex] && t >= stalls[stallIndex][0] + stalls[stallIndex][1]) stallIndex += 1;
      for (const b of held) player.port.onmessage({ data: { type: 'pcm', payload: b } });
      held = [];
      player.port.onmessage({ data: { type: 'pcm', payload: buffer } });
    }
    player.process([], [out]);
    // the ramp's position in the live stream, from the last sample that is not silence
    const v = out[0][QUANTUM - 1];
    if (v !== 0) lastValue = v;
    if (q % Math.round((60 * RATE) / QUANTUM) === 0 && lastValue !== null) {
      const liveFrames = produced; // frames produced so far, held or not
      const playedFrames = Math.round(lastValue * 32768 + 15000); // within a 30000 ramp: position mod 30000
      const behind = (((liveFrames - playedFrames) % 30000) + 30000) % 30000;
      ages.push(Math.round((behind / RATE) * 1000));
    }
  }
  return { ages, messages };
}

// Every ten minutes the page stalls for 150 ms, the way a game starving the renderer does.
const hours = 3;
const stalls = [];
for (let t = 600; t < hours * 3600; t += 600) stalls.push([t, 0.15]);

const { ages, messages } = simulate(hours * 3600, stalls);
const worst = Math.max(...ages);
const last = ages.at(-1);
console.log(`  age of the sound each hour: ${[0, 59, 119, 179].map((m) => `${ages[m]} ms`).join(', ')}; worst ${worst} ms`);
check('after hours of occasional stalls the sound is still close to live (under 120 ms behind)', worst < 120, `worst ${worst} ms, now ${last} ms`);
check('and it has not had to throw audio away to stay that way (no hard drops)', (messages.at(-1)?.droppedMs ?? 0) === 0, `dropped ${messages.at(-1)?.droppedMs ?? 0} ms`);

// A big stall (more than the hard cap) and then nothing for a long while: it must come back to live.
{
  const big = simulate(300, [[30, 0.7]]);
  check('a stall of 700 ms is made up for within a minute (back under 80 ms)', big.ages.slice(2).every((x) => x < 80), `${big.ages.join(', ')} ms`);
}

// No stalls at all: the player must do what it always did -- never catch up, and play every sample as it came.
{
  const { player, messages } = load();
  produced = 0;
  const out = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
  let nextPiece = 0;
  let exact = true;
  const played = [];
  // a stream that is running has a piece in hand already
  player.port.onmessage({ data: { type: 'pcm', payload: piece() } });
  for (let q = 0; q < Math.round((120 * RATE) / QUANTUM); q += 1) {
    const t = (q * QUANTUM) / RATE;
    while (nextPiece <= t) { player.port.onmessage({ data: { type: 'pcm', payload: piece() } }); nextPiece += 0.02; }
    player.process([], [out]);
    for (const v of out[0]) played.push(v);
  }
  // the ramp, as it was produced: every non-silent sample is the previous one plus one step (wrapping)
  let prev = null;
  for (const v of played) {
    if (prev === null && v === 0) continue; // the silence before the first piece arrives
    if (prev !== null) {
      const step = Math.round((v - prev) * 32768);
      if (step !== 1 && step !== -29999) exact = false; // a gap, a repeat or a skipped sample
    }
    prev = v;
  }
  const last = messages.at(-1);
  check('with no stalls it never catches up', (last?.catchUpMs ?? 0) === 0, `caught up ${last?.catchUpMs} ms`);
  check('and plays every sample in order, untouched', exact);
}

// Catching up must not click: a steady tone played through a backlog and out of it stays smooth.
{
  const { player } = load();
  const out = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
  const tone = (n) => {
    const samples = new Int16Array(CHUNK * 2);
    for (let i = 0; i < CHUNK; i += 1) {
      const v = Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * 1000 * (n + i)) / RATE));
      samples[2 * i] = v; samples[2 * i + 1] = v;
    }
    return samples.buffer;
  };
  let n = 0;
  // 400 ms of tone in one go (a backlog), then a piece every 20 ms
  for (let k = 0; k < 20; k += 1) { player.port.onmessage({ data: { type: 'pcm', payload: tone(n) } }); n += CHUNK; }
  let nextPiece = 0;
  let worstStep = 0;
  let last = null;
  let catching = 0;
  for (let q = 0; q < Math.round((12 * RATE) / QUANTUM); q += 1) {
    const t = (q * QUANTUM) / RATE;
    while (nextPiece <= t) { player.port.onmessage({ data: { type: 'pcm', payload: tone(n) } }); n += CHUNK; nextPiece += 0.02; }
    player.process([], [out]);
    if (player.catchingUp) catching += 1;
    for (const v of out[0]) {
      if (last !== null) worstStep = Math.max(worstStep, Math.abs(v - last));
      last = v;
    }
  }
  // a 1 kHz tone at 0.5 moves at most 0.0654 a sample; 3% faster, at most 0.0674
  check('catching up from a 400 ms backlog stays smooth: no sample jumps more than the tone itself does', catching > 0 && worstStep < 0.075, `worst step ${worstStep.toFixed(4)} over ${catching} quanta of catching up`);
}

const failed = summary();
process.exit(failed ? 1 : 0);
