// The back and forward arrows' bookkeeping.
//
//   node --test client/test/nav-history.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavHistory } from '../src/renderer/nav-history.js';

const at = (key) => ({ key });

test('starts with nowhere to go', () => {
  const h = createNavHistory();
  assert.deepEqual([h.canBack, h.canForward, h.back(), h.forward(), h.current], [false, false, null, null, null]);
});

test('going places builds a trail that back and forward walk', () => {
  const h = createNavHistory();
  for (const k of ['a', 'b', 'c']) h.push(at(k));
  assert.deepEqual([h.canBack, h.canForward, h.current.key], [true, false, 'c']);
  assert.equal(h.back().key, 'b');
  assert.equal(h.back().key, 'a');
  assert.equal(h.back(), null, 'at the start');
  assert.deepEqual([h.canBack, h.canForward], [false, true]);
  assert.equal(h.forward().key, 'b');
  assert.equal(h.forward().key, 'c');
  assert.equal(h.forward(), null);
});

test('opening the place you are at is not a new place', () => {
  const h = createNavHistory();
  h.push(at('a'));
  h.push(at('a'));
  assert.equal(h.size, 1);
  h.push(at('b'));
  h.back();
  h.push(at('a'));
  assert.equal(h.size, 2, 'and going back to it then does not add it either');
  assert.equal(h.canForward, true);
});

test('going somewhere new after going back drops what was ahead', () => {
  const h = createNavHistory();
  for (const k of ['a', 'b', 'c']) h.push(at(k));
  h.back();
  h.back();
  h.push(at('x'));
  assert.deepEqual([h.size, h.canForward, h.current.key], [2, false, 'x']);
  assert.equal(h.back().key, 'a');
});

test('is kept to a limit, the oldest going first', () => {
  const h = createNavHistory({ limit: 3 });
  for (const k of ['a', 'b', 'c', 'd']) h.push(at(k));
  assert.equal(h.size, 3);
  assert.equal(h.back().key, 'c');
  assert.equal(h.back().key, 'b');
  assert.equal(h.back(), null);
});

test('a place that is gone is taken out, and the cursor stays where it was', () => {
  const h = createNavHistory();
  for (const k of ['a', 'b', 'c']) h.push(at(k));
  h.drop('b');
  assert.deepEqual([h.size, h.current.key], [2, 'c']);
  assert.equal(h.back().key, 'a');
  h.drop('zzz');
  assert.equal(h.size, 2);
});

test('clearing forgets everything', () => {
  const h = createNavHistory();
  h.push(at('a'));
  h.clear();
  assert.deepEqual([h.size, h.canBack, h.current], [0, false, null]);
});
