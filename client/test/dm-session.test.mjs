// Private conversations end to end: the session (dm-session.js, over the Vault
// and the crypto) against a REAL Harmony server, as two or three people on
// different computers. What is checked is what a person would see: that a
// message written by one arrives readable at the other, that the server never
// holds anything it could read, and what happens when keys change.
//
//   node --test client/test/dm-session.test.mjs

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { MemoryKeyFile } from '../src/renderer/dm-keyfile.js';
import { DmSession } from '../src/renderer/dm-session.js';
import { KeyState } from '../src/renderer/dm-vault.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

// Unique across the suite: node --test runs files in PARALLEL.
const FAKE_MTX_PORT = 20031;
const HARMONY_PORT = 18131;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;
const WS_URL = `ws://127.0.0.1:${HARMONY_PORT}/ws`;

let fakeMtx;
let child;
let dataDir;
let ownerKey = null;
const people = {};

function startFakeMediaMtx() {
  return new Promise((done) => {
    fakeMtx = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ itemCount: 0, pageCount: 0, items: [] }));
    });
    fakeMtx.listen(FAKE_MTX_PORT, '127.0.0.1', done);
  });
}

function startHarmony() {
  return new Promise((done, fail) => {
    child = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        HARMONY_PORT: String(HARMONY_PORT),
        HARMONY_HOST: '127.0.0.1',
        HARMONY_DATA_DIR: dataDir,
        HARMONY_MEDIAMTX_API: `http://127.0.0.1:${FAKE_MTX_PORT}`,
        HARMONY_POLL_INTERVAL_MS: '500',
        HARMONY_SIGNALING_URL: 'http://media.test:8889',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => fail(new Error('server did not start')), 10_000);
    let out = '';
    child.stdout.on('data', (b) => {
      out += b.toString();
      const match = /^\s*│\s+([A-Za-z0-9_-]{20,})\s+│$/m.exec(out);
      if (match) ownerKey = match[1];
      if (out.includes('control server on')) {
        clearTimeout(timer);
        done();
      }
    });
    child.stderr.on('data', (b) => process.stderr.write(`[server] ${b}`));
  });
}

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
      return answer(await fetch(`${BASE}${path}`, {
        method,
        headers: { ...headers(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }));
    },
    async dmUpload(_server, id, bytes) {
      return answer(await fetch(`${BASE}/api/dms/${id}/uploads`, {
        method: 'POST', headers: { ...headers(), 'Content-Type': 'application/octet-stream' }, body: bytes,
      }));
    },
    async dmDownload(_server, id, hash) {
      const res = await fetch(`${BASE}/api/dms/${id}/uploads/${hash}`, { headers: headers() });
      return { status: res.status, bytes: res.ok ? new Uint8Array(await res.arrayBuffer()) : null };
    },
  };
}

