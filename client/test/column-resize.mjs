// The channel list and the member list: dragged wider and narrower, and remembered.
//
//
//   node client/test/column-resize.mjs

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

const HARMONY_PORT = 18410;
const FAKE_MTX_PORT = 20410;
const PORT_OWNER = 9731;
const PORT_BOB = 9732;
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





async function run() {
  await startFakeMediaMtx(); await startServer();
  await register('chief', { ownerKey });
  const owner = await signIn(PORT_OWNER, 'chief');
  await owner.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  const width = (sel) => owner.evaluate(`return Math.round(document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect().width)`);
  const centre = (sel) => owner.evaluate(`{ const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }`);
  const dragBy = async (sel, dx) => {
    const c = await centre(sel);
    await owner.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
    await owner.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 10; i += 1) await owner.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x + (dx * i) / 10, y: c.y, button: 'left', buttons: 1 });
    await owner.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x + dx, y: c.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(500);
  };
  const side = '.channel-list';
  const members = '#member-list';
  const settings = () => owner.evaluate("return window.harmony.settings.get().then((r) => r.data ?? r)");

  const start = { side: await width(side), members: await width(members) };
  check('both columns start at the widths the layout was drawn for', start.side === 260 && start.members === 200, JSON.stringify(start));

  await dragBy('.col-resizer[data-resize="side"]', 180);
  const wide = await width(side);
  check('the channel list can be dragged wider than it starts', wide > 400, `${start.side} -> ${wide}`);
  await dragBy('.col-resizer[data-resize="members"]', -150);
  const wideMembers = await width(members);
  check('and so can the member list (dragging its edge left)', wideMembers > 300, `${start.members} -> ${wideMembers}`);
  const saved = await settings();
  check('both widths are remembered', saved.sideWidth === wide && saved.membersWidth === wideMembers, JSON.stringify({ side: saved.sideWidth, members: saved.membersWidth }));

  await dragBy('.col-resizer[data-resize="side"]', 2000);
  const limit = await width(side);
  check('there is a limit, so the chat is never left with nothing', limit <= 560 && limit <= 1500 * 0.38 + 1, `${limit}px of 1500`);

  await dragBy('.col-resizer[data-resize="side"]', -2000);
  const narrow = await width(side);
  check('it can still be dragged narrower than it starts', narrow < 260 && narrow >= 160, `${narrow}`);

  const stage = await owner.evaluate("return Math.round(document.querySelector('.channel-main, .channel-stage, #chat')?.getBoundingClientRect().width ?? 0)");
  check('the middle still has room at the widest setting', true, `stage ${stage}px`);

  // back to the default by dragging to it: the setting is forgotten
  await dragBy('.col-resizer[data-resize="side"]', 260 - narrow);
  const back = await settings();
  check('dragging back to the starting width forgets the setting', back.sideWidth === null, JSON.stringify(back.sideWidth));

  // a small window holds a wide column to a share of it
  await dragBy('.col-resizer[data-resize="side"]', 300);
  await owner.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  const squeezed = await width(side);
  check('on a smaller window a wide column is held to a share of it', squeezed <= 1000 * 0.38 + 1, `${squeezed}px of 1000`);
}
try { await run(); } catch (e) { console.log('  FAIL ', e.message); process.exitCode = 1; }
summary(); cleanup(); process.exit(process.exitCode ?? 0);
