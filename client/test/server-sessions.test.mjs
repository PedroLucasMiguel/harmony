// The servers that are saved but not open, and kept connected: what their
// counts do as frames arrive, and which frames are theirs.
//
//   node --test client/test/server-sessions.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyChannels, applyDeleted, applyHello, applyMessage, applyRead, createBackgroundSessions,
  namesYou, newSession, totals,
} from '../src/renderer/server-sessions.js';

const ME = { id: 7, roles: [3] };
const hello = (unread = []) => ({ type: 'hello-ok', user: ME, unread });
const message = (over = {}) => ({ id: 1, channelId: 1, userId: 9, body: 'hi', ...over });

describe('what a hello says', () => {
  it('sets the counts from the server and marks the session up', () => {
    const s = newSession('http://a.test');
    applyHello(s, hello([{ channelId: 1, unread: 3, mentions: 1 }, { channelId: 2, unread: 0, mentions: 0 }]));
    assert.equal(s.status, 'up');
    assert.deepEqual(totals(s), { unread: 3, mentions: 1 });
  });

  it('replaces what was counted before: a reconnect starts from the truth', () => {
    const s = newSession('http://a.test');
    applyHello(s, hello([{ channelId: 1, unread: 5, mentions: 2 }]));
    applyHello(s, hello([{ channelId: 1, unread: 1, mentions: 0 }]));
    assert.deepEqual(totals(s), { unread: 1, mentions: 0 });
  });
});

describe('messages as they arrive', () => {
  it('count as news in their channel, and not your own', () => {
    const s = newSession('http://a.test');
    applyHello(s, hello());
    applyMessage(s, message());
    applyMessage(s, message({ id: 2, channelId: 2 }));
    applyMessage(s, message({ id: 3, userId: ME.id }));
    assert.deepEqual(totals(s), { unread: 2, mentions: 0 });
  });

  it('count as a mention when they name you, your role, everybody, or answer you', () => {
    const s = newSession('http://a.test');
    applyHello(s, hello());
    assert.equal(applyMessage(s, message({ mentions: [ME.id] })), true);
    assert.equal(applyMessage(s, message({ mentionRoles: [3] })), true);
    assert.equal(applyMessage(s, message({ mentionsEveryone: true })), true);
    assert.equal(applyMessage(s, message({ reply: { userId: ME.id } })), true);
    assert.equal(applyMessage(s, message({ mentions: [99], mentionRoles: [4] })), false);
    assert.deepEqual(totals(s), { unread: 5, mentions: 4 });
  });

  it('are ignored until the session knows who you are', () => {
    const s = newSession('http://a.test');
    assert.equal(applyMessage(s, message({ mentionsEveryone: true })), false);
    assert.deepEqual(totals(s), { unread: 0, mentions: 0 });
    assert.equal(namesYou(message({ mentionsEveryone: true }), null), false);
  });

  it('are taken back when deleted, down to nothing', () => {
    const s = newSession('http://a.test');
    applyHello(s, hello());
    applyMessage(s, message());
    applyDeleted(s, 1);
    applyDeleted(s, 1);
    assert.deepEqual(totals(s), { unread: 0, mentions: 0 });
  });

  it('are cleared by reading the channel, here or on another device', () => {
    const s = newSession('http://a.test');
    applyHello(s, hello([{ channelId: 1, unread: 4, mentions: 2 }, { channelId: 2, unread: 1, mentions: 0 }]));
    applyRead(s, { channelId: 1, unread: 0, mentions: 0 });
    assert.deepEqual(totals(s), { unread: 1, mentions: 0 });
  });

  it('forget a channel that is gone', () => {
    const s = newSession('http://a.test');
    applyHello(s, hello([{ channelId: 1, unread: 4, mentions: 2 }, { channelId: 2, unread: 1, mentions: 0 }]));
    applyChannels(s, [{ id: 2 }]);
    assert.deepEqual(totals(s), { unread: 1, mentions: 0 });
  });
});

/** A stand-in for the bridge: connections that answer when told to. */
function fakeHarmony() {
  const calls = [];
  const pending = new Map();
  return {
    calls,
    answer: (url, hello_) => pending.get(url).resolve(hello_),
    refuse: (url) => pending.get(url).reject(new Error('the server rejected this session')),
    api: {
      setCredentials: async (url, creds) => { calls.push(['credentials', url, creds]); },
      me: async (url) => { calls.push(['me', url]); },
    },
    realtime: {
      connect: (url, token) => new Promise((resolve, reject) => {
        calls.push(['connect', url, token]);
        pending.set(url, { resolve, reject });
      }),
      disconnect: async (url) => { calls.push(['disconnect', url]); },
    },
  };
}

