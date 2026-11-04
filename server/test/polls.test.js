// Polls in a text channel: what is accepted, how a vote replaces the last, what a person is shown of the others'.
//
//   node --test server/test/polls.test.js

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { liveServer } from './helpers/live-server.js';
import { migrate } from '../src/db.js';
import {
  cleanPoll, Polls, pollOf, isClosed, POLL_LIMITS,
} from '../src/polls.js';

describe('cleanPoll', () => {
  const ok = (raw, now) => {
    const r = cleanPoll(raw, now);
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.poll;
  };
  const bad = (raw, error, now) => assert.deepEqual(cleanPoll(raw, now), { ok: false, error });

  it('keeps what a poll is made of, trimmed, and drops the options left empty', () => {
    const poll = ok({
      title: '  Pizza?  ', description: ' toppings ', footer: ' ends soon ', options: [' yes ', '', '  ', 'no', 'maybe'],
      multiple: true, anonymous: true,
    });
    assert.deepEqual(poll, {
      title: 'Pizza?', description: 'toppings', footer: 'ends soon', options: ['yes', 'no', 'maybe'],
      multiple: true, anonymous: true, endsAt: null,
    });
  });

  it('needs a title and two options that say something', () => {
    bad({ title: '', options: ['a', 'b'] }, 'poll_needs_title');
    bad({ title: '   ', options: ['a', 'b'] }, 'poll_needs_title');
    bad({ title: 'x', options: ['a'] }, 'poll_needs_options');
    bad({ title: 'x', options: ['a', '   '] }, 'poll_needs_options');
    bad({ title: 'x' }, 'poll_needs_options');
    bad(null, 'bad_poll');
    bad('a poll', 'bad_poll');
  });

  it('stops at the most options there are room for, and clips the long texts', () => {
    const many = Array.from({ length: POLL_LIMITS.maxOptions + 1 }, (_, i) => `option ${i}`);
    bad({ title: 'x', options: many }, 'poll_too_many_options');
    const poll = ok({ title: 't'.repeat(900), options: ['o'.repeat(500), 'b'], footer: 'f'.repeat(900) });
    assert.equal(poll.title.length, POLL_LIMITS.title);
    assert.equal(poll.options[0].length, POLL_LIMITS.option);
    assert.equal(poll.footer.length, POLL_LIMITS.footer);
  });

  it('closes only in the future, and not in a century', () => {
    const now = 1_000_000;
    assert.equal(ok({ title: 'x', options: ['a', 'b'], endsAt: now + 60_000 }, now).endsAt, now + 60_000);
    bad({ title: 'x', options: ['a', 'b'], endsAt: now - 1 }, 'poll_bad_end', now);
    bad({ title: 'x', options: ['a', 'b'], endsAt: 'soon' }, 'poll_bad_end', now);
    bad({ title: 'x', options: ['a', 'b'], endsAt: now + POLL_LIMITS.maxDurationMs + 1 }, 'poll_bad_end', now);
    assert.equal(isClosed({ endsAt: now }, now), true);
    assert.equal(isClosed({ endsAt: now + 1 }, now), false);
    assert.equal(isClosed({ endsAt: null }, now), false);
  });
});

