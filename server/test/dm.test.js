// Private conversations: keys, sealed messages, sealed files, reactions,
// read marks, edits, blocking, clearing -- and above all, that
// nobody outside a conversation can touch any of it. Every route is tried by
// a third person, the owner included, and must look exactly like a
// conversation that does not exist.
//
//   node --test server/test/dm.test.js

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import { isPublicKey, isSealedText } from '../src/dms.js';
import { Throttle } from '../src/throttle.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', 'src', 'index.js');

// Unique across the suite: node --test runs these files in PARALLEL.
const FAKE_MTX_PORT = 20011;
const HARMONY_PORT = 18095;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;
const WS_URL = `ws://127.0.0.1:${HARMONY_PORT}/ws`;

let fakeMtx;
let child;
let dataDir;
let ownerKey = null;
const tokens = {};
const ids = {};

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

const api = async (path, { method = 'GET', body, token, raw, contentType } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(raw ? { 'Content-Type': contentType ?? 'application/octet-stream' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...(raw ? { body: raw } : {}),
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buffer.toString()); } catch { /* binary or empty */ }
  return { status: res.status, body: json, buffer, headers: res.headers };
};

const b64 = (n) => randomBytes(n).toString('base64url');
const fakeKey = () => ({ publicKey: b64(32), wrapped: b64(73) });
const sealed = (n = 64) => b64(n);

function connect(token) {
  const ws = new WebSocket(WS_URL);
  const inbox = [];
  const waiters = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    inbox.push(msg);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].match(msg)) {
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });
  const client = {
    ws,
    inbox,
    next(match, { timeoutMs = 5000 } = {}) {
      const found = inbox.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((done, fail) => {
        const timer = setTimeout(
          () => fail(new Error(`timed out; saw ${JSON.stringify(inbox.map((m) => m.type))}`)),
          timeoutMs,
        );
        waiters.push({ match, resolve: (m) => { clearTimeout(timer); done(m); } });
      });
    },
    async request(payload) {
      const rid = Math.random().toString(36).slice(2);
      ws.send(JSON.stringify({ ...payload, rid }));
      return this.next((m) => m.rid === rid);
    },
    async hello(extra = {}) {
      if (ws.readyState !== WebSocket.OPEN) {
        await new Promise((done) => ws.addEventListener('open', done, { once: true }));
      }
      return this.request({ type: 'hello', token, ...extra });
    },
    close() {
      ws.close();
      return new Promise((done) => ws.addEventListener('close', done, { once: true }));
    },
  };
  return client;
}

/** Nothing matching arrives within `ms`. */
async function silent(client, match, ms = 300) {
  await new Promise((done) => setTimeout(done, ms));
  assert.equal(client.inbox.find(match), undefined, 'that should not have reached this socket');
}

const keyOf = {};

async function publishKey(who) {
  const r = await api('/api/keys', { method: 'POST', body: fakeKey(), token: tokens[who] });
  assert.equal(r.status, 201);
  keyOf[who] = r.body.key.id;
  return r.body.key;
}

async function open(who, peer) {
  const r = await api('/api/dms', { method: 'POST', body: { userId: ids[peer] }, token: tokens[who] });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
  return r.body.conversation.id;
}

async function send(who, peer, conversationId, extra = {}) {
  return api(`/api/dms/${conversationId}/messages`, {
    method: 'POST',
    token: tokens[who],
    body: { sealed: sealed(), senderKey: keyOf[who], recipientKey: keyOf[peer], ...extra },
  });
}

