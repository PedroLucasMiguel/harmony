// Who a message notified, for the list under a click on an @.
//
//   node --test server/test/notified.test.js

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
const FAKE_MTX_PORT = 20031;
const HARMONY_PORT = 18131;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

let fakeMtx;
let child;
let dataDir;
let ownerKey = null;
const tokens = {};
const ids = {};
let channelId;
let devRole;

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

function stopHarmony() {
  return new Promise((done) => {
    if (!child || child.exitCode !== null) return done();
    child.once('exit', () => done());
    child.kill('SIGTERM');
    setTimeout(() => { child.kill('SIGKILL'); done(); }, 4000).unref();
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
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* empty */ }
  return { status: res.status, body: json };
};

const say = async (as, body, id = channelId) => (await api(`/api/channels/${id}/messages`, { method: 'POST', body: { body }, token: tokens[as] })).body.message;
const notified = async (message, as = 'boss') => (await api(`/api/messages/${message.id}/notified`, { token: tokens[as] })).body;
const sorted = (list) => [...list].sort((a, b) => a - b);

before(async () => {
  dataDir = mkdtempSync(resolve(tmpdir(), 'harmony-notified-'));
  await startFakeMediaMtx();
  await startHarmony();

  for (const name of ['boss', 'ana', 'bob', 'cy']) {
    const res = await api('/api/accounts/register', {
      method: 'POST', body: { nickname: name, password: 'hunter22', ...(name === 'boss' ? { ownerKey } : {}) },
    });
    tokens[name] = res.body.token;
    ids[name] = res.body.user.id;
  }
  channelId = (await api('/api/channels', { token: tokens.boss })).body.channels.find((c) => c.kind === 'text').id;

  devRole = (await api('/api/roles', { method: 'POST', body: { name: 'Dev', color: '#3fb984' }, token: tokens.boss })).body.role;
  // ana and bob are Dev; cy is not.
  for (const name of ['ana', 'bob']) {
    await api(`/api/accounts/${ids[name]}/roles`, { method: 'POST', body: { roles: [devRole.id] }, token: tokens.boss });
  }
});

after(async () => {
  await stopHarmony();
  await new Promise((done) => fakeMtx.close(done));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('who a message notified', () => {
  it('is the person named', async () => {
    const m = await say('boss', 'hello @ana');
    const n = await notified(m);
    assert.deepEqual(n.notified, [ids.ana]);
    assert.deepEqual(n.userIds, [ids.ana]);
    assert.equal(n.everyone, false);
  });

  it('is everybody who holds a role that is named', async () => {
    const m = await say('boss', '@dev look at this');
    const n = await notified(m);
    assert.deepEqual(sorted(n.notified), sorted([ids.ana, ids.bob]));
    assert.deepEqual(n.roleIds, [devRole.id]);
  });

  it('is everybody for @everyone, except the one who wrote it', async () => {
    const m = await say('boss', '@everyone dinner');
    const n = await notified(m);
    assert.equal(n.everyone, true);
    assert.deepEqual(sorted(n.notified), sorted([ids.ana, ids.bob, ids.cy]));
  });

  it('counts a person once however they are reached', async () => {
    const m = await say('boss', '@ana @dev @everyone');
    const n = await notified(m);
    assert.deepEqual(sorted(n.notified), sorted([ids.ana, ids.bob, ids.cy]));
  });

  it('leaves out the author, even if they hold the role', async () => {
    const m = await say('ana', '@dev anyone?');
    assert.deepEqual((await notified(m)).notified, [ids.bob]);
  });

  it('is nobody for a message that names nobody, or somebody who is not there', async () => {
    const m = await say('boss', 'no names here, and @nobody neither');
    assert.deepEqual((await notified(m)).notified, []);
  });

  it('leaves out people who cannot read the channel', async () => {
    // A channel for Dev only: cy cannot see it, so @everyone there reaches ana and bob.
    const created = await api('/api/channels', {
      method: 'POST', body: { kind: 'text', name: 'devs', roles: [devRole.id] }, token: tokens.boss,
    });
    const secret = created.body.channel.id;
    const m = await say('boss', '@everyone in here', secret);
    const n = await notified(m);
    assert.deepEqual(sorted(n.notified), sorted([ids.ana, ids.bob]));
  });

  it('is not for somebody who cannot read the message', async () => {
    const created = await api('/api/channels', {
      method: 'POST', body: { kind: 'text', name: 'devs-two', roles: [devRole.id] }, token: tokens.boss,
    });
    const m = await say('boss', 'psst @ana', created.body.channel.id);
    const outsider = await api(`/api/messages/${m.id}/notified`, { token: tokens.cy });
    assert.equal(outsider.status, 404);
    assert.equal((await api('/api/messages/999999/notified', { token: tokens.boss })).status, 404);
  });
});
