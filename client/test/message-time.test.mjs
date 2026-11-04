import test from 'node:test';
import assert from 'node:assert/strict';
import { messageTime } from '../src/renderer/message-time.js';

const NOW = new Date(2026, 10, 4, 13, 0).getTime();
const HOUR = 3600e3;

test('a recent message shows only the time', () => {
  const s = messageTime(NOW - 2 * HOUR, NOW);
  assert.match(s, /^\d{1,2}:\d{2}/);
  assert.doesNotMatch(s, /[A-Za-z]{3}/);
});

test('just under 24 hours still shows only the time, even across midnight', () => {
  assert.doesNotMatch(messageTime(NOW - 23 * HOUR, NOW), /[A-Za-z]{3}/);
});

test('older than 24 hours adds the date', () => {
  const s = messageTime(NOW - 25 * HOUR, NOW);
  assert.match(s, /03/);
  assert.match(s, /\d{1,2}:\d{2}/);
  assert.notEqual(s, messageTime(NOW - 2 * HOUR, NOW));
});

test('a different year adds the year', () => {
  assert.match(messageTime(new Date(2025, 5, 1, 9, 0).getTime(), NOW), /2025/);
  assert.doesNotMatch(messageTime(NOW - 48 * HOUR, NOW), /2026/);
});
