// The list of starred messages: where it is kept, what it refuses, and the search over it.
//
//   node --test client/test/stars-store.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MAX_STARS, StarError, channelSnapshot, createStarStore, fold, matches } from '../src/renderer/stars-store.js';

/** A store over a plain object, as `state.settings.stars` is. */
function make(initial = {}) {
  const box = { stars: initial, writes: 0 };
  const store = createStarStore({
    read: () => box.stars,
    write: async (next) => { box.stars = next; box.writes += 1; },
  });
  return { box, store };
}
const channel = (id, savedAt) => ({ kind: 'channel', id, channelId: 1, savedAt, message: { id, body: `m${id}` } });

describe('keeping stars', () => {
  it('lists the one starred last first, by kind, per account', async () => {
    const { store } = make();
    await store.add('s#1', channel(1, 10));
    await store.add('s#1', channel(2, 30));
    await store.add('s#1', { kind: 'dm', id: 5, savedAt: 20, key: 1, sealed: 'x' });
    await store.add('s#2', channel(9, 40));
    assert.deepEqual(store.list('s#1', 'channel').map((e) => e.id), [2, 1]);
    assert.deepEqual(store.list('s#1', 'dm').map((e) => e.id), [5]);
    assert.deepEqual(store.list('s#2', 'channel').map((e) => e.id), [9], 'another account keeps its own');
    assert.equal(store.has('s#1', 'channel', 1), true);
    assert.equal(store.has('s#1', 'channel', 9), false);
    assert.equal(store.has('s#1', 'dm', 1), false, 'a channel message and a private one with the same number are two things');
  });

  it('starring again keeps one, as the newest', async () => {
    const { store } = make();
    await store.add('s#1', channel(1, 10));
    await store.add('s#1', channel(2, 20));
    await store.add('s#1', channel(1, 30));
    assert.deepEqual(store.list('s#1', 'channel').map((e) => e.id), [1, 2]);
  });

  it('lets one go, and an account with none is not kept at all', async () => {
    const { store, box } = make();
    await store.add('s#1', channel(1, 10));
    await store.remove('s#1', 'channel', 1);
    assert.deepEqual(box.stars, {});
    const writes = box.writes;
    await store.remove('s#1', 'channel', 1);
    assert.equal(box.writes, writes, 'nothing to let go, nothing written');
  });

  it('refuses past the limit, and an entry that is none', async () => {
    const { store } = make();
    for (let i = 0; i < MAX_STARS; i += 1) await store.add('s#1', channel(i, i));
    assert.throws(() => store.add('s#1', channel(MAX_STARS + 1, 1)), (e) => e instanceof StarError && e.code === 'too_many');
    await store.add('s#1', channel(0, 5000)); // one already starred is not another
    assert.throws(() => store.add('s#1', { kind: 'other', id: 1 }), (e) => e.code === 'invalid');
  });

  it('is read at once by the next call, and says when it changes', async () => {
    const { store } = make();
    let told = 0;
    const stop = store.onChange(() => { told += 1; });
    store.add('s#1', channel(1, 10));
    assert.equal(store.has('s#1', 'channel', 1), true, 'before the write has finished');
    store.remove('s#1', 'channel', 1);
    assert.equal(told, 2);
    stop();
    store.add('s#1', channel(2, 10));
    assert.equal(told, 2);
  });

  it('survives a settings file that was edited by hand', () => {
    const { store } = make({ 's#1': [null, 7, { kind: 'channel' }, channel(3, 1)], 's#2': 'nonsense' });
    assert.deepEqual(store.list('s#1', 'channel').map((e) => e.id), [3]);
    assert.deepEqual(store.list('s#2', 'channel'), []);
    assert.equal(createStarStore({ read: () => null, write: async () => {} }).count('x'), 0);
  });
});

describe('what a channel star keeps', () => {
  it('is what is drawn of the message, not what goes on around it', () => {
    const kept = channelSnapshot({
      id: 4, channelId: 2, userId: 3, nickname: 'ana', body: 'hi', createdAt: 5, editedAt: null, attachmentHash: 'h', attachmentName: 'a.png',
      attachmentBytes: 9, mediaType: 'image', pinned: true, reactions: [{ emoji: 'x' }], mentions: [1], extra: 1,
    });
    assert.deepEqual(Object.keys(kept).sort(), ['attachmentBytes', 'attachmentHash', 'attachmentName', 'body', 'channelId', 'createdAt', 'editedAt', 'id', 'mediaType', 'nickname', 'userId']);
  });
});

describe('searching them', () => {
  it('ignores case and accents, wants every word, in any order', () => {
    assert.equal(fold('Café ÀÉÎ'), 'cafe aei');
    assert.equal(matches('cafe', 'the plan for the Café'), true);
    assert.equal(matches('PLAN  café', 'the plan for the Café'), true);
    assert.equal(matches('plan tea', 'the plan for the Café'), false);
    assert.equal(matches('', 'anything'), true);
    assert.equal(matches('   ', 'anything'), true);
    assert.equal(matches('x', null), false);
  });
});