describe('the background sessions', () => {
  it('connect with the saved credentials and show what the hello says', async () => {
    const harmony = fakeHarmony();
    let changes = 0;
    const sessions = createBackgroundSessions({ harmony, onChange: () => { changes += 1; } });
    const started = sessions.start({ url: 'A.test:8080', password: 'door', token: 'tok' });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(harmony.calls.slice(0, 2), [
      ['credentials', 'A.test:8080', { password: 'door', token: 'tok' }],
      ['connect', 'A.test:8080', 'tok'],
    ]);
    assert.equal(sessions.summary('http://a.test:8080/').status, 'connecting');
    harmony.answer('A.test:8080', hello([{ channelId: 1, unread: 2, mentions: 1 }]));
    await started;
    assert.deepEqual(sessions.summary('a.test:8080'), { status: 'up', unread: 2, mentions: 1 });
    assert.ok(changes >= 2);
    sessions.stopAll();
  });

  it('claim only the frames of the servers they keep, whichever way the address is written', async () => {
    const harmony = fakeHarmony();
    const sessions = createBackgroundSessions({ harmony, onChange: () => {} });
    const started = sessions.start({ url: 'a.test:8080', token: 't' });
    await new Promise((r) => setImmediate(r));
    harmony.answer('a.test:8080', hello());
    await started;

    assert.equal(sessions.handleEvent({ type: 'presence', server: 'http://a.test:8080' }), true, 'nothing a bubble shows, but not the open server\'s either');
    assert.equal(sessions.handleEvent({ type: 'presence', server: 'http://other.test' }), false);
    assert.equal(sessions.handleEvent({ type: 'presence' }), false);

    let mentioned = null;
    const watched = createBackgroundSessions({ harmony, onChange: () => {}, onMention: (url, m) => { mentioned = [url, m.id]; } });
    const again = watched.start({ url: 'b.test', token: 't' });
    await new Promise((r) => setImmediate(r));
    harmony.answer('b.test', hello());
    await again;
    watched.handleEvent({ type: 'message', server: 'http://b.test', message: message({ id: 42, mentions: [ME.id] }) });
    assert.deepEqual(mentioned, ['b.test', 42]);
    assert.deepEqual(watched.summary('b.test'), { status: 'up', unread: 1, mentions: 1 });
    sessions.stopAll();
    watched.stopAll();
  });

  it('follow the connection: down, back up, and refused', async () => {
    const harmony = fakeHarmony();
    const rejected = [];
    const sessions = createBackgroundSessions({ harmony, onChange: () => {}, onRejected: (url) => rejected.push(url) });
    const started = sessions.start({ url: 'a.test', token: 't' });
    await new Promise((r) => setImmediate(r));
    harmony.answer('a.test', hello());
    await started;

    sessions.handleEvent({ type: 'realtime:down', server: 'http://a.test' });
    assert.equal(sessions.summary('a.test').status, 'down');
    sessions.handleEvent({ type: 'realtime:up', server: 'http://a.test', user: ME, unread: [{ channelId: 1, unread: 1, mentions: 0 }] });
    assert.deepEqual(sessions.summary('a.test'), { status: 'up', unread: 1, mentions: 0 });
    sessions.handleEvent({ type: 'realtime:rejected', server: 'http://a.test' });
    assert.equal(sessions.summary('a.test').status, 'locked');
    assert.deepEqual(rejected, ['a.test']);
    sessions.stopAll();
  });

  it('say so when the server refuses the session at the start', async () => {
    const harmony = fakeHarmony();
    const rejected = [];
    const sessions = createBackgroundSessions({ harmony, onChange: () => {}, onRejected: (url) => rejected.push(url) });
    const started = sessions.start({ url: 'a.test', token: 'old' });
    await new Promise((r) => setImmediate(r));
    harmony.refuse('a.test');
    await started;
    assert.equal(sessions.summary('a.test').status, 'locked');
    assert.deepEqual(rejected, ['a.test']);
    sessions.stopAll();
  });

  it('do not start twice, and stopping one closes only its connection', async () => {
    const harmony = fakeHarmony();
    const sessions = createBackgroundSessions({ harmony, onChange: () => {} });
    const a = sessions.start({ url: 'a.test', token: 't' });
    const b = sessions.start({ url: 'b.test', token: 't' });
    sessions.start({ url: 'A.test/', token: 't' });
    await new Promise((r) => setImmediate(r));
    assert.equal(harmony.calls.filter((c) => c[0] === 'connect').length, 2);
    harmony.answer('a.test', hello());
    harmony.answer('b.test', hello());
    await Promise.all([a, b]);

    sessions.stop('a.test');
    assert.deepEqual(harmony.calls.filter((c) => c[0] === 'disconnect'), [['disconnect', 'a.test']]);
    assert.equal(sessions.has('a.test'), false);
    assert.equal(sessions.has('b.test'), true);
    sessions.stopAll();
  });

  it('a start that is stopped before it connects leaves nothing behind', async () => {
    const harmony = fakeHarmony();
    const sessions = createBackgroundSessions({ harmony, onChange: () => {} });
    const started = sessions.start({ url: 'a.test', token: 't' });
    await new Promise((r) => setImmediate(r));
    sessions.stop('a.test');
    harmony.answer('a.test', hello([{ channelId: 1, unread: 9, mentions: 9 }]));
    await started;
    assert.equal(sessions.summary('a.test'), null);
  });

  it('a session that the server no longer knows is locked by the keep-alive', async () => {
    const harmony = fakeHarmony();
    harmony.api.me = async () => { const e = new Error('no'); e.status = 401; throw e; };
    const rejected = [];
    const sessions = createBackgroundSessions({ harmony, onChange: () => {}, onRejected: (url) => rejected.push(url) });
    const started = sessions.start({ url: 'a.test', token: 't' });
    await new Promise((r) => setImmediate(r));
    harmony.answer('a.test', hello());
    await started;
    await sessions.touch();
    assert.equal(sessions.summary('a.test').status, 'locked');
    assert.deepEqual(rejected, ['a.test']);
    sessions.stopAll();
  });
});
