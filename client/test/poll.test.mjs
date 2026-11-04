// What a poll is, before anything draws it: checking, the private poll's counting and the click rules.
//
//   node --test client/test/poll.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POLL_LIMITS, cleanPoll, validPoll, pollBody, isClosed, optionOfToken, voteToken, withoutVotes, withVotes,
  resultsFromReactions, afterClick, timeLeft,
} from '../src/renderer/poll.js';

const poll = (over = {}) => ({
  title: 'Where?', description: '', footer: '', options: ['a', 'b', 'c'], multiple: false, anonymous: false, endsAt: null, ...over,
});

test('cleanPoll keeps the words trimmed, drops the options left empty, and needs a title and two options', () => {
  const r = cleanPoll({ title: ' Q ', options: [' a ', '', ' ', 'b'], multiple: true, footer: ' f ' });
  assert.deepEqual(r.poll, {
    title: 'Q', description: '', footer: 'f', options: ['a', 'b'], multiple: true, anonymous: false, endsAt: null,
  });
  assert.equal(cleanPoll({ title: '', options: ['a', 'b'] }).error, 'poll_needs_title');
  assert.equal(cleanPoll({ title: 'x', options: ['a', ' '] }).error, 'poll_needs_options');
  assert.equal(cleanPoll({ title: 'x', options: Array(POLL_LIMITS.maxOptions + 1).fill('o') }).error, 'poll_too_many_options');
});

test('cleanPoll takes an end in the future and nothing else', () => {
  const now = 10_000;
  assert.equal(cleanPoll({ title: 'x', options: ['a', 'b'], endsAt: now + 1 }, now).poll.endsAt, now + 1);
  for (const endsAt of [now, now - 5, NaN, 'soon', now + POLL_LIMITS.maxDurationMs + 1]) {
    assert.equal(cleanPoll({ title: 'x', options: ['a', 'b'], endsAt }, now).error, 'poll_bad_end', String(endsAt));
  }
  assert.equal(cleanPoll({ title: 'x', options: ['a', 'b'], endsAt: null }, now).poll.endsAt, null);
});

test('validPoll reads what arrived, and refuses what is not a poll; a closed one is still a poll', () => {
  assert.equal(validPoll(null), null);
  assert.equal(validPoll({ title: 'x', options: ['only one'] }), null);
  assert.equal(validPoll({ title: 'x', options: ['a', 3] }), null);
  assert.equal(validPoll({ title: ' ', options: ['a', 'b'] }), null);
  const old = validPoll({ title: 'x', options: ['a', 'b'], endsAt: 5 });
  assert.equal(old.endsAt, 5);
  assert.equal(isClosed(old, 6), true);
});

test('a private poll is also words, for whatever shows a message as text', () => {
  assert.equal(pollBody(poll({ options: ['yes', 'no'] })), '\u{1F4CA} Where?\n1. yes\n2. no');
});

test('a vote is a reaction text, and anything else is not one', () => {
  assert.equal(voteToken(3), 'poll:3');
  assert.equal(optionOfToken('poll:3'), 3);
  for (const x of ['poll:', 'poll:x', 'poll:123', '\u{1F44D}', 'polls:1', null, 4]) assert.equal(optionOfToken(x), null, String(x));
  assert.deepEqual(withoutVotes([{ emoji: '\u{1F44D}' }, { emoji: 'poll:1' }]).map((r) => r.emoji), ['\u{1F44D}']);
});

test('a person\'s list of reactions has its votes replaced and its emoji kept', () => {
  assert.deepEqual(withVotes(['\u{1F44D}', 'poll:0', 'poll:2'], [1]), ['\u{1F44D}', 'poll:1']);
  assert.deepEqual(withVotes(['poll:1'], []), []);
  assert.deepEqual(withVotes([], [2, 0, 2]), ['poll:0', 'poll:2']);
});

test('the votes are counted from the reactions, who and what is mine', () => {
  const reactions = [
    { emoji: 'poll:0', count: 2, userIds: [1, 2] },
    { emoji: '\u{1F44D}', count: 1, userIds: [1] },
    { emoji: 'poll:2', count: 1, userIds: [3] },
  ];
  const r = resultsFromReactions(poll(), reactions, 2);
  assert.deepEqual([r.counts, r.total, r.voters, r.mine], [[2, 0, 1], 3, [[1, 2], [], [3]], [0]]);
});

test('a poll that takes one answer counts one for somebody who sent several, the same one for everybody', () => {
  const reactions = [
    { emoji: 'poll:2', count: 1, userIds: [1] },
    { emoji: 'poll:1', count: 1, userIds: [1] },
  ];
  const r = resultsFromReactions(poll(), reactions, 1);
  assert.deepEqual([r.counts, r.total, r.mine], [[0, 1, 0], 1, [1]]);
  const many = resultsFromReactions(poll({ multiple: true }), reactions, 1);
  assert.deepEqual([many.counts, many.total, many.mine], [[0, 1, 1], 1, [1, 2]]);
});

test('a hidden poll counts and does not say who; a vote for an option that is not there is ignored', () => {
  const r = resultsFromReactions(poll({ anonymous: true }), [{ emoji: 'poll:0', count: 1, userIds: [1] }, { emoji: 'poll:9', count: 1, userIds: [2] }], 1);
  assert.deepEqual([r.counts, r.total, r.voters, r.mine], [[1, 0, 0], 1, null, [0]]);
});

test('a click chooses, or takes back; on a poll of several it adds to what was chosen', () => {
  assert.deepEqual(afterClick(poll(), [], 1), [1]);
  assert.deepEqual(afterClick(poll(), [1], 2), [2]);
  assert.deepEqual(afterClick(poll(), [1], 1), []);
  assert.deepEqual(afterClick(poll({ multiple: true }), [2], 0), [0, 2]);
  assert.deepEqual(afterClick(poll({ multiple: true }), [0, 2], 0), [2]);
});

test('the time left is said in its biggest whole unit, and is nothing once it is over', () => {
  const now = 1_000_000;
  assert.deepEqual(timeLeft(now + 30_000, now), [1, 'm']);
  assert.deepEqual(timeLeft(now + 5 * 60_000, now), [5, 'm']);
  assert.deepEqual(timeLeft(now + 90 * 60_000, now), [2, 'h']);
  assert.deepEqual(timeLeft(now + 3 * 24 * 3600_000, now), [3, 'd']);
  assert.equal(timeLeft(now, now), null);
});
