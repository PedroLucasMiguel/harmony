// Private groups end to end: the session (dm-session.js, over the vault and the crypto) against a REAL server,
// as several people on different computers. What is checked is what a person would see: that a message to a
// group is read by everybody in it and by nobody else, that the server holds nothing it could read, that
// somebody added later starts from then, and what happens when a key in the group changes.
//
//   node --test client/test/dm-groups.test.mjs

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { MemoryKeyFile } from '../src/renderer/dm-keyfile.js';
import { DmSession, previewOf } from '../src/renderer/dm-session.js';
import { KeyState } from '../src/renderer/dm-vault.js';
import { liveServer } from '../../server/test/helpers/live-server.js';

const s = liveServer({ port: 18142, mtxPort: 20042 });
const NAMES = ['boss', 'alice', 'bob', 'carol', 'dave', 'eve', 'frank', 'grace', 'harry'];

before(async () => { await s.start(NAMES); });
after(() => s.stop());

/** The app's api object, as harmony.api has it, over fetch with one person's token. */
function apiFor(token) {
  const headers = () => ({ Authorization: `Bearer ${token}` });
  const answer = async (res) => {
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* binary */ }
    return { status: res.status, body };
  };
  return {
    async dmRequest(_server, method, path, body) {
      return answer(await fetch(`${s.BASE}${path}`, {
        method,
        headers: { ...headers(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }));
    },
    async dmUpload(_server, id, bytes) {
      return answer(await fetch(`${s.BASE}/api/dms/${id}/uploads`, {
        method: 'POST', headers: { ...headers(), 'Content-Type': 'application/octet-stream' }, body: bytes,
      }));
    },
    async dmDownload(_server, id, hash) {
      const res = await fetch(`${s.BASE}/api/dms/${id}/uploads/${hash}`, { headers: headers() });
      return { status: res.status, bytes: res.ok ? new Uint8Array(await res.arrayBuffer()) : null };
    },
  };
}

/** One person on one computer: a session with its own key file, and a socket feeding it the server's pushes. */
async function computer(who, { file = new MemoryKeyFile() } = {}) {
  const session = new DmSession({
    server: s.BASE, me: { id: s.ids[who] }, api: apiFor(s.tokens[who]), file,
  });
  const pushes = [];
  const waiting = [];
  const sock = s.connect(s.tokens[who]);
  await sock.hello();
  sock.ws.addEventListener('message', async (event) => {
    const msg = JSON.parse(event.data);
    if (!msg.type?.startsWith('dm:') && msg.type !== 'keys:changed') return;
    const result = await session.handle(msg);
    pushes.push({ msg, result });
    for (const w of [...waiting]) {
      if (w.match(msg)) { waiting.splice(waiting.indexOf(w), 1); w.done({ msg, result }); }
    }
  });
  const next = (match, { after: seen = 0 } = {}) => {
    const found = pushes.slice(seen).find((x) => match(x.msg));
    if (found) return Promise.resolve(found);
    return new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`nothing came; saw ${pushes.map((x) => x.msg.type)}`)), 5000);
      waiting.push({ match, done: (x) => { clearTimeout(timer); done(x); } });
    });
  };
  return { who, session, file, pushes, next, close: () => sock.ws.close() };
}

const text = (c, id) => c.session.thread(id).filter((m) => !m.private.group && !m.private.call).map((m) => m.body);

