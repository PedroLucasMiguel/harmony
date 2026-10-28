// Password recovery from three questions: how answers are compared, what is
// stored, who may set them, what a stranger can and cannot learn, how guessing
// is slowed, and that a recovered account really has its password changed.
//
//   node --test server/test/recovery.test.js

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import { normalizeAnswer } from '../src/recovery.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', 'src', 'index.js');

// Unique across the suite: node --test runs these files in PARALLEL.
const FAKE_MTX_PORT = 20012;
const HARMONY_PORT = 18096;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

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

const register = async (nickname, password = 'hunter22') => {
  const r = await api('/api/accounts/register', { method: 'POST', body: { nickname, password, ...(ownerKey && !ids.owner ? { ownerKey } : {}) } });
  assert.equal(r.status, 201, `register ${nickname}: ${JSON.stringify(r.body)}`);
  tokens[nickname] = r.body.token;
  ids[nickname] = r.body.user.id;
  ids.owner ??= r.body.user.id;
};

const ITEMS = [
  { question: 'What city were you born in?', answer: 'São Paulo' },
  { question: "What was your first pet's name?", answer: 'Rex' },
  { question: 'Which street did you grow up on?', answer: 'Rua  das Flores' },
];
const ANSWERS = ['sao paulo', 'rex', 'rua das flores'];

const setQuestions = (who, items = ITEMS, current = 'hunter22') =>
  api('/api/accounts/recovery', { method: 'POST', token: tokens[who], body: { current, items } });
const verify = (nickname, answers) =>
  api('/api/accounts/recovery/verify', { method: 'POST', body: { nickname, answers } });

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'harmony-recovery-'));
  await startFakeMediaMtx();
  await startHarmony();
  await register('alice');
  await register('bob');
  await register('carol');
  await register('dave');
});

after(async () => {
  child?.kill();
  fakeMtx?.close();
  await new Promise((r) => setTimeout(r, 200));
  rmSync(dataDir, { recursive: true, force: true });
});

describe('how an answer is compared', () => {
  it('ignores accents, case, spaces and punctuation', () => {
    const same = ['São Paulo', 'sao paulo', '  SAO   PAULO  ', 'Sao-Paulo!', '“São Paulo”', 'são\tpaulo'];
    for (const a of same) assert.equal(normalizeAnswer(a), 'sao paulo', a);
  });

  it('folds the other Latin accents too, and keeps digits', () => {
    assert.equal(normalizeAnswer('Ñandú  Çedilla Über'), 'nandu cedilla uber');
    assert.equal(normalizeAnswer(' 1,234 '), '1 234');
  });

  it('does not fold different Japanese letters together', () => {
    assert.notEqual(normalizeAnswer('か'), normalizeAnswer('が'));
  });

  it('is not fooled by composed versus decomposed accents', () => {
    assert.equal(normalizeAnswer('e\u0301'), normalizeAnswer('\u00e9'));
  });

  it('is empty for something with no letters in it', () => {
    assert.equal(normalizeAnswer('  ?!  '), '');
    assert.equal(normalizeAnswer(null), '');
  });
});

describe('setting the questions', () => {
  it('starts as not set up', async () => {
    const r = await api('/api/accounts/recovery', { token: tokens.alice });
    assert.deepEqual(r.body, { configured: false, questions: [] });
  });

  it('needs somebody signed in', async () => {
    const r = await api('/api/accounts/recovery', { method: 'POST', body: { current: 'hunter22', items: ITEMS } });
    assert.equal(r.status, 401);
  });

  it('needs the current password, so a borrowed session cannot plant answers', async () => {
    const r = await setQuestions('alice', ITEMS, 'wrong-password');
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'bad_credentials');
    assert.equal((await api('/api/accounts/recovery', { token: tokens.alice })).body.configured, false);
  });

  it('wants exactly three', async () => {
    assert.equal((await setQuestions('alice', ITEMS.slice(0, 2))).body.error, 'need_three');
    assert.equal((await setQuestions('alice', [...ITEMS, ITEMS[0]])).body.error, 'need_three');
  });

  it('refuses a question that is too short, or repeated however it is written', async () => {
    assert.equal((await setQuestions('alice', [{ question: 'Hi?', answer: 'x1' }, ITEMS[1], ITEMS[2]])).body.error, 'bad_question');
    const twice = [ITEMS[0], { question: '  WHAT city were YOU born in ', answer: 'abc' }, ITEMS[2]];
    assert.equal((await setQuestions('alice', twice)).body.error, 'repeated_question');
  });

  it('refuses an answer with nothing in it to compare', async () => {
    const empty = [ITEMS[0], { question: ITEMS[1].question, answer: ' ?! ' }, ITEMS[2]];
    assert.equal((await setQuestions('alice', empty)).body.error, 'bad_answer');
    const short = [ITEMS[0], { question: ITEMS[1].question, answer: 'a' }, ITEMS[2]];
    assert.equal((await setQuestions('alice', short)).body.error, 'bad_answer');
  });

  it('saves them, and says the questions but never the answers', async () => {
    const r = await setQuestions('alice');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.questions, ITEMS.map((i) => i.question));
    assert.equal(JSON.stringify(r.body).includes('Rex'), false);
    const again = await api('/api/accounts/recovery', { token: tokens.alice });
    assert.equal(again.body.configured, true);
    assert.deepEqual(again.body.questions, ITEMS.map((i) => i.question));
    assert.equal(JSON.stringify(again.body).toLowerCase().includes('rex'), false);
  });

  it('stores the answers as salted hashes, not as written', () => {
    const db = new DatabaseSync(join(dataDir, 'harmony.db'));
    const rows = db.prepare('SELECT question, answer_hash FROM recovery_answers WHERE user_id = ? ORDER BY slot').all(ids.alice);
    db.close();
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.match(row.answer_hash, /^scrypt\$/);
      for (const a of ['rex', 'sao paulo', 'flores', 'São']) assert.equal(row.answer_hash.toLowerCase().includes(a.toLowerCase()), false);
    }
    assert.equal(rows[0].question, ITEMS[0].question);
    // Two people with the same answer do not get the same hash.
    assert.equal(new Set(rows.map((r) => r.answer_hash)).size, 3);
  });
});

