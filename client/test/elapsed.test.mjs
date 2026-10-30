import { test } from 'node:test';
import assert from 'node:assert/strict';

import { elapsedText } from '../src/renderer/elapsed.js';

test('under an hour it is minutes and seconds', () => {
  assert.equal(elapsedText(0), '0:00');
  assert.equal(elapsedText(999), '0:00');
  assert.equal(elapsedText(1000), '0:01');
  assert.equal(elapsedText(9 * 1000), '0:09');
  assert.equal(elapsedText((8 * 60 + 54) * 1000), '8:54');
  assert.equal(elapsedText((59 * 60 + 59) * 1000), '59:59');
});

test('from an hour on it has hours as well', () => {
  assert.equal(elapsedText(3600 * 1000), '1:00:00');
  assert.equal(elapsedText((3600 + 2 * 60 + 9) * 1000), '1:02:09');
  assert.equal(elapsedText((27 * 3600 + 5) * 1000), '27:00:05');
});

test('never negative', () => {
  assert.equal(elapsedText(-5000), '0:00');
});
