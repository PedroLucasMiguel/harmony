// How voice is sent for a room of this size.
//
//   node client/test/voice-quality.test.mjs

import assert from 'node:assert/strict';

import { senderProfile } from '../src/renderer/voice-quality.js';

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`  ok   ${name}`); };

test('a few people are sent with 20 ms packets, silence sent, and the bits for FEC to ride on', () => {
  for (const n of [1, 2, 6]) assert.deepEqual(senderProfile(n), { ptime: 20, dtx: false, bitrate: 64_000, name: 'line' });
});
test('a medium room keeps suppressing silence, with shorter packets and more bits than before', () => {
  assert.deepEqual(senderProfile(7), { ptime: 20, dtx: true, bitrate: 48_000, name: 'balanced' });
  assert.equal(senderProfile(12).bitrate, 48_000);
});
test('a large room keeps what saves the relay: 40 ms packets, suppressed silence, 32 kbit/s', () => {
  assert.deepEqual(senderProfile(13), { ptime: 40, dtx: true, bitrate: 32_000, name: 'saving' });
  assert.equal(senderProfile(40).ptime, 40);
});
test('the saving can be asked for at any size, for comparison', () => {
  assert.equal(senderProfile(2, 'legacy').ptime, 40);
});

console.log(`\n${passed}/${passed} checks passed`);
