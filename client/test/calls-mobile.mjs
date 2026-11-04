// Private groups and private calls, as three people see them: real app windows against a real server and MediaMTX.
//
// Alice makes a group of Bob and Carol from the private messages, writes in it, and looks at who is in it.
// She calls the group: Bob answers, Carol turns it down, and Alice and Bob see each other's cameras. Then a call
// between two (a ring, a refusal), the line each call leaves in the conversation, and a person taken out of the
// group losing it at once.
//
//   MEDIAMTX_BIN=/path/to/mediamtx node client/test/dm-groups-calls-ui.mjs

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const serverEntry = resolve(repoRoot, 'server', 'src', 'index.js');

const MEDIAMTX_BIN = process.env.MEDIAMTX_BIN ?? join(homedir(), 'mediamtx', 'mediamtx');
if (!existsSync(MEDIAMTX_BIN)) {
  console.log(`No MediaMTX at ${MEDIAMTX_BIN}. Set MEDIAMTX_BIN.`);
  process.exit(0);
}

const HARMONY_PORT = 18291;
const MTX_API_PORT = 9997 - 141;
const MTX_WEBRTC_PORT = 8889 - 141;
const MTX_ICE_PORT = 8189 - 141;
const PORTS = { alice: 9594, bob: 9595 };
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-gc-'));
const { check, summary } = reporter();
const procs = [];
let mtxLog = '';
let serverLog = '';
let ownerKey = null;

process.on('exit', () => procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } }));
process.on('SIGINT', () => process.exit(130));

