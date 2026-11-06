// Lowering a share by itself when the computer cannot keep up, and raising it again when it can.
//
//   node --test client/test/share-governor.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createShareGovernor } from '../src/renderer/share-governor.js';

/** [frames encoded in the 2 s, total encode time in that time (ms), kbps, link kbps]: the first 90 s of a heavy game shared at 1080p60 (a debug log from a friend's machine). */
const HEAVY_GAME = [
  [0, 0, null, 4801],
  [21, 2782, 4167, 6116],
  [14, 1879, 3044, 6298],
  [7, 870, 2557, 5238],
  [10, 3737, 5249, 6063],
  [24, 5132, 6215, 7071],
  [11, 1668, 7245, 8185],
  [6, 1570, 5694, 9328],
  [12, 2575, 8366, 10146],
  [4, 643, 5171, 11128],
  [19, 3266, 10596, 12491],
  [8, 823, 4780, 13190],
  [10, 5329, 5443, 9024],
  [14, 10951, 4767, 9093],
  [17, 1507, 9166, 8770],
  [17, 1813, 8435, 10231],
  [14, 6441, 5532, 11047],
  [15, 1919, 7440, 12119],
  [21, 5543, 9429, 13212],
  [14, 2955, 7947, 11513],
  [1, 43, 956, 11602],
  [6, 849, 3321, null],
  [12, 1121, 8172, 6233],
  [9, 3458, 6977, 7271],
  [15, 1663, 7311, 8480],
  [22, 6682, 8662, 9891],
  [16, 5475, 7878, 10843],
  [2, 86, 722, 11096],
  [17, 3594, 8838, 12153],
  [2, 90, 10810, 13961],
  [7, 477, 6588, 14716],
  [7, 402, 8272, 15616],
  [7, 2807, 3019, 5602],
  [2, 244, 5351, 6385],
  [6, 398, 4335, 6941],
  [27, 3083, 6136, 6775],
  [10, 4161, 2726, 7437],
  [11, 5468, 4205, 7556],
  [18, 5627, 6388, 8491],
  [10, 579, 4723, 6497],
  [11, 1467, 6595, 7640],
  [8, 3728, 3312, 8060],
  [10, 1348, 5303, 8505],
  [17, 2458, 8782, 9996],
  [13, 886, 9134, 11482]
];

/** Feeds a governor a stretch of readings, 'every' ms apart, as the page's own running totals; returns what it asked for. */
function feed(governor, rows, { every = 2000, start = 0, size = { width: 1920, height: 1080 }, totals = { frames: 0, encodeMs: 0 } } = {}) {
  const asked = [];
  let at = start;
  for (const [frames, encodeMs, kbps, link] of rows) {
    at += every;
    totals.frames += frames;
    totals.encodeMs += encodeMs;
    const change = governor.sample({
      at, framesEncoded: totals.frames, totalEncodeTime: totals.encodeMs / 1000, kbps: kbps ?? undefined, availableKbps: link ?? undefined, ...size, limitedBy: 'none',
    });
    if (change) asked.push({ at, ...change });
  }
  return { asked, at, totals };
}

/** A steady stream: 'fps' frames a second, each taking 'ms' to encode, for 'seconds'. */
const steady = (fps, ms, seconds, { kbps = 3000, link = 20000 } = {}) => Array.from({ length: Math.round(seconds / 2) }, () => [fps * 2, fps * 2 * ms, kbps, link]);

describe('a share that the encoder cannot keep up with', () => {
  it('is lowered, within about half a minute, in the log it was written from', () => {
    // The log's readings are the totals of the first 2 s window of each; the encode time there is total ms over the window.
    const governor = createShareGovernor({ fps: 60, width: 1920, height: 1080 });
    const { asked } = feed(governor, HEAVY_GAME.map(([frames, ms, kbps, link]) => [frames, ms, kbps, link]));
    assert.ok(asked.length >= 1, 'it asked for less');
    assert.equal(asked[0].reason, 'starved');
    assert.ok(asked[0].at <= 30_000, 'the first step is within 30 s: ' + asked[0].at);
    assert.equal(asked[0].fps, 30, 'frame rate first');
    assert.equal(asked[0].height, 1080, 'and not the size yet');
  });

  it('is lowered again, to a smaller picture, if that is not enough, and no further than the last rung', () => {
    const governor = createShareGovernor({ fps: 60, width: 1920, height: 1080 });
    const { asked } = feed(governor, steady(8, 130, 600));
    assert.deepEqual(asked.map((a) => [a.fps, a.height]), [[30, 1080], [30, 720], [20, 540]]);
    assert.ok(asked.every((a) => a.reason === 'starved'));
  });

  it('is not lowered when the picture is only slow because the link is', () => {
    const governor = createShareGovernor({ fps: 60, width: 1920, height: 1080 });
    const { asked } = feed(governor, steady(8, 130, 120, { kbps: 5000, link: 5200 }));
    assert.deepEqual(asked, []);
    const limited = createShareGovernor({ fps: 60, width: 1920, height: 1080 });
    let at = 0; let frames = 0; let total = 0; const out = [];
    for (let i = 0; i < 40; i += 1) {
      at += 2000; frames += 16; total += 16 * 0.13;
      const change = limited.sample({ at, framesEncoded: frames, totalEncodeTime: total, limitedBy: 'bandwidth' });
      if (change) out.push(change);
    }
    assert.deepEqual(out, [], 'and not when WebRTC says it is the bandwidth');
  });

  it('is not lowered when the game itself is slow and the encoder is not', () => {
    const governor = createShareGovernor({ fps: 60, width: 1920, height: 1080 });
    const { asked } = feed(governor, steady(24, 3, 300));
    assert.deepEqual(asked, [], '24 fps on a fast encoder is a slow game, not a starved computer');
  });

  it('is not lowered for a moment of it', () => {
    const governor = createShareGovernor({ fps: 60, width: 1920, height: 1080 });
    const rows = [...steady(60, 3, 20), ...steady(8, 130, 8), ...steady(60, 3, 40)];
    assert.deepEqual(feed(governor, rows).asked, []);
  });
});

