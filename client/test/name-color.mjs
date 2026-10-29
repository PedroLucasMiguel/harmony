// The colour of a display name, from Settings: solid, a moving gradient, the rainbow.
//
//
//   node client/test/name-color.mjs

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

const HARMONY_PORT = 18330;
const FAKE_MTX_PORT = 20330;
const PORT_OWNER = 9651;
const PORT_BOB = 9652;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-namecolor-'));
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
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-namecolor-profile-')),
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
const style = (page, selector) => page.evaluate(`{
  const n = document.querySelector(${JSON.stringify(selector)});
  const c = getComputedStyle(n);
  return { color: c.color, fill: c.webkitTextFillColor, image: c.backgroundImage, animation: c.animationName,
           duration: c.animationDuration, kind: n.dataset.nameStyle ?? null, clip: c.backgroundClip };
}`);
const setColor = (page, selector, value) => page.evaluate(`{
  const i = document.querySelector(${JSON.stringify(selector)}); i.value = ${JSON.stringify(value)};
  i.dispatchEvent(new Event('change', { bubbles: true })); return true;
}`);
const kind = (page, label) => page.evaluate(`[...document.querySelectorAll('#profile-color-modes .font-choice')].find((b) => b.title === ${JSON.stringify(label)}).click(); return true;`);

