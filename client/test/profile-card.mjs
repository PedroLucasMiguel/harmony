// The profile card, multiple roles and the member list's sections: two real app windows.
//
//
//   node client/test/profile-card.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const serverEntry = resolve(repoRoot, 'server', 'src', 'index.js');

const HARMONY_PORT = 18320;
const FAKE_MTX_PORT = 20320;
const PORT_OWNER = 9641;
const PORT_BOB = 9642;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-card-ui-'));
const { check, summary } = reporter();
const procs = [];
let fakeMtx = null;
let serverLog = '';
let ownerKey = null;

function cleanup() {
  for (const p of procs) {
    try { p.kill(); } catch { /* already gone */ }
  }
  try { fakeMtx?.close(); } catch { /* already closed */ }
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

function startFakeMediaMtx() {
  return new Promise((done) => {
    fakeMtx = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ itemCount: 0, pageCount: 0, items: [] }));
    });
    fakeMtx.listen(FAKE_MTX_PORT, '127.0.0.1', done);
  });
}

function startServer() {
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        HARMONY_PORT: String(HARMONY_PORT),
        HARMONY_HOST: '127.0.0.1',
        HARMONY_DATA_DIR: dataDir,
        HARMONY_MEDIAMTX_API: `http://127.0.0.1:${FAKE_MTX_PORT}`,
        HARMONY_SIGNALING_URL: 'http://media.test:8889',
        HARMONY_POLL_INTERVAL_MS: '400',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    procs.push(p);
    const timer = setTimeout(() => fail(new Error('server did not start')), 15_000);
    p.stdout.on('data', (b) => {
      serverLog += b.toString();
      const match = /^\s*│\s+([A-Za-z0-9_-]{20,})\s+│$/m.exec(serverLog);
      if (match) ownerKey = match[1];
      if (serverLog.includes('control server on')) {
        clearTimeout(timer);
        done();
      }
    });
    p.stderr.on('data', (b) => (serverLog += b.toString()));
  });
}