describe('a group of private messages', () => {
  const pc = {};
  let group;

  before(async () => {
    for (const who of ['alice', 'bob', 'carol', 'dave', 'eve']) {
      pc[who] = await computer(who);
      assert.equal(await pc[who].session.start(), KeyState.Ready);
    }
  });
  after(() => Object.values(pc).forEach((c) => c.close()));

  it('is made by anybody, and everybody in it is told', async () => {
    const seen = [pc.bob.pushes.length, pc.carol.pushes.length];
    group = await pc.alice.session.createGroup('Weekend plans', [s.ids.bob, s.ids.carol]);
    const row = pc.alice.session.conversations.get(group);
    assert.equal(row.kind, 'group');
    assert.equal(row.peer, null);
    assert.equal(row.title, 'Weekend plans');
    assert.equal(row.ownerId, s.ids.alice);
    assert.deepEqual([...row.userIds].sort(), [s.ids.alice, s.ids.bob, s.ids.carol].sort());

    await pc.bob.next((m) => m.type === 'dm:message' && m.conversation.id === group, { after: seen[0] });
    await pc.carol.next((m) => m.type === 'dm:message' && m.conversation.id === group, { after: seen[1] });
    const bobRow = pc.bob.session.conversations.get(group);
    assert.equal(bobRow.title, 'Weekend plans');
    assert.equal(bobRow.unread, 1);
    await pc.bob.session.load(group);
    assert.equal(pc.bob.session.thread(group)[0].private.group.event, 'created');
  });

  it('carries what one writes to each of the others, readable, and to their own other computers', async () => {
    for (const who of ['alice', 'bob', 'carol']) await pc[who].session.load(group);
    const seen = [pc.bob.pushes.length, pc.carol.pushes.length];
    await pc.alice.session.send(group, { body: 'who is coming? 🍕' });
    const forBob = await pc.bob.next((m) => m.type === 'dm:message' && m.message.kind === 'text', { after: seen[0] });
    const forCarol = await pc.carol.next((m) => m.type === 'dm:message' && m.message.kind === 'text', { after: seen[1] });
    assert.equal(forBob.result.incoming.body, 'who is coming? 🍕');
    assert.equal(forCarol.result.incoming.body, 'who is coming? 🍕');
    assert.equal(forBob.result.incoming.userId, s.ids.alice);
    assert.deepEqual(text(pc.alice, group), ['who is coming? 🍕'], 'what she wrote reads back for her too');

    // Another computer of hers, with the same key: the history is there, her own words included.
    const second = await computer('alice', { file: pc.alice.file });
    await second.session.start();
    await second.session.refresh();
    await second.session.load(group);
    assert.deepEqual(text(second, group), ['who is coming? 🍕']);
    assert.equal(second.session.thread(group).at(-1).private.unreadable, false);
    second.close();
  });

  it('is answered, reacted to and edited by any of them, and everybody sees it', async () => {
    const original = pc.bob.session.thread(group).find((m) => m.body === 'who is coming? 🍕');
    const seen = pc.alice.pushes.length;
    const replyId = await pc.bob.session.send(group, { body: 'me!', reply: original });
    await pc.alice.next((m) => m.type === 'dm:message' && m.message.id === replyId, { after: seen });
    await pc.carol.session.load(group);
    const reply = pc.carol.session.thread(group).find((m) => m.id === replyId);
    assert.equal(reply.body, 'me!');
    assert.equal(reply.reply.body, 'who is coming? 🍕');
    assert.equal(reply.userId, s.ids.bob);

    await pc.carol.session.toggleReaction(replyId, '👍');
    await pc.alice.session.toggleReaction(replyId, '👍');
    await new Promise((done) => setTimeout(done, 300));
    for (const who of ['alice', 'bob', 'carol']) {
      const m = pc[who].session.thread(group).find((x) => x.id === replyId);
      const thumbs = m.reactions.find((r) => r.emoji === '👍');
      assert.deepEqual(thumbs.userIds.sort(), [s.ids.alice, s.ids.carol].sort(), who);
    }

    await pc.bob.session.edit(replyId, 'me too!');
    await new Promise((done) => setTimeout(done, 300));
    for (const who of ['alice', 'bob', 'carol']) {
      const m = pc[who].session.thread(group).find((x) => x.id === replyId);
      assert.equal(m.body, 'me too!', who);
      assert.ok(m.editedAt);
    }
    // Only the author may.
    await assert.rejects(() => pc.alice.session.edit(replyId, 'nope'));
  });

  it('carries a file, sealed once and opened by all with the key inside their own copy', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const seen = pc.carol.pushes.length;
    const id = await pc.alice.session.send(group, { body: 'the map', file: { name: 'map.bin', mime: 'application/octet-stream', bytes } });
    await pc.carol.next((m) => m.type === 'dm:message' && m.message.id === id, { after: seen });
    const message = pc.carol.session.thread(group).find((m) => m.id === id);
    const file = await pc.carol.session.file(message);
    assert.deepEqual([...new Uint8Array(await file.blob.arrayBuffer())], [...bytes]);
    const own = await pc.alice.session.file(pc.alice.session.thread(group).find((m) => m.id === id));
    assert.deepEqual([...new Uint8Array(await own.blob.arrayBuffer())], [...bytes]);
  });

  it('is held by the server only as ciphertext, a copy for each person', () => {
    const db = new DatabaseSync(resolve(s.dataDir, 'harmony.db'), { readOnly: true });
    try {
      const rows = db.prepare("SELECT sealed FROM dm_messages WHERE conversation_id = ? AND kind = 'text'").all(group);
      assert.ok(rows.length >= 3);
      for (const row of rows) {
        assert.ok(!row.sealed.includes('coming') && !row.sealed.includes('me too'));
        assert.equal(Object.keys(JSON.parse(row.sealed)).length, 3, 'one copy for each of the three');
      }
    } finally {
      db.close();
    }
  });

  it('shows somebody added later only what is said from then on', async () => {
    const seen = pc.dave.pushes.length;
    await pc.alice.session.addMembers(group, [s.ids.dave]);
    await pc.dave.next((m) => m.type === 'dm:message' && m.conversation.id === group, { after: seen });
    await pc.dave.session.load(group);
    assert.deepEqual(text(pc.dave, group), [], 'nothing from before');
    assert.equal(pc.dave.session.thread(group).at(-1).private.group.event, 'added');

    const before = pc.dave.pushes.length;
    await pc.carol.session.send(group, { body: 'welcome, dave' });
    await pc.dave.next((m) => m.type === 'dm:message' && m.message.kind === 'text', { after: before });
    assert.deepEqual(text(pc.dave, group), ['welcome, dave']);
    // And everybody else's copy of the group knows him now, so what they send next is sealed to him too.
    assert.ok(pc.bob.session.conversations.get(group).userIds.includes(s.ids.dave));
    const after = pc.dave.pushes.length;
    await pc.bob.session.send(group, { body: 'hi dave' });
    await pc.dave.next((m) => m.type === 'dm:message' && m.message.kind === 'text' && m.message.userId === s.ids.bob, { after });
    assert.ok(text(pc.dave, group).includes('hi dave'));
  });

  it('is sealed again for the right people when the group changed under the one who is sending', async () => {
    // Bob's computer has not heard that eve is in: he seals for four, the server wants five.
    const row = pc.bob.session.conversations.get(group);
    const stale = [...row.userIds];
    await pc.alice.session.addMembers(group, [s.ids.eve]);
    row.userIds = stale;
    const before = pc.eve.pushes.length;
    await pc.bob.session.send(group, { body: 'eve too' });
    await pc.eve.next((m) => m.type === 'dm:message' && m.message.kind === 'text', { after: before });
    await pc.eve.session.load(group);
    assert.deepEqual(text(pc.eve, group), ['eve too']);
    assert.ok(row.userIds.includes(s.ids.eve), 'and he knows now');
  });

  it('is gone, at once, for somebody taken out, who cannot read what comes after', async () => {
    const seen = pc.carol.pushes.length;
    await pc.alice.session.removeMember(group, s.ids.carol);
    const gone = await pc.carol.next((m) => m.type === 'dm:left', { after: seen });
    assert.equal(gone.result.left, group);
    assert.ok(!pc.carol.session.conversations.has(group));
    await assert.rejects(() => pc.carol.session.load(group));

    const row = pc.bob.session.conversations.get(group);
    await pc.bob.next((m) => m.type === 'dm:message' && m.message.meta?.event === 'removed');
    assert.ok(!row.userIds.includes(s.ids.carol));
    await pc.bob.session.send(group, { body: 'without carol' });
    await assert.rejects(() => pc.carol.session.send(group, { body: 'still here?' }));
  });

  it('can be left by anybody in it, and passes to the one who has been in longest when the one who runs it goes', async () => {
    await pc.dave.session.leave(group);
    assert.ok(!pc.dave.session.conversations.has(group));
    await pc.alice.session.leave(group);
    await pc.bob.next((m) => m.type === 'dm:message' && m.message.meta?.event === 'left' && m.message.meta.owner);
    const row = pc.bob.session.conversations.get(group);
    assert.equal(row.ownerId, s.ids.bob);
    assert.ok(!row.userIds.includes(s.ids.alice));
    // Those who were added can only leave: they cannot put people in.
    await assert.rejects(() => pc.eve.session.addMembers(group, [s.ids.carol]), (e) => e.code === 'forbidden');
    await pc.bob.session.rename(group, 'Bob and Eve');
    await pc.eve.next((m) => m.type === 'dm:message' && m.message.meta?.event === 'renamed');
    assert.equal(pc.eve.session.conversations.get(group).title, 'Bob and Eve');
  });

  it('says what a group line is in the list, not a sealed message', async () => {
    const row = pc.bob.session.conversations.get(group);
    await pc.bob.session.refresh();
    const last = pc.bob.session.conversations.get(group).last;
    assert.ok(previewOf(last).group, row ? 'a line, drawn by the page' : '');
  });
});

