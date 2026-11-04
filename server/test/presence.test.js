// What a person is on a server: online, idle, do not disturb or invisible. Chosen by them, kept per server, and told to
// everybody else as presence -- an invisible person is simply not on the list -- and a person who is not to be disturbed
// is not told when they are named.
//
//   node --test server/test/presence.test.js

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { liveServer } from './helpers/live-server.js';

const s = liveServer({ port: 18190, mtxPort: 20090 });
const { api, tokens, ids } = s;
const NAMES = ['boss', 'alice', 'bob'];
const sock = {};
let general;

before(async () => {
  await s.start(NAMES);
  for (const who of NAMES) {
    sock[who] = s.connect(tokens[who]);
    await sock[who].hello();
  }
  general = (await api('/api/channels', { token: tokens.boss })).body.channels.find((c) => c.kind === 'text').id;
  for (const who of ['alice', 'bob']) await s.publishKey(who);
});
after(async () => {
  Object.values(sock).forEach((c) => c.ws.close());
  await s.stop();
});

const set = (who, status) => sock[who].request({ type: 'presence:set', status });
const presenceWhere = (watcher, test) => sock[watcher].fresh((m) => m.type === 'presence' && test(m));
const listed = async (as) => (await api('/api/channels', { token: tokens[as] })).body;

describe('choosing a status', () => {
  it('starts as online, which is told to the person only as theirs to know', async () => {
    const body = await listed('alice');
    assert.equal(body.status, 'online');
    assert.deepEqual(body.statuses, {});
    assert.ok(body.online.includes(ids.alice));
  });

  it('idle and do not disturb are told to everybody, and are still on the list', async () => {
    const seen = presenceWhere('bob', (m) => m.statuses[ids.alice] === 'idle');
    assert.equal((await set('alice', 'idle')).status, 'idle');
    const push = await seen;
    assert.ok(push.online.includes(ids.alice));
    const dnd = presenceWhere('bob', (m) => m.statuses[ids.alice] === 'dnd');
    await set('alice', 'dnd');
    assert.ok((await dnd).online.includes(ids.alice));
    assert.equal((await listed('bob')).statuses[ids.alice], 'dnd', 'and the plain list says so as well');
  });

  it('invisible is offline to everybody else, and still itself to the person', async () => {
    const gone = presenceWhere('bob', (m) => !m.online.includes(ids.alice));
    await set('alice', 'invisible');
    const push = await gone;
    assert.equal(push.statuses[ids.alice], undefined);
    const seenByBob = await listed('bob');
    assert.ok(!seenByBob.online.includes(ids.alice));
    assert.equal((await listed('alice')).status, 'invisible');
    // Still connected: it is only not shown.
    assert.ok(sock.alice.ws.readyState === WebSocket.OPEN);
  });

  it('tells the person\'s other windows, and nobody else', async () => {
    const second = s.connect(tokens.alice);
    const hello = await second.hello();
    assert.equal(hello.status, 'invisible', 'a window that opens later starts from it');
    assert.ok(!hello.online.includes(ids.alice));
    const told = second.fresh((m) => m.type === 'presence:self');
    const bobMark = sock.bob.inbox.length;
    await set('alice', 'online');
    assert.equal((await told).status, 'online');
    assert.equal(sock.bob.inbox.slice(bobMark).some((m) => m.type === 'presence:self'), false);
    second.ws.close();
  });

  it('refuses a status that is not one', async () => {
    assert.equal((await set('alice', 'away')).error, 'invalid_status');
    assert.equal((await set('alice', undefined)).error, 'invalid_status');
    assert.equal((await listed('alice')).status, 'online');
  });

  it('is kept: it is the same after the person reconnects', async () => {
    await set('alice', 'dnd');
    sock.alice.ws.close();
    await new Promise((done) => setTimeout(done, 200));
    sock.alice = s.connect(tokens.alice);
    const hello = await sock.alice.hello();
    assert.equal(hello.status, 'dnd');
    assert.equal(hello.statuses[ids.alice], 'dnd');
    await set('alice', 'online');
  });
});

describe('the app not being touched', () => {
  const away = (who, value) => sock[who].request({ type: 'presence:away', away: value });

  it('makes an online person idle, and activity makes them online again', async () => {
    const idle = presenceWhere('bob', (m) => m.statuses[ids.alice] === 'idle');
    await away('alice', true);
    await idle;
    const back = presenceWhere('bob', (m) => m.online.includes(ids.alice) && m.statuses[ids.alice] === undefined);
    await away('alice', false);
    await back;
  });

  it('leaves what a person chose alone: do not disturb stays red, invisible stays gone', async () => {
    await set('alice', 'dnd');
    const mark = sock.bob.inbox.length;
    await away('alice', true);
    await away('alice', false);
    assert.equal(sock.bob.inbox.slice(mark).some((m) => m.type === 'presence'), false, 'nothing changed to be told');
    assert.equal((await listed('bob')).statuses[ids.alice], 'dnd');
    await set('alice', 'online');
  });

  it('counts two windows as one person: idle only when both are', async () => {
    const second = s.connect(tokens.alice);
    await second.hello();
    await away('alice', true);
    assert.equal((await listed('bob')).statuses[ids.alice], undefined, 'the other window is in use');
    const idle = presenceWhere('bob', (m) => m.statuses[ids.alice] === 'idle');
    await second.request({ type: 'presence:away', away: true });
    await idle;
    // One window in use again: the person is.
    const back = presenceWhere('bob', (m) => m.statuses[ids.alice] === undefined && m.online.includes(ids.alice));
    await second.request({ type: 'presence:away', away: false });
    await back;
    // And when that window, the only one in use, is closed, the person is idle: nobody was told by a close before.
    const idleAgain = presenceWhere('bob', (m) => m.statuses[ids.alice] === 'idle');
    second.ws.close();
    await idleAgain;
    await away('alice', false);
  });
});

describe('do not disturb', () => {
  const say = async (as, body) => (await api(`/api/channels/${general}/messages`, { method: 'POST', body: { body }, token: tokens[as] })).body.message;

  it('is a matter of sound, which the client keeps: the markers of a mention are still counted', async () => {
    await set('bob', 'dnd');
    const m = await say('boss', '@bob are you there');
    assert.ok(m.id);
    const entry = (await api('/api/unread', { token: tokens.bob })).body.channels.find((c) => c.channelId === general);
    assert.ok(entry.mentions >= 1, 'it is there to be seen when they look');
    const notified = (await api(`/api/messages/${m.id}/notified`, { token: tokens.boss })).body.notified;
    assert.ok(notified.includes(ids.bob));
    await set('bob', 'online');
  });
});