async function run() {
  console.log('Starting the server and two clients…\n');
  await startFakeMediaMtx();
  await startServer();
  const chief = await register('chief', { ownerKey });
  await register('bob');
  // A role with a colour, so that overriding it means something.
  const role = (await rest('chief', '/api/roles', { name: 'Crew', color: '#22aa66' })).body.role;
  await rest('chief', `/api/accounts/${chief.id}/roles`, { roles: [role.id] });

  const me = await signIn(PORT_OWNER, 'chief');
  const bob = await signIn(PORT_BOB, 'bob');
  for (const page of [me, bob]) {
    await page.send('Runtime.enable');
    await page.evaluate("if (document.getElementById('member-list').hidden) document.getElementById('channels-members').click(); return true;");
  }
  const row = `#member-items .member-row[data-user-id="${chief.id}"] .member-name`;
  await sleep(1000);
  check('with nothing chosen the role\'s colour is used', (await style(me, row)).color === rgb('#22aa66'), JSON.stringify(await style(me, row)));

  await click(me, '#voice-config');
  await click(me, '.settings-tab[data-tab="profile"]');
  await until(me, "!document.querySelector('.settings-page[data-page=\"profile\"]').hidden", { label: 'the profile page' });
  const kinds = await me.evaluate("return [...document.querySelectorAll('#profile-color-modes .font-choice')].map((b) => b.title)");
  check('the profile page offers the role colour, solid, gradient and rainbow', JSON.stringify(kinds) === JSON.stringify(['Role colour', 'Solid', 'Gradient', 'Rainbow']), JSON.stringify(kinds));
  check('and none of the controls for a kind until one is chosen', await me.evaluate("return document.getElementById('profile-color-editor').hidden"), '');

  // --- solid ----------------------------------------------------------------------------------------------------
  await kind(me, 'Solid');
  await until(me, "!document.getElementById('profile-color-editor').hidden", { label: 'the solid controls' });
  await setColor(me, '#profile-color-stops input[type=color]', '#ff00aa');
  await until(me, `getComputedStyle(document.querySelector('${row}')).color === ${JSON.stringify(rgb('#ff00aa'))}`, { label: 'the name turning pink' });
  check('a solid colour overrides the role\'s colour in the member list', true, '');
  await until(bob, `getComputedStyle(document.querySelector('${row}')).color === ${JSON.stringify(rgb('#ff00aa'))}`, { timeoutMs: 4000, label: 'Bob seeing it' });
  check('and everybody else sees it at once', true, '');
  const saved = (await rest('chief', '/api/accounts')).body.users.find((u) => u.id === chief.id).nameColor;
  check('and it is kept by the server', saved?.mode === 'solid' && saved.color === '#ff00aa', JSON.stringify(saved));
  check('with no speed control, since it does not move', await me.evaluate("return document.getElementById('profile-color-speed-row').hidden"), '');

  // --- gradient --------------------------------------------------------------------------------------------------
  await kind(me, 'Gradient');
  await until(me, "document.querySelectorAll('#profile-color-stops input[type=color]').length === 2", { label: 'two colour stops' });
  await setColor(me, '#profile-color-stops .name-color-stop:nth-child(1) input', '#ff0000');
  await until(me, `document.querySelector('${row}').style.getPropertyValue('--name-gradient').includes('#ff0000')`, { label: 'the first colour saved' });
  await setColor(me, '#profile-color-stops .name-color-stop:nth-child(2) input', '#0000ff');
  await until(me, `document.querySelector('${row}').style.getPropertyValue('--name-gradient').includes('#0000ff')`, { label: 'the gradient' });
  await click(me, '#profile-color-add');
  await until(me, "document.querySelectorAll('#profile-color-stops input[type=color]').length === 3", { label: 'a third stop' });
  await me.evaluate(`{
    const r = document.getElementById('profile-color-speed'); r.value = ${30 + 1 - 2};
    r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); return true;
  }`);
  await until(me, `getComputedStyle(document.querySelector('${row}')).animationDuration === '2s'`, { label: 'the speed' });
  const g = await style(me, row);
  check('a gradient is drawn as an animated background clipped to the text, in the colours chosen',
    g.kind === 'gradient' && g.image.includes('linear-gradient') && g.image.includes('rgb(255, 0, 0)') && g.image.includes('rgb(0, 0, 255)')
    && g.animation === 'name-flow' && g.clip === 'text' && g.fill === 'rgba(0, 0, 0, 0)', JSON.stringify(g));
  check('with three colours and the speed that was set (2 s)', g.duration === '2s' && (g.image.match(/rgb\(/g) ?? []).length === 4, JSON.stringify(g));
  await click(me, '#profile-color-stops .name-color-stop:nth-child(3) button');
  await until(me, "document.querySelectorAll('#profile-color-stops input[type=color]').length === 2", { label: 'a stop removed' });
  check('a colour can be taken away again, down to two', await me.evaluate("return document.querySelectorAll('#profile-color-stops .name-color-stop button').length === 0"), '');
  await me.evaluate("document.getElementById('profile-color-title').scrollIntoView({ block: 'start' }); return true;");
  await sleep(300);
  await shot(me, 'name-color');
  const seen = await style(bob, row);
  check('Bob sees the moving gradient too', seen.kind === 'gradient' && seen.animation === 'name-flow', JSON.stringify(seen));

  // --- rainbow ---------------------------------------------------------------------------------------------------
  await kind(me, 'Rainbow');
  await until(me, `document.querySelector('${row}').dataset.nameStyle === 'rainbow'`, { label: 'the rainbow' });
  const r = await style(me, row);
  check('the rainbow is a gradient through the spectrum that moves', r.image.includes('linear-gradient') && r.animation === 'name-flow' && r.fill === 'rgba(0, 0, 0, 0)', JSON.stringify(r));
  check('with no colour pickers, only a speed', await me.evaluate("return document.querySelectorAll('#profile-color-stops input').length === 0 && !document.getElementById('profile-color-speed-row').hidden"), '');

  // --- it shows wherever the name does ---------------------------------------------------------------------------
  const text = (await rest('chief', '/api/channels')).body.channels.find((c) => c.kind === 'text');
  await rest('chief', `/api/channels/${text.id}/messages`, { body: 'look at my name' });
  await bob.evaluate(`[...document.querySelectorAll('#channel-items .channel-row')].find((r) => r.textContent.includes(${JSON.stringify(text.name)})).click(); return true;`);
  await until(bob, "document.querySelector('#chat-log .who[data-name-style=\"rainbow\"]')", { label: 'the rainbow name in the chat' });
  check('in the chat as well', true, '');
  await click(bob, `#member-items .member-row[data-user-id="${chief.id}"]`);
  await until(bob, "document.querySelector('.profile-card .profile-card-name[data-name-style=\"rainbow\"]')", { label: 'the card' });
  check('and on the profile card', true, '');

  // --- back to the role's ------------------------------------------------------------------------------------------
  await kind(me, 'Role colour');
  await until(me, `getComputedStyle(document.querySelector('${row}')).color === ${JSON.stringify(rgb('#22aa66'))}`, { label: 'the role colour returning' });
  const back = await style(me, row);
  check('choosing the role colour again puts it back, with no animation left over', back.kind === null && back.image === 'none', JSON.stringify(back));
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
