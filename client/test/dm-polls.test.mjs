// Polls in private conversations, end to end: a poll rides inside the sealed message, a vote is a sealed reaction,
// and every person who is in the conversation counts them the same way. The server, which sees only bytes, is
// asked what it holds.
//
//   node --test client/test/dm-polls.test.mjs

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { MemoryKeyFile } from '../src/renderer/dm-keyfile.js';
import { DmSession } from '../src/renderer/dm-session.js';
import { resultsFromReactions, withoutVotes } from '../src/renderer/poll.js';
import { KeyState } from '../src/renderer/dm-vault.js';
import { liveServer } from '../../server/test/helpers/live-server.js';

const s = liveServer({ port: 18172, mtxPort: 20072 });
const NAMES = ['boss', 'alice', 'bob', 'carol', 'dave', 'eve'];

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


/** Sends a poll and waits until it has been drawn for the sender and for everybody else named. */
async function post(from, conversation, options, others = []) {
  const seen = [from, ...others].map((c) => c.pushes.length);
  const id = await from.session.send(conversation, options);
  await Promise.all([from, ...others].map((c, i) => c.next((m) => m.type === 'dm:message' && m.message?.id === id, { after: seen[i] })));
  return id;
}

/** Waits for something that arrives by a push to have arrived. */
async function until(check, ms = 5000) {
  const stop = Date.now() + ms;
  while (!check()) {
    if (Date.now() > stop) assert.fail('it did not happen in time');
    await new Promise((done) => { setTimeout(done, 25); });
  }
}

const question = (over = {}) => ({ title: 'Where do we eat?', options: ['Pizza', 'Sushi', 'Tacos'], ...over });
const resultsOf = (c, id, messageId) => {
  const m = c.session.thread(id).find((x) => x.id === messageId);
  return resultsFromReactions(m.poll, m.reactions, s.ids[c.who]);
};

