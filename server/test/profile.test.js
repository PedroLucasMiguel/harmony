// Profile pictures, the per-kind upload ceilings, and ordering the soundpad.
//
// These are the three things that were plumbed into the schema in 2.0.0 and
// had no route in front of them: `users.avatar_hash`,
// `soundpad_clips.position`, and the clip/avatar size caps the plan asked for
// and the generic 25 MB upload limit did not provide.
//
//   node --test server/test/profile.test.js

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
const FAKE_MTX_PORT = 20004;
const HARMONY_PORT = 18087;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;
const WS_URL = `ws://127.0.0.1:${HARMONY_PORT}/ws`;

let fakeMtx;
let child;
let dataDir;
let ownerKey = null;
let ownerToken;
let memberToken;
let memberId;

/** A 1x1 PNG. Small, real, and in the allowlist. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const OGG = Buffer.from('OggS\u0000\u0002a short clip', 'binary');

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

const upload = async (bytes, contentType, token) =>
  (await api('/api/uploads', { method: 'POST', raw: bytes, contentType, token })).body;

before(async () => {
  dataDir = mkdtempSync(resolve(tmpdir(), 'harmony-profile-'));
  await startFakeMediaMtx();
  await startHarmony();

  ownerToken = (await api('/api/accounts/register', {
    method: 'POST', body: { nickname: 'boss', password: 'hunter22', ownerKey },
  })).body.token;

  const member = (await api('/api/accounts/register', {
    method: 'POST', body: { nickname: 'member', password: 'hunter22' },
  })).body;
  memberToken = member.token;
  memberId = member.user.id;
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

describe('profile pictures', () => {
  let pngHash;

  it('needs a login', async () => {
    const res = await api('/api/accounts/avatar', { method: 'POST', body: { hash: null } });
    assert.equal(res.status, 401);
  });

  it('sets one from an uploaded image', async () => {
    pngHash = (await upload(PNG, 'image/png', memberToken)).hash;
    const res = await api('/api/accounts/avatar', {
      method: 'POST', body: { hash: pngHash }, token: memberToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.avatarHash, pngHash);
  });

  it('shows up on the roster, so other people can draw it', async () => {
    const { body } = await api('/api/accounts', { token: ownerToken });
    const member = body.users.find((u) => u.nickname === 'member');
    assert.equal(member.avatarHash, pngHash);
  });

  it('refuses a file that was never uploaded', async () => {
    const res = await api('/api/accounts/avatar', {
      method: 'POST', body: { hash: 'a'.repeat(64) }, token: memberToken,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'no_such_upload');
  });

  it('refuses something that is not an image', async () => {
    const hash = (await upload(OGG, 'audio/ogg', memberToken)).hash;
    const res = await api('/api/accounts/avatar', {
      method: 'POST', body: { hash }, token: memberToken,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'not_an_image');
  });

  it('refuses a picture over the size cap', async () => {
    // A PNG header followed by filler: the type check has to pass so the SIZE
    // check is what refuses it.
    const big = Buffer.concat([PNG, Buffer.alloc(300 * 1024, 7)]);
    const hash = (await upload(big, 'image/png', memberToken)).hash;
    const res = await api('/api/accounts/avatar', {
      method: 'POST', body: { hash }, token: memberToken,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'avatar_too_large');
  });

  it('takes a GIF that moves a good deal larger than a still, and refuses one over that', async () => {
    const GIF = Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64');
    // Over what a still may be (256 KB) and under what a GIF may (1 MB).
    const medium = Buffer.concat([GIF, Buffer.alloc(600 * 1024, 7)]);
    const mediumHash = (await upload(medium, 'image/gif', memberToken)).hash;
    const ok = await api('/api/accounts/avatar', { method: 'POST', body: { hash: mediumHash }, token: memberToken });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.user.avatarHash, mediumHash);

    const huge = Buffer.concat([GIF, Buffer.alloc(1100 * 1024, 7)]);
    const hugeHash = (await upload(huge, 'image/gif', memberToken)).hash;
    const refused = await api('/api/accounts/avatar', { method: 'POST', body: { hash: hugeHash }, token: memberToken });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, 'avatar_too_large');
    assert.match(refused.body.message, /1024 KB|1,024 KB/);

    // The same size as a PNG is still refused: the room is for the frames of a GIF.
    const pngMedium = Buffer.concat([PNG, Buffer.alloc(600 * 1024, 7)]);
    const pngHashMedium = (await upload(pngMedium, 'image/png', memberToken)).hash;
    const still = await api('/api/accounts/avatar', { method: 'POST', body: { hash: pngHashMedium }, token: memberToken });
    assert.equal(still.status, 400);
    assert.match(still.body.message, /256 KB.*GIF/);
  });

  it('refuses anything that is not a hash at all', async () => {
    const res = await api('/api/accounts/avatar', {
      method: 'POST', body: { hash: '../../etc/passwd' }, token: memberToken,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'bad_hash');
  });

  it('clears back to initials', async () => {
    const res = await api('/api/accounts/avatar', {
      method: 'POST', body: { hash: null }, token: memberToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.avatarHash, null);
  });

  /**
   * The reference is what keeps an avatar out of the eviction sweep. Setting
   * the same picture twice must not leave it at zero -- the route retains the
   * new hash before releasing the old one precisely so that re-setting is not
   * a moment where nothing points at the file.
   */
  it('still serves a picture that was set, cleared and set again', async () => {
    for (const hash of [pngHash, null, pngHash]) {
      const res = await api('/api/accounts/avatar', {
        method: 'POST', body: { hash }, token: memberToken,
      });
      assert.equal(res.status, 200);
    }
    const file = await fetch(`${BASE}/api/uploads/${pngHash}`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');
  });

  it('is announced over the socket, so other clients repaint', async () => {
    const ws = new WebSocket(WS_URL);
    const seen = [];
    ws.addEventListener('message', (e) => seen.push(JSON.parse(e.data)));
    await new Promise((done, fail) => {
      ws.addEventListener('open', done, { once: true });
      ws.addEventListener('error', () => fail(new Error('socket failed')), { once: true });
    });
    ws.send(JSON.stringify({ type: 'hello', token: ownerToken, rid: 'r1' }));
    await new Promise((r) => setTimeout(r, 300));

    await api('/api/accounts/avatar', {
      method: 'POST', body: { hash: pngHash }, token: memberToken,
    });
    await new Promise((r) => setTimeout(r, 400));

    const event = seen.find((m) => m.type === 'user:updated');
    assert.ok(event, `no user:updated in ${JSON.stringify(seen.map((m) => m.type))}`);
    assert.equal(event.user.id, memberId);
    assert.equal(event.user.avatarHash, pngHash);
    ws.close();
  });
});

