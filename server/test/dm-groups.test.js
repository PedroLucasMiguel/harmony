// Private groups: who may make one, add and remove people, who sees what, and that a message to a group
// is sealed once for each person in it and each person is handed only their own copy.
//
//   node --test server/test/dm-groups.test.js

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';

import { liveServer, sealed, silent } from './helpers/live-server.js';

const s = liveServer({ port: 18140, mtxPort: 20040 });
const { api, tokens, ids, keyOf } = s;
const NAMES = ['boss', 'alice', 'bob', 'carol', 'dave', 'eve', 'nokey'];

before(async () => {
  await s.start(NAMES);
  for (const who of NAMES.filter((n) => n !== 'nokey')) await s.publishKey(who);
});
after(() => s.stop());

/** A message sealed for each of `to`, as a client would make one. */
const copiesFor = (to) => Object.fromEntries(
  to.map((who) => [ids[who], { k: keyOf[who], s: sealed() }]),
);

const makeGroup = async (who, title, others) => api('/api/dms/groups', {
  method: 'POST', token: tokens[who], body: { title, userIds: others.map((n) => ids[n]) },
});

const say = (who, conversationId, to, extra = {}) => api(`/api/dms/${conversationId}/messages`, {
  method: 'POST',
  token: tokens[who],
  body: { senderKey: keyOf[who], copies: copiesFor(to), ...extra },
});

describe('making a group', () => {
  it('lets anybody make one, and they run it', async () => {
    const r = await makeGroup('alice', '  Friday   night  ', ['bob', 'carol']);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const c = r.body.conversation;
    assert.equal(c.kind, 'group');
    assert.equal(c.title, 'Friday night');
    assert.equal(c.ownerId, ids.alice);
    assert.deepEqual([...c.userIds].sort(), [ids.alice, ids.bob, ids.carol].sort());
  });

  it('shows it to everybody in it, with the line that began it, and to nobody else', async () => {
    const r = await makeGroup('alice', 'Visible', ['bob']);
    const id = r.body.conversation.id;
    for (const who of ['alice', 'bob']) {
      const list = await api('/api/dms', { token: tokens[who] });
      assert.ok(list.body.conversations.some((c) => c.id === id && c.kind === 'group'), who);
    }
    const outsider = await api('/api/dms', { token: tokens.eve });
    assert.ok(!outsider.body.conversations.some((c) => c.id === id));
    assert.equal((await api(`/api/dms/${id}/messages`, { token: tokens.eve })).status, 404);
    assert.equal((await api(`/api/dms/${id}`, { token: tokens.boss })).status, 404, 'not even the owner of the server');
  });

  it('refuses what cannot be a group', async () => {
    assert.equal((await makeGroup('alice', '', ['bob'])).body.error, 'bad_title');
    assert.equal((await makeGroup('alice', 'Solo', [])).body.error, 'too_few');
    assert.equal((await makeGroup('alice', 'Self', ['alice'])).body.error, 'too_few');
    const nokey = await makeGroup('alice', 'No key', ['bob', 'nokey']);
    assert.equal(nokey.status, 409);
    assert.equal(nokey.body.error, 'peer_has_no_key');
    assert.equal(nokey.body.userId, ids.nokey);
    const ghost = await api('/api/dms/groups', {
      method: 'POST', token: tokens.alice, body: { title: 'Ghost', userIds: [9999] },
    });
    assert.equal(ghost.body.error, 'no_such_user');
    const many = await api('/api/dms/groups', {
      method: 'POST', token: tokens.alice, body: { title: 'Crowd', userIds: Array.from({ length: 16 }, (_, i) => 1000 + i) },
    });
    assert.equal(many.body.error, 'too_many');
  });

  it('will not put in somebody who has blocked you, or whom you have blocked', async () => {
    await api('/api/dms/blocks', { method: 'POST', token: tokens.dave, body: { userId: ids.alice } });
    const r = await makeGroup('alice', 'Blocked', ['bob', 'dave']);
    assert.equal(r.body.error, 'blocked');
    await api('/api/dms/blocks', { method: 'POST', token: tokens.dave, body: { userId: ids.alice, blocked: false } });
  });
});

