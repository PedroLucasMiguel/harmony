// "Is typing": who is told, and who is not.
//
//   node --test server/test/typing.test.js

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { liveServer, silent } from './helpers/live-server.js';

const s = liveServer({ port: 18143, mtxPort: 20043 });
const { api, tokens, ids } = s;
const NAMES = ['boss', 'alice', 'bob', 'carol'];
const sock = {};
let general;

before(async () => {
  await s.start(NAMES);
  for (const who of NAMES) {
    sock[who] = s.connect(tokens[who]);
    await sock[who].hello();
  }
  const list = await api('/api/channels', { token: tokens.boss });
  general = list.body.channels.find((c) => c.kind === 'text').id;
  for (const who of ['alice', 'bob']) await s.publishKey(who);
});
after(async () => {
  Object.values(sock).forEach((c) => c.ws.close());
  await s.stop();
});

const typing = (who, payload) => sock[who].request({ type: 'typing', ...payload });

describe('typing in a channel', () => {
  it('is told to everybody who can see it, and not to the one typing', async () => {
    const seenByBob = sock.bob.fresh((m) => m.type === 'typing');
    const seenByAlice = sock.alice.inbox.length;
    assert.equal((await typing('alice', { scope: 'channel', id: general })).type, 'typing:ok');
    const got = await seenByBob;
    assert.deepEqual([got.scope, got.id, got.userId], ['channel', general, ids.alice]);
    await sock.carol.next((m) => m.type === 'typing');
    assert.equal(sock.alice.inbox.slice(seenByAlice).some((m) => m.type === 'typing'), false);
  });

  it('is told when they stop, too', async () => {
    const stop = sock.bob.fresh((m) => m.type === 'typing' && m.stopped === true);
    await typing('alice', { scope: 'channel', id: general, stopped: true });
    assert.equal((await stop).userId, ids.alice);
    const start = await (async () => {
      const next = sock.bob.fresh((m) => m.type === 'typing' && m.stopped === false);
      await typing('alice', { scope: 'channel', id: general });
      return next;
    })();
    assert.equal(start.userId, ids.alice, 'and a start says it is not a stop');
  });

  it('is not told for a voice channel, a channel that is not there, or something that is not a place', async () => {
    const list = (await api('/api/channels', { token: tokens.boss })).body.channels;
    const voice = list.find((c) => c.kind === 'voice').id;
    const mark = sock.bob.inbox.length;
    await typing('alice', { scope: 'channel', id: voice });
    await typing('alice', { scope: 'channel', id: 99999 });
    await typing('alice', { scope: 'nowhere', id: general });
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(sock.bob.inbox.slice(mark).some((m) => m.type === 'typing'), false);
  });

  it('is kept from being a flood', async () => {
    const mark = sock.bob.inbox.length;
    for (let i = 0; i < 40; i += 1) await typing('carol', { scope: 'channel', id: general });
    const got = sock.bob.inbox.slice(mark).filter((m) => m.type === 'typing').length;
    assert.ok(got > 0 && got < 20, `${got} got through`);
  });
});

describe('typing in a private conversation', () => {
  let convo;
  before(async () => {
    convo = (await api('/api/dms', { method: 'POST', token: tokens.alice, body: { userId: ids.bob } })).body.conversation.id;
  });

  it('is told to the other person only', async () => {
    const forBob = sock.bob.fresh((m) => m.type === 'typing' && m.scope === 'dm');
    const mark = sock.carol.inbox.length;
    await typing('alice', { scope: 'dm', id: convo });
    const got = await forBob;
    assert.deepEqual([got.id, got.userId], [convo, ids.alice]);
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(sock.carol.inbox.slice(mark).some((m) => m.type === 'typing'), false, 'a third person is told nothing');
  });

  it('is told to nobody for somebody who is not in it', async () => {
    const mark = sock.bob.inbox.length;
    await typing('carol', { scope: 'dm', id: convo });
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(sock.bob.inbox.slice(mark).some((m) => m.type === 'typing'), false);
  });

  it('stops while one has blocked the other', async () => {
    await api('/api/dms/blocks', { method: 'POST', token: tokens.bob, body: { userId: ids.alice } });
    const mark = sock.bob.inbox.length;
    await typing('alice', { scope: 'dm', id: convo });
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(sock.bob.inbox.slice(mark).some((m) => m.type === 'typing'), false);
    await api('/api/dms/blocks', { method: 'POST', token: tokens.bob, body: { userId: ids.alice, blocked: false } });
  });

  it('is told to everybody else in a group', async () => {
    await s.publishKey('carol');
    const group = (await api('/api/dms/groups', {
      method: 'POST', token: tokens.alice, body: { title: 'Three', userIds: [ids.bob, ids.carol] },
    })).body.conversation.id;
    const b = sock.bob.fresh((m) => m.type === 'typing' && m.id === group);
    const c = sock.carol.fresh((m) => m.type === 'typing' && m.id === group);
    await typing('alice', { scope: 'dm', id: group });
    await Promise.all([b, c]);
  });
});
