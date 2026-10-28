// The soundpad: admin-only uploads, and a play event that reaches everyone in
// the channel rather than being mixed into anyone's microphone.
//
//   node --test server/test/soundpad.test.js

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', 'src', 'index.js');

// Unique across the suite: node --test runs these files in PARALLEL.
const FAKE_MTX_PORT = 20003;
const HARMONY_PORT = 18086;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;
const WS_URL = `ws://127.0.0.1:${HARMONY_PORT}/ws`;

let fakeMtx;
let child;
let dataDir;
let ownerKey = null;
let ownerToken;
let memberToken;
let voiceChannelId;
let clipId;
let audioHash;

/** A few bytes that are allowed by content type; contents do not matter here. */
const OGG = Buffer.from('OggS\u0000\u0002fake audio payload for the test', 'binary');

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
      ...(raw ? { 'Content-Type': contentType } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...(raw ? { body: raw } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
};

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
      return client.next((m) => m.rid === rid);
    },
    async hello() {
      if (ws.readyState !== WebSocket.OPEN) {
        await new Promise((done, fail) => {
          ws.addEventListener('open', done, { once: true });
          ws.addEventListener('close', () => fail(new Error('closed')), { once: true });
        });
      }
      return client.request({ type: 'hello', token });
    },
  };
  return client;
}