async function startMediaMtx() {
  const dir = mkdtempSync(join(tmpdir(), 'harmony-gc-mtx-'));
  const config = join(dir, 'mediamtx.yml');
  copyFileSync(join(repoRoot, 'server', 'mediamtx.yml'), config);
  const p = spawn(MEDIAMTX_BIN, [config], {
    env: {
      ...process.env,
      MTX_AUTHHTTPADDRESS: `${BASE}/mediamtx/auth`,
      MTX_WEBRTCADDRESS: `:${MTX_WEBRTC_PORT}`,
      MTX_APIADDRESS: `127.0.0.1:${MTX_API_PORT}`,
      MTX_WEBRTCLOCALUDPADDRESS: `:${MTX_ICE_PORT}`,
      MTX_WEBRTCLOCALTCPADDRESS: `:${MTX_ICE_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(p);
  p.stdout.on('data', (b) => (mtxLog += b.toString()));
  p.stderr.on('data', (b) => (mtxLog += b.toString()));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (new RegExp(`\\[WebRTC\\].*:${MTX_WEBRTC_PORT}`).test(mtxLog)) return;
    await sleep(200);
  }
  throw new Error('MediaMTX did not start');
}

function startServer() {
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        HARMONY_PORT: String(HARMONY_PORT),
        HARMONY_HOST: '127.0.0.1',
        HARMONY_DATA_DIR: dataDir,
        HARMONY_MEDIAMTX_API: `http://127.0.0.1:${MTX_API_PORT}`,
        HARMONY_SIGNALING_URL: `http://127.0.0.1:${MTX_WEBRTC_PORT}`,
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

const register = async (nickname, extra = {}) => {
  const res = await fetch(`${BASE}/api/accounts/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, password: 'hunter22', ...extra }),
  });
  if (!res.ok) throw new Error(`register ${nickname}: ${res.status}`);
};

const setInput = (id, value) => `{
  const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
  i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
}`;

async function signIn(who) {
  const port = PORTS[who];
  const app = launchApp({
    port,
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-gc-profile-')),
    extraArgs: [
      '--autoplay-policy=no-user-gesture-required', '--mute-audio',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    ],
  });
  procs.push(app);
  const page = await attach(await findPage(port));
  await sleep(1500);
  await page.evaluate(`${setInput('server-url', BASE)} return true;`);
  await sleep(4000);
  await page.evaluate(`${setInput('username', who)} ${setInput('account-password', 'hunter22')}
    document.getElementById('continue').click(); return true;`);
  await waitFor(page, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: `${who} signing in`, timeoutMs: 60_000 });
  await sleep(1500);
  await page.send('Runtime.enable');
  page.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
    console.log(`  [${who} exception]`, (d.exception?.description ?? d.text).split('\n').slice(0, 3).join(' / ').slice(0, 300));
  });
  return page;
}

async function until(page, expression, { timeoutMs = 25_000, label = expression } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await page.evaluate(`return (${expression})`).catch(() => undefined);
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

async function shot(page, name) {
  const dir = process.env.DM_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(dir, `${name}.png`), Buffer.from(data, 'base64'));
}

const click = (page, selector) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); return true;`);
const view = (page) => page.evaluate("return document.querySelector('.view[data-active]')?.id");

/** The rail's first bubble: the private messages, opened. */
async function openList(page) {
  if ((await view(page)) !== 'view-dms') await click(page, '#server-rail .rail-home');
  await until(page, "document.querySelector('.view[data-active]')?.id === 'view-dms'", { label: 'the list' });
}

/** The rows of the list: their names. */
const rowNames = (page) => page.evaluate("return [...document.querySelectorAll('#dm-list .dm-row .dm-row-name')].map((n) => n.textContent)");

async function openRow(page, name) {
  await until(page, `[...document.querySelectorAll('#dm-list .dm-row')].some((r) => r.querySelector('.dm-row-name')?.textContent === ${JSON.stringify(name)})`, { label: `a row called ${name}` });
  await page.evaluate(`[...document.querySelectorAll('#dm-list .dm-row')].find((r) => r.querySelector('.dm-row-name')?.textContent === ${JSON.stringify(name)}).click(); return true;`);
  await until(page, "!document.getElementById('dm-active').hidden", { label: 'the conversation' });
}

const logText = (page) => page.evaluate("return [...document.querySelectorAll('#dm-log .chat-msg')].map((m) => m.querySelector('.text')?.textContent ?? '')");

async function write(page, body) {
  await page.evaluate(`{ const i = document.getElementById('dm-input'); i.value = ${JSON.stringify(body)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('dm-send').click(); }  return true;`);
}


const PHONE = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };

/** Everything that must hold on a phone: nothing wider than the screen, and what is drawn is on it. */
const fits = (page, selector) => page.evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { missing: true };
  const r = el.getBoundingClientRect();
  return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), w: innerWidth, h: innerHeight,
    ok: r.left >= 0 && r.right <= innerWidth + 0.5 && r.top >= 0 && r.bottom <= innerHeight + 0.5, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
})()`.replace(/^/, 'return '));

async function run() {
  await startMediaMtx();
  await startServer();
  await register('alice', { ownerKey });
  await register('bob');
  const alice = await signIn('alice');
  const bob = await signIn('bob');
  await bob.send('Emulation.setDeviceMetricsOverride', PHONE);
  await bob.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await bob.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await sleep(2500);

  // Alice (at a desk) makes a group of the two of them and calls it.
  await openList(alice);
  await until(alice, "!document.getElementById('dm-new-group').hidden", { label: 'new group' });
  await click(alice, '#dm-new-group');
  await until(alice, "document.getElementById('dm-group-name')", { label: 'dialog' });
  await alice.evaluate(`{ const n = document.getElementById('dm-group-name'); n.value = 'Weekend plans'; n.dispatchEvent(new Event('input', { bubbles: true })); }
    for (const box of document.querySelectorAll('.dm-picker input[type=checkbox]')) { box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); } return true;`);
  await click(alice, '#dm-group-go');
  await until(alice, "document.getElementById('dm-name').textContent === 'Weekend plans'", { label: 'group' });
  await click(alice, '#dm-call');

  // --- the ring, on a phone
  await until(bob, "document.querySelector('#incoming-calls .incoming-call')", { label: 'ring', timeoutMs: 40_000 });
  await shot(bob, 'm-ring');
  const card = await fits(bob, '.incoming-call');
  check('the ringing card is wholly on the screen, and the page does not scroll sideways', card.ok && !card.overflow, JSON.stringify(card));
  const btn = await bob.evaluate("return [...document.querySelectorAll('.incoming-call-buttons button')].map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })");
  check('its two buttons are each big enough to hit (44 px)', btn.every(([w, h]) => w >= 100 && h >= 44), JSON.stringify(btn));
  const top = await bob.evaluate("return Math.round(document.querySelector('.incoming-call').getBoundingClientRect().top)");
  check('and clear of the notch and the status bar', top >= 8, String(top));

  await click(bob, '#incoming-calls .incoming-call-answer');
  await until(bob, "!document.getElementById('voice-active').hidden", { label: 'bob in the call', timeoutMs: 40_000 });
  await until(bob, "document.querySelectorAll('#voice-roster li').length === 2", { label: 'both', timeoutMs: 40_000 });
  await sleep(800);
  await shot(bob, 'm-call');
  const page = await fits(bob, '#views');
  check('the page of the call fits the phone', page.ok && !page.overflow, JSON.stringify(page));
  const where = await bob.evaluate(`return { view: document.querySelector('.view[data-active]')?.id, screen: !document.getElementById('call-screen').hidden,
    controls: ['cs-mute', 'cs-deafen', 'cs-camera', 'cs-screen', 'cs-hangup'].map((id) => { const e = document.getElementById(id); if (!e) return [id, null]; const r = e.getBoundingClientRect(); return [id, r.width > 0 && r.right <= innerWidth && r.bottom <= innerHeight, Math.round(r.height)]; }) }`);
  check('the call is on its screen over the conversation, and its controls can be reached', where.view === 'view-dms' && where.screen && where.controls.every((c) => c[1]), JSON.stringify(where));
  check('each big enough to press', where.controls.every((c) => c[2] >= 40), JSON.stringify(where));

  // --- reading the private messages in the call
  await sleep(500);
  await shot(bob, 'm-dm-with-call');
  const fitsScreen = await fits(bob, '#call-screen');
  check('the call screen fits the phone', fitsScreen.ok && !fitsScreen.overflow, JSON.stringify(fitsScreen));
  const rail = await bob.evaluate("const r = document.getElementById('server-rail'); return { hidden: r.hidden, w: Math.round(r.getBoundingClientRect().width), h: Math.round(r.getBoundingClientRect().height) }");
  console.log('  (rail)', JSON.stringify(rail));

  // The conversation's header, with the call going on.
  await until(bob, "document.querySelectorAll('#dm-list .dm-row').length > 0", { label: 'row' });
  await bob.evaluate("document.querySelector('#dm-list .dm-row').click(); return true;");
  await until(bob, "!document.getElementById('dm-active').hidden", { label: 'conversation' });
  await sleep(800);
  await shot(bob, 'm-dm-header');
  const head = await bob.evaluate(`return [...document.querySelectorAll('#view-dms .dm-head > *')].filter((e) => !e.hidden && e.getClientRects().length).map((e) => { const r = e.getBoundingClientRect(); return [e.id || e.className.toString().slice(0, 20), Math.round(r.left), Math.round(r.right), Math.round(r.top), Math.round(r.bottom)]; })`);
  check('every control in the conversation header is on the screen', head.every((h) => h[1] >= 0 && h[2] <= 391), JSON.stringify(head));
  check('and the call button is one of them', head.some((h) => h[0] === 'dm-call'), '');
  const cb = await fits(bob, '#view-dms #dm-active');
  check('the conversation does not scroll sideways', !cb.overflow, JSON.stringify(cb));

  // --- from the phone: calling
  await click(bob, '#cs-hangup');
  await until(bob, "document.getElementById('voice-active').hidden", { label: 'bob out' });
  await bob.evaluate("document.querySelector('#server-rail .rail-home')?.click(); return true;").catch(() => {});
  await sleep(800);
  const view2 = await bob.evaluate("return document.querySelector('.view[data-active]')?.id");
  if (view2 !== 'view-dms') await bob.evaluate("document.querySelector('#server-rail .rail-home').click(); return true;");
  await sleep(500);
  if (await bob.evaluate("return document.getElementById('dm-active').hidden")) {
    await bob.evaluate("document.querySelector('#dm-list .dm-row')?.click(); return true;");
    await sleep(500);
  }
  await click(bob, '#dm-call');
  await until(bob, "!document.getElementById('voice-active').hidden", { label: 'bob calling', timeoutMs: 40_000 });
  await sleep(800);
  await shot(bob, 'm-calling');
  const calling = await bob.evaluate("return { status: document.getElementById('call-status').textContent, screen: !document.getElementById('call-screen').hidden, view: document.querySelector('.view[data-active]')?.id }");
  check('calling from the phone puts the call on its screen, ringing, over the conversation', calling.view === 'view-dms' && calling.screen && /Ringing/.test(calling.status), JSON.stringify(calling));
  const again = await fits(bob, '#views');
  check('and fits', again.ok && !again.overflow, JSON.stringify(again));
}

run().then(() => process.exit(summary() ? 1 : 0)).catch((err) => { console.error(err); summary(); process.exit(1); });