describe('asking for the questions, signed out', () => {
  it('shows them for an account that has them', async () => {
    const r = await api('/api/accounts/recovery/start', { method: 'POST', body: { nickname: 'Alice ' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.questions, ITEMS.map((i) => i.question));
  });

  it('says the same thing for no questions as for no such account', async () => {
    const none = await api('/api/accounts/recovery/start', { method: 'POST', body: { nickname: 'bob' } });
    const ghost = await api('/api/accounts/recovery/start', { method: 'POST', body: { nickname: 'nobody-here' } });
    assert.equal(none.status, 404);
    assert.equal(ghost.status, 404);
    assert.deepEqual(none.body, ghost.body);
    assert.equal(none.body.error, 'no_recovery');
  });
});

describe('answering', () => {
  it('accepts the answers however they are typed', async () => {
    for (const typed of [ANSWERS, ['São Paulo', 'REX', '  rua   das flores!! '], ['SÃO PAULO', 'Rex.', 'Rua das Flôres']]) {
      const r = await verify('alice', typed);
      assert.equal(r.status, 200, JSON.stringify(typed));
      assert.ok(r.body.resetToken);
    }
  });

  it('refuses when any one is wrong, without saying which', async () => {
    const wrongs = [['x1', 'rex', 'rua das flores'], ['sao paulo', 'x1', 'rua das flores'], ['sao paulo', 'rex', 'x1']];
    const bodies = [];
    for (const w of wrongs) {
      const r = await verify('alice', w);
      assert.equal(r.status, 401);
      assert.equal(r.body.error, 'wrong_answers');
      bodies.push(JSON.stringify({ ...r.body, attemptsLeft: 0 }));
    }
    assert.equal(new Set(bodies).size, 1);
    // A right set clears the count again.
    assert.equal((await verify('alice', ANSWERS)).status, 200);
  });

  it('refuses the wrong number of answers', async () => {
    assert.equal((await verify('alice', ['sao paulo', 'rex'])).status, 401);
    assert.equal((await verify('alice', 'sao paulo')).status, 401);
  });

  it('has nothing to offer an account without questions', async () => {
    const r = await verify('bob', ANSWERS);
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'no_recovery');
  });

  it('locks guessing after a few wrong tries, and a right answer does not get around it', async () => {
    await setQuestions('carol');
    let last;
    for (let i = 0; i < 5; i += 1) last = await verify('carol', ['no', 'no', 'no']);
    assert.equal(last.status, 429);
    assert.equal(last.body.error, 'locked_out');
    assert.ok(last.body.retryAfterSec > 0);
    const right = await verify('carol', ANSWERS);
    assert.equal(right.status, 429);
    assert.equal(right.body.resetToken, undefined);
  });
});

describe('choosing a new password', () => {
  it('needs a token from a right set of answers', async () => {
    const r = await api('/api/accounts/recovery/reset', { method: 'POST', body: { resetToken: 'made-up', password: 'a-new-password' } });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'reset_expired');
    const missing = await api('/api/accounts/recovery/reset', { method: 'POST', body: { password: 'a-new-password' } });
    assert.equal(missing.status, 401);
  });

  it('changes the password, ends the other sessions and signs the person in', async () => {
    const old = tokens.alice;
    const { body: { resetToken } } = await verify('alice', ANSWERS);

    const weak = await api('/api/accounts/recovery/reset', { method: 'POST', body: { resetToken, password: '123' } });
    assert.equal(weak.status, 400);
    assert.equal(weak.body.error, 'weak_password');

    // The same token still works: a short password is fixed, not started over.
    const r = await api('/api/accounts/recovery/reset', { method: 'POST', body: { resetToken, password: 'a-brand-new-one' } });
    assert.equal(r.status, 200);
    assert.ok(r.body.token);
    assert.equal(r.body.user.nickname, 'alice');
    assert.equal(JSON.stringify(r.body).includes('password_hash'), false);

    assert.equal((await api('/api/accounts/me', { token: old })).status, 401, 'the old session is gone');
    assert.equal((await api('/api/accounts/me', { token: r.body.token })).status, 200);
    const login = await api('/api/accounts/login', { method: 'POST', body: { nickname: 'alice', password: 'a-brand-new-one' } });
    assert.equal(login.status, 200);
    const oldLogin = await api('/api/accounts/login', { method: 'POST', body: { nickname: 'alice', password: 'hunter22' } });
    assert.equal(oldLogin.status, 401);
    tokens.alice = r.body.token;
  });

  it('is used up by choosing', async () => {
    const { body: { resetToken } } = await verify('alice', ANSWERS);
    assert.equal((await api('/api/accounts/recovery/reset', { method: 'POST', body: { resetToken, password: 'second-new-one' } })).status, 200);
    assert.equal((await api('/api/accounts/recovery/reset', { method: 'POST', body: { resetToken, password: 'third-new-one' } })).status, 401);
  });

  it('keeps the questions, so it can be done again', async () => {
    const r = await api('/api/accounts/recovery/start', { method: 'POST', body: { nickname: 'alice' } });
    assert.equal(r.status, 200);
  });
});

