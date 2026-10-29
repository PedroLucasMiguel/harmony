// Roles, as people see them: two real app windows against a real server.
//
// The owner opens the server dialog and makes a role, gives it to Bob from the
// Members page, and restricts a channel to it from the Channels page. Bob's
// window -- a different app, with its own socket -- is the witness: his name
// changes colour, the channel appears in his sidebar, and when the role is
// taken away the channel is gone again, all without his doing anything.
//
//   node client/test/roles-ui.mjs

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

const HARMONY_PORT = 18310;
const FAKE_MTX_PORT = 20310;
const PORT_OWNER = 9631;
const PORT_BOB = 9632;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-roles-ui-'));
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
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-roles-ui-profile-')),
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

const VIP = '#ff8800';
const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;

async function run() {
  console.log('Starting the server and two clients…\n');
  await startFakeMediaMtx();
  await startServer();
  await register('chief', { ownerKey });
  const bob = await register('bob');
  await register('carol');

  const owner = await signIn(PORT_OWNER, 'chief');
  const bobPage = await signIn(PORT_BOB, 'bob');
  for (const [name, page] of [['owner', owner], ['bob', bobPage]]) {
    await page.send('Runtime.enable');
    page.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
      console.log(`  [${name} exception]`, (d.exception?.description ?? d.text).split('\n').slice(0, 3).join(' / ').slice(0, 300));
    });
    await page.evaluate("if (document.getElementById('member-list').hidden) document.getElementById('channels-members').click(); return true;");
  }

  // --- who sees the button ------------------------------------------------------------------------------------------
  check('the owner has the server settings button', await owner.evaluate("return !document.getElementById('server-settings').hidden"), '');
  check('an ordinary member does not', await bobPage.evaluate("return document.getElementById('server-settings').hidden"), '');

  await click(owner, '#server-settings');
  await until(owner, "document.getElementById('server-dialog').open", { label: 'the dialog' });
  const tabs = await owner.evaluate("return [...document.querySelectorAll('#server-dialog .settings-tab')].filter((t) => !t.hidden).map((t) => t.dataset.tab)");
  check('the owner sees General, Roles, Members, Channels and Badges', JSON.stringify(tabs) === JSON.stringify(['general', 'roles', 'members', 'channels', 'badges']), JSON.stringify(tabs));
  check('and General has the old server settings in it', await owner.evaluate("return Boolean(document.querySelector('#server-dialog [data-page=\"general\"] #server-name-input')) && !document.querySelector('#server-dialog [data-page=\"general\"]').hidden"), '');

  // --- making a role from the page ----------------------------------------------------------------------------------
  await tab(owner, 'roles');
  await click(owner, '#roles-new');
  await until(owner, "!document.getElementById('roles-editor').hidden", { label: 'the role editor' });
  await owner.evaluate(`${setInput('role-name', 'Moderator')} ${setInput('role-color-hex', '#22aa66')} return true;`);
  await tick(owner, '#role-permissions', 'Kick');
  await tick(owner, '#role-permissions', 'Manage roles');
  await tick(owner, '#role-permissions', 'Delete any message');
  await shot(owner, '1-roles');
  await click(owner, '#role-save');
  await until(owner, "[...document.querySelectorAll('#roles-list .admin-item')].some((li) => li.textContent.includes('Moderator'))", { label: 'the role in the list' });
  const mod = (await rest('chief', '/api/roles')).body.roles.find((r) => r.name === 'Moderator');
  check('the new role has what was ticked, and its colour', mod
    && mod.color === '#22aa66'
    && ['users.kick', 'roles.hierarchy', 'messages.delete'].every((p) => mod.permissions.includes(p))
    && !mod.permissions.includes('users.ban'), JSON.stringify(mod));

  // The second one through the API: this test is about the pages, not about typing.
  const vip = (await rest('chief', '/api/roles', { name: 'VIP', color: VIP })).body.role;
  await until(owner, "[...document.querySelectorAll('#roles-list .admin-item')].some((li) => li.textContent.includes('VIP'))", { label: 'a role made elsewhere appearing, without a reload' });
  check('a role made somewhere else shows up in the list by itself', true, '');

  // Reordering: the new one is at the bottom; move VIP above Moderator.
  await owner.evaluate(`{
    const item = [...document.querySelectorAll('#roles-list .admin-item')].find((li) => li.textContent.includes('VIP'));
    item.querySelector('button[data-icon="arrow-up"]').click();
  }`);
  await until(owner, "document.querySelector('#roles-list .admin-item').textContent.includes('VIP')", { label: 'VIP moved to the top' });
  check('the arrows reorder the roles', true, '');
  await owner.evaluate(`{
    const item = [...document.querySelectorAll('#roles-list .admin-item')].find((li) => li.textContent.includes('VIP'));
    item.querySelector('button[data-icon="arrow-down"]').click();
  }`);
  await until(owner, "document.querySelector('#roles-list .admin-item').textContent.includes('Moderator')", { label: 'and back' });

  // --- giving a role: immediate for the person who gets it ---------------------------------------------------------
  const bobRowColor = () => nameColor(owner, `#member-items .member-row[data-user-id="${bob.id}"] .member-name`);
  const before = await bobRowColor();
  await tab(owner, 'members');
  await until(owner, `document.querySelector('#members-list .admin-item[data-user-id="${bob.id}"]')`, { label: 'bob in the members page' });
  await click(owner, `#members-list .admin-item[data-user-id="${bob.id}"]`);
  await until(owner, "!document.getElementById('members-editor').hidden", { label: 'the member editor' });
  await shot(owner, '2-members');
  const t0 = Date.now();
  await tick(owner, '#member-roles', 'VIP');
  await until(bobPage, `getComputedStyle(document.getElementById('channels-who')).color === ${JSON.stringify(rgb(VIP))}`, { timeoutMs: 4000, label: 'Bob\'s own name turning the role\'s colour' });
  const took = Date.now() - t0;
  check('Bob\'s own name takes the role\'s colour within a second or two, with nothing done on his side', took < 3000, `${took} ms`);
  check('and so does his row in the owner\'s member list', (await bobRowColor()) === rgb(VIP), `${before} -> ${await bobRowColor()}`);
  check('and his role is shown beside his name in the corner', await bobPage.evaluate("return document.getElementById('channels-role').textContent") === 'VIP', await bobPage.evaluate("return document.getElementById('channels-role').textContent"));

  // --- hierarchy in the member list ---------------------------------------------------------------------------------
  const heads = await owner.evaluate("return [...document.querySelectorAll('#member-items .member-head')].map((h) => h.textContent)");
  check('the member list is grouped by the hierarchy: owner first, then VIP',
    heads[0].startsWith('owner') && heads[1].startsWith('VIP'), JSON.stringify(heads));

  // --- a channel only VIP can see ------------------------------------------------------------------------------------
  await tab(owner, 'channels');
  await click(owner, '#chan-new-text');
  await until(owner, "!document.getElementById('chan-editor').hidden", { label: 'the channel editor' });
  await owner.evaluate(`${setInput('chan-name', 'vip-lounge')} return true;`);
  await tick(owner, '#chan-roles', 'VIP');
  await click(owner, '#chan-save');
  await until(bobPage, "[...document.querySelectorAll('#channel-items .channel-row')].some((r) => r.textContent.includes('vip-lounge'))", { label: 'the channel appearing for Bob' });
  check('a channel restricted to VIP shows up for Bob, who has it', true, '');
  const carolSees = (await rest('carol', '/api/channels')).body.channels.map((c) => c.name);
  check('and not for Carol, who is not told it exists', !carolSees.includes('vip-lounge'), JSON.stringify(carolSees));

  // Bob opens it, then loses the role: it is gone, and so is the chat.
  await bobPage.evaluate("[...document.querySelectorAll('#channel-items .channel-row')].find((r) => r.textContent.includes('vip-lounge')).click(); return true;");
  await until(bobPage, "document.getElementById('chat-title')?.textContent.includes('vip-lounge') || !document.getElementById('chat')?.hidden", { label: 'the chat opening' }).catch(() => {});
  await tab(owner, 'members');
  await click(owner, `#members-list .admin-item[data-user-id="${bob.id}"]`);
  await tick(owner, '#member-roles', 'VIP');
  await until(bobPage, "![...document.querySelectorAll('#channel-items .channel-row')].some((r) => r.textContent.includes('vip-lounge'))", { timeoutMs: 4000, label: 'the channel leaving Bob\'s sidebar' });
  check('taking the role away takes the channel out of his sidebar at once', true, '');
  const chatStillOpen = await bobPage.evaluate("return /vip-lounge/.test(document.getElementById('chat-title')?.textContent ?? '') && !document.getElementById('chat-title')?.closest('[hidden]')");
  check('and the chat that was open on it closes', !chatStillOpen, '');
  check('his name goes back to the ordinary colour',
    (await nameColor(bobPage, '#channels-who')) !== rgb(VIP), await nameColor(bobPage, '#channels-who'));

  // --- a role that can do something opens the dialog for them -----------------------------------------------------
  await rest('chief', `/api/accounts/${bob.id}/roles`, { roles: [mod.id] });
  await until(bobPage, "!document.getElementById('server-settings').hidden", { timeoutMs: 4000, label: 'the button appearing for a moderator' });
  check('a moderator gets the server settings button the moment the role is given', true, '');
  await click(bobPage, '#server-settings');
  await until(bobPage, "document.getElementById('server-dialog').open", { label: 'Bob\'s dialog' });
  const bobTabs = await bobPage.evaluate("return [...document.querySelectorAll('#server-dialog .settings-tab')].filter((t) => !t.hidden).map((t) => t.dataset.tab)");
  check('and sees only the pages he can use: Roles and Members, not General or Channels', JSON.stringify(bobTabs) === JSON.stringify(['roles', 'members']), JSON.stringify(bobTabs));
  const ownRoleEditable = await bobPage.evaluate(`{
    const item = [...document.querySelectorAll('#roles-list .admin-item')].find((li) => li.textContent.includes('Moderator'));
    item.click();
    return !document.getElementById('role-save').disabled;
  }`);
  check('he cannot edit his own role', !ownRoleEditable, '');
  const ownUpDown = await bobPage.evaluate(`{
    const item = [...document.querySelectorAll('#roles-list .admin-item')].find((li) => li.textContent.includes('Moderator'));
    return [...item.querySelectorAll('button')].every((b) => b.disabled);
  }`);
  check('nor move it', ownUpDown, '');
  await click(bobPage, '#server-cancel');

  // --- groups follow their group -------------------------------------------------------------------------------------
  await tab(owner, 'channels');
  await click(owner, '#chan-new-group');
  await until(owner, "!document.getElementById('chan-editor').hidden", { label: 'the group editor' });
  await owner.evaluate(`${setInput('chan-name', 'Secret Area')} ${setInput('chan-password', 'open-sesame')} return true;`);
  await shot(owner, '3-group');
  await tick(owner, '#chan-roles', 'Moderator');
  await click(owner, '#chan-save');
  await until(owner, "[...document.querySelectorAll('#chan-list .admin-item[data-group]')].some((li) => li.textContent.includes('Secret Area'))", { label: 'the group in the list' });
  const groupId = (await rest('chief', '/api/channels')).body.groups.find((g) => g.name === 'Secret Area').id;
  check('a group made with a password and a role has both', await owner.evaluate(`{
    const li = document.querySelector('#chan-list .admin-item[data-group-id="${groupId}"]');
    return Boolean(li.querySelector('.admin-lock')) && li.textContent.includes('Moderator');
  }`), '');

  // Move vip-lounge into it, from the channel editor.
  await click(owner, '#chan-list .admin-item[data-channel-id]');
  const loungeId = (await rest('chief', '/api/channels')).body.channels.find((c) => c.name === 'vip-lounge').id;
  await click(owner, `#chan-list .admin-item[data-channel-id="${loungeId}"]`);
  await owner.evaluate(`{
    const g = document.getElementById('chan-group'); g.value = '${groupId}';
    g.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }`);
  await click(owner, '#chan-save');
  await until(owner, `document.querySelector('#chan-list .admin-item[data-channel-id="${loungeId}"]')?.dataset.nested !== undefined`, { label: 'the channel inside the group' });
  const after = (await rest('chief', '/api/channels')).body.channels.find((c) => c.id === loungeId);
  check('a channel moved into the group takes its password and its roles', after.locked && JSON.stringify(after.roles) === JSON.stringify([mod.id]), JSON.stringify(after));
  await click(owner, `#chan-list .admin-item[data-channel-id="${loungeId}"]`);
  check('and its own password and roles are no longer offered: it follows the group',
    await owner.evaluate("return document.getElementById('chan-password-field').hidden && document.getElementById('chan-roles-field').hidden && !document.getElementById('chan-follows').hidden"), '');

  await shot(owner, '4-channels');
  await shot(bobPage, '5-bob');

  // --- the sidebar's own menu leads here ------------------------------------------------------------------------------
  await click(owner, '#server-cancel');
  await owner.evaluate(`{
    const row = [...document.querySelectorAll('#channel-items .channel-row')].find((r) => r.textContent.includes('vip-lounge'));
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 60 }));
    return true;
  }`);
  await owner.evaluate("[...document.querySelectorAll('#row-menu button')].find((b) => /edit/i.test(b.textContent))?.click(); return true;");
  await until(owner, "document.getElementById('server-dialog').open && !document.querySelector('#server-dialog [data-page=\"channels\"]').hidden", { label: 'Edit in the sidebar opening the Channels page' });
  check('Edit in the sidebar\'s menu opens the Channels page on that channel',
    await owner.evaluate("return document.getElementById('chan-subject').textContent.includes('vip-lounge')"), '');

  // --- several roles, and people by name ---------------------------------------------------------------------------
  const carolId = (await rest('chief', '/api/accounts')).body.users.find((u) => u.nickname === 'carol').id;
  await click(owner, '#chan-new-text');
  await until(owner, "document.getElementById('chan-subject').textContent.includes('New text')", { label: 'a new channel' });
  await owner.evaluate(`${setInput('chan-name', 'duo')} return true;`);
  await tick(owner, '#chan-roles', 'VIP');
  await tick(owner, '#chan-roles', 'Moderator');
  await owner.evaluate(`{ const s = document.getElementById('chan-user-add'); s.value = '${carolId}'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; }`);
  await until(owner, "document.querySelector('#chan-users .chan-person')", { label: 'Carol named' });
  await shot(owner, 'channel-people');
  await click(owner, '#chan-save');
  await until(owner, "[...document.querySelectorAll('#chan-list .admin-item')].some((li) => li.textContent.includes('duo'))", { label: 'the channel in the list' });
  const duo = (await rest('chief', '/api/channels')).body.channels.find((c) => c.name === 'duo');
  check('a channel can be made for several roles at once, and for somebody by name', duo.roles.length === 2 && JSON.stringify(duo.users) === JSON.stringify([carolId]), JSON.stringify(duo));
  check('and the list says how many people are named', await owner.evaluate("return [...document.querySelectorAll('#chan-list .admin-item')].find((li) => li.textContent.includes('duo')).textContent.includes('1 person')"), '');
  check('Carol, who holds neither role, sees it because she is named', (await rest('carol', '/api/channels')).body.channels.some((c) => c.name === 'duo'), '');
  await owner.evaluate("document.querySelector('#chan-users .chan-person button').click(); return true;");
  await click(owner, '#chan-save');
  await until(owner, "!document.querySelector('#chan-users .chan-person')", { label: 'the person removed' });
  await sleep(500);
  check('and taking her off the list hides it from her again', !(await rest('carol', '/api/channels')).body.channels.some((c) => c.name === 'duo'), '');

  // --- a shortcut on the group's own menu --------------------------------------------------------------------------
  await click(owner, '#server-cancel');
  await owner.evaluate(`{
    const row = [...document.querySelectorAll('#channel-items li')].find((r) => /secret area/i.test(r.textContent) && !r.classList.contains('channel-row'));
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 60 }));
    return true;
  }`);
  const labels = await owner.evaluate("return [...document.querySelectorAll('#row-menu-body button')].map((b) => b.textContent)");
  check('right-clicking a group offers a new channel inside it', labels.includes('New channel here…'), JSON.stringify(labels));
  await owner.evaluate("[...document.querySelectorAll('#row-menu-body button')].find((b) => b.textContent === 'New channel here…').click(); return true;");
  await until(owner, "document.getElementById('ask').open", { label: 'the dialog' });
  check('and asks for a name and a kind, saying which group', await owner.evaluate("return document.getElementById('ask-title').textContent.includes('Secret Area')"), '');
  await owner.evaluate("const i = document.querySelector('#ask-fields [name=name]'); i.value = 'fresh'; document.getElementById('ask-ok').click(); return true;");
  await until(owner, "[...document.querySelectorAll('#channel-items .channel-row')].some((r) => r.textContent.includes('fresh'))", { label: 'the new channel' });
  const fresh = (await rest('chief', '/api/channels')).body.channels.find((c) => c.name === 'fresh');
  const groupNow = (await rest('chief', '/api/channels')).body.groups.find((g) => g.name === 'Secret Area');
  check('the channel is made inside the group, with the group\'s password and roles', fresh.groupId === groupNow.id && fresh.locked && JSON.stringify(fresh.roles) === JSON.stringify(groupNow.roles), JSON.stringify(fresh));
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