describe('a poll between two people', () => {
  const pc = {};
  let convo;
  let pollId;

  before(async () => {
    for (const who of ['alice', 'bob']) {
      pc[who] = await computer(who);
      assert.equal(await pc[who].session.start(), KeyState.Ready);
    }
    convo = await pc.alice.session.open(s.ids.bob);
    assert.equal(await pc.bob.session.open(s.ids.alice), convo);
    // A conversation keeps what arrives for it once it has been loaded, as the app does on opening it.
    for (const c of Object.values(pc)) await c.session.load(convo);
  });
  after(() => Object.values(pc).forEach((c) => c.close()));

  it('is read by the other person with its settings, and says its words too for an app that does not know polls', async () => {
    pollId = await post(pc.alice, convo, {
      poll: question({ description: 'Friday', footer: 'majority wins', multiple: false }),
    }, [pc.bob]);
    const theirs = pc.bob.session.thread(convo).find((m) => m.id === pollId);
    assert.equal(theirs.poll.title, 'Where do we eat?');
    assert.deepEqual(theirs.poll.options, ['Pizza', 'Sushi', 'Tacos']);
    assert.equal(theirs.poll.description, 'Friday');
    assert.equal(theirs.poll.footer, 'majority wins');
    assert.match(theirs.body, /Where do we eat\?\n1\. Pizza\n2\. Sushi\n3\. Tacos/);
    assert.equal(pc.alice.session.thread(convo).find((m) => m.id === pollId).poll.title, 'Where do we eat?');
  });

  it('is refused without two options, before anything is sent', async () => {
    await assert.rejects(pc.alice.session.send(convo, { poll: question({ options: ['one'] }) }), { code: 'poll_needs_options' });
    await assert.rejects(pc.alice.session.send(convo, { poll: question({ title: ' ' }) }), { code: 'poll_needs_title' });
  });

  it('takes votes that both people count the same, and a new vote replaces the last', async () => {
    let seen = pc.alice.pushes.length;
    await pc.bob.session.votePoll(pollId, [1]);
    await pc.alice.next((m) => m.type === 'dm:reactions' && m.id === pollId, { after: seen });
    let r = resultsOf(pc.alice, convo, pollId);
    assert.deepEqual([r.counts, r.total, r.voters], [[0, 1, 0], 1, [[], [s.ids.bob], []]]);

    seen = pc.bob.pushes.length;
    await pc.alice.session.votePoll(pollId, [2]);
    await pc.bob.next((m) => m.type === 'dm:reactions' && m.id === pollId, { after: seen });
    r = resultsOf(pc.bob, convo, pollId);
    assert.deepEqual([r.counts, r.total, r.mine], [[0, 1, 1], 2, [1]], 'bob sees alice\'s vote and his own');
    assert.deepEqual(resultsOf(pc.alice, convo, pollId).mine, [2]);

    await pc.bob.session.votePoll(pollId, [0]);
    assert.deepEqual(resultsOf(pc.bob, convo, pollId).counts, [1, 0, 1], 'his second choice took the place of the first');
    await pc.bob.session.votePoll(pollId, []);
    assert.deepEqual(resultsOf(pc.bob, convo, pollId).counts, [0, 0, 1], 'and an empty one takes the vote back');
  });

  it('keeps votes apart from emoji: reacting does not lose a vote, and voting does not lose an emoji', async () => {
    await pc.bob.session.votePoll(pollId, [1]);
    await pc.bob.session.toggleReaction(pollId, '\u{1F44D}');
    const m = pc.bob.session.thread(convo).find((x) => x.id === pollId);
    assert.deepEqual(withoutVotes(m.reactions).map((x) => x.emoji), ['\u{1F44D}']);
    assert.deepEqual(resultsOf(pc.bob, convo, pollId).mine, [1]);
    await pc.bob.session.votePoll(pollId, [2]);
    const after = pc.bob.session.thread(convo).find((x) => x.id === pollId);
    assert.deepEqual(withoutVotes(after.reactions).map((x) => x.emoji), ['\u{1F44D}']);
    assert.deepEqual(resultsOf(pc.bob, convo, pollId).mine, [2]);
    await pc.bob.session.toggleReaction(pollId, '\u{1F44D}');
    assert.deepEqual(resultsOf(pc.bob, convo, pollId).mine, [2], 'taking the emoji back leaves the vote');
  });

  it('refuses a vote the poll cannot take, and a poll cannot be edited', async () => {
    await assert.rejects(pc.bob.session.votePoll(pollId, [0, 1]), { code: 'bad_vote' });
    await assert.rejects(pc.bob.session.votePoll(pollId, [7]), { code: 'bad_vote' });
    await assert.rejects(pc.alice.session.edit(pollId, 'changed'), { code: 'poll_not_editable' });
    const plain = await post(pc.alice, convo, { body: 'just words' }, [pc.bob]);
    await assert.rejects(pc.bob.session.votePoll(plain, [0]), { code: 'not_a_poll' });
  });

  it('takes several answers when it was made to, and counts people once', async () => {
    const id = await post(pc.alice, convo, { poll: question({ multiple: true }) }, [pc.bob]);
    await pc.bob.session.votePoll(id, [0, 2]);
    await pc.alice.session.votePoll(id, [2]);
    const r = resultsOf(pc.bob, convo, id);
    assert.deepEqual([r.counts, r.total, r.mine], [[1, 0, 2], 2, [0, 2]]);
  });

  it('can hide who voted, and still counts', async () => {
    const id = await post(pc.alice, convo, { poll: question({ anonymous: true }) }, [pc.bob]);
    await pc.bob.session.votePoll(id, [1]);
    const r = resultsOf(pc.alice, convo, id);
    assert.deepEqual([r.counts, r.total, r.voters], [[0, 1, 0], 1, null]);
  });

  it('stops taking votes once it has closed, where the vote is made', async () => {
    const id = await post(pc.alice, convo, { poll: question({ endsAt: Date.now() + 600 }) }, [pc.bob]);
    await pc.bob.session.votePoll(id, [0]);
    await new Promise((done) => { setTimeout(done, 800); });
    await assert.rejects(pc.bob.session.votePoll(id, [1]), { code: 'poll_closed' });
    assert.deepEqual(resultsOf(pc.bob, convo, id).counts, [1, 0, 0]);
  });

  it('carries a picture, sealed like any file of the conversation', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const id = await post(pc.alice, convo, {
      poll: question(), file: { name: 'cover.png', mime: 'image/png', bytes: png },
    }, [pc.bob]);
    const m = pc.bob.session.thread(convo).find((x) => x.id === id);
    assert.equal(m.mediaType, 'image');
    const opened = await pc.bob.session.file(m);
    assert.deepEqual(new Uint8Array(await opened.blob.arrayBuffer()), png);
  });

  it('is held by the server only as ciphertext: not the question, not the options, not who chose what', () => {
    const db = new DatabaseSync(resolve(s.dataDir, 'harmony.db'), { readOnly: true });
    try {
      const messages = db.prepare('SELECT sealed FROM dm_messages WHERE conversation_id = ?').all(convo);
      const reactions = db.prepare('SELECT sealed FROM dm_reactions').all();
      assert.ok(reactions.length >= 1);
      for (const row of [...messages, ...reactions]) {
        const text = row.sealed ?? '';
        assert.ok(!/Where do we eat|Pizza|Sushi|poll:/.test(text));
      }
    } finally {
      db.close();
    }
  });
});

describe('a poll in a private group', () => {
  const pc = {};
  let group;

  before(async () => {
    for (const who of ['carol', 'dave', 'eve']) {
      pc[who] = await computer(who);
      assert.equal(await pc[who].session.start(), KeyState.Ready);
    }
    group = await pc.carol.session.createGroup('Dinner', [s.ids.dave, s.ids.eve]);
    await pc.dave.next((m) => m.type === 'dm:message' && m.conversation.id === group);
    await pc.eve.next((m) => m.type === 'dm:message' && m.conversation.id === group);
    for (const c of Object.values(pc)) await c.session.load(group);
  });
  after(() => Object.values(pc).forEach((c) => c.close()));

  it('is voted on by everybody, and each of them counts the same', async () => {
    const id = await post(pc.carol, group, { poll: question({ multiple: true }) }, [pc.dave, pc.eve]);
    await pc.dave.session.votePoll(id, [0]);
    await pc.eve.session.votePoll(id, [0, 1]);
    await pc.carol.session.votePoll(id, [1]);
    // Each one has been told of the others' votes by the time it has looked.
    for (const who of ['carol', 'dave', 'eve']) await until(() => resultsOf(pc[who], group, id).total === 3);
    for (const who of ['carol', 'dave', 'eve']) {
      const r = resultsOf(pc[who], group, id);
      assert.deepEqual([r.counts, r.total], [[2, 2, 0], 3], who);
      assert.deepEqual([...r.voters[0]].sort(), [s.ids.dave, s.ids.eve].sort(), who);
    }
  });
});