before(async () => {
  dataDir = mkdtempSync(resolve(tmpdir(), 'harmony-sp-'));
  await startFakeMediaMtx();
  await startHarmony();

  ownerToken = (await api('/api/accounts/register', {
    method: 'POST', body: { nickname: 'boss', password: 'hunter22', ownerKey },
  })).body.token;
  memberToken = (await api('/api/accounts/register', {
    method: 'POST', body: { nickname: 'member', password: 'hunter22' },
  })).body.token;

  voiceChannelId = (await api('/api/channels', { token: ownerToken }))
    .body.channels.find((c) => c.kind === 'voice').id;

  audioHash = (await api('/api/uploads', {
    method: 'POST', raw: OGG, contentType: 'audio/ogg', token: ownerToken,
  })).body.hash;
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

describe('soundpad clips', () => {
  it('does not let a member add one', async () => {
    const res = await api('/api/soundpad', {
      method: 'POST', body: { name: 'airhorn', hash: audioHash }, token: memberToken,
    });
    assert.equal(res.status, 403);
  });

  it('lets an admin add one', async () => {
    const res = await api('/api/soundpad', {
      method: 'POST', body: { name: 'airhorn', hash: audioHash }, token: ownerToken,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.clip.name, 'airhorn');
    assert.equal(res.body.clip.hash, audioHash);
    clipId = res.body.clip.id;
  });

  it('refuses a clip that is not audio', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const hash = (await api('/api/uploads', {
      method: 'POST', raw: png, contentType: 'image/png', token: ownerToken,
    })).body.hash;

    const res = await api('/api/soundpad', {
      method: 'POST', body: { name: 'not audio', hash }, token: ownerToken,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'not_audio');
  });

  it('refuses a clip whose audio was never uploaded', async () => {
    const res = await api('/api/soundpad', {
      method: 'POST', body: { name: 'ghost', hash: 'a'.repeat(64) }, token: ownerToken,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'no_such_upload');
  });

  it('lists clips to any signed-in user', async () => {
    const res = await api('/api/soundpad', { token: memberToken });
    assert.equal(res.status, 200);
    assert.ok(res.body.clips.some((c) => c.id === clipId));
  });

  /*
   * The emoji is a label, not a validated type.
   *
   * There is no cheap correct test for "is this an emoji", every
   * approximation refuses something somebody wanted, and the worst case is
   * a clip labelled with a letter -- which is fine, and is what several of
   * them will be. So: one grapheme, no control characters, or nothing.
   */
  describe('the emoji on a clip', () => {
    it('is kept, and comes back on the clip', async () => {
      const res = await api('/api/soundpad', {
        method: 'POST',
        body: { name: 'horn', emoji: '\u{1F4EF}', hash: audioHash },
        token: ownerToken,
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.clip.emoji, '\u{1F4EF}');
    });

    it('is cut to one character, so one clip cannot take a whole row', async () => {
      const res = await api('/api/soundpad', {
        method: 'POST',
        body: { name: 'many', emoji: '\u{1F4EF}\u{1F4EF}\u{1F4EF}', hash: audioHash },
        token: ownerToken,
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.clip.emoji, '\u{1F4EF}');
    });

    it('is optional, and absent reads as null rather than empty', async () => {
      const res = await api('/api/soundpad', {
        method: 'POST', body: { name: 'bare', hash: audioHash }, token: ownerToken,
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.clip.emoji, null);
    });

    it('refuses control characters, which are invisible', async () => {
      const res = await api('/api/soundpad', {
        method: 'POST',
        // A right-to-left override would reverse the labels either side of
        // it in a grid of buttons.
        body: { name: 'sneaky', emoji: '\u202E', hash: audioHash },
        token: ownerToken,
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.clip.emoji, null);
    });

    // One emoji is one GRAPHEME, not one code point: each of these was cut to
    // its first code point -- half a flag, a face without its tone, a heart as
    // a text glyph -- or, with a zero-width joiner in it, refused as invisible
    // and drawn as nothing at all.
    for (const [what, emoji] of [
      ['a flag', '\u{1F1E7}\u{1F1F7}'],
      ['a skin tone', '\u{1F44D}\u{1F3FD}'],
      ['a heart with its variation selector', '\u2764\uFE0F'],
      ['a joined family', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'],
      ['a keycap', '1\uFE0F\u20E3'],
    ]) {
      it(`keeps ${what} whole`, async () => {
        const res = await api('/api/soundpad', {
          method: 'POST', body: { name: 'whole', emoji, hash: audioHash }, token: ownerToken,
        });
        assert.equal(res.status, 201);
        assert.equal(res.body.clip.emoji, emoji);
      });
    }

    it('still keeps only the first of several, whole', async () => {
      const res = await api('/api/soundpad', {
        method: 'POST',
        body: { name: 'first', emoji: '\u{1F1E7}\u{1F1F7}\u{1F44D}\u{1F3FD}', hash: audioHash },
        token: ownerToken,
      });
      assert.equal(res.body.clip.emoji, '\u{1F1E7}\u{1F1F7}');
    });

    it('refuses a pile of combining marks pretending to be one', async () => {
      const res = await api('/api/soundpad', {
        method: 'POST', body: { name: 'zalgo', emoji: `e${'\u0301'.repeat(20)}`, hash: audioHash }, token: ownerToken,
      });
      assert.equal(res.body.clip.emoji, null);
    });
  });

  describe('renaming a clip', () => {
    it('changes the label and leaves the audio alone', async () => {
      const res = await api(`/api/soundpad/${clipId}/rename`, {
        method: 'POST', body: { name: 'AIR HORN', emoji: '\u{1F6A8}' }, token: ownerToken,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.clip.name, 'AIR HORN');
      assert.equal(res.body.clip.emoji, '\u{1F6A8}');
      assert.equal(res.body.clip.hash, audioHash, 'the audio must not move');
    });

    it('is refused to non-admins', async () => {
      const res = await api(`/api/soundpad/${clipId}/rename`, {
        method: 'POST', body: { name: 'mine now' }, token: memberToken,
      });
      assert.equal(res.status, 403);
    });

    it('refuses an empty name', async () => {
      const res = await api(`/api/soundpad/${clipId}/rename`, {
        method: 'POST', body: { name: '   ' }, token: ownerToken,
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'invalid_name');
    });
  });
});

describe('playing a clip', () => {
  it('reaches everyone in the channel, not just the clicker', async () => {
    const a = connect(ownerToken);
    const b = connect(memberToken);
    await a.hello();
    await b.hello();
    await a.request({ type: 'voice:join', channelId: voiceChannelId });
    await b.request({ type: 'voice:join', channelId: voiceChannelId });

    const heardByB = b.next((m) => m.type === 'soundpad:play');
    const ok = await a.request({
      type: 'soundpad:play', channelId: voiceChannelId, clipId,
    });
    assert.equal(ok.type, 'voice:ok');

    const event = await heardByB;
    assert.equal(event.clipId, clipId);
    assert.equal(event.hash, audioHash,
      'the hash is what lets each client play its own cached copy');
    assert.equal(event.by, 'boss');

    a.ws.close();
    b.ws.close();
  });

  it('refuses from somebody not in the channel', async () => {
    const c = connect(memberToken);
    await c.hello();
    const res = await c.request({
      type: 'soundpad:play', channelId: voiceChannelId, clipId,
    });
    assert.equal(res.error, 'not_in_channel');
    c.ws.close();
  });

  it('refuses a clip that does not exist', async () => {
    const c = connect(ownerToken);
    await c.hello();
    await c.request({ type: 'voice:join', channelId: voiceChannelId });
    const res = await c.request({
      type: 'soundpad:play', channelId: voiceChannelId, clipId: 99999,
    });
    assert.equal(res.error, 'no_such_clip');
    c.ws.close();
  });
});

describe('moving a user between channels', () => {
  it('is refused to non-admins', async () => {
    const c = connect(memberToken);
    await c.hello();
    const res = await c.request({ type: 'admin:move', userId: 1, toChannelId: voiceChannelId });
    assert.equal(res.error, 'forbidden');
    c.ws.close();
  });

  it('tells the moved user where to go', async () => {
    const admin = connect(ownerToken);
    const target = connect(memberToken);
    await admin.hello();
    const hello = await target.hello();
    await target.request({ type: 'voice:join', channelId: voiceChannelId });

    const moved = target.next((m) => m.type === 'voice:moved');
    const ok = await admin.request({
      type: 'admin:move', userId: hello.user.id, toChannelId: null,
    });
    assert.equal(ok.type, 'voice:ok');

    const event = await moved;
    assert.equal(event.channelId, null, 'null means disconnected');
    assert.equal(event.by, 'boss');

    admin.ws.close();
    target.ws.close();
  });
});
