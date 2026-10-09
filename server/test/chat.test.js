// Messages, pins, uploads and search.
//
//   node --test server/test/chat.test.js

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  Chat, Emojis, ftsPhrase, mediaTypeOf, mentionsIn, MAX_UPLOAD_BYTES,
} from '../src/chat.js';
import { mintMediaKey, verifyMediaKey } from '../src/media-keys.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', 'src', 'index.js');

// Unique across the suite: node --test runs these files in PARALLEL.
const FAKE_MTX_PORT = 20002;
const HARMONY_PORT = 18085;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

let fakeMtx;
let child;
let dataDir;
let ownerKey = null;
let ownerToken;
let memberToken;
let textChannelId;
let lockedChannelId;

function startFakeMediaMtx() {
  return new Promise((done) => {
    fakeMtx = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ itemCount: 0, pageCount: 0, items: [] }));
    });
    fakeMtx.listen(FAKE_MTX_PORT, '127.0.0.1', done);
  });
}

function startHarmony(extraEnv = {}) {
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
        ...extraEnv,
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
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* binary or empty */ }
  return { status: res.status, body: json, text, headers: res.headers };
};

/** A tiny but genuinely valid PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

before(async () => {
  dataDir = mkdtempSync(resolve(tmpdir(), 'harmony-chat-'));
  await startFakeMediaMtx();
  await startHarmony();

  ownerToken = (await api('/api/accounts/register', {
    method: 'POST', body: { nickname: 'boss', password: 'hunter22', ownerKey },
  })).body.token;
  memberToken = (await api('/api/accounts/register', {
    method: 'POST', body: { nickname: 'member', password: 'hunter22' },
  })).body.token;

  const channels = (await api('/api/channels', { token: ownerToken })).body.channels;
  textChannelId = channels.find((c) => c.kind === 'text').id;

  lockedChannelId = (await api('/api/channels', {
    method: 'POST',
    body: { kind: 'text', name: 'secrets', password: 'letmein' },
    token: ownerToken,
  })).body.channel.id;
});

after(async () => {
  await stopHarmony();
  await new Promise((done) => fakeMtx.close(done));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// ---------------------------------------------------------------------------

describe('the FTS5 phrase escaper', () => {
  // Every one of these throws "unterminated string" or is silently parsed as
  // query syntax if passed to MATCH raw.
  it('neutralises query syntax and quotes', () => {
    assert.equal(ftsPhrase('a"b(c'), '"a""b(c"');
    assert.equal(ftsPhrase('NOT bob'), '"NOT bob"');
    assert.equal(ftsPhrase('*'), '"*"');
  });
});

describe('the upload allowlist', () => {
  it('maps allowed types to a media category', () => {
    assert.equal(mediaTypeOf('image/png'), 'image');
    assert.equal(mediaTypeOf('IMAGE/PNG'), 'image');
    assert.equal(mediaTypeOf('video/mp4'), 'video');
    assert.equal(mediaTypeOf('text/html'), null, 'html must never be storable');
    assert.equal(mediaTypeOf('application/javascript'), null);
  });
});

describe('messages', () => {
  it('posts and reads back', async () => {
    const posted = await api(`/api/channels/${textChannelId}/messages`, {
      method: 'POST', body: { body: 'hello everyone' }, token: memberToken,
    });
    assert.equal(posted.status, 201);
    assert.equal(posted.body.message.nickname, 'member');
    assert.equal(posted.body.message.body, 'hello everyone');

    const history = await api(`/api/channels/${textChannelId}/messages`, { token: ownerToken });
    assert.equal(history.status, 200);
    assert.ok(history.body.messages.some((m) => m.body === 'hello everyone'));
  });

  it('refuses an empty message with no attachment', async () => {
    const res = await api(`/api/channels/${textChannelId}/messages`, {
      method: 'POST', body: { body: '   ' }, token: memberToken,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'empty_message');
  });

  it('hides a locked channel from somebody without a grant', async () => {
    const res = await api(`/api/channels/${lockedChannelId}/messages`, { token: memberToken });
    assert.equal(res.status, 404, 'no grant means the channel does not exist to you');
  });

  it('pins and unpins', async () => {
    const posted = await api(`/api/channels/${textChannelId}/messages`, {
      method: 'POST', body: { body: 'pin me' }, token: memberToken,
    });
    const id = posted.body.message.id;

    await api(`/api/messages/${id}/pin`, { method: 'POST', body: { pinned: true }, token: ownerToken });
    let history = await api(`/api/channels/${textChannelId}/messages`, { token: ownerToken });
    assert.ok(history.body.pinned.some((m) => m.id === id));

    await api(`/api/messages/${id}/pin`, { method: 'POST', body: { pinned: false }, token: ownerToken });
    history = await api(`/api/channels/${textChannelId}/messages`, { token: ownerToken });
    assert.ok(!history.body.pinned.some((m) => m.id === id));
  });

  it("lets you delete your own but not someone else's", async () => {
    const mine = await api(`/api/channels/${textChannelId}/messages`, {
      method: 'POST', body: { body: 'my message' }, token: memberToken,
    });
    const theirs = await api(`/api/channels/${textChannelId}/messages`, {
      method: 'POST', body: { body: 'boss message' }, token: ownerToken,
    });

    const forbidden = await api(`/api/messages/${theirs.body.message.id}/delete`, {
      method: 'POST', token: memberToken,
    });
    assert.equal(forbidden.status, 403);

    const own = await api(`/api/messages/${mine.body.message.id}/delete`, {
      method: 'POST', token: memberToken,
    });
    assert.equal(own.status, 200);

    // ...and an admin may delete anybody's.
    const byAdmin = await api(`/api/messages/${theirs.body.message.id}/delete`, {
      method: 'POST', token: ownerToken,
    });
    assert.equal(byAdmin.status, 200);
  });
});

describe('uploads', () => {
  let hash;

  it('accepts a PNG and returns its hash', async () => {
    const res = await api('/api/uploads', {
      method: 'POST', raw: PNG, contentType: 'image/png', token: memberToken,
    });
    assert.equal(res.status, 201);
    assert.match(res.body.hash, /^[0-9a-f]{64}$/);
    assert.equal(res.body.bytes, PNG.length);
    hash = res.body.hash;
  });

  it('deduplicates the same bytes', async () => {
    const res = await api('/api/uploads', {
      method: 'POST', raw: PNG, contentType: 'image/png', token: memberToken,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.hash, hash);
    assert.equal(res.body.deduplicated, true);
  });

  it('refuses a type that is not on the allowlist', async () => {
    const res = await api('/api/uploads', {
      method: 'POST', raw: Buffer.from('<script>alert(1)</script>'),
      contentType: 'text/html', token: memberToken,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'empty_file',
      'express.raw does not even parse a type outside the allowlist');
  });

  it('serves the file back with its stored type and nosniff', async () => {
    const res = await fetch(`${BASE}/api/uploads/${hash}`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(bytes, PNG, 'what comes back must be what went in');
  });

  it('refuses an unauthenticated download', async () => {
    const res = await fetch(`${BASE}/api/uploads/${hash}`);
    assert.equal(res.status, 401);
  });

  it('refuses a hash that is not a hash', async () => {
    const res = await api('/api/uploads/..%2F..%2Fetc%2Fpasswd', { token: memberToken });
    assert.equal(res.status, 400);
  });

  it('serves it by media key, with no headers at all', async () => {
    const issued = await api('/api/media-key', { token: memberToken });
    assert.equal(issued.status, 200);
    assert.match(issued.body.key, /^m1\./);

    const res = await fetch(`${BASE}/api/media/${hash}?k=${encodeURIComponent(issued.body.key)}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  });

  it('refuses a media download with no key or a forged one', async () => {
    assert.equal((await fetch(`${BASE}/api/media/${hash}`)).status, 401);
    const forged = mintMediaKey('not the server secret', 1);
    assert.equal((await fetch(`${BASE}/api/media/${hash}?k=${forged}`)).status, 401);
  });

  it('refuses a media key without a login', async () => {
    assert.equal((await api('/api/media-key')).status, 401);
  });

  it('attaches to a message and records its media type', async () => {
    const res = await api(`/api/channels/${textChannelId}/messages`, {
      method: 'POST', body: { body: 'look at this', attachmentHash: hash }, token: memberToken,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.message.mediaType, 'image');
    assert.equal(res.body.message.attachmentHash, hash);
  });

  it('refuses an attachment that was never uploaded', async () => {
    const res = await api(`/api/channels/${textChannelId}/messages`, {
      method: 'POST', body: { body: 'nope', attachmentHash: 'f'.repeat(64) }, token: memberToken,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'no_such_upload');
  });

  it('still refuses an oversized JSON body on a normal route', async () => {
    // Pinned so nobody "fixes" the upload route by loosening the global limit.
    const res = await api(`/api/channels/${textChannelId}/messages`, {
      method: 'POST', body: { body: 'x'.repeat(20_000) }, token: memberToken,
    });
    assert.equal(res.status, 413);
  });

  it('has a per-file cap well under the disk quota', () => {
    assert.ok(MAX_UPLOAD_BYTES <= 25 * 1024 * 1024);
  });
});

describe('search', () => {
  before(async () => {
    for (const body of ['the quick brown fox', 'a screenshot of the build', 'unrelated chatter']) {
      await api(`/api/channels/${textChannelId}/messages`, {
        method: 'POST', body: { body }, token: memberToken,
      });
    }
  });

  it('matches a substring, not just a whole word', async () => {
    const res = await api(`/api/channels/${textChannelId}/search?q=creensho`, { token: memberToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.mode, 'fts');
    assert.ok(res.body.results.some((m) => m.body.includes('screenshot')),
      'trigram search is what makes "creensho" find "screenshot"');
  });

  it('ignores case', async () => {
    const res = await api(`/api/channels/${textChannelId}/search?q=QUICK`, { token: memberToken });
    assert.ok(res.body.results.some((m) => m.body.includes('quick')));
  });

  it('finds by author', async () => {
    const res = await api(`/api/channels/${textChannelId}/search?q=member`, { token: memberToken });
    assert.ok(res.body.results.length > 0);
  });

  it('finds by media type', async () => {
    const res = await api(`/api/channels/${textChannelId}/search?q=image`, { token: memberToken });
    assert.ok(res.body.results.some((m) => m.mediaType === 'image'));
  });

  it('falls back to LIKE under three characters, instead of silently finding nothing', async () => {
    // The trap: trigram returns ZERO rows for a 1-2 character query and does
    // not error, so without the fallback this looks like "no results".
    const res = await api(`/api/channels/${textChannelId}/search?q=fo`, { token: memberToken });
    assert.equal(res.body.mode, 'like');
    assert.ok(res.body.results.some((m) => m.body.includes('fox')));
  });

  it('survives input that is FTS5 query syntax', async () => {
    for (const q of ['a"b(c', '100%', '*', 'NOT bob', '^he']) {
      const res = await api(
        `/api/channels/${textChannelId}/search?q=${encodeURIComponent(q)}`,
        { token: memberToken },
      );
      assert.equal(res.status, 200, `query ${JSON.stringify(q)} must not 500`);
    }
  });
});

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

describe('what may be reacted with', () => {
  it('takes an emoji, and a :name: for a custom one', () => {
    assert.equal(Chat.reactionKey('\u{1F44D}'), '\u{1F44D}');
    assert.equal(Chat.reactionKey(':shrug:'), ':shrug:');
  });

  it('KEEPS THE ZERO WIDTH JOINER', () => {
    // \p{C} is the obvious control-character test and it is wrong here: ZWJ
    // is Cf, and it is what holds together every profession and family
    // emoji anybody would actually use.
    const dev = '\u{1F468}\u200D\u{1F4BB}';
    assert.equal(Chat.reactionKey(dev), dev, 'a joined emoji must survive');
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    assert.equal(Chat.reactionKey(family), family);
  });

  it('refuses a right-to-left override, which would reverse the row', () => {
    assert.equal(Chat.reactionKey('\u202Eabc'), null);
  });

  it('refuses a paragraph pretending to be a reaction', () => {
    assert.equal(Chat.reactionKey('x'.repeat(40)), null);
    assert.equal(Chat.reactionKey(''), null);
    assert.equal(Chat.reactionKey('   '), null);
  });
});

describe('reactions', () => {
  let messageId;

  before(async () => {
    messageId = (await api(`/api/channels/${textChannelId}/messages`, {
      method: 'POST', body: { body: 'react to me' }, token: ownerToken,
    })).body.message.id;
  });

  it('a new message arrives with an empty strip, not without one', async () => {
    const posted = await api(`/api/channels/${textChannelId}/messages`, {
      method: 'POST', body: { body: 'fresh' }, token: memberToken,
    });
    assert.deepEqual(posted.body.message.reactions, [],
      'a client that has to cope with undefined here will cope with it wrongly');
  });

  it('adds one', async () => {
    const res = await api(`/api/messages/${messageId}/react`, {
      method: 'POST', body: { emoji: '\u{1F44D}' }, token: ownerToken,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.reactions.map((r) => [r.emoji, r.count]), [['\u{1F44D}', 1]]);
  });

  it('SUMS UP when somebody else adds the same one', async () => {
    const res = await api(`/api/messages/${messageId}/react`, {
      method: 'POST', body: { emoji: '\u{1F44D}' }, token: memberToken,
    });
    assert.equal(res.body.reactions.length, 1, 'one entry, not two');
    assert.equal(res.body.reactions[0].count, 2);
    assert.equal(res.body.reactions[0].userIds.length, 2);
  });

  it('counts the same person once, however many times they click', async () => {
    for (let i = 0; i < 3; i += 1) {
      await api(`/api/messages/${messageId}/react`, {
        method: 'POST', body: { emoji: '\u{1F44D}' }, token: memberToken,
      });
    }
    const res = await api(`/api/channels/${textChannelId}/messages`, { token: ownerToken });
    const message = res.body.messages.find((m) => m.id === messageId);
    assert.equal(message.reactions[0].count, 2,
      'the primary key is what makes the count a COUNT');
  });

  it('keeps a different emoji as its own entry, in the order it was first used',
    async () => {
      await api(`/api/messages/${messageId}/react`, {
        method: 'POST', body: { emoji: '\u{1F389}' }, token: ownerToken,
      });
      const res = await api(`/api/channels/${textChannelId}/messages`, { token: memberToken });
      const message = res.body.messages.find((m) => m.id === messageId);
      assert.deepEqual(message.reactions.map((r) => r.emoji), ['\u{1F44D}', '\u{1F389}']);
    });

  it('takes it back, and only yours', async () => {
    const res = await api(`/api/messages/${messageId}/react`, {
      method: 'POST', body: { emoji: '\u{1F44D}', on: false }, token: memberToken,
    });
    assert.equal(res.body.reactions.find((r) => r.emoji === '\u{1F44D}').count, 1);
  });

  it('drops the entry entirely when the last one goes', async () => {
    await api(`/api/messages/${messageId}/react`, {
      method: 'POST', body: { emoji: '\u{1F389}', on: false }, token: ownerToken,
    });
    const res = await api(`/api/channels/${textChannelId}/messages`, { token: ownerToken });
    const message = res.body.messages.find((m) => m.id === messageId);
    assert.deepEqual(message.reactions.map((r) => r.emoji), ['\u{1F44D}']);
  });

  it('refuses a reaction on a channel you cannot read', async () => {
    // Locked AFTER the message was posted, which is the only way to get a
    // message into a password channel over plain HTTP -- the grant is
    // issued on the realtime socket. It is also the real-world case: the
    // one where somebody could read it yesterday.
    const room = (await api('/api/channels', {
      method: 'POST', body: { kind: 'text', name: 'soonlocked' }, token: ownerToken,
    })).body.channel.id;
    const hidden = (await api(`/api/channels/${room}/messages`, {
      method: 'POST', body: { body: 'secret' }, token: ownerToken,
    })).body.message.id;

    const before = await api(`/api/messages/${hidden}/react`, {
      method: 'POST', body: { emoji: '\u{1F44D}' }, token: memberToken,
    });
    assert.equal(before.status, 200, 'readable while the channel is open');

    await api(`/api/channels/${room}`, {
      method: 'POST', body: { password: 'letmein' }, token: ownerToken,
    });
    const after = await api(`/api/messages/${hidden}/react`, {
      method: 'POST', body: { emoji: '\u{1F389}' }, token: memberToken,
    });
    assert.equal(after.status, 404, 'and gone the moment it is not');
  });

  it('refuses nonsense', async () => {
    const res = await api(`/api/messages/${messageId}/react`, {
      method: 'POST', body: { emoji: 'x'.repeat(40) }, token: ownerToken,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'bad_emoji');
  });

  it('TAKES ITS REACTIONS WITH IT WHEN THE MESSAGE GOES', async () => {
    const doomed = (await api(`/api/channels/${textChannelId}/messages`, {
      method: 'POST', body: { body: 'briefly here' }, token: ownerToken,
    })).body.message.id;
    await api(`/api/messages/${doomed}/react`, {
      method: 'POST', body: { emoji: '\u{1F44D}' }, token: memberToken,
    });
    const gone = await api(`/api/messages/${doomed}/delete`, {
      method: 'POST', token: ownerToken,
    });
    assert.equal(gone.status, 200);

    // The point: the cascade has to fire, or the next message to be given
    // this id inherits somebody else's reactions.
    const res = await api(`/api/messages/${doomed}/react`, {
      method: 'POST', body: { emoji: '\u{1F44D}' }, token: ownerToken,
    });
    assert.equal(res.status, 404);
  });
});

// ---------------------------------------------------------------------------
// Custom emoji
// ---------------------------------------------------------------------------

describe('custom emoji names', () => {
  it('fold to something that can be a :trigger:', () => {
    assert.equal(Emojis.normalizeName('  Big Shrug '), 'big_shrug');
    assert.equal(Emojis.normalizeName(':party-parrot:'), 'party_parrot');
    assert.equal(Emojis.normalizeName('OK'), 'ok');
  });

  it('refuse anything the trigger could not match', () => {
    assert.equal(Emojis.normalizeName('a'), null, 'one character is not a name');
    assert.equal(Emojis.normalizeName('x'.repeat(33)), null);
    assert.equal(Emojis.normalizeName('with.dot'), null);
    assert.equal(Emojis.normalizeName(''), null);
  });
});

describe('custom emoji', () => {
  let hash;
  let emojiId;

  before(async () => {
    hash = (await api('/api/uploads', {
      method: 'POST', raw: PNG, contentType: 'image/png', token: memberToken,
    })).body.hash;
  });

  it('A MEMBER MAY ADD ONE', async () => {
    // Deliberately looser than the soundpad, which is admin-only: a clip
    // plays out loud in everyone's ears, an emoji waits in a picker.
    const res = await api('/api/emojis', {
      method: 'POST', body: { name: 'Shrug', hash }, token: memberToken,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.emoji.name, 'shrug');
    emojiId = res.body.emoji.id;
  });

  it('lists it for everybody', async () => {
    const res = await api('/api/emojis', { token: ownerToken });
    assert.ok(res.body.emojis.some((e) => e.name === 'shrug'));
  });

  it('refuses a name already taken', async () => {
    const res = await api('/api/emojis', {
      method: 'POST', body: { name: ':shrug:', hash }, token: ownerToken,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'name_taken',
      'one name must mean one picture, or a message reads differently for two people');
  });

  it('refuses audio dressed up as an emoji', async () => {
    const wav = (await api('/api/uploads', {
      method: 'POST', raw: Buffer.alloc(64, 7), contentType: 'audio/wav', token: ownerToken,
    })).body.hash;
    const res = await api('/api/emojis', {
      method: 'POST', body: { name: 'noise', hash: wav }, token: ownerToken,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'not_an_image');
  });

  it('does not let somebody else delete it', async () => {
    const outsider = (await api('/api/accounts/register', {
      method: 'POST', body: { nickname: 'stranger', password: 'hunter22' },
    })).body.token;
    const res = await api(`/api/emojis/${emojiId}/delete`, {
      method: 'POST', token: outsider,
    });
    assert.equal(res.status, 403);
  });

  it('lets an admin delete it', async () => {
    const res = await api(`/api/emojis/${emojiId}/delete`, {
      method: 'POST', token: ownerToken,
    });
    assert.equal(res.status, 200);
    assert.equal((await api('/api/emojis', { token: ownerToken })).body.emojis.length, 0);
  });

  it('LEAVES REACTIONS THAT USED IT ALONE', async () => {
    // The reaction stores ":name:", not a foreign key, exactly so that
    // tidying up the picker cannot silently delete other people's
    // reactions. The count stays; the picture falls back to the text.
    const message = (await api(`/api/channels/${textChannelId}/messages`, {
      method: 'POST', body: { body: 'before the purge' }, token: ownerToken,
    })).body.message.id;
    const added = (await api('/api/emojis', {
      method: 'POST', body: { name: 'doomed', hash }, token: ownerToken,
    })).body.emoji;
    await api(`/api/messages/${message}/react`, {
      method: 'POST', body: { emoji: ':doomed:' }, token: memberToken,
    });
    await api(`/api/emojis/${added.id}/delete`, { method: 'POST', token: ownerToken });

    const res = await api(`/api/channels/${textChannelId}/messages`, { token: ownerToken });
    const row = res.body.messages.find((m) => m.id === message);
    assert.deepEqual(row.reactions.map((r) => [r.emoji, r.count]), [[':doomed:', 1]]);
  });
});

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

describe('editing a message', () => {
  let mine;

  before(async () => {
    mine = (await api(`/api/channels/${textChannelId}/messages`, {
      method: 'POST', body: { body: 'frist post' }, token: memberToken,
    })).body.message.id;
  });

  it('changes the words and marks when', async () => {
    const res = await api(`/api/messages/${mine}/edit`, {
      method: 'POST', body: { body: 'first post' }, token: memberToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.message.body, 'first post');
    assert.ok(res.body.message.editedAt > 0, 'a message that changed must say so');
  });

  it('IS NOT AN ADMIN POWER, unlike deleting', async () => {
    // Deleting somebody's message removes it and everyone can see it is
    // gone. Editing it would put words in their mouth under their name.
    const res = await api(`/api/messages/${mine}/edit`, {
      method: 'POST', body: { body: 'actually I love mondays' }, token: ownerToken,
    });
    assert.equal(res.status, 403);
  });

  it('FOLLOWS THE MESSAGE INTO THE SEARCH INDEX', async () => {
    // The quiet half: an index still answering with the old words means
    // search can show text the message no longer contains.
    const stale = await api(`/api/channels/${textChannelId}/search?q=frist`, {
      token: memberToken,
    });
    assert.equal(stale.body.results.length, 0, 'the old words must be gone');

    const fresh = await api(`/api/channels/${textChannelId}/search?q=first post`, {
      token: memberToken,
    });
    assert.ok(fresh.body.results.some((m) => m.id === mine), 'and the new ones findable');
  });

  it('refuses to empty a message that has nothing else in it', async () => {
    const res = await api(`/api/messages/${mine}/edit`, {
      method: 'POST', body: { body: '   ' }, token: memberToken,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'empty_message');
  });

  it('leaves editedAt alone when nothing actually changed', async () => {
    const before_ = (await api(`/api/channels/${textChannelId}/messages`, {
      token: memberToken,
    })).body.messages.find((m) => m.id === mine);

    const res = await api(`/api/messages/${mine}/edit`, {
      method: 'POST', body: { body: 'first post' }, token: memberToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.message.editedAt, before_.editedAt,
      'resaving the same text is not an edit');
  });

  it('refuses one that does not exist', async () => {
    const res = await api('/api/messages/999999/edit', {
      method: 'POST', body: { body: 'hello' }, token: memberToken,
    });
    assert.equal(res.status, 404);
  });
});

// ---------------------------------------------------------------------------
// Attachment names
// ---------------------------------------------------------------------------

describe('the name an attachment is saved under', () => {
  it('keeps an ordinary one', () => {
    assert.equal(Chat.cleanFilename('holiday photo.png'), 'holiday photo.png');
  });

  it('KEEPS ONLY THE LAST SEGMENT, on either convention', () => {
    // The client picks where a download goes; the name must never be able
    // to choose for it.
    assert.equal(Chat.cleanFilename('../../.ssh/authorized_keys'), 'authorized_keys');
    assert.equal(Chat.cleanFilename('C:@@Windows@@System32@@evil.dll'.replaceAll('@@', '\\')),
      'evil.dll');
    assert.equal(Chat.cleanFilename('..'), null, 'nothing left is no name at all');
  });

  it('strips control characters', () => {
    assert.equal(Chat.cleanFilename('ok@NL@name.txt'.replace('@NL@', '\n')), 'okname.txt');
  });

  it('gives nothing back for nothing', () => {
    assert.equal(Chat.cleanFilename(''), null);
    assert.equal(Chat.cleanFilename('   '), null);
    assert.equal(Chat.cleanFilename(null), null);
  });
});

describe('posting an attachment with a name', () => {
  it('stores it, and hands it back', async () => {
    const hash = (await api('/api/uploads', {
      method: 'POST', raw: PNG, contentType: 'image/png', token: ownerToken,
    })).body.hash;

    const posted = await api(`/api/channels/${textChannelId}/messages`, {
      method: 'POST',
      body: { body: 'look', attachmentHash: hash, attachmentName: 'furret.png' },
      token: ownerToken,
    });
    assert.equal(posted.status, 201);
    assert.equal(posted.body.message.attachmentName, 'furret.png');
  });

  it('IS A PROPERTY OF THE POST, NOT OF THE FILE', async () => {
    // The same bytes deduplicate to one row in uploads, and two people who
    // post them may well call the file different things.
    const hash = (await api('/api/uploads', {
      method: 'POST', raw: PNG, contentType: 'image/png', token: memberToken,
    })).body.hash;
    const posted = await api(`/api/channels/${textChannelId}/messages`, {
      method: 'POST',
      body: { body: 'same bytes', attachmentHash: hash, attachmentName: 'ferret.png' },
      token: memberToken,
    });
    assert.equal(posted.body.message.attachmentName, 'ferret.png');

    const history = await api(`/api/channels/${textChannelId}/messages`, { token: ownerToken });
    const names = history.body.messages
      .filter((m) => m.attachmentHash === hash)
      .map((m) => m.attachmentName)
      // An earlier test posted these same bytes with no name at all, which
      // is exactly the point: one upload, three posts, three answers.
      .filter(Boolean);
    assert.deepEqual(names, ['furret.png', 'ferret.png']);
  });

  it('leaves it null when there is no attachment to name', async () => {
    const posted = await api(`/api/channels/${textChannelId}/messages`, {
      method: 'POST', body: { body: 'words', attachmentName: 'nope.png' }, token: ownerToken,
    });
    assert.equal(posted.body.message.attachmentName, null);
  });
});

// ---------------------------------------------------------------------------
// Swapping the file on a message
// ---------------------------------------------------------------------------

describe('changing an attachment', () => {
  let messageId;
  let firstHash;
  let secondHash;

  const refsFor = async (hash) => {
    // There is no route that reports a refcount, so this reads the only
    // thing that depends on it: a file with no references left is an
    // orphan and may be evicted. Eviction is hard to trigger on demand,
    // so the check below is on behaviour that IS reachable -- the file
    // stays servable while something points at it.
    const res = await api(`/api/uploads/${hash}`, { token: ownerToken });
    return res.status;
  };

  before(async () => {
    firstHash = (await api('/api/uploads', {
      method: 'POST', raw: PNG, contentType: 'image/png', token: ownerToken,
    })).body.hash;
    secondHash = (await api('/api/uploads', {
      method: 'POST', raw: Buffer.alloc(32, 9), contentType: 'audio/wav', token: ownerToken,
    })).body.hash;

    messageId = (await api(`/api/channels/${textChannelId}/messages`, {
      method: 'POST',
      body: { body: 'here it is', attachmentHash: firstHash, attachmentName: 'one.png' },
      token: ownerToken,
    })).body.message.id;
  });

  it('is refused to somebody else', async () => {
    const res = await api(`/api/messages/${messageId}/attachment`, {
      method: 'POST', body: { hash: secondHash, name: 'theirs.wav' }, token: memberToken,
    });
    assert.equal(res.status, 403);
  });

  it('swaps the file, the name and the kind together', async () => {
    const res = await api(`/api/messages/${messageId}/attachment`, {
      method: 'POST', body: { hash: secondHash, name: 'two.wav' }, token: ownerToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.message.attachmentHash, secondHash);
    assert.equal(res.body.message.attachmentName, 'two.wav');
    assert.equal(res.body.message.mediaType, 'audio',
      'the kind comes from the new file, not from the old one');
    assert.ok(res.body.message.editedAt > 0);
  });

  it('FOLLOWS THE MESSAGE INTO THE SEARCH INDEX', async () => {
    // messages_fts carries media_type, so searching by kind has to stop
    // finding a message whose picture has become a sound.
    const stale = await api(`/api/channels/${textChannelId}/search?q=image`, {
      token: ownerToken,
    });
    assert.ok(!stale.body.results.some((m) => m.id === messageId));

    const fresh = await api(`/api/channels/${textChannelId}/search?q=audio`, {
      token: ownerToken,
    });
    assert.ok(fresh.body.results.some((m) => m.id === messageId));
  });

  it('keeps the new file servable', async () => {
    assert.equal(await refsFor(secondHash), 200);
  });

  it('refuses a file nobody has uploaded', async () => {
    const res = await api(`/api/messages/${messageId}/attachment`, {
      method: 'POST', body: { hash: 'f'.repeat(64) }, token: ownerToken,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'no_such_upload');
  });

  it('takes it off when there are words left', async () => {
    const res = await api(`/api/messages/${messageId}/attachment`, {
      method: 'POST', body: {}, token: ownerToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.message.attachmentHash, null);
    assert.equal(res.body.message.attachmentName, null);
    assert.equal(res.body.message.mediaType, null);
  });

  it('WILL NOT LEAVE A MESSAGE WITH NOTHING IN IT', async () => {
    const silent = (await api(`/api/channels/${textChannelId}/messages`, {
      method: 'POST',
      body: { body: '', attachmentHash: firstHash, attachmentName: 'alone.png' },
      token: ownerToken,
    })).body.message.id;

    const res = await api(`/api/messages/${silent}/attachment`, {
      method: 'POST', body: {}, token: ownerToken,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'empty_message');
  });
});

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

describe('reading mentions out of a message', () => {
  const idOf = (name) => ({ boss: 1, member: 2 })[name] ?? null;

  it('finds the people named', () => {
    assert.deepEqual(mentionsIn('hey @boss and @member', idOf),
      { userIds: [1, 2], everyone: false });
  });

  it('counts a name written twice once', () => {
    // Writing somebody's name twice is emphasis, not two pings.
    assert.deepEqual(mentionsIn('@boss @boss @boss', idOf).userIds, [1]);
  });

  it('ignores a name nobody has', () => {
    assert.deepEqual(mentionsIn('@nobodyhere hello', idOf).userIds, []);
  });

  it('matches whatever case it was typed in', () => {
    assert.deepEqual(mentionsIn('@BOSS', idOf).userIds, [1]);
  });

  it('DOES NOT NOTIFY AN EMAIL ADDRESS', () => {
    // The lookbehind, which is the whole reason there is one.
    assert.deepEqual(mentionsIn('write to me@boss.example', idOf).userIds, []);
    assert.deepEqual(mentionsIn('@@boss', idOf).userIds, []);
  });

  it('reports @everyone separately, and not as a person', () => {
    const result = mentionsIn('@everyone look at this', idOf);
    assert.equal(result.everyone, true);
    assert.deepEqual(result.userIds, []);
  });
});

describe('mentions on a message', () => {
  it('travel with it, as ids', async () => {
    const posted = await api(`/api/channels/${textChannelId}/messages`, {
      method: 'POST', body: { body: 'ping @member about this' }, token: ownerToken,
    });
    assert.equal(posted.status, 201);
    const me = (await api('/api/accounts/me', { token: memberToken })).body.user;
    assert.deepEqual(posted.body.message.mentions, [me.id],
      'ids, so the client does not have to fold nicknames a second time');
    assert.equal(posted.body.message.mentionsEveryone, false);
  });

  it('come back on history too, not only on the push', async () => {
    // A field present on one path and missing on another is the worst
    // case: it works until the pane is refreshed.
    const history = await api(`/api/channels/${textChannelId}/messages`, {
      token: memberToken,
    });
    const row = history.body.messages.find((m) => m.body.includes('ping @member'));
    assert.equal(row.mentions.length, 1);
  });

  it('carries @everyone as its own flag', async () => {
    const posted = await api(`/api/channels/${textChannelId}/messages`, {
      method: 'POST', body: { body: '@everyone the server is up' }, token: memberToken,
    });
    assert.equal(posted.body.message.mentionsEveryone, true);
    assert.deepEqual(posted.body.message.mentions, []);
  });
});

describe('the disk quota', () => {
  it('refuses an upload that would exceed it', async () => {
    // Restart with a quota smaller than the file we are about to send.
    await stopHarmony();
    await startHarmony({ HARMONY_MAX_DISK_BYTES: '100' });

    const token = (await api('/api/accounts/login', {
      method: 'POST', body: { nickname: 'member', password: 'hunter22' },
    })).body.token;

    const big = Buffer.alloc(5000, 1);
    const res = await api('/api/uploads', {
      method: 'POST', raw: big, contentType: 'image/png', token,
    });
    assert.equal(res.status, 507, 'a full disk stops every SQLite write, so refuse early');
    assert.equal(res.body.error, 'server_full');
  });
});

describe('media keys', () => {
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const now = 1_000 * WEEK + 12345;

  it('names the account it was made for', () => {
    assert.equal(verifyMediaKey('s', mintMediaKey('s', 42, now), now), 42);
  });

  it('is still good the week after, and not the week after that', () => {
    const key = mintMediaKey('s', 42, now);
    assert.equal(verifyMediaKey('s', key, now + WEEK), 42);
    assert.equal(verifyMediaKey('s', key, now + 2 * WEEK), null);
  });

  it('refuses another secret, a tampered account, and a channel token', () => {
    const key = mintMediaKey('s', 42, now);
    assert.equal(verifyMediaKey('other', key, now), null);
    assert.equal(verifyMediaKey('s', key.replace('m1.16.', 'm1.17.'), now), null);
    assert.equal(verifyMediaKey('s', 'h1.1.1.rw.abc.def', now), null);
    assert.equal(verifyMediaKey('s', undefined, now), null);
  });
});