describe('the votes', () => {
  let db;
  let polls;
  const mk = (id, poll) => ({ id, poll: JSON.stringify(poll) });
  const choose = (id, over = {}) => mk(id, {
    title: 'q', options: ['a', 'b', 'c'], multiple: false, anonymous: false, endsAt: null, ...over,
  });

  before(() => {
    db = new DatabaseSync(':memory:');
    migrate(db);
    // The votes are the subject here; the messages and people they point at are not made.
    db.exec('PRAGMA foreign_keys = OFF');
    polls = new Polls(db);
  });

  it('puts a vote where it is asked, and a second one replaces the first', () => {
    const m = choose(1);
    assert.deepEqual(polls.vote({ message: m, userId: 7, options: [1] }), { ok: true, mine: [1] });
    assert.deepEqual(polls.vote({ message: m, userId: 7, options: [2] }), { ok: true, mine: [2] });
    assert.deepEqual(polls.resultsOf(m, 7), {
      counts: [0, 0, 1], total: 1, voters: [[], [], [7]], mine: [2],
    });
  });

  it('takes a vote back with an empty list, and repeating one changes nothing', () => {
    const m = choose(2);
    polls.vote({ message: m, userId: 7, options: [0] });
    polls.vote({ message: m, userId: 7, options: [0] });
    assert.equal(polls.resultsOf(m).counts[0], 1);
    polls.vote({ message: m, userId: 7, options: [] });
    assert.deepEqual(polls.resultsOf(m).counts, [0, 0, 0]);
    assert.equal(polls.resultsOf(m).total, 0);
  });

  it('lets several options be chosen only when the poll allows it', () => {
    const one = choose(3);
    assert.deepEqual(polls.vote({ message: one, userId: 7, options: [0, 1] }), { ok: false, error: 'bad_vote' });
    const many = choose(4, { multiple: true });
    assert.deepEqual(polls.vote({ message: many, userId: 7, options: [2, 0, 2] }), { ok: true, mine: [0, 2] });
    polls.vote({ message: many, userId: 8, options: [0] });
    const r = polls.resultsOf(many, 8);
    assert.deepEqual([r.counts, r.total, r.mine], [[2, 0, 1], 2, [0]], 'two people, three votes');
  });

  it('refuses an option that is not there, and anything that is not a list of numbers', () => {
    const m = choose(5);
    for (const options of [[3], [-1], ['0'], [1.5], 1, null, undefined]) {
      assert.deepEqual(polls.vote({ message: m, userId: 7, options }), { ok: false, error: 'bad_vote' }, JSON.stringify(options));
    }
    assert.deepEqual(polls.vote({ message: { id: 6, poll: null }, userId: 7, options: [0] }), { ok: false, error: 'not_a_poll' });
  });

  it('stops taking votes when the poll has closed', () => {
    const m = choose(7, { endsAt: 5_000 });
    assert.equal(polls.vote({ message: m, userId: 7, options: [0], now: 4_999 }).ok, true);
    assert.deepEqual(polls.vote({ message: m, userId: 7, options: [1], now: 5_000 }), { ok: false, error: 'poll_closed' });
    assert.deepEqual(polls.resultsOf(m, 7).mine, [0], 'what was voted stays');
  });

  it('does not say who voted when the poll hides them, and still counts', () => {
    const m = choose(8, { anonymous: true });
    polls.vote({ message: m, userId: 7, options: [0] });
    polls.vote({ message: m, userId: 8, options: [0] });
    const r = polls.resultsOf(m, 7);
    assert.equal(r.voters, null);
    assert.deepEqual([r.counts, r.total, r.mine], [[2, 0, 0], 2, [0]]);
    assert.equal(JSON.stringify(polls.resultsOf(m)).includes('"7"'), false);
  });

  it('answers for a whole page at once, and for the polls only', () => {
    const results = polls.resultsFor([choose(1), { id: 99, poll: null }, choose(2)], 7);
    assert.deepEqual([...results.keys()].sort(), [1, 2]);
    assert.equal(pollOf({ poll: '{broken' }), null);
  });
});