describe('a share that has been lowered', () => {
  it('goes back up one step after the encoder has kept up for half a minute, and not before', () => {
    const governor = createShareGovernor({ fps: 60, width: 1920, height: 1080 });
    const first = feed(governor, steady(8, 130, 60));
    assert.ok(first.asked.length >= 1);
    const rung = first.asked.at(-1).rung;
    // Healthy at what is asked for now.
    const asking = governor.plan.fps;
    const soon = feed(governor, steady(asking, 3, 20), first);
    assert.deepEqual(soon.asked, [], 'not within 20 s');
    const later = feed(governor, steady(asking, 3, 60), soon);
    assert.equal(later.asked[0]?.reason, 'recovered');
    assert.equal(later.asked[0].rung, rung - 1);
  });

  it('does not go back up while the encoder has no room to spare', () => {
    const governor = createShareGovernor({ fps: 60, width: 1920, height: 1080 });
    const first = feed(governor, steady(8, 130, 60));
    const asking = governor.plan.fps;
    const later = feed(governor, steady(asking, 20, 200), first);
    assert.deepEqual(later.asked.filter((a) => a.reason === 'recovered'), []);
  });

  it('does not flicker: a step up that is starved again at once is not tried again for a while', () => {
    const governor = createShareGovernor({ fps: 60, width: 1920, height: 1080 });
    let state = feed(governor, steady(8, 130, 60));
    const events = [];
    for (let cycle = 0; cycle < 4; cycle += 1) {
      state = feed(governor, steady(governor.plan.fps, 3, 70), state);
      events.push(...state.asked);
      state = feed(governor, steady(8, 130, 40), state);
      events.push(...state.asked);
    }
    const ups = events.filter((e) => e.reason === 'recovered');
    // Each time it went back up and was starved again, the wait before the next try grew.
    const gaps = ups.slice(1).map((u, i) => u.at - ups[i].at);
    assert.ok(gaps.length < 2 || gaps.at(-1) >= gaps[0], JSON.stringify(gaps));
  });
});

describe('what is asked for', () => {
  it('never goes below 15 fps or 360 lines', () => {
    const governor = createShareGovernor({ fps: 30, width: 1280, height: 720 });
    const { asked } = feed(governor, steady(2, 400, 1000), { size: { width: 1280, height: 720 } });
    for (const a of asked) {
      assert.ok(a.fps >= 15, 'fps ' + a.fps);
      assert.ok(a.height >= 360, 'height ' + a.height);
    }
  });

  it('keeps the rate a person asked for if it is already low, and takes the size instead', () => {
    const governor = createShareGovernor({ fps: 30, width: 1920, height: 1080 });
    const { asked } = feed(governor, steady(4, 200, 200));
    assert.equal(asked[0].fps, 15);
    assert.ok(asked.every((a) => a.fps <= 30));
  });

  it('takes the size of a native share from the stream itself', () => {
    const governor = createShareGovernor({ fps: 60, width: 0, height: 0 });
    const { asked } = feed(governor, steady(8, 130, 400), { size: { width: 2560, height: 1440 } });
    assert.equal(asked[1].height, 960);
    assert.equal(asked[1].width, 1706);
  });

  it('forgets what it learned when the person changes the setting', () => {
    const governor = createShareGovernor({ fps: 60, width: 1920, height: 1080 });
    feed(governor, steady(8, 130, 60));
    assert.ok(governor.plan.lowered);
    const plan = governor.ask({ fps: 30, width: 1280, height: 720 });
    assert.deepEqual([plan.fps, plan.height, plan.lowered], [30, 720, false]);
  });
});