before(async () => {
  // A dot-folder, as the data directory usually is.
  dataDir = mkdtempSync(resolve(tmpdir(), '.harmony-dm-'));
  await startFakeMediaMtx();
  await startHarmony();
  for (const nick of ['boss', 'alice', 'bob', 'eve', 'carol']) {
    const r = await api('/api/accounts/register', {
      method: 'POST',
      body: { nickname: nick, password: 'hunter22', ...(nick === 'boss' ? { ownerKey } : {}) },
    });
    tokens[nick] = r.body.token;
    ids[nick] = r.body.user.id;
  }
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

// ---------------------------------------------------------------------------

describe('pieces', () => {
  it('knows a public key and a sealed string when it sees one', () => {
    assert.ok(isPublicKey(b64(32)));
    assert.ok(!isPublicKey(b64(31)));
    assert.ok(!isPublicKey(`${b64(32).slice(0, 42)}=`));
    assert.ok(isSealedText(b64(100)));
    assert.ok(!isSealedText('has spaces in it'));
    assert.ok(!isSealedText(''));
  });


  it('throttles a flood but lets a burst through, and refills', () => {
    let now = 0;
    const t = new Throttle({ burst: 3, perSecond: 1, now: () => now });
    assert.ok(t.take('a').allowed && t.take('a').allowed && t.take('a').allowed);
    const refused = t.take('a');
    assert.equal(refused.allowed, false);
    assert.equal(refused.retryAfterSec, 1);
    assert.ok(t.take('b').allowed, 'one person flooding does not slow anybody else');
    now = 1000;
    assert.ok(t.take('a').allowed);
  });


});

describe('keys', () => {
  it('publishes a key and shows the wrapped half only to its owner', async () => {
    const mine = await publishKey('alice');
    assert.ok(mine.wrapped, 'your own key comes back with the wrapped private half');

    const asAlice = await api('/api/keys', { token: tokens.alice });
    assert.equal(asAlice.body.mine.id, mine.id);
    assert.equal(asAlice.body.mine.wrapped, mine.wrapped);

    const asEve = await api('/api/keys', { token: tokens.eve });
    assert.equal(asEve.body.mine, null);
    const listed = asEve.body.keys.find((k) => k.userId === ids.alice);
    assert.equal(listed.publicKey, mine.publicKey);
    assert.equal(listed.wrapped, undefined, 'nobody else ever sees a wrapped key');
  });

  it('refuses things that are not keys', async () => {
    for (const body of [
      { publicKey: 'short', wrapped: b64(73) },
      { publicKey: b64(32), wrapped: 'not base64url!' },
      { publicKey: b64(32), wrapped: b64(1000) },
      {},
    ]) {
      const r = await api('/api/keys', { method: 'POST', body, token: tokens.carol });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error, 'bad_key');
    }
  });

  it('tells everybody when a key changes, and keeps the old one for history', async () => {
    const watcher = connect(tokens.eve);
    await watcher.hello();
    await publishKey('bob');
    const first = keyOf.bob;
    const second = await publishKey('bob');
    const push = await watcher.next((m) => m.type === 'keys:changed' && m.key.id === second.id);
    assert.equal(push.key.userId, ids.bob);
    assert.equal(push.key.wrapped, undefined);

    const looked = await api(`/api/keys/lookup?ids=${first},${second.id}`, { token: tokens.eve });
    assert.deepEqual(looked.body.keys.map((k) => k.id).sort(), [first, second.id].sort());
    await watcher.close();
  });

  it('re-wraps only your current key', async () => {
    const stale = await api('/api/keys/wrap', {
      method: 'POST', body: { keyId: keyOf.bob - 1, wrapped: b64(73) }, token: tokens.bob,
    });
    assert.equal(stale.status, 409);
    const ok = await api('/api/keys/wrap', {
      method: 'POST', body: { keyId: keyOf.bob, wrapped: b64(73) }, token: tokens.bob,
    });
    assert.equal(ok.status, 200);
    const other = await api('/api/keys/wrap', {
      method: 'POST', body: { keyId: keyOf.bob, wrapped: b64(73) }, token: tokens.alice,
    });
    assert.equal(other.status, 409, "somebody else's key is never yours to re-wrap");
  });
});

describe('conversations and messages', () => {
  let convo;

  it('opens one conversation per pair, from either side', async () => {
    convo = await open('alice', 'bob');
    assert.equal(await open('bob', 'alice'), convo);
    const self = await api('/api/dms', { method: 'POST', body: { userId: ids.alice }, token: tokens.alice });
    assert.equal(self.status, 400);
    const ghost = await api('/api/dms', { method: 'POST', body: { userId: 99999 }, token: tokens.alice });
    assert.equal(ghost.status, 404);
  });

  it('does not list a conversation nobody wrote in', async () => {
    const list = await api('/api/dms', { token: tokens.bob });
    assert.equal(list.body.conversations.length, 0);
  });

  it('delivers a sealed message to both people and to nobody else', async () => {
    const a = connect(tokens.alice);
    const b = connect(tokens.bob);
    const e = connect(tokens.eve);
    const o = connect(tokens.boss);
    await Promise.all([a.hello(), b.hello(), e.hello(), o.hello()]);

    const body = sealed(200);
    const r = await send('alice', 'bob', convo, { sealed: body });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.message.sealed, body, 'the server stores and returns exactly what it was given');

    const got = await b.next((m) => m.type === 'dm:message' && m.message.id === r.body.message.id);
    assert.equal(got.message.sealed, body);
    assert.deepEqual(got.conversation.userIds.sort(), [ids.alice, ids.bob].sort());
    await a.next((m) => m.type === 'dm:message' && m.message.id === r.body.message.id);
    await silent(e, (m) => m.type === 'dm:message');
    await silent(o, (m) => m.type === 'dm:message');
    await Promise.all([a.close(), b.close(), e.close(), o.close()]);
  });

  it('counts unread for the reader and clears it with a read mark', async () => {
    let list = await api('/api/dms', { token: tokens.bob });
    assert.equal(list.body.conversations[0].unread, 1);
    assert.equal(list.body.conversations[0].last.senderKey, keyOf.alice);
    assert.ok(list.body.keys.some((k) => k.id === keyOf.alice), 'the keys to open the preview come along');

    const mine = await api('/api/dms', { token: tokens.alice });
    assert.equal(mine.body.conversations[0].unread, 0, 'your own message is never unread to you');

    const lastId = list.body.conversations[0].last.id;
    const read = await api(`/api/dms/${convo}/read`, { method: 'POST', body: { upTo: lastId + 1000 }, token: tokens.bob });
    assert.equal(read.body.lastReadId, lastId, 'a read mark never runs past the last message');
    list = await api('/api/dms', { token: tokens.bob });
    assert.equal(list.body.conversations[0].unread, 0);
  });

  it('refuses a message sealed to a key that has been replaced', async () => {
    const r = await send('alice', 'bob', convo, { recipientKey: keyOf.bob - 1 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'stale_key');
    assert.ok(r.body.keys.some((k) => k.id === keyOf.bob), 'and says what the current keys are');
  });

  it('refuses to send to somebody with no key yet', async () => {
    const c = await open('alice', 'carol');
    const r = await send('alice', 'carol', c, { recipientKey: 1 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'peer_has_no_key');
  });

  it('refuses what is not sealed text', async () => {
    const r = await send('alice', 'bob', convo, { sealed: 'hello bob, in plain text' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'bad_message');
  });

  it('takes a long sealed message that the ordinary JSON limit would refuse', async () => {
    const r = await send('alice', 'bob', convo, { sealed: b64(30_000) });
    assert.equal(r.status, 201);
  });

  it('pages history, oldest first, with the keys needed to open it', async () => {
    const page = await api(`/api/dms/${convo}/messages`, { token: tokens.bob });
    assert.equal(page.status, 200);
    assert.ok(page.body.messages.length >= 2);
    const ids_ = page.body.messages.map((m) => m.id);
    assert.deepEqual(ids_, [...ids_].sort((x, y) => x - y));
    assert.ok(page.body.keys.some((k) => k.id === keyOf.bob));
  });

  it('lets only the author edit or delete -- not the other person, not the owner', async () => {
    const r = await send('alice', 'bob', convo);
    const id = r.body.message.id;
    const editBody = { sealed: sealed(), senderKey: keyOf.bob, recipientKey: keyOf.alice };
    assert.equal((await api(`/api/dm-messages/${id}/edit`, { method: 'POST', body: editBody, token: tokens.bob })).status, 403);
    assert.equal((await api(`/api/dm-messages/${id}/delete`, { method: 'POST', token: tokens.bob })).status, 403);

    const asOwner = await api(`/api/dm-messages/${id}/delete`, { method: 'POST', token: tokens.boss });
    assert.equal(asOwner.status, 404, 'to the owner it does not exist');

    const edited = await api(`/api/dm-messages/${id}/edit`, {
      method: 'POST', token: tokens.alice, body: { sealed: sealed(), senderKey: keyOf.alice, recipientKey: keyOf.bob },
    });
    assert.equal(edited.status, 200);
    assert.ok(edited.body.message.editedAt);
    assert.equal((await api(`/api/dm-messages/${id}/delete`, { method: 'POST', token: tokens.alice })).status, 200);
  });

  it('keeps what a message said before, sealed, for the two of them only', async () => {
    const first = sealed();
    const r = await send('alice', 'bob', convo, { sealed: first });
    const id = r.body.message.id;
    await api(`/api/dm-messages/${id}/edit`, {
      method: 'POST', token: tokens.alice, body: { sealed: sealed(), senderKey: keyOf.alice, recipientKey: keyOf.bob },
    });
    const seen = await api(`/api/dm-messages/${id}/edits`, { token: tokens.bob });
    assert.equal(seen.status, 200);
    assert.equal(seen.body.versions.length, 1);
    assert.equal(seen.body.versions[0].sealed, first);
    assert.equal(seen.body.versions[0].senderKey, keyOf.alice);
    assert.equal((await api(`/api/dm-messages/${id}/edits`, { token: tokens.boss })).status, 404);
  });

  it('keeps one sealed reaction blob per person, and clears it', async () => {
    const r = await send('alice', 'bob', convo);
    const id = r.body.message.id;
    const react = (who, peer, blob) => api(`/api/dm-messages/${id}/react`, {
      method: 'POST', token: tokens[who], body: { sealed: blob, senderKey: keyOf[who], recipientKey: keyOf[peer] },
    });
    let out = await react('bob', 'alice', sealed(40));
    assert.equal(out.body.reactions.length, 1);
    out = await react('bob', 'alice', sealed(40));
    assert.equal(out.body.reactions.length, 1, 'a second reaction replaces the blob, it does not add one');
    out = await react('alice', 'bob', sealed(40));
    assert.equal(out.body.reactions.length, 2);
    out = await react('bob', 'alice', null);
    assert.deepEqual(out.body.reactions.map((x) => x.userId), [ids.alice]);
  });

  it('is invisible to a third person on every route', async () => {
    const { body: { messages: [m] } } = await api(`/api/dms/${convo}/messages`, { token: tokens.alice });
    for (const who of ['eve', 'boss']) {
      const t = tokens[who];
      const tries = [
        api(`/api/dms/${convo}`, { token: t }),
        api(`/api/dms/${convo}/messages`, { token: t }),
        api(`/api/dms/${convo}/messages`, { method: 'POST', token: t, body: { sealed: sealed(), senderKey: 1, recipientKey: 1 } }),
        api(`/api/dms/${convo}/read`, { method: 'POST', token: t, body: { upTo: 1 } }),
        api(`/api/dms/${convo}/clear`, { method: 'POST', token: t }),
        api(`/api/dms/${convo}/uploads`, { method: 'POST', token: t, raw: randomBytes(64) }),
        api(`/api/dms/${convo}/uploads/${'a'.repeat(64)}`, { token: t }),
        api(`/api/dm-messages/${m.id}/edit`, { method: 'POST', token: t, body: { sealed: sealed() } }),
        api(`/api/dm-messages/${m.id}/delete`, { method: 'POST', token: t }),
        api(`/api/dm-messages/${m.id}/react`, { method: 'POST', token: t, body: { sealed: null } }),
      ];
      for (const r of await Promise.all(tries)) assert.equal(r.status, 404, `${who}: ${JSON.stringify(r.body)}`);
    }
    const unauthenticated = await api(`/api/dms/${convo}/messages`);
    assert.equal(unauthenticated.status, 401);
  });
});

describe('sealed files', () => {
  let convo;
  let hash;

  before(async () => {
    convo = await open('alice', 'bob');
  });

  it('stores ciphertext and serves it only through its own conversation', async () => {
    const bytes = randomBytes(2048);
    const up = await api(`/api/dms/${convo}/uploads`, { method: 'POST', token: tokens.alice, raw: bytes });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    hash = up.body.hash;

    // Uploaded but not sent: nobody can fetch it yet, not even the uploader.
    assert.equal((await api(`/api/dms/${convo}/uploads/${hash}`, { token: tokens.alice })).status, 404);

    const r = await send('alice', 'bob', convo, { attachmentHash: hash });
    assert.equal(r.status, 201);

    const got = await api(`/api/dms/${convo}/uploads/${hash}`, { token: tokens.bob });
    assert.equal(got.status, 200);
    assert.ok(got.buffer.equals(bytes));
    assert.equal(got.headers.get('content-type'), 'application/octet-stream');
    assert.match(got.headers.get('cache-control'), /private/);
  });

  it('never serves a sealed file on the public route, to anyone', async () => {
    for (const who of ['alice', 'bob', 'boss']) {
      assert.equal((await api(`/api/uploads/${hash}`, { token: tokens[who] })).status, 404);
    }
  });

  it('NOR BY MEDIA KEY, not even to the two people in it', async () => {
    // A media key opens what /api/uploads opens. The conversation's own route
    // checks who is asking; a key in a URL would check nothing of the sort.
    for (const who of ['alice', 'bob', 'boss']) {
      const key = (await api('/api/media-key', { token: tokens[who] })).body.key;
      const res = await fetch(`${BASE}/api/media/${hash}?k=${encodeURIComponent(key)}`);
      assert.equal(res.status, 404);
    }
  });

  it('cannot be fetched through another conversation, even by somebody in both', async () => {
    const other = await open('alice', 'eve');
    assert.equal((await api(`/api/dms/${other}/uploads/${hash}`, { token: tokens.alice })).status, 404);
  });

  it('cannot be attached to a channel message', async () => {
    const channels = (await api('/api/channels', { token: tokens.alice })).body.channels;
    const text = channels.find((c) => c.kind === 'text').id;
    const r = await api(`/api/channels/${text}/messages`, {
      method: 'POST', token: tokens.alice, body: { body: 'look', attachmentHash: hash },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'no_such_upload');
  });

  it('refuses a public upload as a private attachment', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const pub = await api('/api/uploads', { method: 'POST', token: tokens.alice, raw: png, contentType: 'image/png' });
    const r = await send('alice', 'bob', convo, { attachmentHash: pub.body.hash });
    assert.equal(r.status, 400);
  });
});

describe('blocking', () => {
  let convo;

  before(async () => {
    await publishKey('eve');
    convo = await open('eve', 'alice');
  });

  it('stops messages both ways while it holds, and only then', async () => {
    assert.equal((await send('eve', 'alice', convo)).status, 201);
    const blocked = await api('/api/dms/blocks', { method: 'POST', token: tokens.alice, body: { userId: ids.eve } });
    assert.deepEqual(blocked.body.blocked, [ids.eve]);

    for (const [who, peer] of [['eve', 'alice'], ['alice', 'eve']]) {
      const r = await send(who, peer, convo);
      assert.equal(r.status, 403);
      assert.equal(r.body.error, 'blocked');
    }
    const listed = await api('/api/dms', { token: tokens.alice });
    assert.deepEqual(listed.body.blocked, [ids.eve]);

    await api('/api/dms/blocks', { method: 'POST', token: tokens.alice, body: { userId: ids.eve, blocked: false } });
    assert.equal((await send('eve', 'alice', convo)).status, 201);
  });

});

describe('deleting a conversation for yourself', () => {
  let convo;
  let early;
  let hash;
  const clear = (who) => api(`/api/dms/${convo}/clear`, { method: 'POST', token: tokens[who] });
  const listed = async (who) => (await api('/api/dms', { token: tokens[who] })).body.conversations.find((c) => c.id === convo);
  const history = async (who) => (await api(`/api/dms/${convo}/messages`, { token: tokens[who] })).body.messages.map((m) => m.id);

  before(async () => {
    convo = await open('bob', 'eve');
    const up = await api(`/api/dms/${convo}/uploads`, { method: 'POST', token: tokens.eve, raw: randomBytes(512) });
    hash = up.body.hash;
    early = [
      (await send('eve', 'bob', convo, { attachmentHash: hash })).body.message.id,
      (await send('bob', 'eve', convo)).body.message.id,
      (await send('eve', 'bob', convo)).body.message.id,
    ];
  });

  it('takes it from your list and history, tells your windows, and leaves the other person every word', async () => {
    const b = connect(tokens.bob);
    const e = connect(tokens.eve);
    await Promise.all([b.hello(), e.hello()]);

    const r = await clear('bob');
    assert.equal(r.status, 200);
    assert.equal(r.body.clearedId, early.at(-1));
    await b.next((m) => m.type === 'dm:cleared' && m.conversationId === convo && m.clearedId === early.at(-1));
    await silent(e, (m) => m.type === 'dm:cleared');

    assert.equal(await listed('bob'), undefined);
    assert.deepEqual(await history('bob'), []);
    assert.deepEqual(await history('eve'), early);
    assert.equal((await listed('eve')).last.id, early.at(-1));
    // Or a background client would take what it can't see for news, and stay awake for it.
    assert.ok((await api('/api/inbox', { token: tokens.bob })).body.latest < early.at(-1));
    assert.equal((await api('/api/inbox', { token: tokens.eve })).body.latest, early.at(-1));
    await Promise.all([b.close(), e.close()]);
  });

  it('makes what you deleted not exist for you on any route, while it still does for them', async () => {
    const [first] = early;
    const react = (who, peer) => api(`/api/dm-messages/${first}/react`, {
      method: 'POST', token: tokens[who], body: { sealed: sealed(40), senderKey: keyOf[who], recipientKey: keyOf[peer] },
    });
    assert.equal((await react('bob', 'eve')).status, 404);
    assert.equal((await api(`/api/dm-messages/${first}/edits`, { token: tokens.bob })).status, 404);
    assert.equal((await api(`/api/dms/${convo}/uploads/${hash}`, { token: tokens.bob })).status, 404);
    assert.equal((await api(`/api/dms/${convo}/uploads/${hash}`, { token: tokens.eve })).status, 200);

    const b = connect(tokens.bob);
    await b.hello();
    assert.equal((await react('eve', 'bob')).status, 200);
    await silent(b, (m) => m.type === 'dm:reactions');
    await b.close();
  });

  it('comes back with something new, and only from there', async () => {
    const r = await send('eve', 'bob', convo);
    const row = await listed('bob');
    assert.equal(row.last.id, r.body.message.id);
    assert.equal(row.unread, 1);
    assert.deepEqual(await history('bob'), [r.body.message.id]);
    assert.deepEqual(await history('eve'), [...early, r.body.message.id]);
  });

  it('does not hide what comes after the newest message is deleted', async () => {
    // SQLite would hand the deleted id out again, at the mark: born deleted for bob.
    assert.equal((await clear('bob')).status, 200);
    const newest = (await send('eve', 'bob', convo)).body.message.id;
    assert.equal((await clear('bob')).body.clearedId, newest);
    assert.equal((await api(`/api/dm-messages/${newest}/delete`, { method: 'POST', token: tokens.eve })).status, 200);
    const next = (await send('eve', 'bob', convo)).body.message.id;
    assert.ok(next > newest);
    assert.deepEqual(await history('bob'), [next]);
  });

  it('deletes for real what neither can see any more, and keeps the conversation working', async () => {
    const before_ = (await history('eve')).at(-1);
    assert.equal((await clear('eve')).status, 200);
    assert.equal((await clear('bob')).status, 200);

    const db = new DatabaseSync(resolve(dataDir, 'harmony.db'), { readOnly: true });
    try {
      const left = db.prepare('SELECT COUNT(*) AS n FROM dm_messages WHERE conversation_id = ?').get(convo).n;
      assert.equal(left, 0);
      const refs = db.prepare('SELECT refs FROM uploads WHERE hash = ?').get(hash);
      assert.ok(!refs || refs.refs === 0, 'the file is let go');
    } finally {
      db.close();
    }

    const r = await send('bob', 'eve', convo);
    assert.ok(r.body.message.id > before_);
    assert.deepEqual(await history('bob'), [r.body.message.id]);
    assert.deepEqual(await history('eve'), [r.body.message.id]);
    assert.equal((await listed('eve')).unread, 1);
  });

  it('says so in the health check', async () => {
    assert.ok((await api('/api/health')).body.features.includes('dm-clear'));
  });
});

describe('throttling', () => {
  it('lets a burst of messages through and refuses a flood', async () => {
    const convo = await open('bob', 'alice');
    const results = [];
    for (let i = 0; i < 30; i += 1) results.push((await send('bob', 'alice', convo)).status);
    assert.ok(results.slice(0, 15).every((s) => s === 201), results.join(','));
    assert.ok(results.includes(429), 'thirty in a row is a flood');
  });
});

describe('removing an account', () => {
  it('takes their conversations and frees their files', async () => {
    // Key changes are throttled hard, so carol's is published here only if it was not already.
    if (!keyOf.carol) await publishKey('carol');
    const convo = await open('carol', 'alice');
    const up = await api(`/api/dms/${convo}/uploads`, { method: 'POST', token: tokens.carol, raw: randomBytes(512) });
    assert.equal((await send('carol', 'alice', convo, { attachmentHash: up.body.hash })).status, 201);

    const removed = await api(`/api/accounts/${ids.carol}/delete`, { method: 'POST', token: tokens.boss });
    assert.equal(removed.status, 200);

    assert.equal((await api(`/api/dms/${convo}/messages`, { token: tokens.alice })).status, 404);
    const list = await api('/api/dms', { token: tokens.alice });
    assert.ok(!list.body.conversations.some((c) => c.id === convo));
    const keys = await api('/api/keys', { token: tokens.alice });
    assert.ok(!keys.body.keys.some((k) => k.userId === ids.carol));

    // The file is still on disk but nothing holds it, so the next upload that needs room may sweep it.
    const db = new DatabaseSync(resolve(dataDir, 'harmony.db'), { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT refs FROM uploads WHERE hash = ?').get(up.body.hash).refs, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dm_messages WHERE conversation_id = ?').get(convo).n, 0);
    } finally {
      db.close();
    }
  });
});
