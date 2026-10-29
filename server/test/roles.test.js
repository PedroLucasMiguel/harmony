// Roles: permissions, the hierarchy, who may hand out what, channels that
// follow groups, and the part that has to be IMMEDIATE -- a role assigned is a
// role that has taken effect, on the page of the person who got it, before
// the admin's request has even come back.
//
//   node --test server/test/roles.test.js

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
const FAKE_MTX_PORT = 20020;
const HARMONY_PORT = 18100;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;
const WS_URL = `ws://127.0.0.1:${HARMONY_PORT}/ws`;

let fakeMtx;
let child;
let dataDir;
let ownerKey = null;
const people = {};   // name -> { token, id }

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

/** POST as somebody, by name. */
const as = (name, path, body, method = 'POST') => api(path, { method, body, token: people[name].token });
const get = (name, path) => api(path, { token: people[name].token });

async function register(name) {
  const res = await api('/api/accounts/register', {
    method: 'POST',
    body: { nickname: name, password: 'hunter22', ...(name === 'chief' ? { ownerKey } : {}) },
  });
  people[name] = { token: res.body.token, id: res.body.user.id };
}

function connect(token) {
  const ws = new WebSocket(WS_URL);
  const inbox = [];
  const waiters = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    inbox.push(msg);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].match(msg)) { waiters[i].resolve(msg); waiters.splice(i, 1); }
    }
  });
  const client = {
    ws,
    inbox,
    next(match, { timeoutMs = 4000 } = {}) {
      const found = inbox.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((done, fail) => {
        const timer = setTimeout(
          () => fail(new Error(`timed out; saw ${JSON.stringify(inbox.map((m) => m.type))}`)),
          timeoutMs,
        );
        waiters.push({ match, resolve: (m) => { clearTimeout(timer); done(m); } });
      });
    },
    send(payload) { ws.send(JSON.stringify(payload)); },
    async request(payload) {
      const rid = Math.random().toString(36).slice(2);
      this.send({ ...payload, rid });
      return this.next((m) => m.rid === rid);
    },
    async hello() {
      if (ws.readyState !== WebSocket.OPEN) {
        await new Promise((done) => ws.addEventListener('open', done, { once: true }));
      }
      return this.request({ type: 'hello', token });
    },
    /** Messages of a type that arrived after this call. */
    mark() { return inbox.length; },
    since(mark, type) { return inbox.slice(mark).filter((m) => m.type === type); },
  };
  return client;
}

const roleByName = async (name) => (await get('chief', '/api/roles'))
  .body.roles.find((r) => r.name === name);
const names = (list) => list.map((c) => c.name);

before(async () => {
  dataDir = mkdtempSync(resolve(tmpdir(), 'harmony-roles-'));
  await startFakeMediaMtx();
  await startHarmony();
  for (const n of ['chief', 'sup', 'boss', 'mod', 'helper', 'pleb', 'other', 'target']) {
    await register(n);
  }
  // chief owns; sup is a super admin
  await as('chief', `/api/accounts/${people.sup.id}/role`, { role: 'admin' });
});

