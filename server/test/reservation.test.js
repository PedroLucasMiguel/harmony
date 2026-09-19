// End-to-end test of username reservation and the MediaMTX auth hook.
//
// A stub stands in for MediaMTX's control API so we can make a username go live
// and then stop, which is the state transition the whole design turns on.
//
//   node --test server/test/

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', 'src', 'index.js');

const FAKE_MTX_PORT = 19997;
const HARMONY_PORT = 18080;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

/** Paths the stub MediaMTX currently reports. Mutated by the tests. */
let livePaths = [];
let fakeMtx;
let child;

function startFakeMediaMtx() {
  return new Promise((done) => {
    fakeMtx = http.createServer((req, res) => {
      if (req.url.startsWith('/v3/paths/list')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ itemCount: livePaths.length, pageCount: 1, items: livePaths }));
        return;
      }
      res.writeHead(404).end();
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
        HARMONY_MEDIAMTX_API: `http://127.0.0.1:${FAKE_MTX_PORT}`,
        HARMONY_POLL_INTERVAL_MS: '100',
        HARMONY_SIGNALING_URL: 'http://media.test:8889',
        HARMONY_CLAIM_TTL_MS: '2000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => fail(new Error('server did not start')), 10_000);
    child.stdout.on('data', (buf) => {
      if (buf.toString().includes('control server on')) {
        clearTimeout(timer);
        done();
      }
    });
    child.stderr.on('data', (buf) => process.stderr.write(`[server] ${buf}`));
  });
}

const post = (path, body, headers = {}) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const get = (path) => fetch(`${BASE}${path}`);

/** Let the poller observe whatever we just wrote to `livePaths`. */
const settle = () => new Promise((r) => setTimeout(r, 350));

function goLive(name, viewers = 0) {
  livePaths = [
    ...livePaths.filter((p) => p.name !== name),
    { name, ready: true, readyTime: new Date().toISOString(), tracks: ['H264', 'Opus'], readers: Array(viewers).fill({}) },
  ];
}

function goOffline(name) {
  livePaths = livePaths.filter((p) => p.name !== name);
}

