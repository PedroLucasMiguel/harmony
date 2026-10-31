// A role's name style: a gradient or the rainbow, as a person's can be.
//
//
//   node client/test/role-style.mjs

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

const HARMONY_PORT = 18370;
const FAKE_MTX_PORT = 20370;
const PORT_OWNER = 9691;
const PORT_BOB = 9692;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-rolestyle-'));
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
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-rolestyle-profile-')),
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
const look = (page, selector) => page.evaluate(`{
  const n = document.querySelector(${JSON.stringify(selector)});
  const c = getComputedStyle(n);
  return { color: c.color, image: c.backgroundImage, kind: n.dataset.nameStyle ?? null, speed: n.style.getPropertyValue('--name-speed'), clip: c.backgroundClip };
}`);
const setColor = (page, selector, value) => page.evaluate(`{
  const i = document.querySelector(${JSON.stringify(selector)}); i.value = ${JSON.stringify(value)};
  i.dispatchEvent(new Event('input', { bubbles: true })); return true;
}`);
const kind = (page, label) => page.evaluate(`[...document.querySelectorAll('#role-style .font-choice')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click(); return true;`);

async function run() {
  await startFakeMediaMtx();
  await startServer();
  await register('chief', { ownerKey });
  const bob = await register('bob');
  const crew = (await rest('chief', '/api/roles', { name: 'Crew', color: '#22aa66' })).body.role;
  await rest('chief', `/api/accounts/${bob.id}/roles`, { roles: [crew.id] });

  const owner = await signIn(PORT_OWNER, 'chief');
  const bobPage = await signIn(PORT_BOB, 'bob');
  for (const page of [owner, bobPage]) {
    await page.send('Runtime.enable');
    await page.evaluate("if (document.getElementById('member-list').hidden) document.getElementById('channels-members').click(); return true;");
  }
  const row = `#member-items .member-row[data-user-id="${bob.id}"] .member-name`;
  await sleep(800);
  check('a plain role colours its members\' names as before', (await look(owner, row)).color === rgb('#22aa66'), '');

  await click(owner, '#server-settings');
  await until(owner, "document.getElementById('server-dialog').open");
  await tab(owner, 'roles');
  await owner.evaluate("[...document.querySelectorAll('#roles-list .admin-item')].find((l) => l.textContent.includes('Crew')).click(); return true;");
  await until(owner, "!document.getElementById('roles-editor').hidden");
  const kinds = await owner.evaluate("return [...document.querySelectorAll('#role-style .font-choice')].map((b) => b.textContent.trim())");
  check('the role editor offers a plain colour, a gradient and the rainbow', JSON.stringify(kinds) === JSON.stringify(['Solid', 'Gradient', 'Rainbow']), JSON.stringify(kinds));

  // --- gradient ---------------------------------------------------------------------------------------------------
  await kind(owner, 'Gradient');
  await until(owner, "document.querySelectorAll('#role-style input[type=color]').length === 2", { label: 'two stops' });
  await setColor(owner, '#role-style .name-color-stop:nth-child(1) input', '#ff0000');
  await setColor(owner, '#role-style .name-color-stop:nth-child(2) input', '#0000ff');
  const preview = await look(owner, '#role-style .role-style-preview strong');
  check('the preview draws the gradient as it is edited', preview.kind === 'gradient' && preview.image.includes('rgb(255, 0, 0)') && preview.image.includes('rgb(0, 0, 255)'), JSON.stringify(preview));
  await shot(owner, 'role-style');
  await click(owner, '#role-save');
  await until(owner, `document.querySelector('${row}').dataset.nameStyle === 'gradient'`, { label: 'the member list changing' });
  const saved = (await rest('chief', '/api/roles')).body.roles.find((r) => r.id === crew.id);
  check('Save keeps the gradient, and its first colour as the role\'s plain colour', saved.style?.mode === 'gradient' && saved.color === '#ff0000' && JSON.stringify(saved.style.colors) === JSON.stringify(['#ff0000', '#0000ff']), JSON.stringify(saved));
  const g = await look(owner, row);
  check('members\' names move through the gradient, in the owner\'s member list', g.kind === 'gradient' && g.speed !== '' && g.clip === 'text' && g.image.includes('rgb(0, 0, 255)'), JSON.stringify(g));
  await until(bobPage, "document.getElementById('channels-who').dataset.nameStyle === 'gradient'", { timeoutMs: 4000, label: 'Bob\'s own name' });
  check('and on the member\'s own window at once', true, '');
  const heading = await owner.evaluate("const h = [...document.querySelectorAll('#member-items .member-head')].find((x) => x.textContent.startsWith('Crew')); return { kind: h.querySelector('span').dataset.nameStyle ?? null, dot: h.dataset.dot !== undefined }");
  check('and the role\'s heading in the list', heading.kind === 'gradient' && heading.dot, JSON.stringify(heading));

  // --- a colour of their own wins --------------------------------------------------------------------------------
  await rest('bob', '/api/accounts/name-color', { nameColor: { mode: 'solid', color: '#ff00aa' } });
  await until(owner, `getComputedStyle(document.querySelector('${row}')).color === ${JSON.stringify(rgb('#ff00aa'))}`, { label: 'Bob\'s own colour' });
  check('a person\'s own colour still overrides the role\'s gradient', (await look(owner, row)).kind === null, '');
  await rest('bob', '/api/accounts/name-color', { nameColor: null });
  await until(owner, `document.querySelector('${row}').dataset.nameStyle === 'gradient'`, { label: 'back to the role' });

  // --- rainbow ---------------------------------------------------------------------------------------------------
  await kind(owner, 'Rainbow');
  await click(owner, '#role-save');
  await until(owner, `document.querySelector('${row}').dataset.nameStyle === 'rainbow'`, { label: 'the rainbow' });
  const r = await look(owner, row);
  check('the rainbow works for a role too', r.kind === 'rainbow' && r.image.includes('linear-gradient') && r.speed !== '', JSON.stringify(r));

  // --- back to plain ------------------------------------------------------------------------------------------------
  await kind(owner, 'Solid');
  await click(owner, '#role-save');
  await until(owner, `document.querySelector('${row}').dataset.nameStyle === undefined`, { label: 'plain again' });
  const plain = (await rest('chief', '/api/roles')).body.roles.find((x) => x.id === crew.id);
  check('Solid takes the style away and keeps the colour', plain.style === null && /^#[0-9a-f]{6}$/.test(plain.color), JSON.stringify(plain));
}
try { await run(); } catch (e) { console.log('  FAIL ', e.message); process.exitCode = 1; }
summary(); cleanup(); process.exit(process.exitCode ?? 0);
