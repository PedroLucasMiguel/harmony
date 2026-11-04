// Private calls: ringing, answering, declining, missing, group calls, and that the relay lets in only whoever
// is in the call.
//
//   node --test server/test/calls.test.js

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { liveServer, silent } from './helpers/live-server.js';
import { CALL_BASE, roomOf, isCallRoom, conversationOf } from '../src/calls.js';
import { parseChannelPath, channelPath } from '../src/channels.js';

const s = liveServer({ port: 18141, mtxPort: 20041, env: { HARMONY_CALL_RING_MS: '1200' } });
const { api, tokens, ids, keyOf } = s;
const NAMES = ['boss', 'alice', 'bob', 'carol', 'eve'];
const sockets = {};

before(async () => {
  await s.start(NAMES);
  for (const who of NAMES) await s.publishKey(who);
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

const pair = async (a, b) => (await api('/api/dms', {
  method: 'POST', token: tokens[a], body: { userId: ids[b] },
})).body.conversation.id;

const group = async (owner, title, others) => (await api('/api/dms/groups', {
  method: 'POST', token: tokens[owner], body: { title, userIds: others.map((n) => ids[n]) },
})).body.conversation.id;

const mediaAuth = (action, path, token) => api('/mediamtx/auth', {
  method: 'POST', body: { action, path, query: `token=${encodeURIComponent(token)}` },
});

const callLines = async (who, conversationId) => (await api(`/api/dms/${conversationId}/messages`, {
  token: tokens[who],
})).body.messages.filter((m) => m.kind === 'call');

describe('a call\'s room', () => {
  it('has an id no channel has, and a path the relay can read back', () => {
    const room = roomOf(7);
    assert.equal(room, CALL_BASE + 7);
    assert.ok(isCallRoom(room));
    assert.ok(!isCallRoom(7));
    assert.equal(conversationOf(room), 7);
    const path = channelPath(room, 3, 'cam');
    assert.deepEqual(parseChannelPath(path), { cid: room, mid: 3, kind: 'c' });
    assert.deepEqual(parseChannelPath(channelPath(7, 3, 'voice')), { cid: 7, mid: 3, kind: 'v' });
  });
});

describe('a call between two', () => {
  let convo;
  before(async () => { convo = await pair('alice', 'bob'); });

  it('rings the other person, and puts the caller in the room', async () => {
    const alice = await online('alice');
    const bob = await online('bob');
    const joined = await alice.request({ type: 'call:start', conversationId: convo });
    assert.equal(joined.type, 'call:joined', JSON.stringify(joined));
    assert.equal(joined.channelId, roomOf(convo));
    assert.equal(joined.mid, 1);
    assert.match(joined.publish.voice, new RegExp(`/vc-${roomOf(convo).toString(36)}-1-v/whip\\?token=`));
    assert.equal(joined.roster.length, 1);
    assert.deepEqual(joined.call.ringing, [ids.bob]);

    const ring = await bob.next((m) => m.type === 'call:ring' && m.conversationId === convo);
    assert.equal(ring.from.id, ids.alice);
    assert.equal(ring.from.nickname, 'alice');
    assert.equal(ring.group, false);
    const state = await bob.next((m) => m.type === 'call:state' && m.call);
    assert.deepEqual(state.call.participants, [ids.alice]);

    const inbox = await api('/api/inbox', { token: tokens.bob });
    assert.equal(inbox.body.ringing, true);
    assert.equal((await api('/api/inbox', { token: tokens.alice })).body.inCall, true);
  });

  it('puts the other person in when they answer, and lets both see the roster', async () => {
    const alice = await online('alice');
    const bob = await online('bob');
    const joined = await bob.request({ type: 'call:join', conversationId: convo });
    assert.equal(joined.type, 'call:joined');
    assert.equal(joined.mid, 2);
    assert.equal(joined.roster.length, 2);
    const roster = await alice.next((m) => m.type === 'voice:roster' && m.channelId === roomOf(convo) && m.roster.length === 2);
    assert.deepEqual(roster.roster.map((r) => r.userId), [ids.alice, ids.bob]);
    const state = await alice.next((m) => m.type === 'call:state' && m.call?.answeredAt);
    assert.deepEqual(state.call.ringing, []);
  });

  it('carries mute, publishing and a fresh token on the same requests a channel does', async () => {
    const alice = await online('alice');
    const bob = await online('bob');
    const channelId = roomOf(convo);
    assert.equal((await alice.request({ type: 'voice:mute', channelId, muted: true, deafened: false })).type, 'voice:ok');
    const roster = await bob.next((m) => m.type === 'voice:roster' && m.roster.some((r) => r.userId === ids.alice && r.muted));
    assert.ok(roster);
    assert.equal((await alice.request({ type: 'voice:publishing', channelId, kind: 'c', on: true })).type, 'voice:ok');
    await bob.next((m) => m.type === 'voice:roster' && m.roster.some((r) => r.publishing.includes('c')));
    const tokens2 = await alice.request({ type: 'voice:refresh', channelId });
    assert.equal(tokens2.type, 'voice:tokens');
    assert.equal(tokens2.channelId, channelId);
  });

  it('lets the relay serve those in the call and nobody else', async () => {
    const bob = await online('bob');
    const alice = await online('alice');
    const channelId = roomOf(convo);
    const mine = (await alice.request({ type: 'voice:refresh', channelId })).token;
    assert.equal((await mediaAuth('read', channelPath(channelId, 2, 'voice'), mine)).status, 204);
    assert.equal((await mediaAuth('publish', channelPath(channelId, 1, 'voice'), mine)).status, 204);
    assert.equal((await mediaAuth('publish', channelPath(channelId, 2, 'voice'), mine)).status, 401, 'not into their slot');

    // A token for a channel is no use here, and this one is no use there.
    const other = roomOf(convo + 1);
    assert.equal((await mediaAuth('read', channelPath(other, 2, 'voice'), mine)).status, 401);
  });

  it('is over for both when one of two hangs up, and leaves a line in the conversation', async () => {
    const alice = await online('alice');
    const bob = await online('bob');
    const channelId = roomOf(convo);
    const lineSeen = bob.fresh((m) => m.type === 'dm:message' && m.message.kind === 'call');
    const stateNull = bob.fresh((m) => m.type === 'call:state' && m.call === null);
    const hungUp = bob.fresh((m) => m.type === 'call:ended' && m.conversationId === convo);
    const left = await alice.request({ type: 'voice:leave', channelId });
    assert.equal(left.type, 'voice:left');
    await hungUp;
    const { message } = await lineSeen;
    assert.equal(message.meta.outcome, 'ended');
    assert.equal(message.userId, ids.alice);
    assert.ok(message.meta.durationMs >= 0);
    assert.deepEqual([...message.meta.participants].sort(), [ids.alice, ids.bob].sort());
    await stateNull;

    // Everybody's slot is gone with the call, and a token from it opens nothing.
    const token = (await bob.request({ type: 'voice:refresh', channelId }));
    assert.equal(token.type, 'voice:error');
    // A call both were on is not news to either.
    const list = await api('/api/dms', { token: tokens.bob });
    assert.equal(list.body.conversations.find((c) => c.id === convo).unread, 0);
    assert.equal((await api('/api/inbox', { token: tokens.alice })).body.inCall, false);
  });

  it('is missed when nobody answers, and is news to the one who was rung', async () => {
    const alice = await online('alice');
    const bob = await online('bob');
    const ended = alice.fresh((m) => m.type === 'call:ended' && m.conversationId === convo);
    const stopped = bob.fresh((m) => m.type === 'call:ring-stopped');
    await alice.request({ type: 'call:start', conversationId: convo });
    await ended;
    await stopped;
    const lines = await callLines('bob', convo);
    assert.equal(lines.at(-1).meta.outcome, 'missed');
    const list = await api('/api/dms', { token: tokens.bob });
    assert.equal(list.body.conversations.find((c) => c.id === convo).unread, 1);
    assert.equal((await api('/api/inbox', { token: tokens.bob })).body.ringing, false);
    await api(`/api/dms/${convo}/read`, { method: 'POST', token: tokens.bob, body: { upTo: 1e9 } });
  });

  it('is over when the one rung turns it down, and is not news to them', async () => {
    const alice = await online('alice');
    const bob = await online('bob');
    const ended = alice.fresh((m) => m.type === 'call:ended' && m.conversationId === convo);
    const rung = bob.fresh((m) => m.type === 'call:ring');
    await alice.request({ type: 'call:start', conversationId: convo });
    await rung;
    assert.equal((await bob.request({ type: 'call:decline', conversationId: convo })).type, 'voice:ok');
    await ended;
    assert.equal((await callLines('alice', convo)).at(-1).meta.outcome, 'declined');
    const list = await api('/api/dms', { token: tokens.bob });
    assert.equal(list.body.conversations.find((c) => c.id === convo).unread, 0);
  });

  it('is over when the caller\'s connection drops', async () => {
    const alice = s.connect(tokens.alice);
    await alice.hello();
    const bob = await online('bob');
    const rung = bob.fresh((m) => m.type === 'call:ring');
    const lineSeen = bob.fresh((m) => m.type === 'dm:message' && m.message.kind === 'call');
    await alice.request({ type: 'call:start', conversationId: convo });
    await rung;
    await alice.close();
    sockets.alice = null;
    assert.equal((await lineSeen).message.meta.outcome, 'missed');
  });

  it('cannot be started when one has blocked the other', async () => {
    await api('/api/dms/blocks', { method: 'POST', token: tokens.bob, body: { userId: ids.alice } });
    const alice = await online('alice');
    const r = await alice.request({ type: 'call:start', conversationId: convo });
    assert.equal(r.type, 'call:error');
    assert.equal(r.error, 'blocked');
    await api('/api/dms/blocks', { method: 'POST', token: tokens.bob, body: { userId: ids.alice, blocked: false } });
  });
});

describe('who may call', () => {
  it('is only somebody in the conversation, and a stranger cannot even tell it is there', async () => {
    const convo = await pair('alice', 'bob');
    const eve = await online('eve');
    for (const type of ['call:start', 'call:join', 'call:decline']) {
      const r = await eve.request({ type, conversationId: convo });
      assert.equal(r.type, 'call:error', type);
      assert.equal(r.error, 'no_such_conversation');
    }
    const nothing = await eve.request({ type: 'call:start', conversationId: 999999 });
    assert.equal(nothing.error, 'no_such_conversation');
  });

  it('has nothing to join when there is no call', async () => {
    const convo = await pair('bob', 'carol');
    const bob = await online('bob');
    const r = await bob.request({ type: 'call:join', conversationId: convo });
    assert.equal(r.type, 'call:error');
    assert.equal(r.error, 'no_call');
  });

  it('is kept from being rung like a bell', async () => {
    const convo = await pair('carol', 'eve');
    const carol = await online('carol');
    let refused = null;
    for (let i = 0; i < 20 && !refused; i += 1) {
      const r = await carol.request({ type: 'call:start', conversationId: convo });
      if (r.error === 'slow_down') refused = r;
      else await carol.request({ type: 'voice:leave', channelId: roomOf(convo) });
    }
    assert.ok(refused, 'asking again and again is refused');
  });
});

describe('a call in a group', () => {
  let convo;
  before(async () => { convo = await group('alice', 'Crew', ['bob', 'carol']); });

  it('rings everybody, goes on when one turns it down, and can be joined any time', async () => {
    const alice = await online('alice');
    const bob = await online('bob');
    const carol = await online('carol');
    const joined = await alice.request({ type: 'call:start', conversationId: convo });
    assert.equal(joined.type, 'call:joined');
    const ring = await bob.next((m) => m.type === 'call:ring' && m.conversationId === convo);
    assert.equal(ring.group, true);
    assert.equal(ring.title, 'Crew');
    await carol.next((m) => m.type === 'call:ring' && m.conversationId === convo);

    await carol.request({ type: 'call:decline', conversationId: convo });
    await alice.next((m) => m.type === 'call:state' && m.call && !m.call.ringing.includes(ids.carol));
    // Still going: the call did not end for one person saying no.
    assert.ok(await api(`/api/dms/${convo}`, { token: tokens.alice }));

    assert.equal((await bob.request({ type: 'call:join', conversationId: convo })).type, 'call:joined');
    // Carol changes her mind, and may.
    const late = await carol.request({ type: 'call:join', conversationId: convo });
    assert.equal(late.type, 'call:joined');
    assert.equal(late.roster.length, 3);
    assert.deepEqual(late.roster.map((r) => r.mid), [1, 2, 3]);
  });

  it('is over for the one who is taken out of the group, at once', async () => {
    const carol = await online('carol');
    const alice = await online('alice');
    const told = carol.fresh((m) => m.type === 'call:ended' && m.conversationId === convo);
    const r = await api(`/api/dms/${convo}/members/remove`, { method: 'POST', token: tokens.alice, body: { userId: ids.carol } });
    assert.equal(r.status, 200);
    await told;
    const roster = await alice.next((m) => m.type === 'voice:roster' && m.channelId === roomOf(convo) && m.roster.length === 2);
    assert.deepEqual(roster.roster.map((x) => x.userId), [ids.alice, ids.bob]);
    const carolJoin = await carol.request({ type: 'call:join', conversationId: convo });
    assert.equal(carolJoin.error, 'no_such_conversation');
  });

  it('goes on after the one who began it leaves while two are left, and is over when one is', async () => {
    const alice = await online('alice');
    const bob = await online('bob');
    const carol = await online('carol');
    // Carol is back in it (she was taken out of the group a moment ago, so she is not): bring in a third.
    await api(`/api/dms/${convo}/members`, { method: 'POST', token: tokens.alice, body: { userIds: [ids.carol] } });
    const three = alice.fresh((m) => m.type === 'call:state' && m.call?.participants.length === 3);
    assert.equal((await carol.request({ type: 'call:join', conversationId: convo })).type, 'call:joined');
    assert.ok(await three);
    const aliceGone = bob.fresh((m) => m.type === 'call:state' && m.call && !m.call.participants.includes(ids.alice));
    await alice.request({ type: 'voice:leave', channelId: roomOf(convo) });
    assert.deepEqual((await aliceGone).call.participants.sort(), [ids.bob, ids.carol].sort());
    const ended = bob.fresh((m) => m.type === 'dm:message' && m.message.kind === 'call');
    const told = carol.fresh((m) => m.type === 'call:ended');
    await bob.request({ type: 'voice:leave', channelId: roomOf(convo) });
    assert.equal((await ended).message.meta.outcome, 'ended');
    await told;
  });

  it('is told to somebody who connects while it is going on', async () => {
    const alice = await online('alice');
    await alice.request({ type: 'call:start', conversationId: convo });
    const late = s.connect(tokens.bob);
    const hello = await late.hello();
    assert.equal(hello.calls.length, 1);
    assert.equal(hello.calls[0].conversationId, convo);
    assert.ok(hello.calls[0].ringing.includes(ids.bob), 'and that he is being rung');
    await late.close();
    await alice.request({ type: 'voice:leave', channelId: roomOf(convo) });
  });
});

describe('one room at a time', () => {
  it('takes somebody out of a channel when they join a call, and out of the call when they join a channel', async () => {
    const boss = await online('boss');
    const alice = await online('alice');
    const made = await api('/api/channels', { method: 'POST', token: tokens.boss, body: { name: 'Lounge', kind: 'voice' } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const channelId = made.body.channel.id;

    const inChannel = await alice.request({ type: 'voice:join', channelId });
    assert.equal(inChannel.type, 'voice:joined');
    const convo = await pair('alice', 'bob');
    const call = await alice.request({ type: 'call:start', conversationId: convo });
    assert.equal(call.type, 'call:joined');
    const roster = await boss.next((m) => m.type === 'voice:roster' && m.channelId === channelId && m.roster.length === 0);
    assert.ok(roster, 'the channel is told she has gone');

    const bob = await online('bob');
    const lineSeen = bob.fresh((m) => m.type === 'dm:message' && m.message.kind === 'call');
    const mark = alice.inbox.length;
    const back = await alice.request({ type: 'voice:join', channelId });
    assert.equal(back.type, 'voice:joined');
    assert.equal((await lineSeen).message.meta.outcome, 'missed', 'the call she left ended, with nobody in it');
    assert.equal(alice.inbox.slice(mark).some((m) => m.type === 'call:ended'), false, 'she left it herself: not told it ended');
    await silent(boss, (m) => m.type === 'voice:roster' && m.channelId === roomOf(convo));
  });
});