describe('soundpad size', () => {
  it('takes a clip over 2 MB: a clip is held to what an upload is, and no less', async () => {
    const big = Buffer.concat([OGG, Buffer.alloc(3 * 1024 * 1024, 3)]);
    const { hash, bytes } = await upload(big, 'audio/ogg', ownerToken);
    assert.ok(bytes > 2 * 1024 * 1024, 'the upload must succeed for this to test anything');

    const res = await api('/api/soundpad', {
      method: 'POST', body: { name: 'a long one', hash }, token: ownerToken,
    });
    assert.equal(res.status, 201);
    // Taken out again: the tests after this one count what is on the pad.
    await api(`/api/soundpad/${res.body.clip.id}/delete`, { method: 'POST', token: ownerToken });
  });
});

describe('soundpad order', () => {
  const ids = [];

  it('keeps the order clips were added in', async () => {
    for (const name of ['one', 'two', 'three']) {
      const hash = (await upload(
        Buffer.from(`OggS\u0000\u0002${name}`, 'binary'), 'audio/ogg', ownerToken,
      )).hash;
      const res = await api('/api/soundpad', {
        method: 'POST', body: { name, hash }, token: ownerToken,
      });
      assert.equal(res.status, 201);
      ids.push(res.body.clip.id);
    }
    const { body } = await api('/api/soundpad', { token: memberToken });
    assert.deepEqual(body.clips.map((c) => c.name), ['one', 'two', 'three']);
  });

  it('is not reorderable by a member', async () => {
    const res = await api('/api/soundpad/reorder', {
      method: 'POST', body: { ids: [...ids].reverse() }, token: memberToken,
    });
    assert.equal(res.status, 403);
  });

  it('refuses a partial order rather than guessing the rest', async () => {
    const res = await api('/api/soundpad/reorder', {
      method: 'POST', body: { ids: [ids[0]] }, token: ownerToken,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'bad_order');
  });

  it('reorders for an admin', async () => {
    const wanted = [ids[2], ids[0], ids[1]];
    const res = await api('/api/soundpad/reorder', {
      method: 'POST', body: { ids: wanted }, token: ownerToken,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.clips.map((c) => c.id), wanted);

    const { body } = await api('/api/soundpad', { token: memberToken });
    assert.deepEqual(body.clips.map((c) => c.name), ['three', 'one', 'two']);
  });
});

/**
 * The channel mosaic rests on these three URLs existing and being distinct.
 * They are what the client publishes a camera and a screen share to, and the
 * reason a stream inside a locked channel is not reachable from the flat
 * namespace.
 */
describe('channel media paths', () => {
  it('hands a joining member one path per medium', async () => {
    const voiceChannel = (await api('/api/channels', { token: ownerToken }))
      .body.channels.find((c) => c.kind === 'voice');

    const ws = new WebSocket(WS_URL);
    const inbox = [];
    ws.addEventListener('message', (e) => inbox.push(JSON.parse(e.data)));
    await new Promise((done) => ws.addEventListener('open', done, { once: true }));
    ws.send(JSON.stringify({ type: 'hello', token: ownerToken, rid: 'h' }));
    await new Promise((r) => setTimeout(r, 300));
    ws.send(JSON.stringify({ type: 'voice:join', channelId: voiceChannel.id, rid: 'j' }));
    await new Promise((r) => setTimeout(r, 500));

    const joined = inbox.find((m) => m.type === 'voice:joined');
    assert.ok(joined, `no voice:joined in ${JSON.stringify(inbox.map((m) => m.type))}`);

    const cid = voiceChannel.id.toString(36);
    const mid = joined.mid.toString(36);
    assert.match(joined.publish.voice, new RegExp(`/vc-${cid}-${mid}-v/whip\\?token=`));
    assert.match(joined.publish.cam, new RegExp(`/vc-${cid}-${mid}-c/whip\\?token=`));
    assert.match(joined.publish.screen, new RegExp(`/vc-${cid}-${mid}-s/whip\\?token=`));

    ws.close();
  });

  it('lets the auth hook read a camera path with the channel token', async () => {
    const voiceChannel = (await api('/api/channels', { token: ownerToken }))
      .body.channels.find((c) => c.kind === 'voice');

    const ws = new WebSocket(WS_URL);
    const inbox = [];
    ws.addEventListener('message', (e) => inbox.push(JSON.parse(e.data)));
    await new Promise((done) => ws.addEventListener('open', done, { once: true }));
    ws.send(JSON.stringify({ type: 'hello', token: memberToken, rid: 'h' }));
    await new Promise((r) => setTimeout(r, 300));
    ws.send(JSON.stringify({ type: 'voice:join', channelId: voiceChannel.id, rid: 'j' }));
    await new Promise((r) => setTimeout(r, 500));
    const joined = inbox.find((m) => m.type === 'voice:joined');

    const cid = voiceChannel.id.toString(36);
    // Reading SOMEBODY ELSE'S camera slot: a read only has to match the
    // channel, which is what makes the mosaic work at all.
    const other = (joined.mid === 1 ? 2 : 1).toString(36);
    const read = await fetch(`${BASE}/mediamtx/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'read',
        path: `vc-${cid}-${other}-c`,
        query: `token=${joined.token}`,
      }),
    });
    assert.equal(read.status, 204);

    // Publishing into it must still be refused: the slot has to match.
    const publishOther = await fetch(`${BASE}/mediamtx/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'publish',
        path: `vc-${cid}-${other}-s`,
        query: `token=${joined.token}`,
      }),
    });
    assert.equal(publishOther.status, 401);

    ws.close();
  });
});
