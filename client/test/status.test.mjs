// What a status looks like to others and to yourself, and when the app counts as left alone.
//
//   node client/test/status.test.mjs

import assert from 'node:assert/strict';

import { IDLE_AFTER_MS, createIdleWatch, listedStatus, ownStatus } from '../src/renderer/status.js';

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`  ok   ${name}`); };

test('somebody who is not on has no status, and an invisible person is not on', () => {
  assert.equal(listedStatus(1, new Set([2]), {}), null);
});
test('somebody on is online unless the server says idle or do not disturb', () => {
  const online = new Set([1, 2, 3]);
  assert.equal(listedStatus(1, online, {}), 'online');
  assert.equal(listedStatus(2, online, { 2: 'idle' }), 'idle');
  assert.equal(listedStatus(3, online, { 3: 'dnd' }), 'dnd');
  assert.equal(listedStatus(1, online, { 1: 'invisible' }), 'online', 'anything else is not a status to show');
});
test('your own: what you chose, with the app left alone turning online into idle', () => {
  assert.equal(ownStatus('online', { away: false, inCall: false }), 'online');
  assert.equal(ownStatus('online', { away: true, inCall: false }), 'idle');
  assert.equal(ownStatus('dnd', { away: true, inCall: false }), 'dnd');
  assert.equal(ownStatus('invisible', { away: true, inCall: false }), 'invisible');
  assert.equal(ownStatus('online', { away: true, inCall: true }), 'online', 'somebody in a call is not idling');
  assert.equal(ownStatus('nonsense', { away: false, inCall: false }), 'online');
});
test('the app is left alone after five minutes, and touching it starts the count again', () => {
  assert.equal(IDLE_AFTER_MS, 5 * 60 * 1000);
  let now = 1_000;
  const watch = createIdleWatch({ now: () => now });
  assert.equal(watch.away, false);
  now += IDLE_AFTER_MS - 1;
  assert.equal(watch.away, false);
  now += 1;
  assert.equal(watch.away, true);
  watch.touch();
  assert.equal(watch.away, false);
  now += IDLE_AFTER_MS;
  assert.equal(watch.away, true);
});

console.log(`\n${passed}/${passed} checks passed`);
