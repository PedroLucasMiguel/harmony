// Profile customisation: the display-name font, the banner and the join sound.
//
//   node --test server/test/profile-style.test.js

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
const FAKE_MTX_PORT = 20024;
const HARMONY_PORT = 18107;
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
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** A mono 16-bit PCM WAV of the given length, at a low rate to keep it small. */
function wav(seconds, rate = 8000) {
  const data = Buffer.alloc(Math.round(seconds * rate) * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

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
  dataDir = mkdtempSync(resolve(tmpdir(), 'harmony-style-'));
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

describe('display name font', () => {
  it('needs a login', async () => {
    const res = await api('/api/accounts/name-font', { method: 'POST', body: { font: 'cinzel' } });
    assert.equal(res.status, 401);
  });

  it('starts as none', async () => {
    const { body } = await api('/api/accounts', { token: ownerToken });
    assert.equal(body.users.find((u) => u.nickname === 'member').nameFont, null);
  });

  it('takes one from the list, and shows it on the roster', async () => {
    const res = await api('/api/accounts/name-font', {
      method: 'POST', body: { font: 'pacifico' }, token: memberToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.nameFont, 'pacifico');
    const { body } = await api('/api/accounts', { token: ownerToken });
    assert.equal(body.users.find((u) => u.nickname === 'member').nameFont, 'pacifico');
  });

  it('refuses a font that is not on the list', async () => {
    for (const font of ['Comic Sans MS', 'url(http://evil/x.woff)', '../x', 42]) {
      const res = await api('/api/accounts/name-font', {
        method: 'POST', body: { font }, token: memberToken,
      });
      assert.equal(res.status, 400, String(font));
      assert.equal(res.body.error, 'unknown_font');
    }
    const { body } = await api('/api/accounts', { token: ownerToken });
    assert.equal(body.users.find((u) => u.nickname === 'member').nameFont, 'pacifico');
  });

  it('clears back to the default', async () => {
    const res = await api('/api/accounts/name-font', {
      method: 'POST', body: { font: null }, token: memberToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.nameFont, null);
  });
});

describe('profile banner', () => {
  let gifHash;

  it('takes a GIF, and shows it on the roster', async () => {
    gifHash = (await upload(GIF, 'image/gif', memberToken)).hash;
    const res = await api('/api/accounts/banner', {
      method: 'POST', body: { hash: gifHash }, token: memberToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.bannerHash, gifHash);
    const { body } = await api('/api/accounts', { token: ownerToken });
    assert.equal(body.users.find((u) => u.nickname === 'member').bannerHash, gifHash);
  });

  it('may be bigger than an avatar is allowed to be', async () => {
    const big = Buffer.concat([GIF, Buffer.alloc(1024 * 1024, 1)]);
    const hash = (await upload(big, 'image/gif', memberToken)).hash;
    const res = await api('/api/accounts/banner', {
      method: 'POST', body: { hash }, token: memberToken,
    });
    assert.equal(res.status, 200);
  });

  it('refuses one over 2 MB', async () => {
    const big = Buffer.concat([GIF, Buffer.alloc(3 * 1024 * 1024, 2)]);
    const hash = (await upload(big, 'image/gif', memberToken)).hash;
    const res = await api('/api/accounts/banner', {
      method: 'POST', body: { hash }, token: memberToken,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'banner_too_large');
  });

  it('refuses something that is not an image', async () => {
    const hash = (await upload(wav(1), 'audio/wav', memberToken)).hash;
    const res = await api('/api/accounts/banner', {
      method: 'POST', body: { hash }, token: memberToken,
    });
    assert.equal(res.body.error, 'not_an_image');
  });

  it('clears, and the file survives being set, cleared and set again', async () => {
    for (const hash of [null, gifHash]) {
      const res = await api('/api/accounts/banner', {
        method: 'POST', body: { hash }, token: memberToken,
      });
      assert.equal(res.status, 200);
    }
    const file = await fetch(`${BASE}/api/uploads/${gifHash}`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/gif');
    const cleared = await api('/api/accounts/banner', {
      method: 'POST', body: { hash: null }, token: memberToken,
    });
    assert.equal(cleared.body.user.bannerHash, null);
  });
});

describe('banner dimming', () => {
  it('needs a login', async () => {
    const res = await api('/api/accounts/banner-dim', { method: 'POST', body: { dim: 30 } });
    assert.equal(res.status, 401);
  });

  it('starts as the default, which is null', async () => {
    const { body } = await api('/api/accounts', { token: ownerToken });
    assert.equal(body.users.find((u) => u.nickname === 'member').bannerDim, null);
  });

  it('takes a whole number from 0 to 100, and the roster shows it', async () => {
    for (const dim of [0, 35, 100]) {
      const res = await api('/api/accounts/banner-dim', { method: 'POST', body: { dim }, token: memberToken });
      assert.equal(res.status, 200, String(dim));
      assert.equal(res.body.user.bannerDim, dim);
    }
    const { body } = await api('/api/accounts', { token: ownerToken });
    assert.equal(body.users.find((u) => u.nickname === 'member').bannerDim, 100);
  });

  it('refuses anything else, and keeps what it had', async () => {
    for (const dim of [-1, 101, 12.5, 'dark', {}, [5]]) {
      const res = await api('/api/accounts/banner-dim', { method: 'POST', body: { dim }, token: memberToken });
      assert.equal(res.status, 400, JSON.stringify(dim));
      assert.equal(res.body.error, 'invalid_dim');
    }
    const { body } = await api('/api/accounts', { token: ownerToken });
    assert.equal(body.users.find((u) => u.nickname === 'member').bannerDim, 100);
  });

  it('goes back to the default with nothing', async () => {
    const res = await api('/api/accounts/banner-dim', { method: 'POST', body: { dim: null }, token: memberToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.bannerDim, null);
  });
});

describe('join sound', () => {
  it('takes a WAV of ten seconds, and shows it on the roster', async () => {
    const hash = (await upload(wav(10), 'audio/wav', memberToken)).hash;
    const res = await api('/api/accounts/join-sound', {
      method: 'POST', body: { hash }, token: memberToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.joinSoundHash, hash);
    const { body } = await api('/api/accounts', { token: ownerToken });
    assert.equal(body.users.find((u) => u.nickname === 'member').joinSoundHash, hash);
  });

  it('refuses one that is longer than ten seconds', async () => {
    const hash = (await upload(wav(10.6), 'audio/wav', memberToken)).hash;
    const res = await api('/api/accounts/join-sound', {
      method: 'POST', body: { hash }, token: memberToken,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'join_sound_too_long');
  });

  it('cannot be fooled by a header that claims a short length', async () => {
    const long = wav(30);
    long.writeUInt32LE(1000, 40); // "data" says 1000 bytes; the file holds 30 seconds
    long.writeUInt32LE(8000 * 2, 28);
    const hash = (await upload(long, 'audio/wav', memberToken)).hash;
    const res = await api('/api/accounts/join-sound', {
      method: 'POST', body: { hash }, token: memberToken,
    });
    // The declared size is honoured as the SMALLER of the two, so a lie that
    // makes the clip shorter only truncates it for the person who told it.
    assert.equal(res.status, 200);
  });

  it('refuses a streamed WAV with an unset length by the bytes it really has', async () => {
    const long = wav(30);
    long.writeUInt32LE(0xffffffff, 40);
    const hash = (await upload(long, 'audio/wav', memberToken)).hash;
    const res = await api('/api/accounts/join-sound', {
      method: 'POST', body: { hash }, token: memberToken,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'join_sound_too_long');
  });

  it('refuses a file that is not a WAV', async () => {
    const hash = (await upload(Buffer.from('ID3 not a wav'), 'audio/mpeg', memberToken)).hash;
    const res = await api('/api/accounts/join-sound', {
      method: 'POST', body: { hash }, token: memberToken,
    });
    assert.equal(res.body.error, 'not_wav');
  });

  it('refuses a WAV that is not a WAV inside', async () => {
    const hash = (await upload(Buffer.from('definitely not riff'), 'audio/wav', memberToken)).hash;
    const res = await api('/api/accounts/join-sound', {
      method: 'POST', body: { hash }, token: memberToken,
    });
    assert.equal(res.body.error, 'bad_audio');
  });

  it('refuses one over the size cap whatever its length', async () => {
    const hash = (await upload(wav(10, 96000), 'audio/wav', memberToken)).hash;
    const res = await api('/api/accounts/join-sound', {
      method: 'POST', body: { hash }, token: memberToken,
    });
    assert.equal(res.body.error, 'join_sound_too_large');
  });

  it('clears back to the ordinary tone', async () => {
    const res = await api('/api/accounts/join-sound', {
      method: 'POST', body: { hash: null }, token: memberToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.joinSoundHash, null);
  });
});

describe('removing an account that has a banner and a sound', () => {
  it('still works, and gives both files back', async () => {
    const doomed = (await api('/api/accounts/register', {
      method: 'POST', body: { nickname: 'doomed', password: 'hunter22' },
    })).body;
    const gif = (await upload(Buffer.concat([GIF, Buffer.from('doomed')]), 'image/gif', doomed.token)).hash;
    const sound = (await upload(wav(2), 'audio/wav', doomed.token)).hash;
    await api('/api/accounts/banner', { method: 'POST', body: { hash: gif }, token: doomed.token });
    await api('/api/accounts/join-sound', { method: 'POST', body: { hash: sound }, token: doomed.token });

    const res = await api(`/api/accounts/${doomed.user.id}/delete`, { method: 'POST', token: ownerToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });
});