describe('clearing', () => {
  before(async () => {
    // Choosing a new password ended every session alice had.
    const login = await api('/api/accounts/login', { method: 'POST', body: { nickname: 'alice', password: 'second-new-one' } });
    tokens.alice = login.body.token;
  });

  it('needs the current password', async () => {
    const r = await api('/api/accounts/recovery/clear', { method: 'POST', token: tokens.alice, body: { current: 'nope-nope' } });
    assert.equal(r.status, 401);
    assert.equal((await api('/api/accounts/recovery', { token: tokens.alice })).body.configured, true);
  });

  it('takes them away, and recovery is then not possible for that account', async () => {
    // Alice's password is now the last one she chose.
    const r = await api('/api/accounts/recovery/clear', { method: 'POST', token: tokens.alice, body: { current: 'second-new-one' } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { configured: false, questions: [] });
    assert.equal((await api('/api/accounts/recovery/start', { method: 'POST', body: { nickname: 'alice' } })).status, 404);
    assert.equal((await verify('alice', ANSWERS)).status, 404);
  });

  it('setting again replaces all three', async () => {
    await api('/api/accounts/login', { method: 'POST', body: { nickname: 'alice', password: 'second-new-one' } });
    const items = ITEMS.map((i, n) => ({ question: `${i.question} (${n})`, answer: `answer ${n} here` }));
    assert.equal((await setQuestions('alice', items, 'second-new-one')).status, 200);
    assert.equal((await verify('alice', ANSWERS)).status, 401);
    assert.equal((await verify('alice', ['answer 0 here', 'Answer 1 Here', 'ANSWER 2 here'])).status, 200);
  });
});

describe('changing the password when signed in', () => {
  it('changes it with the current one, and hands back a session', async () => {
    const r = await api('/api/accounts/password', { method: 'POST', token: tokens.dave, body: { current: 'hunter22', password: 'dave-new-pass' } });
    assert.equal(r.status, 200);
    assert.ok(r.body.token);
    assert.equal((await api('/api/accounts/me', { token: tokens.dave })).status, 401);
    tokens.dave = r.body.token;
    assert.equal((await api('/api/accounts/login', { method: 'POST', body: { nickname: 'dave', password: 'dave-new-pass' } })).status, 200);
  });

  it('refuses a wrong current password and a weak new one', async () => {
    const wrong = await api('/api/accounts/password', { method: 'POST', token: tokens.dave, body: { current: 'nope-nope', password: 'whatever-new' } });
    assert.equal(wrong.status, 401);
    const weak = await api('/api/accounts/password', { method: 'POST', token: tokens.dave, body: { current: 'dave-new-pass', password: '12' } });
    assert.equal(weak.status, 400);
  });

  it('slows down guessing the current password with a borrowed session', async () => {
    let last;
    for (let i = 0; i < 12; i += 1) {
      last = await api('/api/accounts/password', { method: 'POST', token: tokens.bob, body: { current: `guess-${i}-x`, password: 'whatever-new' } });
      if (last.status === 429) break;
    }
    assert.equal(last.status, 429);
    // ...and that does not stop the real owner of the account signing in.
    const login = await api('/api/accounts/login', { method: 'POST', body: { nickname: 'bob', password: 'hunter22' } });
    assert.equal(login.status, 200);
  });
});