async function register(nickname, extra = {}) {
  const res = await fetch(`${BASE}/api/accounts/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, password: 'hunter22', ...extra }),
  });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  return { token: body.token, id: body.user.id };
}

/** One person on one computer: a session with its own key file, and a socket feeding it the server's pushes. */
async function computer(who, { file = new MemoryKeyFile(), socket = true } = {}) {
  const p = people[who];
  const session = new DmSession({ server: BASE, me: { id: p.id }, api: apiFor(p.token), file });
  const pushes = [];
  const waiting = [];
  let ws = null;
  if (socket) {
    ws = new WebSocket(WS_URL);
    await new Promise((done) => ws.addEventListener('open', done, { once: true }));
    ws.addEventListener('message', async (event) => {
      const msg = JSON.parse(event.data);
      if (!msg.type?.startsWith('dm:') && msg.type !== 'keys:changed') return;
      const result = await session.handle(msg);
      pushes.push({ msg, result });
      for (const w of [...waiting]) if (w.match(msg)) { waiting.splice(waiting.indexOf(w), 1); w.done({ msg, result }); }
    });
    ws.send(JSON.stringify({ type: 'hello', token: p.token, rid: 'hello' }));
    await new Promise((done) => {
      const listener = (event) => { if (JSON.parse(event.data).rid === 'hello') { ws.removeEventListener('message', listener); done(); } };
      ws.addEventListener('message', listener);
    });
  }
  return {
    session,
    file,
    pushes,
    /** The next push of this type, from now or already seen. */
    next(type, { after: seen = 0 } = {}) {
      const found = pushes.slice(seen).find((x) => x.msg.type === type);
      if (found) return Promise.resolve(found);
      return new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`no ${type}; saw ${pushes.map((x) => x.msg.type)}`)), 5000);
        waiting.push({ match: (m) => m.type === type, done: (x) => { clearTimeout(timer); done(x); } });
      });
    },
    close() { ws?.close(); },
  };
}

before(async () => {
  dataDir = mkdtempSync(resolve(tmpdir(), '.harmony-dms-'));
  await startFakeMediaMtx();
  await startHarmony();
  people.boss = await register('boss', { ownerKey });
  for (const n of ['alice', 'bob', 'eve']) people[n] = await register(n);
});

after(async () => {
  await new Promise((done) => {
    if (!child || child.exitCode !== null) return done();
    child.once('exit', done);
    child.kill('SIGTERM');
    setTimeout(() => { child.kill('SIGKILL'); done(); }, 4000).unref();
  });
  await new Promise((done) => fakeMtx.close(done));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('private conversations between two people', () => {
  let alice;
  let bob;
  let convo;
  let hello;

  before(async () => {
    alice = await computer('alice');
    bob = await computer('bob');
  });
  after(() => { alice.close(); bob.close(); });

  it('each makes a key on first use, and is shown a recovery key to keep', async () => {
    assert.equal(await alice.session.start(), KeyState.Ready);
    assert.equal(await bob.session.start(), KeyState.Ready);
    assert.equal(alice.session.vault.needsBackup, true);
    assert.match(alice.session.vault.recovery(), /^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
    await alice.session.markBackedUp();
    assert.equal(alice.session.vault.needsBackup, false);
  });

  it('a message written by one arrives readable at the other, pushed', async () => {
    convo = await alice.session.open(people.bob.id);
    assert.equal(await bob.session.open(people.alice.id), convo, 'the same conversation from either side');
    await alice.session.load(convo);
    await bob.session.load(convo);

    const seen = bob.pushes.length;
    hello = await alice.session.send(convo, { body: 'oi, bob 👋' });
    const { result } = await bob.next('dm:message', { after: seen });
    assert.equal(result.incoming.body, 'oi, bob 👋');
    assert.equal(result.incoming.userId, people.alice.id);
    assert.equal(bob.session.thread(convo).at(-1).body, 'oi, bob 👋');
    assert.equal(alice.session.thread(convo).at(-1).body, 'oi, bob 👋', 'and the echo is not a second copy');
    assert.equal(alice.session.thread(convo).length, 1);
    assert.equal(bob.session.conversations.get(convo).unread, 1);
  });

  it('the server holds ciphertext only', () => {
    const db = new DatabaseSync(resolve(dataDir, 'harmony.db'), { readOnly: true });
    try {
      const rows = db.prepare('SELECT sealed FROM dm_messages').all();
      assert.ok(rows.length > 0);
      assert.ok(rows.every((r) => !r.sealed.includes('bob') && !r.sealed.includes('oi')));
      const key = db.prepare('SELECT wrapped FROM user_keys WHERE user_id = ?').get(people.alice.id);
      assert.ok(key.wrapped.length > 40, 'a wrapped key, which only the recovery key opens');
    } finally {
      db.close();
    }
  });

  it('a reply, with a quote of what it answers', async () => {
    const original = bob.session.thread(convo).at(-1);
    const seen = alice.pushes.length;
    await bob.session.send(convo, { body: 'oi!', reply: original });
    const { result } = await alice.next('dm:message', { after: seen });
    assert.equal(result.incoming.reply.id, hello);
    assert.equal(result.incoming.reply.body, 'oi, bob 👋');
  });

  it('an edit, and both sides see the new words marked edited', async () => {
    const seen = bob.pushes.length;
    await alice.session.edit(hello, 'oi, bob! 👋');
    await bob.next('dm:updated', { after: seen });
    const m = bob.session.thread(convo).find((x) => x.id === hello);
    assert.equal(m.body, 'oi, bob! 👋');
    assert.ok(m.editedAt);
    assert.equal(alice.session.thread(convo).find((x) => x.id === hello).body, 'oi, bob! 👋');
  });

  it('reactions, one set per person, counted together', async () => {
    const seen = alice.pushes.length;
    await bob.session.toggleReaction(hello, '👍');
    await alice.next('dm:reactions', { after: seen });
    await alice.session.toggleReaction(hello, '👍');
    await alice.session.toggleReaction(hello, '🔥');
    const reactions = bob.session.thread(convo).find((x) => x.id === hello).reactions;
    await new Promise((done) => setTimeout(done, 200));
    const counted = bob.session.thread(convo).find((x) => x.id === hello).reactions;
    assert.deepEqual(counted.find((r) => r.emoji === '👍').userIds.sort(), [people.alice.id, people.bob.id].sort());
    assert.equal(counted.find((r) => r.emoji === '🔥').count, 1);
    assert.ok(reactions);
    await alice.session.toggleReaction(hello, '🔥');
    await new Promise((done) => setTimeout(done, 200));
    assert.ok(!bob.session.thread(convo).find((x) => x.id === hello).reactions.some((r) => r.emoji === '🔥'));
  });

  it('a file travels sealed and opens at the other end', async () => {
    const bytes = new Uint8Array(5000).map((_, i) => i % 251);
    const seen = bob.pushes.length;
    await alice.session.send(convo, { body: 'olha', file: { name: 'dados.bin', mime: 'application/x-thing', bytes } });
    const { result } = await bob.next('dm:message', { after: seen });
    const m = result.incoming;
    assert.equal(m.attachmentName, 'dados.bin');
    assert.equal(m.attachmentBytes, 5000);
    assert.equal(m.mediaType, 'file');
    const opened = await bob.session.file(m);
    assert.equal(opened.inline, false, 'a type the page does not draw is a download');
    assert.deepEqual(new Uint8Array(await opened.blob.arrayBuffer()), bytes);
    const mine = await alice.session.file(alice.session.thread(convo).at(-1));
    assert.deepEqual(new Uint8Array(await mine.blob.arrayBuffer()), bytes, 'and the sender can open it too');
  });

  it('a picture is drawn inline, and what the sender called it is not trusted for anything else', async () => {
    const png = Uint8Array.from(Buffer.from('iVBORw0KGgo=', 'base64'));
    const seen = bob.pushes.length;
    await alice.session.send(convo, { file: { name: 'a.png', mime: 'image/png', bytes: png } });
    const { result } = await bob.next('dm:message', { after: seen });
    assert.equal((await bob.session.file(result.incoming)).inline, true);
  });

  it('reading moves the mark, for your other windows too', async () => {
    // Another window of the same computer: the same key file.
    const other = await computer('bob', { file: bob.file });
    await other.session.start();
    await other.session.load(convo);
    assert.ok(bob.session.conversations.get(convo).unread > 0);
    const seen = other.pushes.length;
    await bob.session.markRead(convo);
    assert.equal(bob.session.conversations.get(convo).unread, 0);
    await other.next('dm:read', { after: seen });
    assert.equal(other.session.conversations.get(convo).unread, 0);
    other.close();
  });

  it('deleting your message removes it for both', async () => {
    const id = await alice.session.send(convo, { body: 'apaga isso' });
    await bob.next('dm:message');
    const seen = bob.pushes.length;
    await alice.session.remove(id);
    await bob.next('dm:deleted', { after: seen });
    assert.ok(!bob.session.thread(convo).some((m) => m.id === id));
    assert.ok(!alice.session.thread(convo).some((m) => m.id === id));
  });

  it('a conversation deleted for yourself leaves your list and stays for the other', async () => {
    await bob.session.clear(convo);
    assert.ok(!bob.session.conversations.has(convo));
    await alice.session.refresh();
    assert.ok(alice.session.conversations.has(convo));
    assert.ok(alice.session.thread(convo).length > 0);
  });

  it('blocking stops what goes either way', async () => {
    await alice.session.open(people.bob.id);
    await bob.session.refresh();
    const bobsView = await bob.session.open(people.alice.id);
    await bob.session.setBlocked(people.alice.id, true);
    await assert.rejects(alice.session.send(convo, { body: 'ainda aí?' }), (e) => e.code === 'blocked');
    await bob.session.setBlocked(people.alice.id, false);
    assert.ok(await alice.session.send(convo, { body: 'voltei' }));
    assert.equal(bobsView, convo);
  });

  it('somebody else cannot read any of it, or even tell it exists', async () => {
    const eve = await computer('eve', { socket: false });
    await eve.session.start();
    await assert.rejects(eve.session.load(convo), (e) => e.code === 'no_such_conversation');
    const res = await eve.session.vault.state;
    assert.equal(res, KeyState.Ready);
    const api = apiFor(people.eve.token);
    assert.equal((await api.dmRequest(BASE, 'GET', `/api/dms/${convo}/messages`)).status, 404);
  });
});

describe('when keys change', () => {
  let carol;
  let dan;
  let convo;

  before(async () => {
    people.carol = await register('carol');
    people.dan = await register('dan');
    carol = await computer('carol');
    dan = await computer('dan');
    await carol.session.start();
    await dan.session.start();
    convo = await carol.session.open(people.dan.id);
    await dan.session.open(people.carol.id);
    await carol.session.load(convo);
    await dan.session.load(convo);
    await carol.session.send(convo, { body: 'primeira' });
    await dan.next('dm:message');
  });
  after(() => { carol.close(); dan.close(); });

  it('a new computer opens the history with the recovery key, and only with it', async () => {
    const recovery = dan.session.vault.recovery();
    const fresh = await computer('dan', { socket: false });
    assert.equal(await fresh.session.start(), KeyState.Locked);
    assert.equal(await fresh.session.unlock('0000-0000-0000-0000-0000-0000-0000-0000'), false);
    assert.equal(await fresh.session.unlock('not a key'), false);
    assert.equal(await fresh.session.unlock(recovery), true);
    assert.equal(fresh.session.state, KeyState.Ready);
    await fresh.session.refresh();
    const thread = await fresh.session.load(convo);
    assert.equal(thread[0].body, 'primeira', 'sealed before this computer existed, and it opens');
    assert.equal(fresh.session.vault.needsBackup, false, 'they typed it in, so they have it');
  });

  it('a new key (the recovery key lost) is noticed, and nothing is sealed to it until it is accepted', async () => {
    const seen = carol.pushes.length;
    await dan.session.startOver();
    await carol.next('keys:changed', { after: seen });
    assert.equal(carol.session.keyChangedFor(people.dan.id), true);
    await assert.rejects(
      carol.session.send(convo, { body: 'ainda é você?' }),
      (e) => e.code === 'key_not_confirmed',
    );

    carol.session.acceptKey(people.dan.id);
    assert.equal(carol.session.keyChangedFor(people.dan.id), false);
    const before = dan.pushes.length;
    await carol.session.send(convo, { body: 'agora sim' });
    const { result } = await dan.next('dm:message', { after: before });
    assert.equal(result.incoming.body, 'agora sim', 'sealed to the new key, which only the new key opens');
  });

  it('the computer that had the old key keeps it, and so keeps the history', async () => {
    await dan.session.load(convo);
    assert.equal(dan.session.thread(convo)[0].body, 'primeira', 'archived, not deleted: what was sealed to it still opens here');
    assert.equal(dan.session.thread(convo).at(-1).body, 'agora sim');
  });

  it('a computer that never had it cannot read what was sealed to it, and can read what came after', async () => {
    const fresh = await computer('dan', { socket: false });
    assert.equal(await fresh.session.start(), KeyState.Locked);
    assert.equal(await fresh.session.unlock(dan.session.vault.recovery()), true, 'the NEW recovery key');
    const thread = await fresh.session.load(convo);
    assert.equal(thread[0].private.unreadable, true, 'sealed to a key that is lost for good');
    assert.equal(thread.at(-1).body, 'agora sim');
    await carol.session.load(convo);
    assert.equal(carol.session.thread(convo)[0].body, 'primeira', 'and the other person still reads all of it');
  });

  it('a computer that cannot open them still knows how many are waiting', async () => {
    await carol.session.send(convo, { body: 'segunda' });
    await dan.next('dm:message');
    const fresh = await computer('dan', { socket: false });
    assert.equal(await fresh.session.start(), KeyState.Locked);
    assert.ok(fresh.session.unread >= 2, `what the server counts, with nothing opened (${fresh.session.unread})`);
    assert.deepEqual(fresh.session.list(), [], 'and nothing read');
  });

  it('a safety number is the same on both screens, and checking it accepts a change', async () => {
    assert.equal(carol.session.safetyNumber(people.dan.id), dan.session.safetyNumber(people.carol.id));
    assert.match(carol.session.safetyNumber(people.dan.id), /^(\d{5} ){5}\d{5}$/);
    carol.session.setVerified(people.dan.id, true);
    assert.equal(carol.session.verified(people.dan.id), true);
  });
});
