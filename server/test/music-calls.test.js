// Music Buddy in a private call: the same music as in a voice channel, for the people on the call and nobody else.
//
//   node --test server/test/music-calls.test.js

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { liveServer } from './helpers/live-server.js';
import { roomOf } from '../src/calls.js';
import { maxFilesizeFor } from '../src/music/ytdlp.js';

const here = dirname(fileURLToPath(import.meta.url));
const s = liveServer({
  port: 18144,
  mtxPort: 20044,
  env: {
    HARMONY_YTDLP_BIN: resolve(here, 'fixtures', 'fake-ytdlp.mjs'),
    FAKE_DURATION: '60',
    HARMONY_MUSIC_NO_THUMBNAILS: '1',
  },
});
const { api, tokens, ids } = s;
const NAMES = ['boss', 'alice', 'bob', 'carol'];
const sockets = {};

before(async () => {
  await s.start(NAMES);
  for (const who of NAMES) await s.publishKey(who);
  assert.equal((await api('/api/server', { method: 'POST', token: tokens.boss, body: { musicEnabled: true } })).status, 200);
  const role = (await api('/api/roles', { method: 'POST', token: tokens.boss, body: { name: 'DJ', permissions: ['music.control'] } })).body.role;
  await api(`/api/accounts/${ids.alice}/roles`, { method: 'POST', token: tokens.boss, body: { roles: [role.id] } });
});
after(async () => {
  for (const sock of Object.values(sockets)) { try { sock.ws.close(); } catch { /* gone */ } }
  await s.stop();
});

async function online(who) {
  if (sockets[who]?.ws.readyState === WebSocket.OPEN) return sockets[who];
  sockets[who] = s.connect(tokens[who]);
  await sockets[who].hello();
  return sockets[who];
}

const group = async (owner, title, others) => (await api('/api/dms/groups', {
  method: 'POST', token: tokens[owner], body: { title, userIds: others.map((n) => ids[n]) },
})).body.conversation.id;

const items = (n) => Array.from({ length: n }, (_, i) => ({
  source: `yt:${String(i + 1).padStart(2, '0')}abcdefghi`, title: `Song ${i + 1}`, artist: 'Artist', durationMs: 60_000,
}));
const states = (client) => client.inbox.filter((m) => m.type === 'music:state');
const waitState = async (client, test) => (await client.next((m) => m.type === 'music:state' && test(m.state, m))).state;

describe('music in a call', () => {
  let convo;
  let room;
  before(async () => {
    convo = await group('alice', 'Listening', ['bob', 'carol']);
    room = roomOf(convo);
  });

  it('is asked for in the call\'s room, by somebody who is on the call and holds the permission', async () => {
    const alice = await online('alice');
    const bob = await online('bob');
    const started = await alice.request({ type: 'call:start', conversationId: convo });
    assert.equal(started.type, 'call:joined');
    assert.equal(started.music, null, 'nothing is playing yet');
    assert.equal((await bob.request({ type: 'call:join', conversationId: convo })).type, 'call:joined');

    const added = await alice.request({ type: 'music:add', channelId: room, items: items(2) });
    assert.deepEqual([added.type, added.added], ['voice:ok', 2]);
    const heardByAlice = await waitState(alice, (state) => state.status === 'playing');
    const heardByBob = await waitState(bob, (state) => state.status === 'playing');
    assert.equal(heardByAlice.queue.length, 2);
    assert.equal(heardByBob.current, heardByAlice.current, 'both are at the same track');
    assert.ok(heardByBob.queue[0].hash, 'the file they will both play');
  });

  it('somebody on the call without the permission can listen, and cannot add or control', async () => {
    const bob = await online('bob');
    const add = await bob.request({ type: 'music:add', channelId: room, items: items(1) });
    assert.deepEqual([add.type, add.error], ['voice:error', 'forbidden']);
    assert.equal((await bob.request({ type: 'music:control', channelId: room, action: 'pause' })).error, 'forbidden');
    const sync = await bob.request({ type: 'music:sync', channelId: room });
    assert.equal(sync.type, 'music:sync');
    assert.equal(sync.music.state.status, 'playing');
    assert.equal((await bob.request({ type: 'music:clock', channelId: room })).type, 'music:clock');
  });

  it('somebody in the conversation who is not on the call hears nothing, and cannot reach it', async () => {
    const carol = await online('carol');
    assert.equal(states(carol).length, 0);
    assert.equal((await carol.request({ type: 'music:sync', channelId: room })).error, 'not_in_channel');
    assert.equal((await carol.request({ type: 'music:add', channelId: room, items: items(1) })).error, 'not_in_channel');
  });

  it('is controlled for everybody on the call at once', async () => {
    const alice = await online('alice');
    const bob = await online('bob');
    const paused = bob.fresh((m) => m.type === 'music:state' && m.state.status === 'paused');
    assert.equal((await alice.request({ type: 'music:control', channelId: room, action: 'pause' })).type, 'voice:ok');
    assert.equal((await paused).state.status, 'paused');
  });

  it('is where it is for somebody who joins in the middle', async () => {
    const carol = await online('carol');
    const joined = await carol.request({ type: 'call:join', conversationId: convo });
    assert.equal(joined.type, 'call:joined');
    assert.ok(joined.music, 'the join carries it');
    assert.equal(joined.music.state.status, 'paused');
    assert.equal(joined.music.state.queue.length, 2);
  });

  it('is not a channel\'s: an ordinary voice channel does not see it, and the permission is the same', async () => {
    const channel = (await api('/api/channels', { token: tokens.boss })).body.channels.find((c) => c.kind === 'voice');
    const bob = await online('bob');
    // Bob is in the call; the channel is not his room.
    assert.equal((await bob.request({ type: 'music:sync', channelId: channel.id })).error, 'not_in_channel');
  });

  it('is over with the call: nothing is playing when it starts again', async () => {
    const alice = await online('alice');
    const bob = await online('bob');
    const carol = await online('carol');
    for (const sock of [alice, bob, carol]) await sock.request({ type: 'voice:leave', channelId: room });
    const again = await alice.request({ type: 'call:start', conversationId: convo });
    assert.equal(again.type, 'call:joined');
    assert.equal(again.music, null, 'the music did not outlast the call');
  });
});

describe('the longest a track may be', () => {
  it('is four hours, and the biggest file that allows is worked out from it', () => {
    assert.equal(maxFilesizeFor(900), '31M', 'a quarter of an hour');
    assert.equal(maxFilesizeFor(60), '24M', 'and never less than a song needs');
    assert.equal(maxFilesizeFor(14_400), '481M');
    assert.equal(maxFilesizeFor(3600), '121M');
  });
});