describe('who may change a group', () => {
  let group;
  before(async () => {
    group = (await makeGroup('alice', 'Rules', ['bob', 'carol'])).body.conversation.id;
  });

  it('lets only the one who runs it add people, and tells everybody', async () => {
    const bob = s.connect(tokens.bob);
    const dave = s.connect(tokens.dave);
    await bob.hello();
    await dave.hello();

    const denied = await api(`/api/dms/${group}/members`, {
      method: 'POST', token: tokens.bob, body: { userIds: [ids.dave] },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'forbidden');

    const r = await api(`/api/dms/${group}/members`, {
      method: 'POST', token: tokens.alice, body: { userIds: [ids.dave] },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.conversation.userIds.includes(ids.dave));

    const told = await bob.next((m) => m.type === 'dm:message' && m.message.kind === 'group');
    assert.equal(told.message.meta.event, 'added');
    assert.deepEqual(told.message.meta.users, [ids.dave]);
    assert.ok(told.conversation.userIds.includes(ids.dave));
    const hers = await dave.next((m) => m.type === 'dm:message' && m.message.kind === 'group');
    assert.equal(hers.conversation.id, group, 'the person added is told of the group');
    await bob.close();
    await dave.close();

    const again = await api(`/api/dms/${group}/members`, {
      method: 'POST', token: tokens.alice, body: { userIds: [ids.dave] },
    });
    assert.equal(again.body.error, 'already_members');
  });

  it('lets only the one who runs it take people out, who then lose it at once', async () => {
    const carol = s.connect(tokens.carol);
    await carol.hello();
    const denied = await api(`/api/dms/${group}/members/remove`, {
      method: 'POST', token: tokens.bob, body: { userId: ids.carol },
    });
    assert.equal(denied.status, 403);
    const self = await api(`/api/dms/${group}/members/remove`, {
      method: 'POST', token: tokens.alice, body: { userId: ids.alice },
    });
    assert.equal(self.body.error, 'use_leave');

    const r = await api(`/api/dms/${group}/members/remove`, {
      method: 'POST', token: tokens.alice, body: { userId: ids.carol },
    });
    assert.equal(r.status, 200);
    assert.ok(!r.body.conversation.userIds.includes(ids.carol));
    await carol.next((m) => m.type === 'dm:left' && m.conversationId === group);
    await carol.close();

    assert.equal((await api(`/api/dms/${group}/messages`, { token: tokens.carol })).status, 404);
    const list = await api('/api/dms', { token: tokens.carol });
    assert.ok(!list.body.conversations.some((c) => c.id === group));
    const gone = await api(`/api/dms/${group}/members/remove`, {
      method: 'POST', token: tokens.alice, body: { userId: ids.carol },
    });
    assert.equal(gone.body.error, 'not_a_member');
  });

  it('lets those who were added only leave', async () => {
    const r = await api(`/api/dms/${group}/members`, {
      method: 'POST', token: tokens.bob, body: { userIds: [ids.eve] },
    });
    assert.equal(r.status, 403);
    const rename = await api(`/api/dms/${group}/rename`, {
      method: 'POST', token: tokens.bob, body: { title: 'Mine now' },
    });
    assert.equal(rename.status, 403);

    const dave = s.connect(tokens.dave);
    await dave.hello();
    const left = await api(`/api/dms/${group}/leave`, { method: 'POST', token: tokens.dave });
    assert.equal(left.status, 200);
    await dave.next((m) => m.type === 'dm:left' && m.conversationId === group);
    await dave.close();
    assert.equal((await api(`/api/dms/${group}/messages`, { token: tokens.dave })).status, 404);

    const alice = await api(`/api/dms/${group}`, { token: tokens.alice });
    assert.deepEqual(alice.body.conversation.userIds, [ids.alice, ids.bob]);
    assert.equal(alice.body.conversation.ownerId, ids.alice, 'leaving does not move who runs it');
  });

  it('lets the one who runs it rename it', async () => {
    const r = await api(`/api/dms/${group}/rename`, {
      method: 'POST', token: tokens.alice, body: { title: 'New name' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.conversation.title, 'New name');
    assert.equal((await api(`/api/dms/${group}/rename`, {
      method: 'POST', token: tokens.alice, body: { title: '   ' },
    })).body.error, 'bad_title');
  });

  it('is not a thing a pair can do', async () => {
    const pair = (await api('/api/dms', { method: 'POST', token: tokens.alice, body: { userId: ids.bob } })).body.conversation.id;
    for (const [path, body] of [
      [`/api/dms/${pair}/members`, { userIds: [ids.eve] }],
      [`/api/dms/${pair}/leave`, {}],
      [`/api/dms/${pair}/rename`, { title: 'x' }],
    ]) {
      const r = await api(path, { method: 'POST', token: tokens.alice, body });
      assert.equal(r.body.error, 'not_a_group', path);
    }
  });
});

describe('who runs it after the one who does leaves', () => {
  it('passes to whoever has been in longest, and ends a group down to one', async () => {
    const id = (await makeGroup('alice', 'Handover', ['bob', 'carol'])).body.conversation.id;
    const left = await api(`/api/dms/${id}/leave`, { method: 'POST', token: tokens.alice });
    assert.equal(left.status, 200);
    const c = (await api(`/api/dms/${id}`, { token: tokens.bob })).body.conversation;
    assert.equal(c.ownerId, ids.bob);
    assert.deepEqual(c.userIds, [ids.bob, ids.carol]);
    // The new one can run it.
    const add = await api(`/api/dms/${id}/members`, { method: 'POST', token: tokens.bob, body: { userIds: [ids.eve] } });
    assert.equal(add.status, 200);

    await api(`/api/dms/${id}/leave`, { method: 'POST', token: tokens.eve });
    await api(`/api/dms/${id}/leave`, { method: 'POST', token: tokens.carol });
    // Bob is alone, and so is the group: it is gone.
    const gone = await api(`/api/dms/${id}`, { token: tokens.bob });
    assert.equal(gone.status, 404);
  });
});

describe('what is said in a group', () => {
  let group;
  before(async () => {
    group = (await makeGroup('alice', 'Talk', ['bob', 'carol'])).body.conversation.id;
  });

  it('is sealed once per person, and each person is given only their own copy', async () => {
    const copies = copiesFor(['alice', 'bob', 'carol']);
    const r = await api(`/api/dms/${group}/messages`, {
      method: 'POST', token: tokens.alice, body: { senderKey: keyOf.alice, copies },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = r.body.message.id;

    for (const who of ['alice', 'bob', 'carol']) {
      const page = await api(`/api/dms/${group}/messages`, { token: tokens[who] });
      const m = page.body.messages.find((x) => x.id === id);
      assert.equal(m.sealed, copies[ids[who]].s, `${who} gets theirs`);
      assert.equal(m.recipientKey, keyOf[who]);
      assert.equal(m.senderKey, keyOf.alice);
      for (const other of ['alice', 'bob', 'carol'].filter((n) => n !== who)) {
        assert.ok(!JSON.stringify(page.body).includes(copies[ids[other]].s), `${who} is not handed ${other}'s copy`);
      }
    }
  });

  it('is pushed to each person with their own copy', async () => {
    const bob = s.connect(tokens.bob);
    const carol = s.connect(tokens.carol);
    await bob.hello();
    await carol.hello();
    const copies = copiesFor(['alice', 'bob', 'carol']);
    await api(`/api/dms/${group}/messages`, {
      method: 'POST', token: tokens.alice, body: { senderKey: keyOf.alice, copies },
    });
    const forBob = await bob.next((m) => m.type === 'dm:message' && m.message.kind === 'text');
    const forCarol = await carol.next((m) => m.type === 'dm:message' && m.message.kind === 'text');
    assert.equal(forBob.message.sealed, copies[ids.bob].s);
    assert.equal(forCarol.message.sealed, copies[ids.carol].s);
    await bob.close();
    await carol.close();
  });

  it('is refused unless it is sealed for exactly the people in the group, under their current keys', async () => {
    const short = await say('alice', group, ['alice', 'bob']);
    assert.equal(short.status, 409);
    assert.equal(short.body.error, 'stale_members');
    assert.deepEqual([...short.body.members].sort(), [ids.alice, ids.bob, ids.carol].sort());
    assert.ok(short.body.keys.length === 3, 'with what is needed to seal it again');

    const extra = await say('alice', group, ['alice', 'bob', 'carol', 'eve']);
    assert.equal(extra.body.error, 'stale_members');

    const wrongKey = copiesFor(['alice', 'bob', 'carol']);
    wrongKey[ids.bob].k = keyOf.bob + 999;
    const stale = await api(`/api/dms/${group}/messages`, {
      method: 'POST', token: tokens.alice, body: { senderKey: keyOf.alice, copies: wrongKey },
    });
    assert.equal(stale.body.error, 'stale_key');

    const notSealed = copiesFor(['alice', 'bob', 'carol']);
    notSealed[ids.carol].s = 'not sealed!';
    const bad = await api(`/api/dms/${group}/messages`, {
      method: 'POST', token: tokens.alice, body: { senderKey: keyOf.alice, copies: notSealed },
    });
    assert.equal(bad.body.error, 'bad_message');

    const noCopies = await api(`/api/dms/${group}/messages`, {
      method: 'POST', token: tokens.alice, body: { senderKey: keyOf.alice, sealed: sealed(), recipientKey: keyOf.bob },
    });
    assert.equal(noCopies.body.error, 'bad_message');
  });

  it('keeps a reaction as a copy for each person, shown to each as theirs', async () => {
    const sent = await say('alice', group, ['alice', 'bob', 'carol']);
    const id = sent.body.message.id;
    const copies = copiesFor(['alice', 'bob', 'carol']);
    const r = await api(`/api/dm-messages/${id}/react`, {
      method: 'POST', token: tokens.bob, body: { senderKey: keyOf.bob, copies },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.reactions[0].sealed, copies[ids.bob].s, 'the reactor sees their own copy');
    const seen = await api(`/api/dms/${group}/messages`, { token: tokens.carol });
    const reactions = seen.body.messages.find((m) => m.id === id).reactions;
    assert.equal(reactions.length, 1);
    assert.equal(reactions[0].userId, ids.bob);
    assert.equal(reactions[0].sealed, copies[ids.carol].s);

    const cleared = await api(`/api/dm-messages/${id}/react`, {
      method: 'POST', token: tokens.bob, body: {},
    });
    assert.deepEqual(cleared.body.reactions, []);
  });

  it('can be edited by its author, sealed again for everybody, keeping the old text for each', async () => {
    const sent = await say('bob', group, ['alice', 'bob', 'carol']);
    const id = sent.body.message.id;
    const first = sent.body.message.sealed;
    const copies = copiesFor(['alice', 'bob', 'carol']);
    const r = await api(`/api/dm-messages/${id}/edit`, {
      method: 'POST', token: tokens.bob, body: { senderKey: keyOf.bob, copies },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.message.sealed, copies[ids.bob].s);
    const denied = await api(`/api/dm-messages/${id}/edit`, {
      method: 'POST', token: tokens.alice, body: { senderKey: keyOf.alice, copies },
    });
    assert.equal(denied.status, 403);

    const old = await api(`/api/dm-messages/${id}/edits`, { token: tokens.bob });
    assert.equal(old.body.versions.length, 1);
    assert.equal(old.body.versions[0].sealed, first);
  });

  it('lets any of them pin it, and only its author delete it', async () => {
    const sent = await say('alice', group, ['alice', 'bob', 'carol']);
    const id = sent.body.message.id;
    const pin = await api(`/api/dm-messages/${id}/pin`, { method: 'POST', token: tokens.carol, body: { pinned: true } });
    assert.equal(pin.status, 200);
    assert.equal(pin.body.message.pinned, true);
    assert.equal((await api(`/api/dm-messages/${id}/delete`, { method: 'POST', token: tokens.carol })).status, 403);
    assert.equal((await api(`/api/dm-messages/${id}/delete`, { method: 'POST', token: tokens.alice })).status, 200);
  });

  it('counts as news for the others and not for the one who wrote it', async () => {
    const id = (await makeGroup('carol', 'News', ['bob'])).body.conversation.id;
    const before = (await api('/api/dms', { token: tokens.bob })).body.conversations.find((c) => c.id === id);
    await say('carol', id, ['bob', 'carol']);
    const bob = (await api('/api/dms', { token: tokens.bob })).body.conversations.find((c) => c.id === id);
    const carol = (await api('/api/dms', { token: tokens.carol })).body.conversations.find((c) => c.id === id);
    assert.equal(bob.unread, before.unread + 1);
    assert.equal(carol.unread, 0);
    await api(`/api/dms/${id}/read`, { method: 'POST', token: tokens.bob, body: { upTo: 1e9 } });
    const read = (await api('/api/dms', { token: tokens.bob })).body.conversations.find((c) => c.id === id);
    assert.equal(read.unread, 0);
  });
});

describe('what somebody added later can see', () => {
  it('is only what is said from then on, and not even the files from before', async () => {
    const id = (await makeGroup('alice', 'Late', ['bob'])).body.conversation.id;
    const up = await api(`/api/dms/${id}/uploads`, { method: 'POST', token: tokens.alice, raw: randomBytes(300) });
    const early = await say('alice', id, ['alice', 'bob'], { attachmentHash: up.body.hash });
    assert.equal(early.status, 201);

    const add = await api(`/api/dms/${id}/members`, { method: 'POST', token: tokens.alice, body: { userIds: [ids.eve] } });
    assert.equal(add.status, 200);
    const late = await say('alice', id, ['alice', 'bob', 'eve']);
    assert.equal(late.status, 201);

    const page = await api(`/api/dms/${id}/messages`, { token: tokens.eve });
    const texts = page.body.messages.filter((m) => m.kind === 'text').map((m) => m.id);
    assert.deepEqual(texts, [late.body.message.id], 'only what came after');
    assert.equal(page.body.messages.find((m) => m.kind === 'group').meta.event, 'added', 'and the line that let them in');
    assert.equal((await api(`/api/dms/${id}/uploads/${up.body.hash}`, { token: tokens.eve })).status, 404);
    assert.equal((await api(`/api/dms/${id}/uploads/${up.body.hash}`, { token: tokens.bob })).status, 200);

    // Bob still sees all of it.
    const bobSees = (await api(`/api/dms/${id}/messages`, { token: tokens.bob })).body.messages.filter((m) => m.kind === 'text');
    assert.equal(bobSees.length, 2);
  });

  it('does not bring back what a person saw before they were taken out and put in again', async () => {
    const id = (await makeGroup('alice', 'Back again', ['bob', 'carol'])).body.conversation.id;
    const one = await say('alice', id, ['alice', 'bob', 'carol']);
    await api(`/api/dms/${id}/members/remove`, { method: 'POST', token: tokens.alice, body: { userId: ids.carol } });
    const two = await say('alice', id, ['alice', 'bob']);
    await api(`/api/dms/${id}/members`, { method: 'POST', token: tokens.alice, body: { userIds: [ids.carol] } });
    const three = await say('alice', id, ['alice', 'bob', 'carol']);
    const seen = (await api(`/api/dms/${id}/messages`, { token: tokens.carol })).body.messages
      .filter((m) => m.kind === 'text').map((m) => m.id);
    assert.deepEqual(seen, [three.body.message.id]);
    assert.ok(one.body.message.id < two.body.message.id);
  });
});

describe('clearing a group for yourself', () => {
  it('takes it from your list and leaves it for the others, until something new is said', async () => {
    const id = (await makeGroup('alice', 'Clear', ['bob'])).body.conversation.id;
    await say('alice', id, ['alice', 'bob']);
    const r = await api(`/api/dms/${id}/clear`, { method: 'POST', token: tokens.bob });
    assert.equal(r.status, 200);
    assert.ok(!(await api('/api/dms', { token: tokens.bob })).body.conversations.some((c) => c.id === id));
    assert.ok((await api('/api/dms', { token: tokens.alice })).body.conversations.some((c) => c.id === id));
    await say('alice', id, ['alice', 'bob']);
    assert.ok((await api('/api/dms', { token: tokens.bob })).body.conversations.some((c) => c.id === id));
  });
});

describe('removing an account', () => {
  it('leaves the group to those still in it, with a new one to run it', async () => {
    const id = (await makeGroup('eve', 'Eve runs', ['bob', 'carol', 'dave'])).body.conversation.id;
    const up = await api(`/api/dms/${id}/uploads`, { method: 'POST', token: tokens.eve, raw: randomBytes(200) });
    await say('eve', id, ['eve', 'bob', 'carol', 'dave'], { attachmentHash: up.body.hash });
    await say('bob', id, ['eve', 'bob', 'carol', 'dave']);

    assert.equal((await api(`/api/accounts/${ids.eve}/delete`, { method: 'POST', token: tokens.boss })).status, 200);

    const c = (await api(`/api/dms/${id}`, { token: tokens.bob })).body.conversation;
    assert.equal(c.ownerId, ids.bob);
    assert.deepEqual(c.userIds, [ids.bob, ids.carol, ids.dave]);
    const texts = (await api(`/api/dms/${id}/messages`, { token: tokens.bob })).body.messages.filter((m) => m.kind === 'text');
    assert.equal(texts.length, 1, 'what they wrote went with them');

    const db = new DatabaseSync(resolve(s.dataDir, 'harmony.db'), { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT refs FROM uploads WHERE hash = ?').get(up.body.hash).refs, 0, 'and its file was let go');
    } finally {
      db.close();
    }
  });

  it('ends a group that is left with one person', async () => {
    const id = (await makeGroup('carol', 'Two of us', ['dave'])).body.conversation.id;
    assert.equal((await api(`/api/accounts/${ids.dave}/delete`, { method: 'POST', token: tokens.boss })).status, 200);
    assert.equal((await api(`/api/dms/${id}`, { token: tokens.carol })).status, 404);
  });
});

describe('a database from before groups', () => {
  it('keeps every conversation, message and file through the migration', async () => {
    const { migrate } = await import('../src/db.js');
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    // Up to the schema before groups, with a conversation in it.
    migrate(db, 27);
    db.exec(`
      INSERT INTO users (id, nickname, password_hash, role, created_at) VALUES (1, 'a', 'x', 'member', 0), (2, 'b', 'x', 'member', 0);
      INSERT INTO dm_conversations (id, user_a, user_b, created_at, last_at) VALUES (7, 1, 2, 1, 2);
      INSERT INTO dm_messages (id, conversation_id, user_id, sealed, created_at) VALUES (1, 7, 1, 'abc', 5);
      INSERT INTO dm_reads (conversation_id, user_id, last_read_id) VALUES (7, 2, 1);
    `);
    migrate(db);
    assert.equal(db.prepare('SELECT kind FROM dm_conversations WHERE id = 7').get().kind, 'pair');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dm_messages').get().n, 1, 'the messages were not cascaded away');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dm_reads').get().n, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    // And it still cascades: the children follow the conversation.
    db.exec('DELETE FROM dm_conversations WHERE id = 7');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dm_messages').get().n, 0);
    // A pair is still one row per two people.
    db.exec("INSERT INTO dm_conversations (user_a, user_b, created_at, last_at) VALUES (1, 2, 1, 1)");
    assert.throws(() => db.exec("INSERT INTO dm_conversations (user_a, user_b, created_at, last_at) VALUES (1, 2, 1, 1)"));
    assert.throws(() => db.exec("INSERT INTO dm_conversations (user_a, user_b, created_at, last_at) VALUES (2, 1, 1, 1)"));
  });
});