const tokens = {};
async function register(nickname, extra = {}) {
  const res = await fetch(`${BASE}/api/accounts/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, password: 'hunter22', ...extra }),
  });
  if (!res.ok) throw new Error(`register ${nickname}: ${res.status}`);
  const body = await res.json();
  tokens[nickname] = body.token;
  return body.user;
}
const rest = async (as, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[as]}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const STUBS = `
  const md = navigator.mediaDevices;
  md.enumerateDevices = async () => [];
  md.getUserMedia = async () => { throw new DOMException('no device', 'NotFoundError'); };
  return true;`;

const setInput = (id, value) => `{
  const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
  i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
}`;

async function signIn(port, nickname) {
  const app = launchApp({
    port,
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-card-ui-profile-')),
    extraArgs: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  procs.push(app);
  const page = await attach(await findPage(port));
  await sleep(1500);
  await page.evaluate(STUBS);
  await page.evaluate(`${setInput('server-url', BASE)} return true;`);
  await sleep(4000);
  await page.evaluate(`${setInput('username', nickname)} ${setInput('account-password', 'hunter22')}
    document.getElementById('continue').click(); return true;`);
  await waitFor(page, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: `${nickname} signing in`, timeoutMs: 60_000 });
  await sleep(1500);
  return page;
}

async function until(page, expression, { timeoutMs = 10_000, label = expression } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await page.evaluate(`return (${expression})`).catch(() => undefined);
    if (last) return last;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

/** ROLES_SHOTS=/some/dir saves a picture of each page, for looking at rather than asserting. */
async function shot(page, name) {
  const dir = process.env.ROLES_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(dir, `${name}.png`), Buffer.from(data, 'base64'));
}

const click = (page, selector) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); return true;`);
const tab = (page, name) => click(page, `#server-dialog .settings-tab[data-tab="${name}"]`);
/** Click the checkbox whose label contains this text, inside a container. */
const tick = (page, container, label) => page.evaluate(`{
  const row = [...document.querySelectorAll(${JSON.stringify(`${container} label.check`)})]
    .find((l) => l.textContent.includes(${JSON.stringify(label)}));
  row.querySelector('input').click();
  return true;
}`);
const nameColor = (page, selector) => page.evaluate(`{
  const n = document.querySelector(${JSON.stringify(selector)});
  return n ? getComputedStyle(n).color : null;
}`);


const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;

async function run() {
  console.log('Starting the server and two clients…\n');
  await startFakeMediaMtx();
  await startServer();
  const chief = await register('chief', { ownerKey });
  const bob = await register('bob');
  const carol = await register('carol');

  // Two roles, Helper above VIP, each with something the other lacks.
  const helper = (await rest('chief', '/api/roles', { name: 'Helper', color: '#22aa66', permissions: ['users.kick'] })).body.role;
  const vip = (await rest('chief', '/api/roles', { name: 'VIP', color: '#ff8800', permissions: ['messages.delete'] })).body.role;

  // --- several roles at once, merged --------------------------------------------------------------------------------
  const both = await rest('chief', `/api/accounts/${bob.id}/roles`, { roles: [vip.id, helper.id] });
  check('somebody can hold several roles at once', both.status === 200 && both.body.user.roles.length === 2, JSON.stringify(both.body.user?.roles));
  const text = (await rest('bob', '/api/channels')).body.channels.find((c) => c.kind === 'text');
  const posted = await rest('carol', `/api/channels/${text.id}/messages`, { body: 'delete me' });
  const del = await rest('bob', `/api/messages/${posted.body.message.id}/delete`, {});
  check('their permissions are merged: one role\'s (delete any message) and the other\'s (kick) both apply',
    del.status === 200 && (await rest('bob', `/api/accounts/${carol.id}/kick`, {})).status === 200,
    `delete ${del.status}`);
  await rest('chief', `/api/accounts/${carol.id}/roles`, { roles: [helper.id] });

  const owner = await signIn(PORT_OWNER, 'chief');
  const bobPage = await signIn(PORT_BOB, 'bob');
  for (const [name, page] of [['owner', owner], ['bob', bobPage]]) {
    await page.send('Runtime.enable');
    page.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
      console.log(`  [${name} exception]`, (d.exception?.description ?? d.text).split('\n').slice(0, 3).join(' / ').slice(0, 300));
    });
    await page.evaluate("if (document.getElementById('member-list').hidden) document.getElementById('channels-members').click(); return true;");
  }
  await sleep(1500);

  // --- the member list's sections -----------------------------------------------------------------------------------
  const sections = () => owner.evaluate(`{
    const out = []; let head = null;
    for (const li of document.querySelectorAll('#member-items > li')) {
      if (li.classList.contains('member-head')) { head = li.textContent; out.push([head, []]); }
      else out.at(-1)[1].push(li.querySelector('.member-name').textContent);
    }
    return out;
  }`);
  let list = await sections();
  check('somebody with two roles sits under the higher one only',
    JSON.stringify(list.find(([h]) => h === 'Helper — 1')?.[1]) === '["bob"]'
    && !list.some(([h]) => h.startsWith('VIP')), JSON.stringify(list));
  check('the owner has a section of their own, first', list[0][0].startsWith('owner'), list[0][0]);
  const offlineAt = list.findIndex(([h]) => h.startsWith('Offline'));
  check('people who are away are one Offline section, like everybody', offlineAt === list.length - 1
    && JSON.stringify(list[offlineAt][1]) === '["carol"]', JSON.stringify(list));
  await sleep(600);
  const carolColor = await owner.evaluate(`return getComputedStyle(document.querySelector('#member-items .member-row[data-off] .member-name')).color`);
  check('and Carol, offline, still has her role\'s colour on her name', carolColor === rgb('#22aa66'), carolColor);
  check('with no empty "Online" heading in the way', !list.some(([h]) => h.startsWith('Online')), JSON.stringify(list.map(([h]) => h)));
  await shot(owner, 'members');

  const scheme = await owner.evaluate(`{
    const root = document.documentElement;
    const dark = getComputedStyle(root).colorScheme;
    root.dataset.theme = 'daylight';
    const light = getComputedStyle(root).colorScheme;
    delete root.dataset.theme;
    return { dark, light };
  }`);
  check('native pickers follow the theme: dark on dark palettes, light on daylight', scheme.dark === 'dark' && scheme.light === 'light', JSON.stringify(scheme));

  // --- the owner's and a super admin's marks --------------------------------------------------------------------------
  await rest('chief', `/api/accounts/${carol.id}/role`, { role: 'admin' });
  await sleep(800);
  const marks = await owner.evaluate(`{
    const mark = (id) => { const i = document.querySelector('#member-items .member-row[data-user-id="' + id + '"] .role-icon'); return i ? { kind: i.dataset.kind, icon: i.dataset.icon, label: i.getAttribute('aria-label'), color: getComputedStyle(i).color } : null; };
    return { owner: mark(${chief.id}), superAdmin: mark(${carol.id}), plain: mark(${bob.id}), words: document.querySelectorAll('#member-items .role-tag').length };
  }`);
  await shot(owner, 'marks');
  check('the owner is marked with a crown and a super admin with a shield, not with words',
    marks.owner?.icon === 'crown-simple' && marks.superAdmin?.icon === 'shield-star' && marks.plain === null && marks.words === 0, JSON.stringify(marks));
  check('each says what it is to anything that reads it, and has its own colour',
    marks.owner.label === 'owner' && marks.superAdmin.label === 'super admin' && marks.owner.color !== marks.superAdmin.color, JSON.stringify(marks));
  await rest('chief', `/api/accounts/${carol.id}/role`, { role: 'member' });
  await sleep(500);

  // --- the card from the member list ---------------------------------------------------------------------------------
  await click(owner, `#member-items .member-row[data-user-id="${bob.id}"]`);
  await until(owner, "!document.querySelector('.profile-card').hidden", { label: 'the card' });
  const card = await owner.evaluate(`{
    const c = document.querySelector('.profile-card');
    return {
      name: c.querySelector('.profile-card-name').textContent,
      chips: [...c.querySelectorAll('.profile-card-chips .role-chip')].map((x) => x.textContent.trim()).filter(Boolean),
      removable: c.querySelectorAll('.profile-card-chip-x').length,
      banner: Boolean(c.querySelector('.profile-card-banner')),
      avatar: Boolean(c.querySelector('.profile-card-avatar')),
      round: (() => { const a = getComputedStyle(c.querySelector('.profile-card-avatar')); return a.borderRadius === '50%' && a.overflow === 'hidden'; })(),
      initials: !c.querySelector('.profile-card-avatar img'),
      // The circle of somebody with no picture must not let the banner behind it show through.
      avatarFill: getComputedStyle(c.querySelector('.profile-card-avatar')).backgroundColor,
      buttons: [...c.querySelectorAll('.profile-card-actions button')].map((b) => b.getAttribute('aria-label')),
      inside: (() => { const r = c.getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })(),
    };
  }`);
  await shot(owner, 'card');
  check('clicking a member opens a card with their name, picture, banner and both roles',
    card.name === 'bob' && card.banner && card.avatar && card.round && card.chips.includes('Helper') && card.chips.includes('VIP'), JSON.stringify(card));
  check('a face that is only initials is solid, not see-through onto the banner',
    card.initials && /^rgb\(/.test(card.avatarFill) || /, 1\)$/.test(card.avatarFill), JSON.stringify({ initials: card.initials, fill: card.avatarFill }));
  check('with a shortcut to manage roles, and the card stays inside the window', card.buttons.some((b) => /manage/i.test(b)) && card.inside, JSON.stringify(card.buttons));

  // Roles taken off and put back from the card itself.
  const bobRoles = async () => (await rest('chief', '/api/accounts')).body.users.find((u) => u.id === bob.id).roles.length;
  await owner.evaluate(`{
    const chip = [...document.querySelectorAll('.profile-card-chips .role-chip')].find((c) => c.textContent.includes('VIP'));
    chip.querySelector('.profile-card-chip-x').click(); return true;
  }`);
  await until(owner, "![...document.querySelectorAll('.profile-card-chips .role-chip')].some((c) => c.textContent.includes('VIP'))", { label: 'the chip going' });
  check('the x on a role chip takes the role away', (await bobRoles()) === 1, String(await bobRoles()));
  await click(owner, '.profile-card-add');
  await until(owner, "document.querySelector('.profile-card-pick')", { label: 'the role picker' });
  await owner.evaluate("[...document.querySelectorAll('.profile-card-pick button')].find((b) => b.textContent.includes('VIP')).click(); return true;");
  await until(owner, "[...document.querySelectorAll('.profile-card-chips .role-chip')].some((c) => c.textContent.includes('VIP'))", { label: 'the chip returning' });
  check('and the + adds one', (await bobRoles()) === 2, String(await bobRoles()));
  check('Bob\'s own window followed at once: his name is the higher role\'s colour',
    await until(bobPage, `getComputedStyle(document.getElementById('channels-who')).color === ${JSON.stringify(rgb('#22aa66'))}`, { timeoutMs: 4000 }).then(() => true).catch(() => false), '');

  // The manage shortcut opens the Members page on them.
  await click(owner, '.profile-card-actions button[aria-label*="anage"]');
  await until(owner, "document.getElementById('server-dialog').open && !document.getElementById('members-editor').hidden", { label: 'Members page' });
  check('the manage shortcut opens the Members page on that person', await owner.evaluate("return document.querySelector('#member-subject').textContent.includes('bob')"), '');
  await click(owner, '#server-cancel');

  // --- the card from a chat message ----------------------------------------------------------------------------------
  await rest('bob', `/api/channels/${text.id}/messages`, { body: 'hello from bob' });
  await owner.evaluate(`[...document.querySelectorAll('#channel-items .channel-row')].find((r) => r.textContent.includes(${JSON.stringify(text.name)})).click(); return true;`);
  await until(owner, "document.querySelector('#chat-log [data-profile-user]')", { label: 'a message with a face' });
  await owner.evaluate("document.querySelector('#chat-log .msg-avatar[data-profile-user]').click(); return true;");
  await until(owner, "!document.querySelector('.profile-card').hidden", { label: 'the card from the chat' });
  check('clicking a picture in the chat opens their card too', await owner.evaluate("return document.querySelector('.profile-card-name').textContent") === 'bob', '');
  await owner.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true;");
  check('Escape puts it away', await owner.evaluate("return document.querySelector('.profile-card').hidden"), '');

  // --- the card from a voice channel ----------------------------------------------------------------------------------
  const voice = (await rest('bob', '/api/channels')).body.channels.find((c) => c.kind === 'voice');
  // Bob joins from a socket of the test's own: this is about the card, not about his microphone.
  const ws = new WebSocket(`ws://127.0.0.1:${HARMONY_PORT}/ws`);
  await new Promise((done) => ws.addEventListener('open', done, { once: true }));
  ws.send(JSON.stringify({ type: 'hello', token: tokens.bob, rid: 'h' }));
  await sleep(500);
  ws.send(JSON.stringify({ type: 'voice:join', channelId: voice.id, rid: 'j' }));
  await until(owner, "document.querySelector('#channel-items .channel-member[data-profile-user]')", { label: 'Bob in the voice channel', timeoutMs: 15000 });
  await owner.evaluate("document.querySelector('#channel-items .channel-member[data-profile-user]').click(); return true;");
  await until(owner, "!document.querySelector('.profile-card').hidden", { label: 'the card from the voice channel' });
  ws.close();
  check('and clicking somebody in a voice channel', await owner.evaluate("return document.querySelector('.profile-card-name').textContent") === 'bob', '');

  // --- what a member sees --------------------------------------------------------------------------------------------
  await click(bobPage, `#member-items .member-row[data-user-id="${(await rest('chief', '/api/accounts')).body.users.find((u) => u.nickname === 'chief').id}"]`);
  await until(bobPage, "!document.querySelector('.profile-card').hidden", { label: 'the owner\'s card for Bob' });
  const forBob = await bobPage.evaluate("return { x: document.querySelectorAll('.profile-card-chip-x').length, add: Boolean(document.querySelector('.profile-card-add')) }");
  check('a moderator cannot change the owner\'s roles from the card', forBob.x === 0 && !forBob.add, JSON.stringify(forBob));
}

try {
  await run();
} catch (err) {
  console.log('  FAIL ', err.message);
  process.exitCode = 1;
}
summary();
cleanup();
process.exit(process.exitCode ?? 0);
