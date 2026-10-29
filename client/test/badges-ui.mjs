// Badges: made in the server settings, handed out, and shown on the profile card.
//
//
//   node client/test/badges-ui.mjs

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

const HARMONY_PORT = 18340;
const FAKE_MTX_PORT = 20340;
const PORT_OWNER = 9661;
const PORT_BOB = 9662;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-badges-'));
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
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-badges-profile-')),
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




const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const setValue = (page, selector, value) => page.evaluate(`{
  const i = document.querySelector(${JSON.stringify(selector)}); i.value = ${JSON.stringify(value)};
  i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true;
}`);

async function run() {
  console.log('Starting the server and two clients…\n');
  await startFakeMediaMtx();
  await startServer();
  const chief = await register('chief', { ownerKey });
  const bob = await register('bob');
  const awarder = (await rest('chief', '/api/roles', { name: 'Awarder' })).body.role;

  const owner = await signIn(PORT_OWNER, 'chief');
  const bobPage = await signIn(PORT_BOB, 'bob');
  for (const page of [owner, bobPage]) {
    await page.send('Runtime.enable');
    await page.evaluate("if (document.getElementById('member-list').hidden) document.getElementById('channels-members').click(); return true;");
  }

  // --- making one from the server settings ------------------------------------------------------------------------
  await click(owner, '#server-settings');
  await until(owner, "document.getElementById('server-dialog').open", { label: 'the dialog' });
  const tabs = await owner.evaluate("return [...document.querySelectorAll('#server-dialog .settings-tab')].filter((t) => !t.hidden).map((t) => t.dataset.tab)");
  check('the server settings have a Badges page', tabs.includes('badges'), JSON.stringify(tabs));
  await tab(owner, 'badges');
  await click(owner, '#badges-new');
  await until(owner, "!document.getElementById('badges-editor').hidden", { label: 'the badge editor' });
  await setValue(owner, '#badge-name', 'Devoted');
  await setValue(owner, '#badge-description', '424 hours of games played');
  await setValue(owner, '#badge-emoji', '⚔️');
  check('the editor previews what the badge will look like', await owner.evaluate("return document.querySelector('#badge-preview .badge-icon').textContent") === '⚔️', '');
  await shot(owner, 'badge-editor');
  await click(owner, '#badge-save');
  await until(owner, "[...document.querySelectorAll('#badges-list .admin-item')].some((li) => li.textContent.includes('Devoted'))", { label: 'the badge in the list' });
  const made = (await rest('chief', '/api/badges')).body.badges;
  check('it is kept with its name, description and emoji', made.length === 1 && made[0].description === '424 hours of games played' && made[0].emoji === '⚔️', JSON.stringify(made));

  // A second one with a picture, made through the API.
  const up = await (await fetch(`${BASE}/api/uploads`, { method: 'POST', headers: { 'Content-Type': 'image/gif', Authorization: `Bearer ${tokens.chief}` }, body: GIF })).json();
  const medal = (await rest('chief', '/api/badges', { name: 'First!', description: 'Here before anybody', imageHash: up.hash })).body.badge;
  await until(owner, "document.querySelectorAll('#badges-list .admin-item').length === 2", { label: 'a badge made elsewhere appearing' });
  check('a badge with a picture is listed with that picture', await owner.evaluate("return Boolean(document.querySelector('#badges-list .admin-item img'))"), '');
  const devoted = made[0];

  // --- handing out from the Members page --------------------------------------------------------------------------
  await tab(owner, 'members');
  await click(owner, `#members-list .admin-item[data-user-id="${bob.id}"]`);
  await until(owner, "!document.getElementById('members-editor').hidden", { label: 'the member editor' });
  const offered = await owner.evaluate("return [...document.querySelectorAll('#member-badges label.check')].map((l) => l.textContent.trim())");
  check('the Members page offers every badge to somebody who can award them all', offered.length === 2, JSON.stringify(offered));
  await owner.evaluate("[...document.querySelectorAll('#member-badges label.check')].find((l) => l.textContent.includes('Devoted')).querySelector('input').click(); return true;");
  await until(bobPage, `document.querySelector('#member-items .member-row[data-user-id="${bob.id}"]')`, { label: 'Bob\'s row' });
  await sleep(500);
  check('and the badge is Bob\'s on the server straight away', (await rest('chief', '/api/accounts')).body.users.find((u) => u.id === bob.id).badges.includes(devoted.id), '');
  await click(owner, '#server-cancel');

  // --- on the card, below the name -----------------------------------------------------------------------------------
  await click(owner, `#member-items .member-row[data-user-id="${bob.id}"]`);
  await until(owner, "document.querySelector('.profile-card .profile-card-badge')", { label: 'the badge on the card' });
  const layout = await owner.evaluate(`{
    const c = document.querySelector('.profile-card');
    const handle = c.querySelector('.profile-card-handle').getBoundingClientRect();
    const badge = c.querySelector('.profile-card-badge').getBoundingClientRect();
    const roles = c.querySelector('.profile-card-roles').getBoundingClientRect();
    return { below: badge.top >= handle.bottom - 1, above: badge.bottom <= roles.top + 1, count: c.querySelectorAll('.profile-card-badge').length };
  }`);
  check('the card shows the badge right below the name, above the roles', layout.below && layout.above && layout.count === 1, JSON.stringify(layout));
  const tipHidden = await owner.evaluate("return document.querySelector('.badge-tip').hidden");
  check('and says nothing more until you point at it', tipHidden, '');
  await owner.evaluate("document.querySelector('.profile-card-badge').dispatchEvent(new MouseEvent('mouseenter')); return true;");
  await until(owner, "!document.querySelector('.badge-tip').hidden", { label: 'the tip' });
  const tip = await owner.evaluate("const t = document.querySelector('.badge-tip'); return { text: t.textContent, big: Boolean(t.querySelector('.badge-icon.large')) }");
  await shot(owner, 'badge-tip');
  check('pointing at it shows its picture, its name and its description', tip.big && tip.text.includes('Devoted') && tip.text.includes('424 hours of games played'), JSON.stringify(tip));
  await owner.evaluate("document.querySelector('.profile-card-badge').dispatchEvent(new MouseEvent('mouseleave')); return true;");
  check('and it goes away again', await owner.evaluate("return document.querySelector('.badge-tip').hidden"), '');

  // --- anybody can look at it -------------------------------------------------------------------------------------------
  await rest('chief', `/api/accounts/${chief.id}/badges`, { badges: [medal.id] });
  await click(bobPage, `#member-items .member-row[data-user-id="${chief.id}"]`);
  await until(bobPage, "document.querySelector('.profile-card .profile-card-badge img')", { label: 'the picture badge on the owner\'s card' });
  check('Bob sees the owner\'s picture badge on their card, with no controls to change it', await bobPage.evaluate("return document.querySelectorAll('.profile-card-chip-x').length === 0"), '');
  await bobPage.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true;");

  // --- who may hand out which ---------------------------------------------------------------------------------------------
  check('a member with no role has no server settings at all', await bobPage.evaluate("return document.getElementById('server-settings').hidden"), '');
  await rest('chief', `/api/roles/${awarder.id}`, { assignableBadges: [devoted.id] });
  await rest('chief', `/api/accounts/${bob.id}/roles`, { roles: [awarder.id] });
  await until(bobPage, "!document.getElementById('server-settings').hidden", { timeoutMs: 4000, label: 'Bob getting the settings button' });
  await click(bobPage, '#server-settings');
  await until(bobPage, "document.getElementById('server-dialog').open", { label: 'Bob\'s dialog' });
  const bobTabs = await bobPage.evaluate("return [...document.querySelectorAll('#server-dialog .settings-tab')].filter((t) => !t.hidden).map((t) => t.dataset.tab)");
  check('a role that can only award badges gets the Members page, and not the Badges page', JSON.stringify(bobTabs) === JSON.stringify(['members']), JSON.stringify(bobTabs));
  const carol = await register('carol');
  await sleep(800);
  await click(bobPage, `#members-list .admin-item[data-user-id="${carol.id}"]`);
  const bobOffers = await bobPage.evaluate("return [...document.querySelectorAll('#member-badges label.check')].map((l) => l.textContent.trim())");
  check('and is offered only the badge its role lists', JSON.stringify(bobOffers) === JSON.stringify(['Devoted']) || (bobOffers.length === 1 && bobOffers[0].includes('Devoted')), JSON.stringify(bobOffers));
  await bobPage.evaluate("document.querySelector('#member-badges input').click(); return true;");
  await until(bobPage, `true`, { timeoutMs: 500 });
  await sleep(700);
  check('and giving it works', (await rest('chief', '/api/accounts')).body.users.find((u) => u.id === carol.id).badges.includes(devoted.id), '');
  await click(bobPage, '#server-cancel');

  // --- the role editor lists badges --------------------------------------------------------------------------------------
  await click(owner, '#server-settings');
  await tab(owner, 'roles');
  await owner.evaluate(`[...document.querySelectorAll('#roles-list .admin-item')].find((li) => li.textContent.includes('Awarder')).click(); return true;`);
  await until(owner, "document.querySelectorAll('#role-badges label.check').length === 2", { label: 'the badge list in the role editor' });
  check('a role\'s editor lists the badges it can award, with the right one ticked',
    await owner.evaluate("return [...document.querySelectorAll('#role-badges label.check')].filter((l) => l.querySelector('input').checked).map((l) => l.textContent.trim()).join() .includes('Devoted')"), '');

  // --- deleting ---------------------------------------------------------------------------------------------------------
  await tab(owner, 'badges');
  await owner.evaluate("[...document.querySelectorAll('#badges-list .admin-item')].find((li) => li.textContent.includes('Devoted')).click(); return true;");
  await click(owner, '#badge-delete');
  await until(owner, "document.getElementById('ask-ok') && document.getElementById('ask').open", { label: 'the confirmation' }).catch(() => {});
  await owner.evaluate("document.getElementById('ask-ok')?.click(); return true;");
  await until(owner, "document.querySelectorAll('#badges-list .admin-item').length === 1", { label: 'the badge gone from the list' });
  const left = (await rest('chief', '/api/accounts')).body.users.find((u) => u.id === bob.id).badges;
  check('deleting a badge takes it from everybody who had it', left.length === 0, JSON.stringify(left));
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