describe('when somebody in a group changes their key', () => {
  const pc = {};
  let group;

  before(async () => {
    for (const who of ['frank', 'grace', 'harry']) {
      pc[who] = await computer(who);
      assert.equal(await pc[who].session.start(), KeyState.Ready);
    }
  });
  after(() => Object.values(pc).forEach((c) => c.close()));

  it('holds back what would be sealed to a key nobody accepted, and says whose it is', async () => {
    group = await pc.frank.session.createGroup('Keys', [s.ids.grace, s.ids.harry]);
    await pc.frank.session.load(group);
    await pc.frank.session.send(group, { body: 'before' });

    // harry's recovery key is lost: on a new computer he starts over with a key of his own.
    const replacement = await computer('harry');
    assert.equal(await replacement.session.start(), KeyState.Locked);
    await replacement.session.startOver();
    await new Promise((done) => setTimeout(done, 300));
    assert.ok(pc.frank.session.keyChangedFor(s.ids.harry));

    await assert.rejects(
      () => pc.frank.session.send(group, { body: 'during' }),
      (e) => e.code === 'key_not_confirmed' && e.userId === s.ids.harry,
    );
    pc.frank.session.acceptKey(s.ids.harry);
    await pc.frank.session.send(group, { body: 'after' });
    assert.ok(text(pc.frank, group).includes('after'));

    // And the new computer reads it, and not what came before.
    await replacement.session.refresh();
    await replacement.session.load(group);
    const seen = replacement.session.thread(group).filter((m) => !m.private.group);
    assert.deepEqual(seen.map((m) => [m.private.unreadable, m.body]), [[true, ''], [false, 'after']],
      'what was sealed to the old key cannot be read on a computer that never had it');
    replacement.close();
  });
});