describe('username reservation', () => {
  before(async () => {
    await startFakeMediaMtx();
    await startHarmony();
    await settle();
  });

  after(() => {
    child?.kill();
    fakeMtx?.close();
  });

  it('reports healthy once MediaMTX answers', async () => {
    const body = await (await get('/api/health')).json();
    assert.equal(body.ok, true);
    assert.equal(body.mediamtx, 'up');
  });

  it('rejects malformed usernames', async () => {
    for (const bad of ['', 'a', 'has space', 'UPPER!', '-leading', 'x'.repeat(25)]) {
      const res = await post('/api/session', { username: bad });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    }
  });

  it('rejects names that collide with routing or MediaMTX internals', async () => {
    for (const reserved of ['api', 'all_others', 'mediamtx', 'whip', 'admin']) {
      const res = await post('/api/session', { username: reserved });
      assert.equal(res.status, 400, `expected 400 for reserved name ${reserved}`);
    }
  });

  it('gives the first user the broadcaster role and a publish token', async () => {
    const body = await (await post('/api/session', { username: 'alice' })).json();
    assert.equal(body.role, 'broadcaster');
    assert.equal(body.username, 'alice');
    assert.ok(body.token, 'expected a publish token');
    assert.match(body.whipUrl, /^http:\/\/media\.test:8889\/alice\/whip\?token=/);
    globalThis.__token = body.token;
  });

  it('accepts a publish with the right token and refuses a wrong one', async () => {
    const ok = await post('/mediamtx/auth', {
      action: 'publish',
      path: 'alice',
      query: `token=${globalThis.__token}`,
      protocol: 'webrtc',
    });
    assert.equal(ok.status, 204);

    const bad = await post('/mediamtx/auth', {
      action: 'publish',
      path: 'alice',
      query: 'token=not-the-token',
      protocol: 'webrtc',
    });
    assert.equal(bad.status, 401);

    const none = await post('/mediamtx/auth', { action: 'publish', path: 'alice', query: '' });
    assert.equal(none.status, 401);
  });

  it('turns a second person on a claimed-but-not-live name into a waiting viewer', async () => {
    const res = await post('/api/session', { username: 'alice' });
    const body = await res.json();
    assert.equal(body.role, 'viewer');
    assert.equal(body.pending, true);
    assert.equal(body.whepUrl, 'http://media.test:8889/alice/whep');
  });

  it('lets the holder of a token reclaim its own pending username', async () => {
    const body = await (
      await post('/api/session', { username: 'alice', token: globalThis.__token })
    ).json();
    assert.equal(body.role, 'broadcaster');
    assert.equal(body.token, globalThis.__token);
  });

  it('does not hand out a claim to a spoofed source address', async () => {
    // Identity must rest on the token alone: X-Forwarded-For is client-supplied
    // and trivially forged once the server sits behind a proxy or tunnel.
    const body = await (
      await post('/api/session', { username: 'alice' }, { 'X-Forwarded-For': '127.0.0.1' })
    ).json();
    assert.equal(body.role, 'viewer');
    assert.equal(body.token, undefined);
  });

  it('ignores a wrong token when reclaiming', async () => {
    const body = await (await post('/api/session', { username: 'alice', token: 'wrong' })).json();
    assert.equal(body.role, 'viewer');
    assert.equal(body.token, undefined);
  });

  it('turns everyone else into a viewer once the stream is live', async () => {
    goLive('alice', 3);
    await settle();

    const body = await (await post('/api/session', { username: 'alice' })).json();
    assert.equal(body.role, 'viewer');
    assert.equal(body.pending, false);

    const { streams } = await (await get('/api/streams')).json();
    assert.deepEqual(
      streams.map((s) => [s.username, s.viewers]),
      [['alice', 3]],
    );
  });

  it('lets anyone read without a token', async () => {
    const res = await post('/mediamtx/auth', { action: 'read', path: 'alice', query: '' });
    assert.equal(res.status, 204);
  });

  it('frees the name when the publisher disappears', async () => {
    goOffline('alice');
    await settle();
    // The claim TTL is 2s in this run; wait it out so nothing lingers.
    await new Promise((r) => setTimeout(r, 2200));

    const body = await (await post('/api/session', { username: 'alice' })).json();
    assert.equal(body.role, 'broadcaster');
    assert.notEqual(body.token, globalThis.__token, 'expected a fresh token');
  });

  it('frees the name immediately on an explicit release', async () => {
    const claimed = await (await post('/api/session', { username: 'ana' })).json();
    assert.equal(claimed.role, 'broadcaster');

    const released = await (
      await post('/api/session/release', { username: 'ana', token: claimed.token })
    ).json();
    assert.equal(released.ok, true);

    const again = await (await post('/api/session', { username: 'ana' })).json();
    assert.equal(again.role, 'broadcaster', 'name should be free straight away');
  });

  it('will not let a stale token publish after release', async () => {
    const claimed = await (await post('/api/session', { username: 'bruno' })).json();
    await post('/api/session/release', { username: 'bruno', token: claimed.token });

    const res = await post('/mediamtx/auth', {
      action: 'publish',
      path: 'bruno',
      query: `token=${claimed.token}`,
    });
    assert.equal(res.status, 401);
  });

  it('keeps a claim alive while the broadcaster heartbeats', async () => {
    const claimed = await (await post('/api/session', { username: 'carla' })).json();

    // TTL is 2s; heartbeat past it and the claim must survive.
    await new Promise((r) => setTimeout(r, 1200));
    const beat = await (
      await post('/api/session/heartbeat', { username: 'carla', token: claimed.token })
    ).json();
    assert.equal(beat.ok, true);

    await new Promise((r) => setTimeout(r, 1200));
    const other = await (await post('/api/session', { username: 'carla' })).json();
    assert.equal(other.role, 'viewer', 'claim should still be held');
  });
});
