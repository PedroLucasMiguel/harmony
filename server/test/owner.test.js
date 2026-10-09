// The two things only the owner can do: delete somebody, and change the
// server itself.
//
// Its own file rather than another describe in accounts.test.js, because
// one of these tests CHANGES THE DOOR PASSWORD. Everything that ran after
// it in the same file would be talking to a server it no longer has the key
// to, and the failures would look like anything but the cause.
//
//   node --test server/test/owner.test.js

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
const FAKE_MTX_PORT = 19996;
const HARMONY_PORT = 18088;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

let fakeMtx;
let child;
let dataDir;
let ownerKey = null;
let ownerToken;
let adminToken;
let memberToken;
let textChannelId;

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
    child.stdout.on('data', (buf) => {
      out += buf.toString();
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

function stopHarmony() {
  return new Promise((done) => {
    if (!child || child.exitCode !== null) return done();
    child.once('exit', () => done());
    child.kill('SIGTERM');
    setTimeout(() => { child.kill('SIGKILL'); done(); }, 4000).unref();
  });
}

/** `password` is the SHARED door key, not an account's. */
const api = async (path, { method = 'GET', body, token, password } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(password ? { 'x-harmony-password': password } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 */ }
  return { status: res.status, body: json };
};

before(async () => {
  dataDir = mkdtempSync(resolve(tmpdir(), 'harmony-owner-'));
  await startFakeMediaMtx();
  await startHarmony();

  ownerToken = (await api('/api/accounts/register', {
    method: 'POST', body: { nickname: 'chief', password: 'hunter22', ownerKey },
  })).body.token;
  adminToken = (await api('/api/accounts/register', {
    method: 'POST', body: { nickname: 'deputy', password: 'hunter22' },
  })).body.token;
  memberToken = (await api('/api/accounts/register', {
    method: 'POST', body: { nickname: 'regular', password: 'hunter22' },
  })).body.token;

  const roster = (await api('/api/accounts', { token: ownerToken })).body.users;
  await api(`/api/accounts/${roster.find((u) => u.nickname === 'deputy').id}/role`, {
    method: 'POST', body: { role: 'admin' }, token: ownerToken,
  });

  textChannelId = (await api('/api/channels', { token: ownerToken }))
    .body.channels.find((c) => c.kind === 'text').id;
});

after(async () => {
  await stopHarmony();
  await new Promise((done) => fakeMtx.close(done));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// ---------------------------------------------------------------------------

describe('removing an account', () => {
  let victimToken;
  let victimId;

  before(async () => {
    victimToken = (await api('/api/accounts/register', {
      method: 'POST', body: { nickname: 'victim', password: 'hunter22' },
    })).body.token;
    victimId = (await api('/api/accounts/me', { token: victimToken })).body.user.id;
    await api(`/api/channels/${textChannelId}/messages`, {
      method: 'POST', body: { body: 'something they said' }, token: victimToken,
    });
  });

  it('is refused to an admin', async () => {
    // Granting admin is reversible and a force-mute lasts until it is
    // lifted. This takes a person's whole history off the server.
    const res = await api(`/api/accounts/${victimId}/delete`, {
      method: 'POST', token: adminToken,
    });
    assert.equal(res.status, 403);
  });

  it('is refused to the person themselves', async () => {
    const res = await api(`/api/accounts/${victimId}/delete`, {
      method: 'POST', token: victimToken,
    });
    assert.equal(res.status, 403);
  });

  it('is refused for the owner, even to the owner', async () => {
    const me = (await api('/api/accounts/me', { token: ownerToken })).body.user;
    const res = await api(`/api/accounts/${me.id}/delete`, {
      method: 'POST', token: ownerToken,
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'cannot_remove_owner');
  });

  it('TAKES EVERY MESSAGE THEY WROTE WITH IT', async () => {
    const before_ = (await api(`/api/channels/${textChannelId}/messages`, { token: ownerToken }))
      .body.messages.filter((m) => m.nickname === 'victim');
    assert.ok(before_.length > 0, 'there has to be something to delete');

    const res = await api(`/api/accounts/${victimId}/delete`, {
      method: 'POST', token: ownerToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.messages, before_.length);

    const after_ = (await api(`/api/channels/${textChannelId}/messages`, { token: ownerToken }))
      .body.messages.filter((m) => m.nickname === 'victim');
    assert.equal(after_.length, 0);
  });

  it('CLEARS THE SEARCH INDEX TOO', async () => {
    // messages_fts has no foreign key to anything, so nothing would have
    // cleaned it up. A search that still answers with deleted rows is the
    // quiet half of this bug.
    const res = await api(`/api/channels/${textChannelId}/search?q=something`, {
      token: ownerToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.results.length, 0);
  });

  it('takes them out of the member list, and ends their session', async () => {
    const roster = await api('/api/accounts', { token: ownerToken });
    assert.ok(!roster.body.users.some((u) => u.nickname === 'victim'));

    const theirs = await api('/api/accounts/me', { token: victimToken });
    assert.equal(theirs.status, 401, 'the session went with the row');
  });

  it('refuses one that is already gone', async () => {
    const res = await api(`/api/accounts/${victimId}/delete`, {
      method: 'POST', token: ownerToken,
    });
    assert.equal(res.status, 404);
  });

  it('FREES THE NICKNAME, and the new holder inherits nothing', async () => {
    const again = await api('/api/accounts/register', {
      method: 'POST', body: { nickname: 'victim', password: 'different1' },
    });
    assert.equal(again.status, 201);

    const history = await api(`/api/channels/${textChannelId}/messages`, { token: ownerToken });
    assert.equal(history.body.messages.filter((m) => m.nickname === 'victim').length, 0,
      'a reused name must not come with somebody else\'s words attached');
  });
});

// ---------------------------------------------------------------------------

describe('server settings', () => {
  it('start from the environment, with a default name', async () => {
    const res = await api('/api/server', { token: memberToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.server.name, 'Harmony');
    assert.equal(res.body.server.passwordRequired, false);
  });

  it('are not a member\'s to change', async () => {
    const res = await api('/api/server', {
      method: 'POST', body: { name: 'Mine Now' }, token: memberToken,
    });
    assert.equal(res.status, 403);
  });

  it('are not an admin\'s either', async () => {
    const res = await api('/api/server', {
      method: 'POST', body: { name: 'Mine Now' }, token: adminToken,
    });
    assert.equal(res.status, 403);
  });

  it('let the owner rename it, keeping what was typed', async () => {
    const res = await api('/api/server', {
      method: 'POST', body: { name: '  Galpao   18 ' }, token: ownerToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.server.name, 'Galpao 18');

    const seen = await api('/api/server', { token: memberToken });
    assert.equal(seen.body.server.name, 'Galpao 18');
  });

  it('RENAMING DOES NOT TOUCH THE PASSWORD', async () => {
    // An absent field and an empty string are different answers here.
    // Treating both as falsy would take the door off by omission.
    const was = (await api('/api/server', { token: ownerToken })).body.server;
    const res = await api('/api/server', {
      method: 'POST', body: { name: 'Still Here' }, token: ownerToken,
    });
    assert.equal(res.body.server.passwordRequired, was.passwordRequired);
  });

  it('say when the media relay is out of step', async () => {
    // This server booted open, so turning the password on is exactly the
    // case where MediaMTX keeps its boot-time stance until a restart.
    const res = await api('/api/server', {
      method: 'POST', body: { password: 'letmeinplease' }, token: ownerToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.server.passwordRequired, true);
    assert.equal(res.body.server.restartRequired, true,
      'saying so is better than hoping nobody notices');
  });

  it('CLOSE THE DOOR IMMEDIATELY, token or no token', async () => {
    const res = await api('/api/accounts', { token: ownerToken });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'password_required');
  });

  it('open it for the new password', async () => {
    const res = await api('/api/health', { password: 'letmeinplease' });
    assert.equal(res.body.passwordRequired, true);
    assert.equal(res.body.authenticated, true);
    assert.equal(res.body.name, 'Still Here');
  });

  it('refuse the wrong one', async () => {
    const res = await api('/api/accounts', { token: ownerToken, password: 'nope' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'bad_password');
  });

  it('and the owner can take the door off again', async () => {
    const res = await api('/api/server', {
      method: 'POST',
      body: { password: '' },
      token: ownerToken,
      password: 'letmeinplease',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.server.passwordRequired, false);
    assert.equal((await api('/api/accounts', { token: ownerToken })).status, 200);
  });

  it('SURVIVE A RESTART', async () => {
    // The whole point of storing them: the environment still says one
    // thing and the server has to keep saying the other.
    await stopHarmony();
    await startHarmony();
    const res = await api('/api/health');
    assert.equal(res.body.name, 'Still Here');
    assert.equal(res.body.passwordRequired, false);
  });
});

// ---------------------------------------------------------------------------

describe('the server logo', () => {
  // A real 1x1 PNG, so the content type and the bytes are both honest.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const upload = async (bytes, type, token) => {
    const res = await fetch(`${BASE}/api/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': type, Authorization: `Bearer ${token}` },
      body: bytes,
    });
    return { status: res.status, body: await res.json() };
  };
  let hash;

  before(async () => {
    const res = await upload(PNG, 'image/png', ownerToken);
    assert.equal(res.status, 201);
    hash = res.body.hash;
  });

  it('starts as none, and there is nothing to fetch', async () => {
    assert.equal((await api('/api/health')).body.logo, null);
    assert.equal((await api('/api/server/logo')).status, 404);
  });

  it('is the owner\'s to set, not an admin\'s or a member\'s', async () => {
    for (const token of [memberToken, adminToken]) {
      const res = await api('/api/server', { method: 'POST', body: { logo: hash }, token });
      assert.equal(res.status, 403);
    }
  });

  it('refuses something that is not an upload', async () => {
    const bad = await api('/api/server', { method: 'POST', body: { logo: 'nope' }, token: ownerToken });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'bad_hash');
    const missing = await api('/api/server', {
      method: 'POST', body: { logo: 'a'.repeat(64) }, token: ownerToken,
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, 'no_such_upload');
  });

  it('is set by the owner and reported by health as its hash', async () => {
    const res = await api('/api/server', { method: 'POST', body: { logo: hash }, token: ownerToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.server.logo, hash);
    assert.equal((await api('/api/health')).body.logo, hash);
  });

  it('SETTING IT DOES NOT TOUCH THE NAME OR THE PASSWORD', async () => {
    const res = await api('/api/server', { token: ownerToken });
    assert.equal(res.body.server.name, 'Still Here');
    assert.equal(res.body.server.passwordRequired, false);
  });

  it('is served with no login at all -- the server list asks without a session', async () => {
    const res = await fetch(`${BASE}/api/server/logo`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-harmony-hash'), hash);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  });

  it('BUT STILL BEHIND THE DOOR PASSWORD', async () => {
    await api('/api/server', { method: 'POST', body: { password: 'logodoor' }, token: ownerToken });
    try {
      assert.equal((await fetch(`${BASE}/api/server/logo`)).status, 401);
      // Nor does health hand out the hash to somebody without the key.
      assert.equal((await api('/api/health')).body.logo, undefined);
      const res = await fetch(`${BASE}/api/server/logo`, { headers: { 'x-harmony-password': 'logodoor' } });
      assert.equal(res.status, 200);
      assert.equal((await api('/api/health', { password: 'logodoor' })).body.logo, hash);
    } finally {
      await api('/api/server', {
        method: 'POST', body: { password: '' }, token: ownerToken, password: 'logodoor',
      });
    }
  });

  it('SURVIVES A RESTART', async () => {
    await stopHarmony();
    await startHarmony();
    assert.equal((await api('/api/health')).body.logo, hash);
    assert.equal((await fetch(`${BASE}/api/server/logo`)).status, 200);
  });

  it('can be taken away again', async () => {
    const res = await api('/api/server', { method: 'POST', body: { logo: null }, token: ownerToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.server.logo, null);
    assert.equal((await api('/api/health')).body.logo, null);
    assert.equal((await api('/api/server/logo')).status, 404);
  });
});
