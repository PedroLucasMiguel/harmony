// The optional server password, its escalating lockout, and the watch token
// that stops the password being a front door with the back door left open.
//
//   node --test server/test/

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { LoginLimiter, secretsMatch } from '../src/auth.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', 'src', 'index.js');

const FAKE_MTX_PORT = 19998;
const HARMONY_PORT = 18081;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;
const PASSWORD = 'correct horse battery staple';

let fakeMtx;
let child;
let livePaths = [];

// ---------------------------------------------------------------------------
// The limiter on its own, driven by a fake clock so an hour costs no time.
// ---------------------------------------------------------------------------

describe('login lockout', () => {
  /** @returns {[LoginLimiter, (ms: number) => void]} */
  function makeLimiter() {
    let now = 1_000_000;
    const limiter = new LoginLimiter({
      maxAttempts: 3,
      lockoutMinutes: [5, 10, 30, 60],
      now: () => now,
    });
    return [limiter, (ms) => (now += ms)];
  }

  const MINUTE = 60_000;

  it('allows two wrong answers, then locks on the third', () => {
    const [limiter] = makeLimiter();
    assert.equal(limiter.fail('ip').locked, false);
    assert.equal(limiter.fail('ip').locked, false);
    const third = limiter.fail('ip');
    assert.equal(third.locked, true);
    assert.equal(third.retryAfterSec, 5 * 60);
    assert.equal(limiter.check('ip').allowed, false);
  });

  it('counts down and reopens when the lockout expires', () => {
    const [limiter, advance] = makeLimiter();
    for (let i = 0; i < 3; i++) limiter.fail('ip');

    advance(4 * MINUTE);
    const midway = limiter.check('ip');
    assert.equal(midway.allowed, false);
    assert.equal(midway.retryAfterSec, 60, 'a minute still to wait');

    advance(1 * MINUTE + 1);
    assert.equal(limiter.check('ip').allowed, true);
  });

  it('escalates 5 -> 10 -> 30 -> 60 minutes and then stays at 60', () => {
    const [limiter, advance] = makeLimiter();
    const expected = [5, 10, 30, 60, 60, 60];

    for (const minutes of expected) {
      limiter.fail('ip');
      limiter.fail('ip');
      const locked = limiter.fail('ip');
      assert.equal(locked.locked, true);
      assert.equal(
        locked.retryAfterSec,
        minutes * 60,
        `expected a ${minutes} minute lockout at this rung`,
      );
      advance(minutes * MINUTE + 1);
    }
  });

  it('reports how many tries are left before the next lockout', () => {
    const [limiter] = makeLimiter();
    assert.equal(limiter.fail('ip').attemptsLeft, 2);
    assert.equal(limiter.fail('ip').attemptsLeft, 1);
  });

  it('a correct password clears the count and the escalation', () => {
    const [limiter, advance] = makeLimiter();
    for (let i = 0; i < 3; i++) limiter.fail('ip'); // -> 5 min
    advance(5 * MINUTE + 1);

    limiter.succeed('ip');

    // Back to the first rung rather than the second.
    limiter.fail('ip');
    limiter.fail('ip');
    assert.equal(limiter.fail('ip').retryAfterSec, 5 * 60);
  });

  it('locks each address separately', () => {
    const [limiter] = makeLimiter();
    for (let i = 0; i < 3; i++) limiter.fail('a');
    assert.equal(limiter.check('a').allowed, false);
    assert.equal(limiter.check('b').allowed, true, 'one address must not lock out another');
  });

  it('does not grow without bound under a spray of one-shot attempts', () => {
    const [limiter, advance] = makeLimiter();
    for (let i = 0; i < 200; i++) limiter.fail(`ip-${i}`);
    advance(61 * MINUTE);
    limiter.fail('trigger-a-sweep');
    assert.ok(limiter.size < 200, `expected old entries to be swept, held ${limiter.size}`);
  });
});

describe('constant-time secret comparison', () => {
  it('matches a secret with itself', () => {
    assert.equal(secretsMatch('hunter2', 'hunter2'), true);
  });

  it('rejects a wrong secret, including one that is merely a prefix', () => {
    assert.equal(secretsMatch('hunter', 'hunter2'), false);
    assert.equal(secretsMatch('hunter22', 'hunter2'), false);
  });

  it('rejects empty input rather than treating it as a match', () => {
    assert.equal(secretsMatch('', ''), false);
    assert.equal(secretsMatch(undefined, 'hunter2'), false);
  });

  it('survives inputs of wildly different length', () => {
    // Hashing first is what makes this safe: timingSafeEqual throws on a length
    // mismatch, and that throw would leak the real password's length.
    assert.doesNotThrow(() => secretsMatch('x'.repeat(4096), 'hunter2'));
    assert.equal(secretsMatch('x'.repeat(4096), 'hunter2'), false);
  });
});

