// How the camera's background effect backs off, fed numbers.
//
//   node --test client/test/background-load.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  LoadWatch, OVERLOAD_FOR_MS, OVERLOAD_MS, renderStride, segmentStride,
} from '../src/renderer/background-load.js';

describe('segmenting fewer frames', () => {
  it('every frame while it is cheap', () => {
    assert.equal(segmentStride(5), 1);
    assert.equal(segmentStride(28), 1);
  });

  it('one in two, three, four as it gets dearer', () => {
    assert.equal(segmentStride(29), 2);
    assert.equal(segmentStride(46), 3);
    assert.equal(segmentStride(71), 4);
    assert.equal(segmentStride(500), 4);
  });
});

describe('drawing fewer frames', () => {
  it('all of them while a frame is cheap', () => {
    assert.equal(renderStride(10), 1);
    assert.equal(renderStride(60), 1);
  });

  it('one in two, then one in three', () => {
    assert.equal(renderStride(61), 2);
    assert.equal(renderStride(86), 3);
  });
});

describe('giving up', () => {
  it('not for a moment of slowness', () => {
    const watch = new LoadWatch();
    assert.equal(watch.update(OVERLOAD_MS + 50, 0), false);
    assert.equal(watch.update(OVERLOAD_MS + 50, OVERLOAD_FOR_MS - 1), false);
  });

  it('after it has lasted', () => {
    const watch = new LoadWatch();
    watch.update(OVERLOAD_MS + 50, 1000);
    assert.equal(watch.update(OVERLOAD_MS + 50, 1000 + OVERLOAD_FOR_MS), true);
  });

  it('a good moment starts the count again', () => {
    const watch = new LoadWatch();
    watch.update(OVERLOAD_MS + 50, 0);
    watch.update(OVERLOAD_MS + 50, OVERLOAD_FOR_MS - 500);
    watch.update(OVERLOAD_MS - 20, OVERLOAD_FOR_MS); // recovered
    assert.equal(watch.update(OVERLOAD_MS + 50, OVERLOAD_FOR_MS + 100), false);
    assert.equal(watch.update(OVERLOAD_MS + 50, OVERLOAD_FOR_MS + 100 + OVERLOAD_FOR_MS), true);
  });

  it('says so once, not on every frame after', () => {
    const watch = new LoadWatch();
    watch.update(OVERLOAD_MS + 50, 0);
    assert.equal(watch.update(OVERLOAD_MS + 50, OVERLOAD_FOR_MS), true);
    assert.equal(watch.update(OVERLOAD_MS + 50, OVERLOAD_FOR_MS + 33), false);
    assert.equal(watch.update(OVERLOAD_MS + 50, OVERLOAD_FOR_MS * 3), false);
  });
});