describe('a poll in a channel, over HTTP and the socket', () => {
  const s = liveServer({ port: 18171, mtxPort: 20071 });
  const { api, tokens, ids } = s;
  let channel;
  let ann;
  let bob;
  let post;

  before(async () => {
    await s.start(['boss', 'ann', 'bob']);
    channel = (await api('/api/channels', { token: tokens.boss })).body.channels.find((c) => c.kind === 'text').id;
    ann = s.connect(tokens.ann);
    await ann.hello();
    bob = s.connect(tokens.bob);
    await bob.hello();
    post = (token, body) => api(`/api/channels/${channel}/messages`, { method: 'POST', token, body });
  });
  after(async () => {
    ann.ws.close();
    bob.ws.close();
    await s.stop();
  });

  const question = (over = {}) => ({ title: 'Where do we eat?', options: ['Pizza', 'Sushi', 'Tacos'], ...over });

  it('is sent as a message that says its title, with its settings and no votes yet', async () => {
    const r = await post(tokens.boss, { poll: question({ description: 'Friday', footer: 'majority wins' }) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const m = r.body.message;
    assert.equal(m.body, 'Where do we eat?');
    assert.equal(m.poll.description, 'Friday');
    assert.deepEqual(m.poll.options, ['Pizza', 'Sushi', 'Tacos']);
    assert.deepEqual(m.poll.results.counts, [0, 0, 0]);
    const seen = (await ann.next((x) => x.type === 'message' && x.message.id === m.id)).message;
    assert.equal(seen.poll.title, 'Where do we eat?');
  });

  it('is refused without a title or with fewer than two options', async () => {
    assert.equal((await post(tokens.boss, { poll: question({ title: ' ' }) })).body.error, 'poll_needs_title');
    assert.equal((await post(tokens.boss, { poll: question({ options: ['only', ''] }) })).body.error, 'poll_needs_options');
    assert.equal((await post(tokens.boss, { poll: question({ endsAt: Date.now() - 1000 }) })).body.error, 'poll_bad_end');
  });

  it('takes a vote, tells everybody the count, and tells the voter alone what they chose', async () => {
    const id = (await post(tokens.boss, { poll: question() })).body.message.id;
    const first = await api(`/api/messages/${id}/vote`, { method: 'POST', token: tokens.ann, body: { options: [1] } });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual([first.body.results.counts, first.body.results.mine], [[0, 1, 0], [1]]);

    const told = await bob.next((m) => m.type === 'message:poll' && m.id === id && m.results.total === 1);
    assert.deepEqual(told.results.voters[1], [ids.ann]);
    assert.equal(told.results.mine, undefined, 'the others are not told what ann chose, apart from who');
    const own = await ann.next((m) => m.type === 'message:poll' && m.id === id && m.results.mine);
    assert.deepEqual(own.results.mine, [1]);

    const history = (await api(`/api/channels/${channel}/messages`, { token: tokens.ann })).body.messages.find((m) => m.id === id);
    assert.deepEqual(history.poll.results.mine, [1]);
    const other = (await api(`/api/channels/${channel}/messages`, { token: tokens.bob })).body.messages.find((m) => m.id === id);
    assert.deepEqual(other.poll.results.mine, []);
  });

  it('refuses a second option on a poll that takes one, and a vote on a message that is not a poll', async () => {
    const id = (await post(tokens.boss, { poll: question() })).body.message.id;
    const two = await api(`/api/messages/${id}/vote`, { method: 'POST', token: tokens.ann, body: { options: [0, 1] } });
    assert.equal(two.body.error, 'bad_vote');
    const plain = (await post(tokens.boss, { body: 'just words' })).body.message.id;
    const no = await api(`/api/messages/${plain}/vote`, { method: 'POST', token: tokens.ann, body: { options: [0] } });
    assert.equal(no.status, 404);
  });

  it('hides who voted from everybody when it was asked to', async () => {
    const id = (await post(tokens.boss, { poll: question({ anonymous: true, multiple: true }) })).body.message.id;
    await api(`/api/messages/${id}/vote`, { method: 'POST', token: tokens.ann, body: { options: [0, 2] } });
    const told = await bob.next((m) => m.type === 'message:poll' && m.id === id);
    assert.equal(told.results.voters, null);
    assert.deepEqual(told.results.counts, [1, 0, 1]);
    const history = (await api(`/api/channels/${channel}/messages`, { token: tokens.bob })).body.messages.find((m) => m.id === id);
    assert.equal(history.poll.results.voters, null);
  });

  it('closes: a vote after the end is refused', async () => {
    const id = (await post(tokens.boss, { poll: question({ endsAt: Date.now() + 700 }) })).body.message.id;
    assert.equal((await api(`/api/messages/${id}/vote`, { method: 'POST', token: tokens.ann, body: { options: [0] } })).status, 200);
    await new Promise((done) => { setTimeout(done, 900); });
    const late = await api(`/api/messages/${id}/vote`, { method: 'POST', token: tokens.bob, body: { options: [0] } });
    assert.deepEqual([late.status, late.body.error], [400, 'poll_closed']);
  });

  it('cannot be edited, and takes its votes with it when it is deleted', async () => {
    const id = (await post(tokens.boss, { poll: question() })).body.message.id;
    await api(`/api/messages/${id}/vote`, { method: 'POST', token: tokens.ann, body: { options: [0] } });
    const edit = await api(`/api/messages/${id}/edit`, { method: 'POST', token: tokens.boss, body: { body: 'changed' } });
    assert.equal(edit.body.error, 'poll_not_editable');
    assert.equal((await api(`/api/messages/${id}/delete`, { method: 'POST', token: tokens.boss })).status, 200);
    const gone = await api(`/api/messages/${id}/vote`, { method: 'POST', token: tokens.ann, body: { options: [1] } });
    assert.equal(gone.status, 404);
  });
});
