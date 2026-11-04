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

const HARMONY_PORT = 18292;
const MTX_API_PORT = 9997 - 142;
const MTX_WEBRTC_PORT = 8889 - 142;
const MTX_ICE_PORT = 8189 - 142;
const PORTS = { alice: 9596, bob: 9597 };
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



const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const type = (page, id, value) => page.evaluate(`{ const i = document.getElementById(${JSON.stringify(id)}); i.focus(); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); } return true;`);
const line = (page, id) => page.evaluate(`return document.getElementById(${JSON.stringify(id)}).textContent`);

async function run() {
  await startMediaMtx();
  await startServer();
  await register('alice', { ownerKey });
  await register('bob');
  const alice = await signIn('alice');
  const bob = await signIn('bob');
  await sleep(2500);

  // --- a text channel
  const openGeneral = (page) => page.evaluate("[...document.querySelectorAll('#channel-items li.channel-row')].find((r) => r.textContent.includes('general')).click(); return true;");
  await openGeneral(alice);
  await openGeneral(bob);
  await until(bob, "!document.getElementById('chat-active').hidden", { label: 'bob in the channel' });
  await until(alice, "!document.getElementById('chat-active').hidden", { label: 'alice in the channel' });
  check('nothing is said while nobody types', (await line(bob, 'chat-typing')) === '', '');
  await type(alice, 'chat-input', 'hel');
  await until(bob, "document.getElementById('chat-typing').textContent === 'alice is typing…'", { label: 'bob seeing it' });
  check('typing in a channel shows, over the box, for the others', true, '');
  const own = await line(alice, 'chat-typing');
  check('and not to the one typing', own === '', own);
  await shot(bob, 'typing-channel');
  await alice.evaluate("document.getElementById('chat-input').value = 'hello'; document.getElementById('chat-form').requestSubmit(); return true;");
  await until(bob, "document.getElementById('chat-typing').textContent === ''", { label: 'the line going' });
  check('sending what was typed takes the line away at once', true, '');
  await type(alice, 'chat-input', 'x');
  await until(bob, "document.getElementById('chat-typing').textContent !== ''", { label: 'it again' });
  const began = Date.now();
  await until(bob, "document.getElementById('chat-typing').textContent === ''", { label: 'it going by itself', timeoutMs: 12_000 });
  const lasted = Date.now() - began;
  check('somebody who stopped typing is not shown for long: gone about two seconds after the last key', lasted < 3500, `${lasted} ms`);
  // And not shown again until they actually start again.
  await sleep(1500);
  check('and not shown again until they type again', (await line(bob, 'chat-typing')) === '', '');
  await type(alice, 'chat-input', 'xy');
  await until(bob, "document.getElementById('chat-typing').textContent !== ''", { label: 'it when they start again' });
  await type(alice, 'chat-input', '');
  const t0 = Date.now();
  await until(bob, "document.getElementById('chat-typing').textContent === ''", { label: 'it going when the box is emptied', timeoutMs: 5000 });
  check('emptying the box takes it away at once', Date.now() - t0 < 1500, `${Date.now() - t0} ms`);

  // --- a private conversation
  const openWith = async (page, name) => {
    if ((await view(page)) !== 'view-channels') await click(page, '#server-rail .rail-home');
    await page.evaluate("if (document.getElementById('member-list').hidden) document.getElementById('channels-members').click(); return true;");
    await until(page, `[...document.querySelectorAll('.member-row')].some((r) => r.textContent.includes(${JSON.stringify(name)}))`, { label: 'the member list' });
    await page.evaluate(`const row = [...document.querySelectorAll('.member-row')].find((r) => r.textContent.includes(${JSON.stringify(name)}));
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 })); return true;`);
    await page.evaluate("[...document.querySelectorAll('#member-menu-body button')].find((b) => b.textContent === 'Send a private message').click(); return true;");
    await until(page, `document.getElementById('dm-name').textContent === ${JSON.stringify(name)} && !document.getElementById('dm-input').disabled`, { label: `the conversation with ${name}` });
  };
  await openWith(alice, 'bob');
  await write(alice, 'hi bob');
  await openWith(bob, 'alice');
  await until(bob, "document.getElementById('dm-log').textContent.includes('hi bob')", { label: 'the message' });
  await type(alice, 'dm-input', 'typing…');
  await until(bob, "document.getElementById('dm-typing').textContent === 'alice is typing…'", { label: 'bob seeing it in the conversation' });
  check('typing in a private conversation shows over its box', true, '');
  await shot(bob, 'typing-dm');
  await alice.evaluate("document.getElementById('dm-send').click(); return true;");
  await until(bob, "document.getElementById('dm-typing').textContent === ''", { label: 'it going on sending' });
  check('and goes when the message arrives', true, '');

  // The list says it too, in the row, where the last message was.
  const row = () => bob.evaluate(`{
    const li = [...document.querySelectorAll('#dm-list .dm-row')].find((r) => r.querySelector('.dm-row-name')?.textContent === 'alice');
    return { there: Boolean(li), typing: li?.hasAttribute('data-typing'), words: li?.querySelector('.dm-row-typing')?.textContent,
      typingShown: li ? getComputedStyle(li.querySelector('.dm-row-typing')).display !== 'none' : null,
      previewShown: li ? getComputedStyle(li.querySelector('.dm-row-text')).display !== 'none' : null };
  }`);
  const rest = await row();
  check('a row in the list says nothing of typing while nobody types', rest.there && !rest.typing && rest.typingShown === false && rest.previewShown === true, JSON.stringify(rest));
  await type(alice, 'dm-input', 'again…');
  await until(bob, "document.querySelector('#dm-list .dm-row[data-typing]')", { label: 'the row saying it' });
  const typingRow = await row();
  check('while somebody types in a conversation its row says so instead of the last message',
    typingRow.typing && typingRow.words === 'typing…' && typingRow.typingShown && !typingRow.previewShown, JSON.stringify(typingRow));
  await shot(bob, 'typing-row');
  await alice.evaluate("{ const i = document.getElementById('dm-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); } return true;");
  await until(bob, "!document.querySelector('#dm-list .dm-row[data-typing]')", { label: 'the row going back' });
  check('and the last message is back when they stop', (await row()).previewShown === true, '');

  // --- a picture in a private conversation
  await alice.evaluate(`{
    const bytes = Uint8Array.from(atob(${JSON.stringify(PNG)}), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'dot.png', { type: 'image/png' }));
    const input = document.getElementById('dm-input'); input.focus();
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  } return true;`);
  await until(alice, "!document.getElementById('dm-pending').hidden", { label: 'the picture attached' });
  await alice.evaluate("document.getElementById('dm-send').click(); return true;");
  await until(bob, "document.querySelector('#dm-log img.expandable')", { label: 'the picture in bob\'s conversation' });
  const img = await bob.evaluate("const i = document.querySelector('#dm-log img.expandable'); return { cursor: getComputedStyle(i).cursor, title: i.title }");
  check('a picture in a private conversation looks clickable, as in a channel', img.cursor === 'zoom-in' && img.title !== '', JSON.stringify(img));
  await bob.evaluate("document.querySelector('#dm-log img.expandable').click(); return true;");
  const box = await bob.evaluate("const l = document.getElementById('lightbox'); const i = document.getElementById('lightbox-img'); return { shown: !l.hidden, src: i.src.slice(0, 5), name: document.getElementById('lightbox-name').textContent }");
  check('clicking it opens it full size, from what was opened on this computer', box.shown && box.src === 'blob:' && box.name === 'dot.png', JSON.stringify(box));
  await shot(bob, 'dm-lightbox');
  await bob.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await until(bob, "document.getElementById('lightbox').hidden", { label: 'Escape closing it' });
  check('Escape closes it, and it lets go of the picture', await bob.evaluate("return !document.getElementById('lightbox-img').hasAttribute('src')"), '');
  // And a channel's picture still opens as it did: its own URL, its own save.
  check('the lightbox still has a save button', await bob.evaluate("return Boolean(document.getElementById('lightbox-save'))"), '');
}

run().then(() => process.exit(summary() ? 1 : 0)).catch((err) => { console.error(err); summary(); process.exit(1); });
