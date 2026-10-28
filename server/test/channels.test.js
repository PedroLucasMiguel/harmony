// Channels, channel-scoped media tokens, and the auth-hook ordering that makes
// a channel password mean anything.
//
//   node --test server/test/channels.test.js

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { normalizeName, normalizeUsername, normalizePath } from '../src/rooms.js';
import { normalizeNickname } from '../src/accounts.js';
import { parseChannelPath, channelPath } from '../src/channels.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', 'src', 'index.js');

// Unique across the suite: node --test runs these files in PARALLEL.
const FAKE_MTX_PORT = 20000;
const HARMONY_PORT = 18083;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

let fakeMtx;
let child;
let dataDir;

function startFakeMediaMtx() {
  return new Promise((done) => {
    fakeMtx = http.createServer((req, res) => {
      if (req.url.startsWith('/v3/paths/list')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ itemCount: 0, pageCount: 0, items: [] }));
        return;
      }
      if (req.url.startsWith('/v3/webrtcsessions/list')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ itemCount: 0, pageCount: 0, items: [] }));
        return;
      }
      res.writeHead(404).end();
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
        HARMONY_POLL_INTERVAL_MS: '200',
        HARMONY_SIGNALING_URL: 'http://media.test:8889',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => fail(new Error('server did not start')), 10_000);
    let out = '';
    child.stdout.on('data', (b) => {
      out += b.toString();
      const match = /^\s*\u2502\s+([A-Za-z0-9_-]{20,})\s+\u2502$/m.exec(out);
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

let adminToken;
let memberToken;
let ownerKey = null;

before(async () => {
  dataDir = mkdtempSync(resolve(tmpdir(), 'harmony-chan-'));
  await startFakeMediaMtx();
  await startHarmony();

  // boss claims ownership with the key the server printed at first start.
  const owner = await api('/api/accounts/register', {
    method: 'POST', body: { nickname: 'boss', password: 'hunter22', ownerKey },
  });
  assert.equal(owner.body.ownerClaimed, true, 'test setup needs a real owner');
  adminToken = owner.body.token;

  const member = await api('/api/accounts/register', {
    method: 'POST', body: { nickname: 'member', password: 'hunter22' },
  });
  memberToken = member.body.token;
});

after(async () => {
  await stopHarmony();
  await new Promise((done) => fakeMtx.close(done));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// ---------------------------------------------------------------------------

describe('name normalisation', () => {
  it('folds case and strips spaces', () => {
    assert.equal(normalizeName('  Pedro Lucas  '), 'pedrolucas');
    assert.equal(normalizeName('Game   Night'), 'gamenight');
    assert.equal(normalizeName('ALLCAPS'), 'allcaps');
  });

  it('accepts a spaced, capitalised nickname and stores it folded', () => {
    assert.equal(normalizeNickname('Pedro Lucas'), 'pedrolucas');
    assert.equal(normalizeUsername('Pedro Lucas'), 'pedrolucas');
  });

  it('applies the length cap to the folded form, not the typed one', () => {
    // 22 characters typed, 20 once the spaces go: inside the nickname cap.
    assert.equal(normalizeNickname('ab cd ef gh ij kl mnop'), 'abcdefghijklmnop');
    // 21 characters with nothing to strip: over it.
    assert.equal(normalizeNickname('a'.repeat(21)), null);
  });

  it('still refuses the system namespace after folding', () => {
    assert.equal(normalizeNickname('VC-1-7-v'), null, 'folding must not sneak vc- past the ban');
    assert.equal(normalizeNickname('Bob Cam'), 'bobcam', 'bobcam is fine; bob-cam is not');
    assert.equal(normalizeNickname('bob-cam'), null);
  });

  it('does NOT fold spaces when parsing a MediaMTX path', () => {
    // A path is not human input. Deleting characters before deciding what it
    // means is how a parser gets talked into the wrong answer.
    assert.equal(normalizePath('vc- 1-7-v'), null);
    assert.equal(normalizePath('vc-1-7-v'), 'vc-1-7-v');
  });
});

describe('channel paths', () => {
  it('round-trips through base36', () => {
    assert.equal(channelPath(1, 7, 'voice'), 'vc-1-7-v');
    assert.equal(channelPath(40, 15, 'screen'), 'vc-14-f-s');
    assert.deepEqual(parseChannelPath('vc-14-f-s'), { cid: 40, mid: 15, kind: 's' });
  });

  it('refuses anything that is not a channel path', () => {
    assert.equal(parseChannelPath('alice'), null);
    assert.equal(parseChannelPath('vc-1-7'), null);
    assert.equal(parseChannelPath('vc-1-7-x'), null);
    assert.equal(parseChannelPath('vc--7-v'), null);
  });
});

describe('channel management', () => {
  it('ships a default text and voice channel', async () => {
    const res = await api('/api/channels', { token: memberToken });
    assert.equal(res.status, 200);
    const kinds = res.body.channels.map((c) => c.kind).sort();
    assert.deepEqual(kinds, ['text', 'voice']);
  });

  it('does not let a member create a channel', async () => {
    const res = await api('/api/channels', {
      method: 'POST', body: { kind: 'voice', name: 'nope' }, token: memberToken,
    });
    assert.equal(res.status, 403);
  });

  it('KEEPS THE NAME AS IT WAS TYPED', async () => {
    // Not folded like a nickname. A nickname is an identifier -- it is what
    // a mention matches and what the MediaMTX namespace holds, so two
    // spellings would be two people. A channel name is a label: nothing
    // matches on it and nothing is routed by it.
    const res = await api('/api/channels', {
      method: 'POST', body: { kind: 'voice', name: 'Game Night' }, token: adminToken,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.channel.name, 'Game Night');
    assert.equal(res.body.channel.kind, 'voice');
    assert.equal(res.body.channel.locked, false);
  });

  it('collapses whitespace nobody can see, and strips control characters', async () => {
    const res = await api('/api/channels', {
      method: 'POST',
      body: { kind: 'text', name: '  Book\u0007   Club \u202e ' },
      token: adminToken,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.channel.name, 'Book Club',
      'two names must not be able to differ by something invisible');
  });

  it('keeps an emoji in one piece', async () => {
    // \p{C} is the obvious way to strip the invisible characters and it
    // would take the zero width joiner with it, quietly breaking every
    // emoji made of more than one code point.
    const res = await api('/api/channels', {
      method: 'POST',
      body: { kind: 'text', name: '\u{1F468}\u200D\u{1F4BB} dev talk' },
      token: adminToken,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.channel.name, '\u{1F468}\u200D\u{1F4BB} dev talk');
  });

  it('refuses a name that is nothing but spaces', async () => {
    const res = await api('/api/channels', {
      method: 'POST', body: { kind: 'voice', name: '   ' }, token: adminToken,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_name');
  });

  it('refuses a kind that is neither voice nor text', async () => {
    const res = await api('/api/channels', {
      method: 'POST', body: { kind: 'telepathy', name: 'hmm' }, token: adminToken,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_kind');
  });

  it('marks a password-protected channel as locked', async () => {
    const res = await api('/api/channels', {
      method: 'POST',
      body: { kind: 'voice', name: 'Private Room', password: 'letmein' },
      token: adminToken,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.channel.name, 'Private Room');
    assert.equal(res.body.channel.locked, true);
  });

  it('does not leak the password hash to clients', async () => {
    const res = await api('/api/channels', { token: memberToken });
    for (const c of res.body.channels) {
      assert.equal(c.password_hash, undefined);
      assert.equal(c.passwordHash, undefined);
    }
  });

  it('reorders only on a complete permutation', async () => {
    const before = (await api('/api/channels', { token: adminToken })).body.channels;
    const ids = before.map((c) => c.id);

    const partial = await api('/api/channels/reorder', {
      method: 'POST', body: { ids: ids.slice(0, 2) }, token: adminToken,
    });
    assert.equal(partial.status, 400, 'a partial list must be refused outright');

    const reversed = [...ids].reverse();
    const ok = await api('/api/channels/reorder', {
      method: 'POST', body: { ids: reversed }, token: adminToken,
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.channels.map((c) => c.id), reversed);
  });

  it('does not let a member reorder channels', async () => {
    const res = await api('/api/channels/reorder', {
      method: 'POST', body: { ids: [] }, token: memberToken,
    });
    assert.equal(res.status, 403);
  });
});

/*
 * Groups.
 *
 * A group is a heading with a fold, not a container. The thing most worth
 * pinning is that deleting one does NOT delete its channels -- it is the
 * opposite of every other delete in this server, and getting it wrong
 * destroys a year of chat with one click.
 */
describe('channel groups', () => {
  let groupId;
  let channelId;

  before(async () => {
    const made = await api('/api/channels', {
      method: 'POST', body: { kind: 'text', name: 'grouped' }, token: adminToken,
    });
    channelId = made.body.channel.id;
  });

  it('lets an admin make one', async () => {
    const res = await api('/api/channels/groups', {
      method: 'POST', body: { name: 'Hangouts' }, token: adminToken,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.group.name, 'Hangouts');
    groupId = res.body.group.id;
  });

  it('is refused to a member', async () => {
    const res = await api('/api/channels/groups', {
      method: 'POST', body: { name: 'mine' }, token: memberToken,
    });
    assert.equal(res.status, 403);
  });

  it('lists groups beside the channels', async () => {
    const res = await api('/api/channels', { token: memberToken });
    assert.equal(res.status, 200);
    assert.ok(res.body.groups.some((g) => g.id === groupId),
      'the two must travel together, or a client draws channels into folders it has not got');
  });

  it('puts a channel in a group, and reports it', async () => {
    const res = await api('/api/channels/arrange', {
      method: 'POST',
      body: { groups: [groupId], channels: [{ id: channelId, groupId }] },
      token: adminToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.channels.find((c) => c.id === channelId).groupId, groupId);
  });

  it('leaves channels it was not told about alone', async () => {
    const before = (await api('/api/channels', { token: adminToken })).body.channels;
    const other = before.find((c) => c.id !== channelId);
    const res = await api('/api/channels/arrange', {
      method: 'POST', body: { channels: [{ id: channelId, groupId }] }, token: adminToken,
    });
    assert.equal(res.status, 200);
    const after = res.body.channels.find((c) => c.id === other.id);
    assert.equal(after.groupId, other.groupId,
      'a client that has not refreshed must not drag everything else to the top');
  });

  it('refuses an arrangement naming a group that is gone', async () => {
    const res = await api('/api/channels/arrange', {
      method: 'POST',
      body: { channels: [{ id: channelId, groupId: 9999 }] },
      token: adminToken,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'no_such_group');
  });

  it('REORDERS THE GROUPS THEMSELVES, and their channels follow', async () => {
    // The route accepted this from the day it was written and nothing in
    // the client could ask for it, which is the same shape of gap as a
    // tested route with no button in front of it.
    const second = (await api('/api/channels/groups', {
      method: 'POST', body: { name: 'Quiet Corner' }, token: adminToken,
    })).body.group.id;

    const before = (await api('/api/channels', { token: adminToken })).body.groups;
    assert.deepEqual(before.map((g) => g.id), [groupId, second]);

    const res = await api('/api/channels/arrange', {
      method: 'POST',
      body: {
        groups: [second, groupId],
        channels: [{ id: channelId, groupId }],
      },
      token: adminToken,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.groups.map((g) => g.id), [second, groupId],
      'position comes from the index in the submitted list');

    const after = (await api('/api/channels', { token: memberToken })).body.groups;
    assert.deepEqual(after.map((g) => g.id), [second, groupId],
      'and everybody sees the same order');

    // Put it back, so the delete test below still finds what it expects.
    await api(`/api/channels/groups/${second}/delete`, { method: 'POST', token: adminToken });
  });

  it('renames one', async () => {
    const res = await api(`/api/channels/groups/${groupId}`, {
      method: 'POST', body: { name: 'Lounge' }, token: adminToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.group.name, 'Lounge');
  });

  it('DELETING A GROUP KEEPS ITS CHANNELS', async () => {
    const res = await api(`/api/channels/groups/${groupId}/delete`, {
      method: 'POST', token: adminToken,
    });
    assert.equal(res.status, 200);

    const after = await api('/api/channels', { token: adminToken });
    const channel = after.body.channels.find((c) => c.id === channelId);
    assert.ok(channel, 'the channel must survive its group');
    assert.equal(channel.groupId, null, 'and come back ungrouped');
    assert.equal(after.body.groups.length, 0);
  });
});

/*
 * Groups and ungrouped channels share one order, so a group can be put above a
 * channel that belongs to none. The sidebar is submitted as one list in the
 * order it is drawn -- `order`, with `{ group }` for a heading -- and its index
 * is the position of everything in it.
 */
describe('groups among ungrouped channels', () => {
  let a;
  let b;
  let c;
  let g1;
  let g2;
  const made = async (name) => (await api('/api/channels', {
    method: 'POST', body: { kind: 'text', name }, token: adminToken,
  })).body.channel.id;
  const group = async (name) => (await api('/api/channels/groups', {
    method: 'POST', body: { name }, token: adminToken,
  })).body.group.id;
  const arrange = (body) => api('/api/channels/arrange', { method: 'POST', body, token: adminToken });
  /** What the sidebar would draw: headings and ungrouped channels by position, a group's own under it. */
  const layout = async () => {
    const { body } = await api('/api/channels', { token: adminToken });
    const mine = new Set([a, b, c]);
    const tops = [
      ...body.channels.filter((ch) => mine.has(ch.id) && ch.groupId == null)
        .map((ch) => ({ key: `ch:${ch.name}`, position: ch.position })),
      ...body.groups.filter((g) => [g1, g2].includes(g.id))
        .map((g) => ({ key: `group:${g.name}`, position: g.position, id: g.id })),
    ].sort((x, y) => x.position - y.position);
    return tops.flatMap((t) => [
      t.key,
      ...(t.id ? body.channels.filter((ch) => ch.groupId === t.id)
        .sort((x, y) => x.position - y.position).map((ch) => `  ${ch.name}`) : []),
    ]);
  };

  before(async () => {
    a = await made('ua');
    b = await made('ub');
    c = await made('uc');
    g1 = await group('G1');
    g2 = await group('G2');
  });

  it('puts a group above ungrouped channels', async () => {
    const res = await arrange({
      order: [
        { group: g1 },
        { id: c, groupId: g1 },
        { id: a, groupId: null },
        { id: b, groupId: null },
        { group: g2 },
      ],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await layout(), ['group:G1', '  uc', 'ch:ua', 'ch:ub', 'group:G2']);
  });

  it('puts a group between two ungrouped channels', async () => {
    await arrange({
      order: [
        { id: a, groupId: null },
        { group: g1 },
        { id: c, groupId: g1 },
        { id: b, groupId: null },
        { group: g2 },
      ],
    });
    assert.deepEqual(await layout(), ['ch:ua', 'group:G1', '  uc', 'ch:ub', 'group:G2']);
  });

  it('still reads what an older client sends: ungrouped first, then the groups', async () => {
    const res = await arrange({
      groups: [g2, g1],
      channels: [{ id: c, groupId: g1 }, { id: a, groupId: null }, { id: b, groupId: null }],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await layout(), ['ch:ua', 'ch:ub', 'group:G2', 'group:G1', '  uc']);
  });

  it('leaves out of a list what it does not name, after what it does', async () => {
    await arrange({ order: [{ id: b, groupId: null }] });
    const lay = await layout();
    assert.equal(lay[0], 'ch:ub', 'the one that was named comes first');
    assert.equal(lay.length, 5, 'and nothing is lost');
  });

  it('refuses a list naming a group or a channel that is gone', async () => {
    assert.equal((await arrange({ order: [{ group: 99999 }] })).body.error, 'no_such_group');
    assert.equal((await arrange({ order: [{ id: 99999, groupId: null }] })).body.error, 'no_such_channel');
    assert.equal((await arrange({ order: [{ id: a, groupId: 99999 }] })).body.error, 'no_such_group');
  });

  it('ignores a channel or a group named twice', async () => {
    const res = await arrange({
      order: [{ id: a, groupId: null }, { id: a, groupId: null }, { group: g1 }, { group: g1 }],
    });
    assert.equal(res.status, 200);
    const positions = [...res.body.channels, ...res.body.groups].map((x) => x.position);
    assert.equal(new Set(positions).size, positions.length, 'every position is used once');
  });

  it('puts a new channel, and a new group, at the end of everything', async () => {
    const before = (await api('/api/channels', { token: adminToken })).body;
    const top = Math.max(...before.channels.map((x) => x.position), ...before.groups.map((x) => x.position));
    const fresh = await made('ufresh');
    const freshGroup = await group('G3');
    const after = (await api('/api/channels', { token: adminToken })).body;
    const channelPosition = after.channels.find((x) => x.id === fresh).position;
    const groupPosition = after.groups.find((x) => x.id === freshGroup).position;
    assert.ok(channelPosition > top, 'a new channel is below every group and channel there was');
    assert.ok(groupPosition > channelPosition, 'and a group made after it is below that');
  });

  it('a deleted group leaves its channels where the group was', async () => {
    await arrange({
      order: [
        { id: a, groupId: null },
        { group: g1 },
        { id: c, groupId: g1 },
        { id: b, groupId: null },
      ],
    });
    await api(`/api/channels/groups/${g1}/delete`, { method: 'POST', token: adminToken });
    const { body } = await api('/api/channels', { token: adminToken });
    const order = body.channels.filter((x) => [a, b, c].includes(x.id)).map((x) => x.name);
    assert.deepEqual(order, ['ua', 'uc', 'ub'], 'uc is ungrouped now, and still between the other two');
    assert.equal(body.channels.find((x) => x.id === c).groupId, null);
  });
});

describe('channel-scoped media tokens', () => {
  it('refuses a read on a channel path with no token', async () => {
    const res = await api('/mediamtx/auth', {
      method: 'POST', body: { action: 'read', path: 'vc-1-1-v', query: '' },
    });
    assert.equal(res.status, 401,
      'the open-server shortcut must NOT apply to channel paths');
  });

  it('refuses a read on a channel path with a made-up token', async () => {
    const res = await api('/mediamtx/auth', {
      method: 'POST',
      body: { action: 'read', path: 'vc-1-1-v', query: 'token=h1.1.1.rw.zzzz.AAAAAAAAAAAAAAAAAAAAAA' },
    });
    assert.equal(res.status, 401);
  });

  it('still allows a plain username read on an open server', async () => {
    // The legacy branch must keep working: this server has no HARMONY_PASSWORD.
    const res = await api('/mediamtx/auth', {
      method: 'POST', body: { action: 'read', path: 'alice', query: '' },
    });
    assert.equal(res.status, 204);
  });

  it('refuses a publish to a channel path with no token', async () => {
    const res = await api('/mediamtx/auth', {
      method: 'POST', body: { action: 'publish', path: 'vc-1-1-v', query: '' },
    });
    assert.equal(res.status, 401);
  });
});

describe('the webcam path', () => {
  it('is derived from the authenticated nickname, not from the body', async () => {
    const res = await api('/api/session', {
      method: 'POST',
      // A deliberately hostile body: neither of these may influence the path.
      body: { kind: 'camera', username: 'boss' },
      token: memberToken,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.username, 'member-cam');
    assert.match(res.body.whipUrl, /\/member-cam\/whip/);
  });

  it('cannot be claimed by registering the name', async () => {
    const res = await api('/api/accounts/register', {
      method: 'POST', body: { nickname: 'member-cam', password: 'hunter22' },
    });
    assert.equal(res.status, 400,
      'if -cam were registerable, somebody could hold another user\u2019s camera path');
    assert.equal(res.body.error, 'invalid_nickname');
  });

  it('needs a login', async () => {
    const res = await api('/api/session', { method: 'POST', body: { kind: 'camera' } });
    assert.equal(res.status, 401);
  });
});

describe('the username namespace cannot reach channels', () => {
  it('refuses to register a nickname in the vc- namespace', async () => {
    const res = await api('/api/accounts/register', {
      method: 'POST', body: { nickname: 'vc-1-1-v', password: 'hunter22' },
    });
    assert.equal(res.status, 400);
  });

  it('refuses a session claim on a channel path name', async () => {
    const res = await api('/api/session', {
      method: 'POST', body: { username: 'vc-1-1-v' }, token: memberToken,
    });
    // A logged-in caller streams under their own nickname, so this is simply
    // ignored -- which is itself the proof that the body cannot steer the path.
    assert.equal(res.body.username, 'member');
  });
});
