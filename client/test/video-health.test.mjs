import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  judgeVideo, VIDEO_MAX_REBUILDS, VIDEO_START_MS, VIDEO_STALL_MS,
} from '../src/renderer/video-health.js';

const stats = (framesReceived, framesDecoded, packetsReceived = framesReceived * 10) => ({ framesReceived, framesDecoded, packetsReceived });

/** Walk a subscription through a series of looks: [secondsSinceStart, stats]. */
function walk(looks) {
  let prev = null;
  const verdicts = [];
  for (const [seconds, s] of looks) {
    const out = judgeVideo(prev, s, seconds * 1000);
    prev = out.next;
    verdicts.push(out.verdict);
  }
  return verdicts;
}

test('a picture that is being drawn is fine, however long it goes on', () => {
  const looks = Array.from({ length: 12 }, (_, i) => [i * 2, stats(i * 30, i * 30)]);
  assert.ok(walk(looks).every((v) => v === 'ok'));
});

test('a still screen share is not mistaken for a black one: few frames, and those are decoded', () => {
  assert.ok(walk([[0, stats(1, 1)], [4, stats(2, 2)], [8, stats(2, 2)], [12, stats(3, 3)], [16, stats(3, 3)], [20, stats(4, 4)]]).every((v) => v === 'ok'));
});

test('frames that arrive and are not decoded make the decoder stuck, after the window', () => {
  const verdicts = walk([[0, stats(100, 100)], [2, stats(160, 100)], [4, stats(220, 100)], [VIDEO_STALL_MS / 1000 + 0.5, stats(300, 100)]]);
  assert.deepEqual(verdicts.slice(0, 3), ['ok', 'ok', 'ok']);
  assert.equal(verdicts[3], 'decoder-stuck');
});

test('nothing arriving at all is not this: that is the connection\'s to notice', () => {
  assert.ok(walk([[0, stats(10, 10)], [10, stats(10, 10)], [20, stats(10, 10)]]).every((v) => v === 'ok'));
});

test('packets and frames arriving and not one decoded since the start: it never started', () => {
  const verdicts = walk([[0, stats(0, 0, 0)], [3, stats(40, 0, 400)], [6, stats(80, 0, 800)], [VIDEO_START_MS / 1000 + 1, stats(200, 0, 2000)]]);
  assert.equal(verdicts.at(-1), 'never-started');
});

test('a few stray packets and no frames is a connection that has only just opened', () => {
  assert.ok(walk([[0, stats(0, 0, 0)], [5, stats(0, 0, 12)], [12, stats(0, 0, 20)]]).every((v) => v === 'ok'));
});

test('decoding again clears the verdict', () => {
  const verdicts = walk([[0, stats(100, 100)], [3, stats(200, 100)], [6, stats(300, 100)], [7, stats(330, 130)], [8, stats(360, 160)]]);
  assert.equal(verdicts[2], 'decoder-stuck');
  assert.deepEqual(verdicts.slice(3), ['ok', 'ok']);
});

test('a tile is rebuilt a few times and then left alone', () => {
  assert.ok(VIDEO_MAX_REBUILDS >= 2 && VIDEO_MAX_REBUILDS <= 5);
});