// ---------------------------------------------------------------------------
// The same thing over HTTP, against a real server process.
// ---------------------------------------------------------------------------

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
        HARMONY_PASSWORD: PASSWORD,
        // One rung, kept short, so the HTTP tests do not wait five minutes.
        HARMONY_LOCKOUT_MINUTES: '1',
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

const withPassword = (password) => (password ? { 'X-Harmony-Password': password } : {});
const get = (path, password) => fetch(`${BASE}${path}`, { headers: withPassword(password) });
const post = (path, body, password) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...withPassword(password) },
    body: JSON.stringify(body),
  });

describe('password-protected server', () => {
  before(async () => {
    await startFakeMediaMtx();
    await startHarmony();
    await new Promise((r) => setTimeout(r, 350));
  });

  after(() => {
    child?.kill();
    fakeMtx?.close();
  });

  it('answers /api/health without a password, so the client can ask whether it needs one', async () => {
    const res = await get('/api/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.passwordRequired, true);
    assert.equal(body.authenticated, false);
  });

  it('withholds the details from an unauthenticated health check', async () => {
    const body = await (await get('/api/health')).json();
    assert.equal(body.signalingBase, undefined);
    assert.equal(body.liveStreams, undefined);

    const authed = await (await get('/api/health', PASSWORD)).json();
    assert.equal(authed.authenticated, true);
    assert.equal(authed.signalingBase, 'http://media.test:8889');
  });

  it('refuses the stream list without a password', async () => {
    const res = await get('/api/streams');
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'password_required');
  });

  it('refuses a session without a password', async () => {
    const res = await post('/api/session', { username: 'alice' });
    assert.equal(res.status, 401);
  });

  it('does not spend an attempt on a request that offers no password', async () => {
    // The client polls the stream list from the moment it opens. If that
    // counted, a user could lock themselves out of their own server in three
    // refreshes without ever typing a wrong password.
    for (let i = 0; i < 6; i++) {
      const res = await get('/api/streams');
      assert.equal(res.status, 401, 'expected 401, never 429');
    }
    // Two real guesses are still available, proving nothing was counted.
    assert.equal((await get('/api/streams', 'nope-1')).status, 401);
    assert.equal((await get('/api/streams', 'nope-2')).status, 401);
    assert.equal((await get('/api/streams', PASSWORD)).status, 200, 'and the right one still works');
  });

  it('allows everything once the password is right', async () => {
    const streams = await get('/api/streams', PASSWORD);
    assert.equal(streams.status, 200);

    const session = await post('/api/session', { username: 'alice' }, PASSWORD);
    assert.equal(session.status, 200);
    assert.equal((await session.json()).role, 'broadcaster');
  });

  it('accepts the password in the body as well as the header, for curl', async () => {
    const res = await post('/api/session', { username: 'bob', password: PASSWORD });
    assert.equal(res.status, 200);
  });

  it('puts a watch token in the WHEP URL', async () => {
    const { streams } = await (await get('/api/streams', PASSWORD)).json();
    livePaths = [
      { name: 'carla', ready: true, readyTime: new Date().toISOString(), tracks: ['H264'], readers: [] },
    ];
    await new Promise((r) => setTimeout(r, 350));

    const body = await (await get('/api/streams', PASSWORD)).json();
    const carla = body.streams.find((s) => s.username === 'carla');
    assert.ok(carla, 'expected carla to be listed');
    assert.match(carla.whepUrl, /\/carla\/whep\?token=.+/);
    assert.ok(Array.isArray(streams));
  });

  it('refuses a MediaMTX read that has no watch token', async () => {
    // This is the hole a password on the API alone would leave: MediaMTX
    // listens on its own port, so a viewer could skip the control server.
    const res = await post('/mediamtx/auth', { action: 'read', path: 'carla', query: '' });
    assert.equal(res.status, 401);
  });

  it('allows a MediaMTX read carrying the token it handed out', async () => {
    const body = await (await get('/api/streams', PASSWORD)).json();
    const query = new URL(body.streams[0].whepUrl).search.slice(1);

    const res = await post('/mediamtx/auth', { action: 'read', path: 'carla', query });
    assert.equal(res.status, 204);
  });

  it('locks out after three wrong passwords and says for how long', async () => {
    // A fresh limiter: the successful calls above cleared this address.
    assert.equal((await get('/api/streams', 'wrong-1')).status, 401);
    assert.equal((await get('/api/streams', 'wrong-2')).status, 401);

    const locked = await get('/api/streams', 'wrong-3');
    assert.equal(locked.status, 429);
    const body = await locked.json();
    assert.equal(body.error, 'locked_out');
    assert.ok(body.retryAfterSec > 0 && body.retryAfterSec <= 60, `got ${body.retryAfterSec}`);
    assert.equal(locked.headers.get('retry-after'), String(body.retryAfterSec));
  });

  it('rejects even the CORRECT password while locked out', async () => {
    // Otherwise the lockout would be trivially skippable by whoever eventually
    // guesses right, which is precisely the case it exists to slow down.
    const res = await get('/api/streams', PASSWORD);
    assert.equal(res.status, 429);
  });
});
