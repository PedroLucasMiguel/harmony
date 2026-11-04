// The automatic gain control and the automatic sensitivity (renderer/mic-dsp.js) on synthetic sound.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoThreshold, Agc, softLimit, AUTO_MIN, AUTO_MAX, AGC_MAX_GAIN, AGC_MIN_GAIN } from '../src/renderer/mic-dsp.js';

const STEP = 0.01; // 10 ms pieces, as the worker gets them

/** Feed `seconds` of a steady level to a function of (level) and return the last answer. */
function feed(seconds, level, each) {
  let last;
  for (let t = 0; t < seconds; t += STEP) last = each(level, STEP);
  return last;
}

/** Talking and pausing: `voice` for 0.8 s, `room` for 0.3 s, over and over. */
function talk(seconds, room, voice, each) {
  let last;
  let t = 0;
  while (t < seconds) {
    last = feed(0.8, voice, each);
    last = feed(0.3, room, each);
    t += 1.1;
  }
  return last;
}

test('the automatic threshold sits between a quiet room and a voice', () => {
  const auto = new AutoThreshold();
  const found = talk(12, 0.002, 0.1, (l, s) => auto.update(l, s));
  assert.ok(found > 0.002 * 1.5, `above the room: ${found}`);
  assert.ok(found < 0.1 * 0.4, `below the voice: ${found}`);
});

test('a noisy room gets a higher threshold than a quiet one', () => {
  const quiet = new AutoThreshold();
  const noisy = new AutoThreshold();
  const q = talk(12, 0.002, 0.1, (l, s) => quiet.update(l, s));
  const n = talk(12, 0.02, 0.15, (l, s) => noisy.update(l, s));
  assert.ok(n > q * 3, `${n} against ${q}`);
  assert.ok(n > 0.02, 'and above the noise itself');
});

test('a quiet voice is still above the threshold', () => {
  // The case of a voice at 0.006 in a room at 0.001: the old fixed threshold of about 0.0047 cut it.
  const auto = new AutoThreshold();
  const found = talk(12, 0.001, 0.006, (l, s) => auto.update(l, s));
  assert.ok(found < 0.006, `the voice gets through: ${found}`);
  assert.ok(found > 0.001, `the room does not: ${found}`);
});

test('it follows a room that gets louder, and one that gets quieter', () => {
  const auto = new AutoThreshold();
  const before = talk(12, 0.002, 0.1, (l, s) => auto.update(l, s));
  const louder = talk(24, 0.01, 0.1, (l, s) => auto.update(l, s));
  assert.ok(louder > before * 2, `${louder} against ${before}`);
  const quieter = talk(24, 0.001, 0.1, (l, s) => auto.update(l, s));
  assert.ok(quieter < louder / 2, `${quieter} against ${louder}`);
});

test('a speaker who never pauses for a while does not close the gate on themselves', () => {
  const auto = new AutoThreshold();
  talk(10, 0.002, 0.1, (l, s) => auto.update(l, s));
  // Eight seconds of nothing but voice: the room has not been heard for as long as the memory goes back.
  const found = feed(7, 0.1, (l, s) => auto.update(l, s));
  assert.ok(found < 0.1, `still below the voice: ${found}`);
});

test('the threshold stays inside its limits', () => {
  const dead = new AutoThreshold();
  assert.equal(feed(5, 0, (l, s) => dead.update(l, s)), AUTO_MIN);
  const loud = new AutoThreshold();
  assert.ok(feed(12, 0.5, (l, s) => loud.update(l, s)) <= AUTO_MAX);
});

/** One piece through the control: the gain it ends on, and the level that comes out. */
const run = (agc, level) => (l, s) => agc.next(l, l * 1.5, s).to;

test('a quiet voice is brought up to a usable level', () => {
  const agc = new Agc();
  talk(1.2, 0.0005, 0.01, run(agc));
  const gain = talk(20, 0.0005, 0.01, run(agc));
  assert.ok(gain > 7 && gain < 12, `about ten times: ${gain}`);
  assert.ok(0.01 * gain > 0.07 && 0.01 * gain < 0.13, 'which puts the voice at about -20 dBFS');
});

test('a loud voice is brought down, and never below the least gain', () => {
  const agc = new Agc();
  const gain = talk(20, 0.001, 0.4, run(agc));
  assert.ok(gain < 0.5, `down: ${gain}`);
  assert.ok(gain >= AGC_MIN_GAIN);
});

test('the gain is held in a pause, not run up on the room', () => {
  const agc = new Agc();
  talk(20, 0.0005, 0.01, run(agc));
  const after = agc.gain;
  feed(6, 0.0005, run(agc));
  assert.ok(Math.abs(agc.gain - after) < after * 0.05, `${agc.gain} against ${after}`);
});

test('it never asks for more than the room allows', () => {
  // A room at 0.01 would be brought to 0.3 by a gain of 30: it is held to what keeps the room under 0.02.
  const agc = new Agc();
  talk(20, 0.01, 0.02, run(agc));
  assert.ok(agc.gain * 0.01 <= 0.021, `the room after the gain: ${agc.gain * 0.01}`);
  assert.ok(agc.gain <= AGC_MAX_GAIN);
});

test('a click does not leave the voice after it turned down', () => {
  const agc = new Agc();
  talk(20, 0.0005, 0.01, run(agc));
  const before = agc.gain;
  const hit = agc.next(0.0005, 0.9, STEP); // a peak that would be 9 after the gain
  assert.ok(hit.to < before, 'that piece is held below the ceiling');
  assert.ok(hit.to * 0.9 <= 0.951);
  assert.ok(agc.gain >= before * 0.9, `what the voice calls for is not forgotten: ${agc.gain} against ${before}`);
});

test('the gain moves in small steps, not jumps', () => {
  const agc = new Agc();
  talk(5, 0.0005, 0.01, run(agc));
  let worst = 0;
  for (let i = 0; i < 100; i += 1) {
    const { from, to } = agc.next(0.01, 0.015, STEP);
    worst = Math.max(worst, Math.abs(Math.log10(to / from)) * 20);
  }
  assert.ok(worst < 0.5, `${worst} dB in a piece`);
});

test('the limiter squeezes and never goes over 1', () => {
  for (const x of [0.5, 0.8, 0.9, 1, 2, 10, 100]) {
    const y = softLimit(x);
    assert.ok(y <= 1 && y >= Math.min(x, 0.8), `${x} -> ${y}`);
    assert.equal(softLimit(-x), -y);
  }
  assert.equal(softLimit(0.3), 0.3);
});