after(async () => {
  await stopHarmony();
  await new Promise((done) => fakeMtx.close(done));
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// ---------------------------------------------------------------------------

describe('super admins are made by the owner alone', () => {
  it('refuses a super admin who tries to make another', async () => {
    const res = await as('sup', `/api/accounts/${people.pleb.id}/role`, { role: 'admin' });
    assert.equal(res.status, 403);
  });
  it('refuses an ordinary member', async () => {
    const res = await as('pleb', `/api/accounts/${people.other.id}/role`, { role: 'admin' });
    assert.equal(res.status, 403);
  });
});

describe('the roles themselves', () => {
  it('starts with none, and lists the permissions', async () => {
    const res = await get('pleb', '/api/roles');
    assert.deepEqual(res.body.roles, []);
    assert.ok(res.body.permissions.includes('channels.password'));
    assert.ok(res.body.permissions.includes('roles.hierarchy'));
  });

  it('lets the owner create roles, which go to the bottom in order', async () => {
    for (const body of [
      { name: 'Boss', color: '#ff0000', admin: true },
      { name: 'Mod', color: '#00ff00', permissions: ['users.mute', 'users.kick', 'users.ban', 'messages.delete', 'roles.hierarchy', 'channels.edit'] },
      { name: 'Helper', color: '#0000ff', permissions: ['users.mute'] },
      { name: 'Guest', color: '#888888' },
    ]) {
      const res = await as('chief', '/api/roles', body);
      assert.equal(res.status, 201, JSON.stringify(res.body));
    }
    const list = (await get('pleb', '/api/roles')).body.roles;
    assert.deepEqual(names(list), ['Boss', 'Mod', 'Helper', 'Guest']);
    assert.deepEqual(list.map((r) => r.position), [0, 1, 2, 3]);
  });

  it('refuses a bad colour, a bad permission and a repeated name', async () => {
    assert.equal((await as('chief', '/api/roles', { name: 'x', color: 'red' })).status, 400);
    assert.equal((await as('chief', '/api/roles', { name: 'x', permissions: ['sudo'] })).status, 400);
    const dup = await as('chief', '/api/roles', { name: 'mod' });
    assert.equal(dup.status, 400);
    assert.equal(dup.body.error, 'name_taken');
  });

  it('refuses everybody without the permission', async () => {
    assert.equal((await as('pleb', '/api/roles', { name: 'Mine' })).status, 403);
  });
});

describe('the hierarchy', () => {
  before(async () => {
    // mod holds Mod; boss holds Boss; helper holds Helper
    const ids = { boss: 'Boss', mod: 'Mod', helper: 'Helper' };
    for (const [who, role] of Object.entries(ids)) {
      const res = await as('chief', `/api/accounts/${people[who].id}/roles`, {
        roles: [(await roleByName(role)).id],
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
  });

  it('shows the roles on the account', async () => {
    const users = (await get('pleb', '/api/accounts')).body.users;
    const mod = users.find((u) => u.nickname === 'mod');
    assert.equal(mod.roles.length, 1);
  });

  it('lets a role that manages roles create one -- at the bottom, below itself', async () => {
    const res = await as('mod', '/api/roles', { name: 'Newbie', permissions: ['users.mute'] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const list = (await get('pleb', '/api/roles')).body.roles;
    assert.equal(list.at(-1).name, 'Newbie');
  });

  it('does not let it grant what it does not have', async () => {
    const res = await as('mod', '/api/roles', { name: 'Gate', permissions: ['channels.password'] });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'cannot_grant');
    const admin = await as('mod', '/api/roles', { name: 'Gate2', admin: true });
    assert.equal(admin.status, 403);
  });

  it('does not let it edit or delete its own role, or any above', async () => {
    const boss = await roleByName('Boss');
    const mod = await roleByName('Mod');
    for (const role of [boss, mod]) {
      assert.equal((await as('mod', `/api/roles/${role.id}`, { name: 'Renamed' })).status, 403);
      assert.equal((await as('mod', `/api/roles/${role.id}/delete`, {})).status, 403);
    }
  });

  it('lets it edit one below it', async () => {
    const helper = await roleByName('Helper');
    const res = await as('mod', `/api/roles/${helper.id}`, { color: '#123456' });
    assert.equal(res.status, 200);
    assert.equal(res.body.role.color, '#123456');
  });

  it('does not let it move itself or the roles above, nor put a role above itself', async () => {
    const list = (await get('mod', '/api/roles')).body.roles;
    const ids = list.map((r) => r.id);
    // Swap Boss and Mod: both are at or above Mod.
    const swapped = [ids[1], ids[0], ...ids.slice(2)];
    assert.equal((await as('mod', '/api/roles/reorder', { ids: swapped })).status, 403);
    // Put the bottom role at the very top.
    const jumped = [ids.at(-1), ...ids.slice(0, -1)];
    assert.equal((await as('mod', '/api/roles/reorder', { ids: jumped })).status, 403);
  });

  it('lets it reorder the roles below it', async () => {
    const ids = (await get('mod', '/api/roles')).body.roles.map((r) => r.id);
    const reordered = [...ids.slice(0, 2), ...ids.slice(2).reverse()];
    const res = await as('mod', '/api/roles/reorder', { ids: reordered });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.roles.map((r) => r.id), reordered);
  });

  it('lets the owner and a super admin move anything', async () => {
    const ids = (await get('chief', '/api/roles')).body.roles.map((r) => r.id);
    const swapped = [ids[1], ids[0], ...ids.slice(2)];
    assert.equal((await as('sup', '/api/roles/reorder', { ids: swapped })).status, 200);
    assert.equal((await as('chief', '/api/roles/reorder', { ids })).status, 200);
  });

  it('refuses an order that leaves a role out', async () => {
    const ids = (await get('chief', '/api/roles')).body.roles.map((r) => r.id);
    assert.equal((await as('chief', '/api/roles/reorder', { ids: ids.slice(1) })).status, 400);
  });

  it('forgets a deleted role everywhere it was named', async () => {
    const throwaway = (await as('chief', '/api/roles', { name: 'Throwaway' })).body.role;
    const mod = await roleByName('Mod');
    await as('chief', `/api/roles/${mod.id}`, { assignable: [throwaway.id] });
    await as('chief', `/api/accounts/${people.other.id}/roles`, { roles: [throwaway.id] });
    assert.equal((await as('chief', `/api/roles/${throwaway.id}/delete`, {})).status, 200);
    assert.deepEqual((await roleByName('Mod')).assignable, []);
    const other = (await get('chief', '/api/accounts')).body.users.find((u) => u.nickname === 'other');
    assert.deepEqual(other.roles, []);
  });
});

describe('handing roles out', () => {
  let helper;
  let guest;
  let boss;
  before(async () => {
    helper = await roleByName('Helper');
    guest = await roleByName('Guest');
    boss = await roleByName('Boss');
    const mod = await roleByName('Mod');
    await as('chief', `/api/roles/${mod.id}`, { assignable: [guest.id, helper.id, boss.id] });
  });

  it('lets a role hand out the roles it lists', async () => {
    const res = await as('mod', `/api/accounts/${people.pleb.id}/roles`, { roles: [guest.id] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.user.roles, [guest.id]);
  });

  it('does not hand out what it lists but is not below it', async () => {
    // Boss is above Mod, so listing it does not make it assignable.
    const res = await as('mod', `/api/accounts/${people.pleb.id}/roles`, { roles: [guest.id, boss.id] });
    assert.equal(res.status, 403);
  });

  it('does not hand out a role it does not list', async () => {
    const newbie = await roleByName('Newbie');
    const res = await as('mod', `/api/accounts/${people.pleb.id}/roles`, { roles: [newbie.id] });
    assert.equal(res.status, 403);
  });

  it('does not let anybody change their own roles, or a peer\'s or superior\'s', async () => {
    assert.equal((await as('mod', `/api/accounts/${people.mod.id}/roles`, { roles: [] })).status, 403);
    assert.equal((await as('mod', `/api/accounts/${people.boss.id}/roles`, { roles: [] })).status, 403);
    assert.equal((await as('helper', `/api/accounts/${people.pleb.id}/roles`, { roles: [] })).status, 403);
  });

  it('keeps a role the actor cannot remove when changing another', async () => {
    // pleb holds Guest; adding Helper beside it works, Guest stays.
    const res = await as('mod', `/api/accounts/${people.pleb.id}/roles`, { roles: [guest.id, helper.id] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.user.roles.sort(), [guest.id, helper.id].sort());
    await as('mod', `/api/accounts/${people.pleb.id}/roles`, { roles: [guest.id] });
  });

  it('lets a super admin hand out anything, and an admin role anything below it', async () => {
    assert.equal((await as('sup', `/api/accounts/${people.other.id}/roles`, { roles: [boss.id] })).status, 200);
    // other now holds Boss (an admin role) and can hand out roles below it
    const res = await as('other', `/api/accounts/${people.target.id}/roles`, { roles: [helper.id] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await as('chief', `/api/accounts/${people.target.id}/roles`, { roles: [] });
    await as('chief', `/api/accounts/${people.other.id}/roles`, { roles: [] });
  });
});

describe('moderating accounts', () => {
  it('lets a role kick and ban only what it outranks', async () => {
    assert.equal((await as('mod', `/api/accounts/${people.boss.id}/ban`, {})).status, 403);
    assert.equal((await as('mod', `/api/accounts/${people.sup.id}/kick`, {})).status, 403);
    assert.equal((await as('mod', `/api/accounts/${people.chief.id}/ban`, {})).status, 403);
    assert.equal((await as('helper', `/api/accounts/${people.pleb.id}/ban`, {})).status, 403, 'no ban permission');
  });

  it('bans: no sign-in, no session, until it is lifted', async () => {
    const res = await as('mod', `/api/accounts/${people.target.id}/ban`, { banned: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.user.banned, true);

    assert.equal((await get('target', '/api/channels')).status, 401, 'their session is gone');
    const login = await api('/api/accounts/login', {
      method: 'POST', body: { nickname: 'target', password: 'hunter22' },
    });
    assert.equal(login.status, 403);
    assert.equal(login.body.error, 'banned');

    assert.equal((await as('mod', `/api/accounts/${people.target.id}/ban`, { banned: false })).status, 200);
    const back = await api('/api/accounts/login', {
      method: 'POST', body: { nickname: 'target', password: 'hunter22' },
    });
    assert.equal(back.status, 200);
    people.target.token = back.body.token;
  });

  it('kicks: closes their socket and signs them out, but they may return', async () => {
    const c = connect(people.target.token);
    await c.hello();
    const closed = new Promise((done) => c.ws.addEventListener('close', done));
    assert.equal((await as('mod', `/api/accounts/${people.target.id}/kick`, {})).status, 200);
    await closed;
    assert.equal((await get('target', '/api/channels')).status, 401);
    const back = await api('/api/accounts/login', {
      method: 'POST', body: { nickname: 'target', password: 'hunter22' },
    });
    assert.equal(back.status, 200);
    people.target.token = back.body.token;
  });

  it('lets only the permission delete other people\'s messages', async () => {
    const text = (await get('chief', '/api/channels')).body.channels.find((c) => c.kind === 'text');
    const posted = await as('pleb', `/api/channels/${text.id}/messages`, { body: 'hello there' });
    const id = posted.body.message.id;
    assert.equal((await as('helper', `/api/messages/${id}/delete`, {})).status, 403);
    assert.equal((await as('mod', `/api/messages/${id}/delete`, {})).status, 200);
  });
});

describe('channels with roles', () => {
  let secret;       // a text channel for Mod only
  let secretVoice;
  let mod;
  let guest;

  before(async () => {
    mod = await roleByName('Mod');
    guest = await roleByName('Guest');
  });

  it('needs the channel permissions', async () => {
    assert.equal((await as('pleb', '/api/channels', { kind: 'text', name: 'nope' })).status, 403);
    // mod has channels.edit but not create/password/delete
    assert.equal((await as('mod', '/api/channels', { kind: 'text', name: 'nope' })).status, 403);
  });

  it('hides a channel from everybody outside its roles', async () => {
    const made = await as('chief', '/api/channels', { kind: 'text', name: 'Staff', roles: [mod.id] });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    secret = made.body.channel;
    assert.deepEqual(secret.roles, [mod.id]);
    const v = await as('chief', '/api/channels', { kind: 'voice', name: 'Staff Voice', roles: [mod.id] });
    secretVoice = v.body.channel;

    for (const who of ['mod', 'chief', 'sup', 'boss']) {
      assert.ok(names((await get(who, '/api/channels')).body.channels).includes('Staff'), `${who} sees it`);
    }
    for (const who of ['pleb', 'helper', 'target']) {
      const list = (await get(who, '/api/channels')).body;
      assert.ok(!names(list.channels).includes('Staff'), `${who} does not`);
      assert.ok(!names(list.channels).includes('Staff Voice'));
    }
  });

  it('does not let them read it, post to it, edit it or learn it is there', async () => {
    assert.equal((await get('pleb', `/api/channels/${secret.id}/messages`)).status, 404);
    assert.equal((await as('pleb', `/api/channels/${secret.id}/messages`, { body: 'hi' })).status, 404);
    assert.equal((await get('pleb', `/api/channels/${secret.id}/search?q=hi`)).status, 404);
    const edit = await as('mod', `/api/channels/${secret.id}`, { name: 'Renamed' });
    assert.equal(edit.status, 200, 'a member of the role may edit it (channels.edit)');
    const peek = await as('helper', `/api/channels/${secret.id}`, { name: 'x' });
    assert.equal(peek.status, 404, 'not 403: that would say it exists');
    await as('mod', `/api/channels/${secret.id}`, { name: 'Staff' });
  });

  it('keeps its messages and its voice room out of everybody else\'s sockets', async () => {
    const outsider = connect(people.pleb.token);
    const insider = connect(people.mod.token);
    const helloOut = await outsider.hello();
    const helloIn = await insider.hello();
    assert.ok(!names(helloOut.channels).includes('Staff'));
    assert.ok(names(helloIn.channels).includes('Staff'));

    const posted = await as('mod', `/api/channels/${secret.id}/messages`, { body: 'secret plans' });
    assert.equal(posted.status, 201);
    await insider.next((m) => m.type === 'message' && m.message.body === 'secret plans');
    await new Promise((done) => setTimeout(done, 300));
    assert.ok(!outsider.inbox.some((m) => m.type === 'message' && m.message.body === 'secret plans'));

    const join = await outsider.request({ type: 'voice:join', channelId: secretVoice.id });
    assert.equal(join.error, 'no_such_channel');
    const ok = await insider.request({ type: 'voice:join', channelId: secretVoice.id });
    assert.equal(ok.type, 'voice:joined');
    await new Promise((done) => setTimeout(done, 300));
    assert.ok(!outsider.inbox.some((m) => m.type === 'voice:roster' && m.channelId === secretVoice.id),
      'who is in a hidden room is hidden too');
    insider.ws.close();
    outsider.ws.close();
  });

  it('applies the instant a role is assigned: visible at once, over the socket, before the reply', async () => {
    const watcher = connect(people.pleb.token);
    const hello = await watcher.hello();
    assert.ok(!names(hello.channels).includes('Staff'));

    const mark = watcher.mark();
    const reply = await as('chief', `/api/accounts/${people.pleb.id}/roles`, { roles: [mod.id] });
    assert.equal(reply.status, 200);
    // Already in the inbox the moment the request returns: no waiting.
    const updated = watcher.since(mark, 'user:updated').find((m) => m.user.id === people.pleb.id);
    assert.ok(updated, 'the person was told their new roles');
    assert.deepEqual(updated.user.roles, [mod.id]);
    const channelsPush = watcher.since(mark, 'channels').at(-1);
    assert.ok(channelsPush && names(channelsPush.channels).includes('Staff'), 'and shown the channel');
    assert.equal((await get('pleb', `/api/channels/${secret.id}/messages`)).status, 200, 'and the server lets them in');
    watcher.ws.close();
  });

  it('applies the instant a role is taken away: gone from the list, thrown out of the room, refused', async () => {
    const watcher = connect(people.pleb.token);
    await watcher.hello();
    const joined = await watcher.request({ type: 'voice:join', channelId: secretVoice.id });
    assert.equal(joined.type, 'voice:joined');

    const mark = watcher.mark();
    const reply = await as('chief', `/api/accounts/${people.pleb.id}/roles`, { roles: [guest.id] });
    assert.equal(reply.status, 200);
    const push = watcher.since(mark, 'channels').at(-1);
    assert.ok(push && !names(push.channels).includes('Staff'));
    assert.ok(watcher.since(mark, 'voice:moved').length >= 1, 'told to leave the room');
    assert.equal((await get('pleb', `/api/channels/${secret.id}/messages`)).status, 404);
    const again = await watcher.request({ type: 'voice:join', channelId: secretVoice.id });
    assert.equal(again.error, 'no_such_channel');
    watcher.ws.close();
  });

  it('applies a role\'s new permission at once, too', async () => {
    const helper = await roleByName('Helper');
    const text = (await get('chief', '/api/channels')).body.channels.find((c) => c.name === 'general' || c.kind === 'text');
    const posted = await as('pleb', `/api/channels/${text.id}/messages`, { body: 'for deletion' });
    const id = posted.body.message.id;
    await as('chief', `/api/accounts/${people.helper.id}/roles`, { roles: [helper.id] });
    assert.equal((await as('helper', `/api/messages/${id}/delete`, {})).status, 403);
    await as('chief', `/api/roles/${helper.id}`, { permissions: ['users.mute', 'messages.delete'] });
    assert.equal((await as('helper', `/api/messages/${id}/delete`, {})).status, 200);
    await as('chief', `/api/roles/${helper.id}`, { permissions: ['users.mute'] });
  });

  it('opens the channel up when its only role is deleted, rather than hiding it from everyone', async () => {
    const temp = (await as('chief', '/api/roles', { name: 'Temp' })).body.role;
    const ch = (await as('chief', '/api/channels', { kind: 'text', name: 'Tempchan', roles: [temp.id] })).body.channel;
    assert.ok(!names((await get('pleb', '/api/channels')).body.channels).includes('Tempchan'));
    await as('chief', `/api/roles/${temp.id}/delete`, {});
    assert.ok(names((await get('pleb', '/api/channels')).body.channels).includes('Tempchan'));
    assert.deepEqual((await get('pleb', '/api/channels')).body.channels.find((c) => c.id === ch.id).roles, []);
  });

  it('refuses a role that does not exist rather than leaving the channel open', async () => {
    const res = await as('chief', '/api/channels', { kind: 'text', name: 'Ghost', roles: [99999] });
    assert.equal(res.status, 404);
    assert.ok(!names((await get('chief', '/api/channels')).body.channels).includes('Ghost'));
  });
});

describe('groups', () => {
  let group;
  let mod;

  before(async () => {
    mod = await roleByName('Mod');
  });

  it('needs the permission for each part', async () => {
    assert.equal((await as('pleb', '/api/channels/groups', { name: 'Nope' })).status, 403);
  });

  it('hides a whole group, and everything in it, from outsiders', async () => {
    const made = await as('chief', '/api/channels/groups', { name: 'Staff Area', roles: [mod.id] });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    group = made.body.group;
    assert.deepEqual(group.roles, [mod.id]);

    const c = (await as('chief', '/api/channels', { kind: 'text', name: 'In Group' })).body.channel;
    await as('chief', '/api/channels/arrange', {
      order: [{ id: c.id, groupId: group.id }, { group: group.id }],
    });
    // The arrange above names the heading after the channel; redo it properly.
    await as('chief', '/api/channels/arrange', {
      order: [{ group: group.id }, { id: c.id, groupId: group.id }],
    });
    const view = (await get('pleb', '/api/channels')).body;
    assert.ok(!names(view.groups).includes('Staff Area'));
    assert.ok(!names(view.channels).includes('In Group'));
    const seen = (await get('mod', '/api/channels')).body;
    assert.ok(names(seen.groups).includes('Staff Area'));
    assert.ok(names(seen.channels).includes('In Group'));
  });

  it('makes a channel moved in follow the group: roles AND password', async () => {
    const loose = (await as('chief', '/api/channels', {
      kind: 'voice', name: 'Loose', password: 'own-key', roles: [(await roleByName('Guest')).id],
    })).body.channel;
    assert.equal(loose.locked, true);

    await as('chief', '/api/channels/groups/' + group.id, { password: 'group-key' });
    await as('chief', '/api/channels/arrange', {
      order: [{ group: group.id }, { id: loose.id, groupId: group.id }],
    });
    const now = (await get('chief', '/api/channels')).body.channels.find((c) => c.id === loose.id);
    assert.deepEqual(now.roles, [mod.id], 'its own roles were replaced by the group\'s');
    assert.equal(now.locked, true);
    assert.equal(now.groupId, group.id);
  });

  it('follows the group when the group changes', async () => {
    const inside = (await get('chief', '/api/channels')).body.channels.filter((c) => c.groupId === group.id);
    assert.ok(inside.length >= 2);
    const guest = await roleByName('Guest');
    await as('chief', `/api/channels/groups/${group.id}`, { roles: [guest.id, mod.id] });
    for (const c of (await get('chief', '/api/channels')).body.channels.filter((x) => x.groupId === group.id)) {
      assert.deepEqual([...c.roles].sort(), [guest.id, mod.id].sort());
      assert.equal(c.locked, true, 'every channel has the group\'s password');
    }
    await as('chief', `/api/channels/groups/${group.id}`, { roles: [mod.id] });
  });

  it('refuses a channel in a group a password or roles of its own', async () => {
    const inside = (await get('chief', '/api/channels')).body.channels.find((c) => c.groupId === group.id);
    const pw = await as('chief', `/api/channels/${inside.id}`, { password: 'mine' });
    assert.equal(pw.status, 400);
    assert.equal(pw.body.error, 'follows_group');
    const rl = await as('chief', `/api/channels/${inside.id}`, { roles: [] });
    assert.equal(rl.body.error, 'follows_group');
    // …but it may still be renamed.
    assert.equal((await as('chief', `/api/channels/${inside.id}`, { name: 'Renamed In Group' })).status, 200);
  });

  it('opens every channel of a group with one entry of the password', async () => {
    const siblings = (await get('chief', '/api/channels')).body.channels
      .filter((c) => c.groupId === group.id && c.kind === 'voice');
    // Add a second voice channel to the group.
    const second = (await as('chief', '/api/channels', { kind: 'voice', name: 'Second Voice' })).body.channel;
    await as('chief', '/api/channels/arrange', {
      order: [{ group: group.id }, ...[...siblings, second].map((c) => ({ id: c.id, groupId: group.id }))],
    });
    // mod is in the group's role; entering the password for one opens both.
    const ws = connect(people.mod.token);
    await ws.hello();
    const wrong = await ws.request({ type: 'voice:join', channelId: second.id, password: 'nope' });
    assert.equal(wrong.error, 'bad_password');
    const ok = await ws.request({ type: 'voice:join', channelId: second.id, password: 'group-key' });
    assert.equal(ok.type, 'voice:joined');
    const view = (await get('mod', '/api/channels')).body.channels.filter((c) => c.groupId === group.id);
    assert.ok(view.length >= 3);
    assert.ok(view.every((c) => c.unlocked), 'the whole group is unlocked, not one door');
    ws.ws.close();
  });

  it('takes the password off everything in the group together', async () => {
    await as('chief', `/api/channels/groups/${group.id}`, { password: '' });
    const view = (await get('chief', '/api/channels')).body;
    assert.equal(view.groups.find((g) => g.id === group.id).locked, false);
    assert.ok(view.channels.filter((c) => c.groupId === group.id).every((c) => !c.locked));
  });

  it('does not open a channel to everybody when it leaves a restricted group', async () => {
    const inside = (await get('chief', '/api/channels')).body.channels.find((c) => c.groupId === group.id);
    await as('chief', '/api/channels/arrange', { order: [{ id: inside.id, groupId: null }, { group: group.id }] });
    const out = (await get('chief', '/api/channels')).body.channels.find((c) => c.id === inside.id);
    assert.deepEqual(out.roles, [mod.id]);
    assert.ok(!names((await get('helper', '/api/channels')).body.channels).includes(out.name));
  });

  it('keeps the channels, still restricted, when the group is deleted', async () => {
    const left = (await get('chief', '/api/channels')).body.channels.filter((c) => c.groupId === group.id);
    assert.equal((await as('chief', `/api/channels/groups/${group.id}/delete`, {})).status, 200);
    for (const c of left) {
      const now = (await get('chief', '/api/channels')).body.channels.find((x) => x.id === c.id);
      assert.deepEqual(now.roles, [mod.id]);
    }
  });
});

describe('server mute over the socket', () => {
  it('needs the permission and a higher rank', async () => {
    const text = (await get('chief', '/api/channels')).body.channels.find((c) => c.kind === 'voice' && c.roles.length === 0);
    const mute = async (who, victim) => {
      const v = connect(people[victim].token);
      await v.hello();
      const joined = await v.request({ type: 'voice:join', channelId: text.id });
      const a = connect(people[who].token);
      await a.hello();
      await a.request({ type: 'voice:join', channelId: text.id });
      const reply = await a.request({
        type: 'admin:force-mute', channelId: text.id, mid: joined.mid, muted: true,
      });
      v.ws.close();
      a.ws.close();
      await new Promise((done) => setTimeout(done, 100));
      return reply;
    };
    // helper (users.mute) mutes a member with no role: allowed.
    await as('chief', `/api/accounts/${people.pleb.id}/roles`, { roles: [] });
    assert.equal((await mute('helper', 'pleb')).type, 'voice:ok');
    // helper cannot mute mod (higher)
    assert.equal((await mute('helper', 'mod')).error, 'forbidden');
    // mod cannot mute boss
    assert.equal((await mute('mod', 'boss')).error, 'forbidden');
    // pleb has no permission
    assert.equal((await mute('pleb', 'target')).error, 'forbidden');
  });
});

describe('the colour of a display name', () => {
  const set = (who, nameColor) => as(who, '/api/accounts/name-color', { nameColor });

  it('starts as none, which leaves the role in charge', async () => {
    const users = (await get('pleb', '/api/accounts')).body.users;
    assert.equal(users.find((u) => u.nickname === 'pleb').nameColor, null);
  });

  it('takes a solid colour, a moving gradient, or the rainbow', async () => {
    const solid = await set('pleb', { mode: 'solid', color: '#FF00AA' });
    assert.equal(solid.status, 200, JSON.stringify(solid.body));
    assert.deepEqual(solid.body.user.nameColor, { mode: 'solid', color: '#ff00aa' });

    const gradient = await set('pleb', { mode: 'gradient', colors: ['#ff0000', '#00ff00', '#0000ff'], speed: 3 });
    assert.deepEqual(gradient.body.user.nameColor, {
      mode: 'gradient', colors: ['#ff0000', '#00ff00', '#0000ff'], speed: 3,
    });

    const rainbow = await set('pleb', { mode: 'rainbow' });
    assert.deepEqual(rainbow.body.user.nameColor, { mode: 'rainbow', speed: 6 }, 'speed has a default');
  });

  it('keeps the speed in range, and shows it to everybody', async () => {
    const fast = await set('pleb', { mode: 'rainbow', speed: 0.01 });
    assert.equal(fast.body.user.nameColor.speed, 1);
    const slow = await set('pleb', { mode: 'rainbow', speed: 9999 });
    assert.equal(slow.body.user.nameColor.speed, 30);
    const seen = (await get('other', '/api/accounts')).body.users.find((u) => u.nickname === 'pleb');
    assert.equal(seen.nameColor.mode, 'rainbow');
  });

  it('refuses anything that is not exactly one of those', async () => {
    for (const bad of [
      { mode: 'solid', color: 'red' },
      { mode: 'solid', color: 'url(javascript:1)' },
      { mode: 'solid' },
      { mode: 'gradient', colors: ['#ff0000'] },
      { mode: 'gradient', colors: ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff'] },
      { mode: 'gradient', colors: ['#ff0000', 'blue'] },
      { mode: 'rainbow', speed: 'fast' },
      { mode: 'sparkle' },
      'red',
    ]) {
      const res = await set('pleb', bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal(res.body.error, 'bad_name_color');
    }
  });

  it('goes back to none, and is one person\'s to change', async () => {
    assert.equal((await set('pleb', null)).body.user.nameColor, null);
    await set('pleb', { mode: 'solid', color: '#123456' });
    // Nobody else's call: the route takes no id.
    const mine = (await get('other', '/api/accounts')).body.users.find((u) => u.nickname === 'other');
    assert.equal(mine.nameColor, null);
    assert.equal((await api('/api/accounts/name-color', { method: 'POST', body: { nameColor: null } })).status, 401);
  });
});

describe('badges', () => {
  const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const upload = async (bytes, contentType, who) => {
    const res = await fetch(`${BASE}/api/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': contentType, Authorization: `Bearer ${people[who].token}` },
      body: bytes,
    });
    return res.json();
  };
  let sword;
  let medal;
  let curator;   // may create and edit badges, award none
  let awarder;   // may award `medal` only
  let medalRole;

  before(async () => {
    // Fresh accounts: the earlier describes left everybody with roles.
    for (const n of ['curator', 'awarder', 'winner']) await register(n);
    curator = (await as('chief', '/api/roles', { name: 'Curator', permissions: ['badges.create', 'badges.edit'] })).body.role;
    awarder = (await as('chief', '/api/roles', { name: 'Awarder' })).body.role;
    await as('chief', `/api/accounts/${people.curator.id}/roles`, { roles: [curator.id] });
    await as('chief', `/api/accounts/${people.awarder.id}/roles`, { roles: [awarder.id] });
  });

  it('is made with a name, a description and an emoji, by somebody with the permission', async () => {
    assert.equal((await as('winner', '/api/badges', { name: 'Nope', emoji: '🏆' })).status, 403);
    const res = await as('curator', '/api/badges', { name: 'Devoted', description: '424 hours of games', emoji: '⚔️' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    sword = res.body.badge;
    assert.deepEqual([sword.name, sword.description, sword.emoji, sword.imageHash], ['Devoted', '424 hours of games', '⚔️', null]);
    assert.deepEqual((await get('winner', '/api/badges')).body.badges.map((b) => b.name), ['Devoted']);
  });

  it('can be a picture instead, which has to be an uploaded image', async () => {
    assert.equal((await as('curator', '/api/badges', { name: 'Ghost', imageHash: 'a'.repeat(64) })).status, 400);
    const { hash } = await upload(GIF, 'image/gif', 'curator');
    const res = await as('curator', '/api/badges', { name: 'Medal', description: 'For being first', imageHash: hash });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    medal = res.body.badge;
    assert.equal(medal.imageHash, hash);
    const text = await upload(Buffer.from('not a picture'), 'text/plain', 'curator');
    assert.equal((await as('curator', '/api/badges', { name: 'Text', imageHash: text.hash })).status, 400);
  });

  it('refuses a badge with no picture, a bad emoji, a repeated name', async () => {
    assert.equal((await as('curator', '/api/badges', { name: 'Blank' })).body.error, 'needs_picture');
    assert.equal((await as('curator', '/api/badges', { name: 'Bad', emoji: 'abc' })).body.error, 'invalid_emoji');
    assert.equal((await as('curator', '/api/badges', { name: 'devoted', emoji: '🏆' })).body.error, 'name_taken');
    assert.equal((await as('curator', '/api/badges', { name: '', emoji: '🏆' })).body.error, 'invalid_name');
  });

  it('is edited and deleted only with badges.edit', async () => {
    assert.equal((await as('winner', `/api/badges/${sword.id}`, { name: 'Hacked' })).status, 403);
    const res = await as('curator', `/api/badges/${sword.id}`, { description: 'Over 424 hours' });
    assert.equal(res.body.badge.description, 'Over 424 hours');
    assert.equal((await as('winner', `/api/badges/${sword.id}/delete`, {})).status, 403);
  });

  it('is handed out only by those whose role lists it', async () => {
    // Nobody can award yet: not even the curator.
    assert.equal((await as('curator', `/api/accounts/${people.winner.id}/badges`, { badges: [sword.id] })).status, 403);
    assert.equal((await as('awarder', `/api/accounts/${people.winner.id}/badges`, { badges: [sword.id] })).status, 403);

    // The owner lists the sword on Awarder; a role may not list what its editor cannot award.
    const listed = await as('chief', `/api/roles/${awarder.id}`, { assignableBadges: [sword.id] });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(listed.body.role.assignableBadges, [sword.id]);

    const given = await as('awarder', `/api/accounts/${people.winner.id}/badges`, { badges: [sword.id] });
    assert.equal(given.status, 200, JSON.stringify(given.body));
    assert.deepEqual(given.body.user.badges, [sword.id]);
    // Not the one it does not list.
    assert.equal((await as('awarder', `/api/accounts/${people.winner.id}/badges`, { badges: [sword.id, medal.id] })).status, 403);
    // And may take it back.
    assert.deepEqual((await as('awarder', `/api/accounts/${people.winner.id}/badges`, { badges: [] })).body.user.badges, []);
  });

  it('cannot be put in a role\'s list by somebody who could not award it', async () => {
    // RoleMaker first, so the role it edits is below it.
    const helper = (await as('chief', '/api/roles', { name: 'RoleMaker', permissions: ['roles.hierarchy'], assignableBadges: [sword.id] })).body.role;
    medalRole = (await as('chief', '/api/roles', { name: 'Medals' })).body.role;
    await register('rolemaker');
    await as('chief', `/api/accounts/${people.rolemaker.id}/roles`, { roles: [helper.id] });
    const res = await as('rolemaker', `/api/roles/${medalRole.id}`, { assignableBadges: [medal.id] });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'cannot_grant');
    assert.equal((await as('rolemaker', `/api/roles/${medalRole.id}`, { assignableBadges: [sword.id] })).status, 200);
  });

  it('shows on the account, and goes everywhere at once', async () => {
    const ws = new WebSocket(WS_URL);
    const inbox = [];
    ws.addEventListener('message', (e) => inbox.push(JSON.parse(e.data)));
    await new Promise((done) => ws.addEventListener('open', done, { once: true }));
    ws.send(JSON.stringify({ type: 'hello', token: people.pleb.token, rid: 'h' }));
    await new Promise((done) => setTimeout(done, 300));
    const hello = inbox.find((m) => m.type === 'hello-ok');
    assert.ok(hello.badges.some((b) => b.name === 'Devoted'), 'the hello carries the badges');

    const mark = inbox.length;
    await as('chief', `/api/accounts/${people.winner.id}/badges`, { badges: [sword.id, medal.id] });
    const pushed = inbox.slice(mark).find((m) => m.type === 'user:updated' && m.user.id === people.winner.id);
    assert.deepEqual(pushed.user.badges.sort(), [sword.id, medal.id].sort());
    ws.close();
  });

  it('is gone from everybody when the badge is deleted, and from the lists that named it', async () => {
    assert.equal((await as('curator', `/api/badges/${sword.id}/delete`, {})).status, 200);
    const winner = (await get('chief', '/api/accounts')).body.users.find((u) => u.nickname === 'winner');
    assert.deepEqual(winner.badges, [medal.id]);
    assert.deepEqual((await get('chief', '/api/roles')).body.roles.find((r) => r.id === awarder.id).assignableBadges, []);
  });
});

describe('channels for several roles, and for people by name', () => {
  let a;
  let b;
  let room;
  before(async () => {
    for (const n of ['anna', 'ben', 'cleo', 'dan']) await register(n);
    a = (await as('chief', '/api/roles', { name: 'RoleA' })).body.role;
    b = (await as('chief', '/api/roles', { name: 'RoleB' })).body.role;
    await as('chief', `/api/accounts/${people.anna.id}/roles`, { roles: [a.id] });
    await as('chief', `/api/accounts/${people.ben.id}/roles`, { roles: [b.id] });
  });
  const sees = async (who, name) => names((await get(who, '/api/channels')).body.channels).includes(name);

  it('is visible to every one of several roles, and to nobody outside them', async () => {
    const res = await as('chief', '/api/channels', { kind: 'text', name: 'Two Roles', roles: [a.id, b.id] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    room = res.body.channel;
    assert.deepEqual([...room.roles].sort(), [a.id, b.id].sort());
    assert.equal(await sees('anna', 'Two Roles'), true);
    assert.equal(await sees('ben', 'Two Roles'), true);
    assert.equal(await sees('cleo', 'Two Roles'), false);
  });

  it('can also name people, who then see it without the role', async () => {
    const res = await as('chief', `/api/channels/${room.id}`, { users: [people.cleo.id] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.channel.users, [people.cleo.id]);
    assert.equal(await sees('cleo', 'Two Roles'), true, 'named, with no role');
    assert.equal(await sees('anna', 'Two Roles'), true, 'the roles still count');
    assert.equal(await sees('dan', 'Two Roles'), false, 'and nobody else');
    // Reading and posting follow what is seen.
    assert.equal((await as('cleo', `/api/channels/${room.id}/messages`, { body: 'let in by name' })).status, 201);
    assert.equal((await get('dan', `/api/channels/${room.id}/messages`)).status, 404);
  });

  it('can be only people, with no roles at all', async () => {
    const res = await as('chief', '/api/channels', { kind: 'text', name: 'Just Dan', users: [people.dan.id] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(await sees('dan', 'Just Dan'), true);
    assert.equal(await sees('anna', 'Just Dan'), false);
  });

  it('applies the instant somebody is added or taken off the list, over the socket', async () => {
    const ws = new WebSocket(WS_URL);
    const inbox = [];
    ws.addEventListener('message', (e) => inbox.push(JSON.parse(e.data)));
    await new Promise((done) => ws.addEventListener('open', done, { once: true }));
    ws.send(JSON.stringify({ type: 'hello', token: people.cleo.token, rid: 'h' }));
    await new Promise((done) => setTimeout(done, 300));
    const mark = inbox.length;
    const id = (await get('chief', '/api/channels')).body.channels.find((c) => c.name === 'Just Dan').id;
    await as('chief', `/api/channels/${id}`, { users: [people.dan.id, people.cleo.id] });
    const added = inbox.slice(mark).filter((m) => m.type === 'channels').at(-1);
    assert.ok(names(added.channels).includes('Just Dan'), 'shown to the person just named');
    const mark2 = inbox.length;
    await as('chief', `/api/channels/${id}`, { users: [people.dan.id] });
    const removed = inbox.slice(mark2).filter((m) => m.type === 'channels').at(-1);
    assert.ok(!names(removed.channels).includes('Just Dan'), 'and taken away again');
    ws.close();
  });

  it('is followed by every channel in a group, and refused to a channel inside one', async () => {
    const g = (await as('chief', '/api/channels/groups', { name: 'Names', users: [people.dan.id] })).body.group;
    assert.deepEqual(g.users, [people.dan.id]);
    const c = (await as('chief', '/api/channels', { kind: 'text', name: 'In Names' })).body.channel;
    await as('chief', '/api/channels/arrange', { order: [{ group: g.id }, { id: c.id, groupId: g.id }] });
    assert.equal(await sees('dan', 'In Names'), true);
    assert.equal(await sees('anna', 'In Names'), false);
    assert.ok(names((await get('dan', '/api/channels')).body.groups).includes('Names'), 'and the heading too');
    const refused = await as('chief', `/api/channels/${c.id}`, { users: [people.anna.id] });
    assert.equal(refused.body.error, 'follows_group');
    await as('chief', `/api/channels/groups/${g.id}`, { users: [people.dan.id, people.anna.id] });
    assert.equal(await sees('anna', 'In Names'), true, 'a change to the group reaches its channels');
  });

  it('refuses somebody who does not exist, and needs the permission', async () => {
    const bad = await as('chief', '/api/channels', { kind: 'text', name: 'Ghost Guest', users: [99999] });
    assert.equal(bad.status, 404);
    assert.equal(await sees('chief', 'Ghost Guest'), false, 'not left behind');
    assert.equal((await as('pleb', '/api/channels', { kind: 'text', name: 'X', users: [people.dan.id] })).status, 403);
  });

  it('forgets a person who is deleted', async () => {
    await register('temp');
    const made = (await as('chief', '/api/channels', { kind: 'text', name: 'Temp Only', users: [people.temp.id] })).body.channel;
    assert.equal(await sees('temp', 'Temp Only'), true);
    await as('chief', `/api/accounts/${people.temp.id}/delete`, {});
    const now = (await get('chief', '/api/channels')).body.channels.find((c) => c.id === made.id);
    assert.deepEqual(now.users, []);
  });
});

describe('admins hold every key', () => {
  let vc;
  let tc;
  const joinAs = async (who, password) => {
    const ws = new WebSocket(WS_URL);
    const inbox = [];
    ws.addEventListener('message', (e) => inbox.push(JSON.parse(e.data)));
    await new Promise((done) => ws.addEventListener('open', done, { once: true }));
    ws.send(JSON.stringify({ type: 'hello', token: people[who].token, rid: 'h' }));
    await new Promise((done) => setTimeout(done, 200));
    ws.send(JSON.stringify({ type: 'voice:join', channelId: vc.id, ...(password ? { password } : {}), rid: 'j' }));
    await new Promise((done) => setTimeout(done, 250));
    const reply = inbox.find((m) => m.rid === 'j');
    ws.close();
    return reply;
  };

  before(async () => {
    await register('keyless');
    vc = (await as('chief', '/api/channels', { kind: 'voice', name: 'Vault Voice', password: 'sesame' })).body.channel;
    tc = (await as('chief', '/api/channels', { kind: 'text', name: 'Vault Text', password: 'sesame' })).body.channel;
  });

  it('lets the owner, a super admin and an admin role into a passworded voice channel with no password', async () => {
    for (const who of ['chief', 'sup', 'boss']) {
      const reply = await joinAs(who);
      assert.equal(reply?.type, 'voice:joined', `${who}: ${JSON.stringify(reply)}`);
    }
  });

  it('still asks everybody else', async () => {
    assert.equal((await joinAs('keyless'))?.error, 'password_required');
    assert.equal((await joinAs('keyless', 'wrong'))?.error, 'bad_password');
    assert.equal((await joinAs('mod'))?.error, 'password_required', 'a role that is not an admin role has no key either');
  });

  it('reads and writes a passworded text channel without being let in', async () => {
    for (const who of ['chief', 'sup', 'boss']) {
      assert.equal((await get(who, `/api/channels/${tc.id}/messages`)).status, 200, who);
      assert.equal((await as(who, `/api/channels/${tc.id}/messages`, { body: `from ${who}` })).status, 201, who);
    }
    assert.equal((await get('keyless', `/api/channels/${tc.id}/messages`)).status, 404);
  });

  it('shows it as unlocked to them, and as locked to everybody else', async () => {
    const view = async (who) => (await get(who, '/api/channels')).body.channels.find((c) => c.id === tc.id);
    for (const who of ['chief', 'sup', 'boss']) assert.equal((await view(who)).unlocked, true, who);
    assert.equal((await view('keyless')).unlocked, false);
  });

  it('sends a locked channel\'s messages to admins live, and to nobody else without the key', async () => {
    const connectAs = async (who) => {
      const ws = new WebSocket(WS_URL);
      const inbox = [];
      ws.addEventListener('message', (e) => inbox.push(JSON.parse(e.data)));
      await new Promise((done) => ws.addEventListener('open', done, { once: true }));
      ws.send(JSON.stringify({ type: 'hello', token: people[who].token, rid: 'h' }));
      await new Promise((done) => setTimeout(done, 200));
      return { ws, inbox };
    };
    const admin = await connectAs('boss');
    const other = await connectAs('keyless');
    await as('chief', `/api/channels/${tc.id}/messages`, { body: 'for those with the key' });
    await new Promise((done) => setTimeout(done, 300));
    assert.ok(admin.inbox.some((m) => m.type === 'message' && m.message.body === 'for those with the key'));
    assert.ok(!other.inbox.some((m) => m.type === 'message' && m.message.body === 'for those with the key'));
    admin.ws.close();
    other.ws.close();
  });

  it('sees channels restricted to roles and people it is not in, however it was restricted', async () => {
    const hidden = (await as('chief', '/api/channels', { kind: 'text', name: 'Eyes Only', roles: [(await roleByName('Guest')).id], users: [people.keyless.id] })).body.channel;
    for (const who of ['chief', 'sup', 'boss']) {
      assert.ok(names((await get(who, '/api/channels')).body.channels).includes('Eyes Only'), who);
    }
    assert.equal((await get('boss', `/api/channels/${hidden.id}/messages`)).status, 200);
    assert.ok(!names((await get('other', '/api/channels')).body.channels).includes('Eyes Only'));
  });
});

describe('a channel made inside a group', () => {
  it('is born with the group\'s password, roles and people, never open for a moment', async () => {
    const guest = await roleByName('Guest');
    const g = (await as('chief', '/api/channels/groups', {
      name: 'Born Inside', password: 'inside', roles: [guest.id], users: [people.dan.id],
    })).body.group;
    const made = await as('chief', '/api/channels', { kind: 'text', name: 'Newborn', groupId: g.id, password: 'ignored', roles: [] });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const c = made.body.channel;
    assert.equal(c.groupId, g.id);
    assert.equal(c.locked, true);
    assert.deepEqual(c.roles, [guest.id]);
    assert.deepEqual(c.users, [people.dan.id]);
    // The group's key opens it; the one that was passed does not.
    assert.equal((await as('chief', `/api/channels/${c.id}`, { password: 'x' })).body.error, 'follows_group');
  });

  it('refuses a group that is not there, or that the caller cannot see', async () => {
    assert.equal((await as('chief', '/api/channels', { kind: 'text', name: 'Orphan', groupId: 99999 })).status, 404);
    const hidden = (await as('chief', '/api/channels/groups', { name: 'Hidden Group', users: [people.dan.id] })).body.group;
    // pleb has no create permission at all; a role that may create but is outside the group:
    const maker = (await as('chief', '/api/roles', { name: 'GroupMaker', permissions: ['channels.create'] })).body.role;
    await register('maker2');
    await as('chief', `/api/accounts/${people.maker2.id}/roles`, { roles: [maker.id] });
    const res = await as('maker2', '/api/channels', { kind: 'text', name: 'Sneaky', groupId: hidden.id });
    assert.equal(res.status, 404, 'a group nobody told them about does not exist');
    assert.ok(!names((await get('chief', '/api/channels')).body.channels).includes('Sneaky'));
  });
});

describe('a role\'s name style', () => {
  it('is a plain colour, a gradient that moves, or the rainbow', async () => {
    const plain = (await as('chief', '/api/roles', { name: 'Plain Style', color: '#112233' })).body.role;
    assert.equal(plain.style, null);

    const grad = await as('chief', `/api/roles/${plain.id}`, {
      color: '#ff0000', style: { mode: 'gradient', colors: ['#ff0000', '#0000ff'], speed: 4 },
    });
    assert.equal(grad.status, 200, JSON.stringify(grad.body));
    assert.deepEqual(grad.body.role.style, { mode: 'gradient', colors: ['#ff0000', '#0000ff'], speed: 4 });
    assert.equal(grad.body.role.color, '#ff0000', 'the plain colour stays, for the dot beside the name');

    const rainbow = await as('chief', `/api/roles/${plain.id}`, { style: { mode: 'rainbow', speed: 2 } });
    assert.deepEqual(rainbow.body.role.style, { mode: 'rainbow', speed: 2 });
    assert.equal((await roleByName('Plain Style')).style.mode, 'rainbow');

    const back = await as('chief', `/api/roles/${plain.id}`, { style: null });
    assert.equal(back.body.role.style, null);
  });

  it('can be set when the role is made, and is refused when it is not one of those', async () => {
    const made = await as('chief', '/api/roles', { name: 'Born Rainbow', style: { mode: 'rainbow' } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.deepEqual(made.body.role.style, { mode: 'rainbow', speed: 6 });
    for (const bad of [{ mode: 'solid', color: '#ff0000' }, { mode: 'gradient', colors: ['#ff0000'] }, { mode: 'sparkle' }, 'red']) {
      const res = await as('chief', `/api/roles/${made.body.role.id}`, { style: bad });
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal(res.body.error, 'invalid_style');
    }
    // A name edit leaves the style alone.
    await as('chief', `/api/roles/${made.body.role.id}`, { name: 'Still Rainbow' });
    assert.equal((await roleByName('Still Rainbow')).style.mode, 'rainbow');
  });

  it('is reached by everybody, with the role list', async () => {
    const seen = (await get('keyless', '/api/roles')).body.roles.find((r) => r.name === 'Still Rainbow');
    assert.equal(seen.style.mode, 'rainbow');
  });
});

describe('mentioning a role', () => {
  let text;
  let tag;
  before(async () => {
    // Earlier suites have shut the first channel behind roles and groups: this one is open.
    text = (await as('chief', '/api/channels', { name: 'mentions-room', kind: 'text' })).body.channel;
    tag = (await as('chief', '/api/roles', { name: 'Night Owls' })).body.role;
  });

  it('is written as @ and the role\'s name, folded like a nickname', async () => {
    const posted = await as('pleb', `/api/channels/${text.id}/messages`, { body: 'hey @night-owls, anyone up?' });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    assert.deepEqual(posted.body.message.mentionRoles, [tag.id]);
    assert.deepEqual(posted.body.message.mentions, []);
    assert.equal(posted.body.message.mentionsEveryone, false);
  });

  it('still says so when the history is read back', async () => {
    const list = (await get('pleb', `/api/channels/${text.id}/messages`)).body.messages;
    const found = list.find((m) => m.body.startsWith('hey @night-owls'));
    assert.deepEqual(found.mentionRoles, [tag.id]);
  });

  it('is pushed with the message, which names the role for whoever holds it', async () => {
    const holder = connect(people.other.token);
    await holder.hello();
    const mark = holder.mark();
    await as('chief', `/api/accounts/${people.other.id}/roles`, { roleIds: [tag.id] });
    await as('pleb', `/api/channels/${text.id}/messages`, { body: '@Night-Owls again' });
    await holder.next((m) => m.type === 'message' && m.message.body === '@Night-Owls again');
    const got = holder.since(mark, 'message').find((m) => m.message.body === '@Night-Owls again');
    assert.deepEqual(got.message.mentionRoles, [tag.id]);
    holder.ws.close();
  });

  it('is nothing when no role has that name, and a person\'s nickname is never a role\'s', async () => {
    const none = await as('pleb', `/api/channels/${text.id}/messages`, { body: '@nobody-here' });
    assert.deepEqual(none.body.message.mentionRoles, []);

    // A role called like somebody: the person is who is meant.
    const clash = (await as('chief', '/api/roles', { name: 'target' })).body.role;
    const posted = await as('pleb', `/api/channels/${text.id}/messages`, { body: 'psst @target' });
    assert.deepEqual(posted.body.message.mentions, [people.target.id]);
    assert.deepEqual(posted.body.message.mentionRoles, []);
    await as('chief', `/api/roles/${clash.id}/delete`, {});
  });

  it('follows the role when it is renamed', async () => {
    await as('chief', `/api/roles/${tag.id}`, { name: 'Early Birds' });
    const old = await as('pleb', `/api/channels/${text.id}/messages`, { body: '@night-owls' });
    assert.deepEqual(old.body.message.mentionRoles, []);
    const fresh = await as('pleb', `/api/channels/${text.id}/messages`, { body: '@early-birds' });
    assert.deepEqual(fresh.body.message.mentionRoles, [tag.id]);
  });
});
