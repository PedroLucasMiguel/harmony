// The WebSocket layer: authentication, voice presence, and the force-mute
// path that the Phase 0 spike showed depends on the auth hook rather than on
// kicking the session.
//
//   node --test server/test/realtime.test.js

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { VoiceRooms, VOICE_HARD_CAP, channelPath } from '../src/channels.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', 'src', 'index.js');

// Unique across the suite: node --test runs these files in PARALLEL.
const FAKE_MTX_PORT = 20001;
const HARMONY_PORT = 18084;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;
const WS_URL = `ws://127.0.0.1:${HARMONY_PORT}/ws`;

let fakeMtx;
let child;
let dataDir;
let ownerKey = null;
let ownerToken;
let memberToken;
let voiceChannelId;
let lockedChannelId;

function startFakeMediaMtx() {
  return new Promise((done) => {
    fakeMtx = http.createServer((req, res) => {
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
        HARMONY_POLL_INTERVAL_MS: '200',
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

const api = async (path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 */ }
  return { status: res.status, body: json };
};

/**
 * A tiny client over Node's built-in global WebSocket -- deliberately the same
 * constructor the Electron main process will use, so anything that depends on
 * its browser-shaped API (no custom headers, hence the `hello` frame) breaks
 * here first.
 */
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
    closed: new Promise((done) => ws.addEventListener('close', (e) => done(e))),

    /** Wait for the first message matching a predicate, past or future. */
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

    send(payload) {
      ws.send(JSON.stringify(payload));
    },

    /** Send with an rid and wait for the reply carrying it back. */
    async request(payload) {
      const rid = Math.random().toString(36).slice(2);
      this.send({ ...payload, rid });
      return this.next((m) => m.rid === rid);
    },

    async ready() {
      if (ws.readyState !== WebSocket.OPEN) {
        await new Promise((done, fail) => {
          ws.addEventListener('open', done, { once: true });
          ws.addEventListener('close', () => fail(new Error('closed before open')), { once: true });
        });
      }
      return this;
    },
  };

  client.hello = async () => {
    await client.ready();
    return client.request({ type: 'hello', token });
  };

  return client;
}

before(async () => {
  dataDir = mkdtempSync(resolve(tmpdir(), 'harmony-rt-'));
  await startFakeMediaMtx();
  await startHarmony();

  ownerToken = (await api('/api/accounts/register', {
    method: 'POST', body: { nickname: 'boss', password: 'hunter22', ownerKey },
  })).body.token;
  memberToken = (await api('/api/accounts/register', {
    method: 'POST', body: { nickname: 'member', password: 'hunter22' },
  })).body.token;

  const channels = (await api('/api/channels', { token: ownerToken })).body.channels;
  voiceChannelId = channels.find((c) => c.kind === 'voice').id;

  lockedChannelId = (await api('/api/channels', {
    method: 'POST',
    body: { kind: 'voice', name: 'Locked Room', password: 'letmein' },
    token: ownerToken,
  })).body.channel.id;
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

describe('the socket handshake', () => {
  it('refuses a bad token and closes', async () => {
    const c = connect('not-a-real-token');
    await c.ready();
    const reply = await c.request({ type: 'hello', token: 'not-a-real-token' });
    assert.equal(reply.type, 'hello-failed');
    const close = await c.closed;
    assert.equal(close.code, 4401, 'a credential rejection must close, so the client stops retrying');
  });

  it('refuses anything before hello', async () => {
    const c = connect(memberToken);
    await c.ready();
    const reply = await c.request({ type: 'voice:join', channelId: voiceChannelId });
    assert.equal(reply.error, 'no_hello');
    c.ws.close();
  });

  it('answers hello with the user, the channels and the cap', async () => {
    const c = connect(memberToken);
    const hello = await c.hello();
    assert.equal(hello.type, 'hello-ok');
    assert.equal(hello.user.nickname, 'member');
    assert.ok(Array.isArray(hello.channels) && hello.channels.length >= 2);
    assert.equal(hello.voiceCap, VOICE_HARD_CAP);
    assert.equal(hello.user.password_hash, undefined);
    c.ws.close();
  });
});

describe('somebody new registering', () => {
  it('is announced to everybody already connected', async () => {
    // The member list is drawn from the accounts a client already holds;
    // without this push a new account appeared in nobody's list until a
    // restart, even with its owner online.
    const watcher = connect(memberToken);
    await watcher.hello();
    const res = await api('/api/accounts/register', {
      method: 'POST', body: { nickname: 'newcomer', password: 'hunter22' },
    });
    assert.equal(res.status, 201);
    const push = await watcher.next((m) => m.type === 'user:updated' && m.user?.nickname === 'newcomer');
    assert.equal(push.user.id, res.body.user.id);
    // The public view only: nothing about the password or the session.
    assert.equal(push.user.passwordHash, undefined);
    assert.equal(push.token, undefined);
    watcher.ws.close();
  });
});

describe('voice presence', () => {
  it('joins, gets a slot, and publishes a roster to everyone', async () => {
    const watcher = connect(ownerToken);
    await watcher.hello();

    const joiner = connect(memberToken);
    await joiner.hello();
    const joined = await joiner.request({ type: 'voice:join', channelId: voiceChannelId });

    assert.equal(joined.type, 'voice:joined');
    assert.ok(joined.mid >= 1);
    assert.ok(joined.token, 'a media token must come back with the join');
    assert.match(joined.publish.voice, /\/vc-[0-9a-z]+-[0-9a-z]+-v\/whip\?token=/);

    const roster = await watcher.next(
      (m) => m.type === 'voice:roster' && m.channelId === voiceChannelId && m.roster.length === 1,
    );
    assert.equal(roster.roster[0].nickname, 'member');
    assert.equal(roster.roster[0].forceMuted, false);

    joiner.ws.close();
    watcher.ws.close();
  });

  it('removes presence when the socket drops, with nothing to reconcile', async () => {
    const watcher = connect(ownerToken);
    await watcher.hello();

    const joiner = connect(memberToken);
    await joiner.hello();
    await joiner.request({ type: 'voice:join', channelId: voiceChannelId });
    await watcher.next((m) => m.type === 'voice:roster' && m.roster.length === 1);

    joiner.ws.close();
    const empty = await watcher.next(
      (m) => m.type === 'voice:roster' && m.channelId === voiceChannelId && m.roster.length === 0,
    );
    assert.equal(empty.roster.length, 0);
    watcher.ws.close();
  });

  it('gives a reconnecting member the same slot back', async () => {
    const first = connect(memberToken);
    await first.hello();
    const a = await first.request({ type: 'voice:join', channelId: voiceChannelId });
    first.ws.close();
    await first.closed;

    const second = connect(memberToken);
    await second.hello();
    const b = await second.request({ type: 'voice:join', channelId: voiceChannelId });
    assert.equal(b.mid, a.mid,
      'the same slot means subscribers see the path come back, not a new one');
    second.ws.close();
  });
});

describe('channel passwords', () => {
  it('refuses a locked channel without the password', async () => {
    const c = connect(memberToken);
    await c.hello();
    const res = await c.request({ type: 'voice:join', channelId: lockedChannelId });
    assert.equal(res.type, 'voice:error');
    assert.equal(res.error, 'password_required');
    c.ws.close();
  });

  it('refuses a wrong password', async () => {
    const c = connect(memberToken);
    await c.hello();
    const res = await c.request({
      type: 'voice:join', channelId: lockedChannelId, password: 'guess',
    });
    assert.equal(res.error, 'bad_password');
    c.ws.close();
  });

  it('admits with the right one, and remembers it afterwards', async () => {
    const c = connect(memberToken);
    await c.hello();
    const ok = await c.request({
      type: 'voice:join', channelId: lockedChannelId, password: 'letmein',
    });
    assert.equal(ok.type, 'voice:joined');
    c.ws.close();
    await c.closed;

    const again = connect(memberToken);
    await again.hello();
    const second = await again.request({ type: 'voice:join', channelId: lockedChannelId });
    assert.equal(second.type, 'voice:joined', 'the grant means it is asked once, not every join');
    again.ws.close();
  });
});

describe('admin force-mute actually stops the publish', () => {
  it('is refused to non-admins', async () => {
    const c = connect(memberToken);
    await c.hello();
    const res = await c.request({
      type: 'admin:force-mute', channelId: voiceChannelId, mid: 1, muted: true,
    });
    assert.equal(res.error, 'forbidden');
    c.ws.close();
  });

  it('flips the auth hook from 204 to 401 for that slot', async () => {
    const victim = connect(memberToken);
    await victim.hello();
    const joined = await victim.request({ type: 'voice:join', channelId: voiceChannelId });

    const path = channelPath(voiceChannelId, joined.mid, 'voice');
    const query = `token=${encodeURIComponent(joined.token)}`;

    const before = await api('/mediamtx/auth', {
      method: 'POST', body: { action: 'publish', path, query },
    });
    assert.equal(before.status, 204, 'the member can publish to their own slot');

    const admin = connect(ownerToken);
    await admin.hello();
    const muted = await admin.request({
      type: 'admin:force-mute', channelId: voiceChannelId, mid: joined.mid, muted: true,
    });
    assert.equal(muted.type, 'voice:ok');

    // THIS is the enforcement. The spike showed kicking the live session alone
    // does nothing lasting -- the path is immediately re-publishable -- so if
    // this stays 204 a force-muted user simply reconnects and is audible again.
    const after = await api('/mediamtx/auth', {
      method: 'POST', body: { action: 'publish', path, query },
    });
    assert.equal(after.status, 401, 'force-mute must refuse the republish');

    // Reading is unaffected: being muted is not being deafened.
    const read = await api('/mediamtx/auth', {
      method: 'POST', body: { action: 'read', path, query },
    });
    assert.equal(read.status, 204);

    const unmuted = await admin.request({
      type: 'admin:force-mute', channelId: voiceChannelId, mid: joined.mid, muted: false,
    });
    assert.equal(unmuted.type, 'voice:ok');
    const restored = await api('/mediamtx/auth', {
      method: 'POST', body: { action: 'publish', path, query },
    });
    assert.equal(restored.status, 204);

    victim.ws.close();
    admin.ws.close();
  });

  it('tells the muted client before the kick, because WebRTC will not', async () => {
    const victim = connect(memberToken);
    await victim.hello();
    const joined = await victim.request({ type: 'voice:join', channelId: voiceChannelId });

    const admin = connect(ownerToken);
    await admin.hello();
    await admin.request({
      type: 'admin:force-mute', channelId: voiceChannelId, mid: joined.mid, muted: true,
    });

    // The measured gap is about nine seconds of the victim's peer connection
    // still reporting `connected`, so this push is the only timely signal.
    const roster = await victim.next(
      (m) => m.type === 'voice:roster'
        && m.channelId === voiceChannelId
        && m.roster.some((r) => r.mid === joined.mid && r.forceMuted),
    );
    assert.ok(roster, 'the victim must learn of the mute from the roster');

    await admin.request({
      type: 'admin:force-mute', channelId: voiceChannelId, mid: joined.mid, muted: false,
    });
    victim.ws.close();
    admin.ws.close();
  });
});

describe('the voice cap', () => {
  // Sixteen real sockets would be a slow test for a rule that lives entirely
  // in one data structure, so this one is a unit test on purpose.
  it('refuses the seventeenth member', () => {
    const rooms = new VoiceRooms();
    for (let i = 1; i <= VOICE_HARD_CAP; i += 1) {
      const res = rooms.join(1, { id: i, nickname: `u${i}` });
      assert.equal(res.ok, true, `member ${i} should fit`);
    }
    const overflow = rooms.join(1, { id: 999, nickname: 'late' });
    assert.equal(overflow.ok, false);
    assert.equal(overflow.error, 'channel_full');
  });

  it('reuses a freed slot rather than counting upwards forever', () => {
    const rooms = new VoiceRooms();
    rooms.join(1, { id: 1, nickname: 'a' });
    const second = rooms.join(1, { id: 2, nickname: 'b' });
    rooms.join(1, { id: 3, nickname: 'c' });

    rooms.leave(1, 2);
    const replacement = rooms.join(1, { id: 4, nickname: 'd' });
    assert.equal(replacement.mid, second.mid,
      'slots stay small so paths stay short');
  });
});
