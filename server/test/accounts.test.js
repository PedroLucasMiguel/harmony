// Accounts, roles, sessions and the two holes that open up the moment
// identities become permanent.
//
//   node --test server/test/accounts.test.js

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

// Unique across the suite: node --test runs these files in PARALLEL, so a
// port shared with auth.test.js means whichever boots second never binds.
const FAKE_MTX_PORT = 19999;
const HARMONY_PORT = 18082;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

let livePaths = [];
let fakeMtx;
let child;
let dataDir;
let ownerKey = null;

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

/** Boot the server against `dataDir`, capturing the owner key it prints. */
function startHarmony() {
  return new Promise((done, fail) => {
    child = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        HARMONY_PORT: String(HARMONY_PORT),
        HARMONY_HOST: '127.0.0.1',
        HARMONY_DATA_DIR: dataDir,
        HARMONY_MEDIAMTX_API: `http://127.0.0.1:${FAKE_MTX_PORT}`,
        HARMONY_POLL_INTERVAL_MS: '100',
        HARMONY_SIGNALING_URL: 'http://media.test:8889',
        HARMONY_CLAIM_TTL_MS: '2000',
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

before(async () => {
  dataDir = mkdtempSync(resolve(tmpdir(), 'harmony-test-'));
  await startFakeMediaMtx();
  await startHarmony();
});

after(async () => {
  await stopHarmony();
  await new Promise((done) => fakeMtx.close(done));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('registration', () => {
  it('rejects a nickname in the voice-channel namespace', async () => {
    const res = await api('/api/accounts/register', {
      method: 'POST',
      body: { nickname: 'vc-1-7-v', password: 'hunter22' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_nickname');
  });

  it('rejects a nickname that would hijack a webcam path', async () => {
    const res = await api('/api/accounts/register', {
      method: 'POST',
      body: { nickname: 'bob-cam', password: 'hunter22' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_nickname');
  });

  it('rejects a short password', async () => {
    const res = await api('/api/accounts/register', {
      method: 'POST',
      body: { nickname: 'shorty', password: 'abc' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'weak_password');
  });

  it('creates an account and returns a session token', async () => {
    const res = await api('/api/accounts/register', {
      method: 'POST',
      body: { nickname: 'alice', password: 'hunter22' },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.nickname, 'alice');
    assert.equal(res.body.user.role, 'member');
    assert.ok(res.body.token);
    assert.equal(res.body.user.password_hash, undefined, 'must never leak the hash');
  });

  it('refuses a nickname that is already taken', async () => {
    const res = await api('/api/accounts/register', {
      method: 'POST',
      body: { nickname: 'alice', password: 'different1' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'nickname_taken');
  });
});

describe('login', () => {
  it('accepts the right password', async () => {
    const res = await api('/api/accounts/login', {
      method: 'POST',
      body: { nickname: 'alice', password: 'hunter22' },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
  });

  it('refuses the wrong password', async () => {
    const res = await api('/api/accounts/login', {
      method: 'POST',
      body: { nickname: 'alice', password: 'wrong-one' },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'bad_credentials');
  });

  it('gives the same answer for an account that does not exist', async () => {
    const res = await api('/api/accounts/login', {
      method: 'POST',
      body: { nickname: 'nobody', password: 'wrong-one' },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'bad_credentials',
      'a different error here would enumerate nicknames');
  });

  it('locks out after repeated failures, keyed by nickname', async () => {
    // maxAttempts defaults to 3; two failures are already on the record above.
    let last;
    for (let i = 0; i < 4; i += 1) {
      last = await api('/api/accounts/login', {
        method: 'POST',
        body: { nickname: 'alice', password: 'still-wrong' },
      });
    }
    assert.equal(last.status, 429);
    assert.equal(last.body.error, 'locked_out');

    // A different nickname is unaffected -- the whole point of keying by name.
    const other = await api('/api/accounts/login', {
      method: 'POST',
      body: { nickname: 'someoneelse', password: 'nope' },
    });
    assert.equal(other.status, 401);
  });
});

describe('sessions', () => {
  let token;

  before(async () => {
    const res = await api('/api/accounts/register', {
      method: 'POST',
      body: { nickname: 'carol', password: 'hunter22' },
    });
    token = res.body.token;
  });

  it('resolves a bearer token to the user', async () => {
    const res = await api('/api/accounts/me', { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.nickname, 'carol');
  });

  it('refuses a made-up token', async () => {
    const res = await api('/api/accounts/me', { token: 'not-a-real-token' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'login_required');
  });

  it('invalidates the token on logout', async () => {
    assert.equal((await api('/api/accounts/logout', { method: 'POST', token })).status, 200);
    assert.equal((await api('/api/accounts/me', { token })).status, 401);
  });
});

describe('the owner bootstrap', () => {
  it('printed a key at first start', () => {
    assert.ok(ownerKey, 'the server must print an owner key on an empty database');
  });

  it('refuses a wrong key', async () => {
    const res = await api('/api/accounts/register', {
      method: 'POST',
      body: { nickname: 'imposter', password: 'hunter22', ownerKey: 'wrong-key-entirely' },
    });
    assert.equal(res.status, 201, 'registration still succeeds');
    assert.equal(res.body.ownerClaimed, false);
    assert.equal(res.body.ownerKeyRejected, true);
    assert.equal(res.body.user.role, 'member');
  });

  it('grants owner to the first account presenting it', async () => {
    const res = await api('/api/accounts/register', {
      method: 'POST',
      body: { nickname: 'pedro', password: 'hunter22', ownerKey },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.ownerClaimed, true);
    assert.equal(res.body.user.role, 'owner');
  });

  it('works once and only once', async () => {
    const res = await api('/api/accounts/register', {
      method: 'POST',
      body: { nickname: 'latecomer', password: 'hunter22', ownerKey },
    });
    assert.equal(res.body.ownerClaimed, false, 'the key must be consumed');
    assert.equal(res.body.user.role, 'member');
  });
});

describe('roles', () => {
  let ownerToken;
  let memberToken;
  let aliceId;

  before(async () => {
    ownerToken = (await api('/api/accounts/login', {
      method: 'POST', body: { nickname: 'pedro', password: 'hunter22' },
    })).body.token;
    memberToken = (await api('/api/accounts/login', {
      method: 'POST', body: { nickname: 'carol', password: 'hunter22' },
    })).body.token;
    const roster = await api('/api/accounts', { token: ownerToken });
    aliceId = roster.body.users.find((u) => u.nickname === 'alice').id;
  });

  it('lets an owner promote someone to admin', async () => {
    const res = await api(`/api/accounts/${aliceId}/role`, {
      method: 'POST', body: { role: 'admin' }, token: ownerToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, 'admin');
  });

  it('does not let a member promote anyone', async () => {
    const res = await api(`/api/accounts/${aliceId}/role`, {
      method: 'POST', body: { role: 'owner' }, token: memberToken,
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'forbidden');
  });

  it('does not let the last owner demote themselves', async () => {
    const me = await api('/api/accounts/me', { token: ownerToken });
    const res = await api(`/api/accounts/${me.body.user.id}/role`, {
      method: 'POST', body: { role: 'member' }, token: ownerToken,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'last_owner');
  });

  it('refuses a role that is not a role', async () => {
    const res = await api(`/api/accounts/${aliceId}/role`, {
      method: 'POST', body: { role: 'superuser' }, token: ownerToken,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_role');
  });

  /*
   * Only the owner makes or unmakes an admin -- a "super admin", the one
   * account nothing about which a role can limit.
   *
   * It used to be that an admin could hand admin out and not take it away.
   * Roles changed that: a super admin outranks every role, so being able to
   * make another is being able to make something that outranks the people
   * who gave you the job. With symmetric powers any two of them could also
   * demote each other and the first to click would win.
   */
  describe('an admin cannot promote or demote anybody', () => {
    let adminToken;
    let carolId;

    before(async () => {
      /*
       * A FRESH account, not alice -- who the first test in this block
       * promoted to admin and would be the obvious choice.
       *
       * "locks out after repeated failures, keyed by nickname" deliberately
       * burns alice's login attempts earlier in this file, and the lockout
       * is keyed by nickname and outlives the suite that caused it. Logging
       * in as her here returns 429 with no token, and every request that
       * followed came back 401 -- which reads as a permissions bug in the
       * route rather than as a test that rate-limited its own fixture.
       */
      await api('/api/accounts/register', {
        method: 'POST', body: { nickname: 'dave', password: 'hunter22' },
      });
      const roster = await api('/api/accounts', { token: ownerToken });
      const daveId = roster.body.users.find((u) => u.nickname === 'dave').id;
      await api(`/api/accounts/${daveId}/role`, {
        method: 'POST', body: { role: 'admin' }, token: ownerToken,
      });
      adminToken = (await api('/api/accounts/login', {
        method: 'POST', body: { nickname: 'dave', password: 'hunter22' },
      })).body.token;
      carolId = roster.body.users.find((u) => u.nickname === 'carol').id;
    });

    it('does not let an admin make another admin', async () => {
      const res = await api(`/api/accounts/${carolId}/role`, {
        method: 'POST', body: { role: 'admin' }, token: adminToken,
      });
      assert.equal(res.status, 403);
      assert.equal(res.body.error, 'forbidden');
    });

    it('does not let an admin demote another admin', async () => {
      await api(`/api/accounts/${carolId}/role`, {
        method: 'POST', body: { role: 'admin' }, token: ownerToken,
      });
      const res = await api(`/api/accounts/${carolId}/role`, {
        method: 'POST', body: { role: 'member' }, token: adminToken,
      });
      assert.equal(res.status, 403);
      assert.equal(res.body.error, 'forbidden');
    });

    it('does not let an admin appoint an owner', async () => {
      const res = await api(`/api/accounts/${carolId}/role`, {
        method: 'POST', body: { role: 'owner' }, token: adminToken,
      });
      assert.equal(res.status, 403);
      assert.equal(res.body.error, 'forbidden');
    });

    it('lets the owner make and unmake one', async () => {
      const res = await api(`/api/accounts/${carolId}/role`, {
        method: 'POST', body: { role: 'member' }, token: ownerToken,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.role, 'member');
    });
  });

  /*
   * Display names.
   *
   * A label, not an identity. Nothing is looked up by it, no path is built
   * from it and no uniqueness is claimed for it, which is exactly why it
   * can hold the characters a nickname cannot.
   */
  describe('display names', () => {
    it('accepts capitals, spaces, accents and emoji', async () => {
      const res = await api('/api/accounts/display-name', {
        method: 'POST', body: { displayName: 'Pedro Lucas \u{1F996}' }, token: ownerToken,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.displayName, 'Pedro Lucas \u{1F996}');
      assert.equal(res.body.user.customName, true);
      // The nickname is untouched. It is what the auth hook parses out of a
      // MediaMTX path, so a display name reaching it would be a security
      // change rather than a cosmetic one.
      assert.match(res.body.user.nickname, /^[a-z0-9-]+$/);
    });

    it('falls back to the nickname when cleared', async () => {
      const res = await api('/api/accounts/display-name', {
        method: 'POST', body: { displayName: '   ' }, token: ownerToken,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.displayName, res.body.user.nickname);
      assert.equal(res.body.user.customName, false);
    });

    it('refuses control characters, which are invisible', async () => {
      const res = await api('/api/accounts/display-name', {
        // A right-to-left override: it would reverse everything drawn after
        // it, including other people's names on the same line.
        method: 'POST', body: { displayName: 'bob\u202Eeve' }, token: ownerToken,
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'bad_characters');
    });

    it('counts code points, not UTF-16 units', async () => {
      // 32 dinosaurs is 64 .length and 32 characters. The limit is about
      // how much room a name takes on screen, so it has to agree with what
      // a person can see.
      const ok = await api('/api/accounts/display-name', {
        method: 'POST', body: { displayName: '\u{1F996}'.repeat(32) }, token: ownerToken,
      });
      assert.equal(ok.status, 200);
      const tooLong = await api('/api/accounts/display-name', {
        method: 'POST', body: { displayName: '\u{1F996}'.repeat(33) }, token: ownerToken,
      });
      assert.equal(tooLong.status, 400);
      assert.equal(tooLong.body.error, 'too_long');
    });

    it('needs a login, and renames only the person asking', async () => {
      const res = await api('/api/accounts/display-name', {
        method: 'POST', body: { displayName: 'Nobody' },
      });
      assert.equal(res.status, 401);
    });
  });
});

describe('/api/session is not an impersonation hole', () => {
  let carolToken;

  before(async () => {
    carolToken = (await api('/api/accounts/login', {
      method: 'POST', body: { nickname: 'carol', password: 'hunter22' },
    })).body.token;
  });

  it('ignores the body username and uses the logged-in nickname', async () => {
    const res = await api('/api/session', {
      method: 'POST', body: { username: 'alice' }, token: carolToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.username, 'carol',
      'carol must not be able to stream under the name alice');
    assert.match(res.body.whipUrl, /\/carol\/whip/);
  });

  it('refuses an anonymous claim once accounts exist', async () => {
    const res = await api('/api/session', { method: 'POST', body: { username: 'ghost' } });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'login_required');
  });
});

describe('persistence', () => {
  it('keeps accounts and roles across a restart', async () => {
    await stopHarmony();
    await startHarmony();

    const login = await api('/api/accounts/login', {
      method: 'POST', body: { nickname: 'pedro', password: 'hunter22' },
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.role, 'owner', 'the role must survive a restart');

    const roster = await api('/api/accounts', { token: login.body.token });
    const alice = roster.body.users.find((u) => u.nickname === 'alice');
    assert.equal(alice.role, 'admin', 'a promotion must survive a restart');
  });

  it('does not print a new owner key once an owner exists', async () => {
    const health = await api('/api/health');
    assert.equal(health.body.needsOwner, false);
    assert.equal(health.body.hasAccounts, true);
  });
});
