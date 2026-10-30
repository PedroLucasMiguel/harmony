// How far each person has read each channel: the read mark, the counts, and
// what a client is told when it connects.
//
//   node --test server/test/reads.test.js

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
const FAKE_MTX_PORT = 20030;
const HARMONY_PORT = 18130;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

let fakeMtx;
let child;
let dataDir;
let ownerKey = null;
let boss;
let ana;
let channelId;
let lockedId;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const say = (token, body, id = channelId) => api(`/api/channels/${id}/messages`, { method: 'POST', body: { body }, token });
const unread = async (token, id = channelId) => (await api('/api/unread', { token })).body.channels.find((c) => c.channelId === id);

/** Connect over the socket the way a client does, and keep what the server pushes. */
async function connect(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${HARMONY_PORT}/ws`);
  const frames = [];
  let helloReply;
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.type === 'hello-ok') helloReply = msg;
    else frames.push(msg);
  });
  await new Promise((r) => ws.addEventListener('open', r));
  ws.send(JSON.stringify({ type: 'hello', token, rid: '1' }));
  for (let i = 0; i < 50 && !helloReply; i += 1) await sleep(40);
  return { ws, frames, hello: helloReply };
}

before(async () => {
  dataDir = mkdtempSync(resolve(tmpdir(), 'harmony-reads-'));
  await startFakeMediaMtx();
  await startHarmony();

  boss = (await api('/api/accounts/register', {
    method: 'POST', body: { nickname: 'boss', password: 'hunter22', ownerKey },
  })).body.token;
  ana = (await api('/api/accounts/register', {
    method: 'POST', body: { nickname: 'ana', password: 'hunter22' },
  })).body.token;

  const channels = (await api('/api/channels', { token: boss })).body.channels;
  channelId = channels.find((c) => c.kind === 'text').id;
  lockedId = (await api('/api/channels', {
    method: 'POST', body: { kind: 'text', name: 'secrets', password: 'letmein' }, token: boss,
  })).body.channel.id;
});

after(async () => {
  await stopHarmony();
  await new Promise((done) => fakeMtx.close(done));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('unread counts', () => {
  it('start at zero for somebody who has just arrived, whatever was said before', async () => {
    await say(boss, 'old news 1');
    await say(boss, 'old news 2');
    const entry = await unread(ana);
    assert.equal(entry.unread, 0);
    assert.equal(entry.mentions, 0);
  });

  it('count what others write afterwards, and not what you write yourself', async () => {
    await say(boss, 'one');
    await say(boss, 'two');
    await say(ana, 'mine');
    const entry = await unread(ana);
    // Posting is reading: ana's own message moved her mark past 'one' and 'two' as well.
    assert.equal(entry.unread, 0);

    await say(boss, 'three');
    await say(boss, 'four');
    assert.equal((await unread(ana)).unread, 2);
  });

  it('count the mentions among them: by name, by @everyone, and not other people\'s', async () => {
    await say(boss, 'hey @ana');
    await say(boss, 'nothing to do with you, @boss');
    await say(boss, '@everyone listen');
    const entry = await unread(ana);
    assert.equal(entry.unread, 5);
    assert.equal(entry.mentions, 2);
  });

  it('are cleared by reading, and the mark never goes back', async () => {
    const newest = (await unread(ana)).lastId;
    const read = await api(`/api/channels/${channelId}/read`, { method: 'POST', body: { upTo: newest }, token: ana });
    assert.equal(read.status, 200);
    assert.equal(read.body.unread, 0);
    assert.equal(read.body.lastReadId, newest);

    // A late report of an older message does not bring the old ones back.
    const late = await api(`/api/channels/${channelId}/read`, { method: 'POST', body: { upTo: 1 }, token: ana });
    assert.equal(late.body.lastReadId, newest);
    assert.equal(late.body.unread, 0);
  });

  it('cannot be pushed past the newest message', async () => {
    const read = await api(`/api/channels/${channelId}/read`, { method: 'POST', body: { upTo: 999999 }, token: ana });
    const entry = await unread(ana);
    assert.equal(read.body.lastReadId, entry.lastId);
    await say(boss, 'after');
    assert.equal((await unread(ana)).unread, 1, 'a message that arrives later is still news');
  });

  it('are kept apart for each person', async () => {
    assert.equal((await unread(boss)).unread, 0);
    await say(ana, 'ping @boss');
    assert.equal((await unread(boss)).mentions, 1);
  });
});

describe('who is told about what', () => {
  it('a channel behind a password is not counted for somebody who has not unlocked it', async () => {
    await say(boss, 'secret stuff', lockedId);
    const list = (await api('/api/unread', { token: ana })).body.channels;
    assert.ok(!list.some((c) => c.channelId === lockedId));
    const read = await api(`/api/channels/${lockedId}/read`, { method: 'POST', body: {}, token: ana });
    assert.equal(read.status, 404);
  });

  it('an unknown channel is a 404, and reading needs a login', async () => {
    assert.equal((await api('/api/channels/99999/read', { method: 'POST', body: {}, token: ana })).status, 404);
    assert.equal((await api('/api/unread')).status, 401);
  });
});

describe('connecting', () => {
  it('the hello says what is unread', async () => {
    await say(boss, 'while you were away');
    const { ws, hello } = await connect(ana);
    const entry = hello.unread.find((c) => c.channelId === channelId);
    // Ana's last message in this channel moved her mark, so only what came after it is news.
    assert.equal(entry.unread, 1, JSON.stringify(entry));
    ws.close();
  });

  it('reading on one device clears the others', async () => {
    const other = await connect(ana);
    const newest = (await unread(ana)).lastId;
    await api(`/api/channels/${channelId}/read`, { method: 'POST', body: { upTo: newest }, token: ana });
    await sleep(300);
    const pushed = other.frames.find((f) => f.type === 'channel:read');
    assert.ok(pushed, 'the second connection was told');
    assert.equal(pushed.channelId, channelId);
    assert.equal(pushed.unread, 0);
    other.ws.close();
  });
});
