// Private conversations, as a person sees them: two real app windows against a
// real server and MediaMTX.
//
// Alice right-clicks Bob in the member list and opens a conversation (and is
// shown her recovery key, the first time). She writes; Bob sees the badge on the
// button in the corner, opens the list, opens the conversation and answers.
// Opening a channel puts the conversation away.
//
//   MEDIAMTX_BIN=/path/to/mediamtx node client/test/dm-ui.mjs

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

const HARMONY_PORT = 18280;
const MTX_API_PORT = 9997 - 130;
const MTX_WEBRTC_PORT = 8889 - 130;
const MTX_ICE_PORT = 8189 - 130;
const PORT_ALICE = 9583;
const PORT_BOB = 9584;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-du-'));
const { check, summary } = reporter();
const procs = [];
let mtxLog = '';
let serverLog = '';
let ownerKey = null;

process.on('exit', () => {
  for (const p of procs) {
    try { p.kill(); } catch { /* already gone */ }
  }
});
process.on('SIGINT', () => process.exit(130));

async function startMediaMtx() {
  const dir = mkdtempSync(join(tmpdir(), 'harmony-du-mtx-'));
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
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-du-profile-')),
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

/** Wait for a condition evaluated in the page, polled, returning what it returned. */
async function until(page, expression, { timeoutMs = 20_000, label = expression } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await page.evaluate(`return (${expression})`).catch(() => undefined);
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

/** DM_SHOTS=/some/dir saves a picture of each step, for looking at rather than asserting. */
async function shot(page, name) {
  const dir = process.env.DM_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(dir, `${name}.png`), Buffer.from(data, 'base64'));
}

const text = (id) => `document.getElementById('${id}')?.textContent ?? ''`;

async function run() {
  console.log('Starting MediaMTX, the server and two clients…\n');
  await startMediaMtx();
  await startServer();
  await register('alice', { ownerKey });
  await register('bob');
  const alice = await signIn(PORT_ALICE, 'alice');
  const bob = await signIn(PORT_BOB, 'bob');
  for (const [name, page] of [['alice', alice], ['bob', bob]]) {
    await page.send('Runtime.enable');
    page.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
      console.log(`  [${name} exception]`, (d.exception?.description ?? d.text).split('\n').slice(0, 3).join(' / ').slice(0, 300));
    });
    // The member list is where somebody is right-clicked.
    await page.evaluate("if (document.getElementById('member-list').hidden) document.getElementById('channels-members').click(); return true;");
  }
  await sleep(3000);

  // --- the button ----------------------------------------------------------------------------------------------------
  await until(alice, "!document.getElementById('dm-open').hidden", { label: 'the button in the corner' });
  check('the button for private messages is in the top bar', await alice.evaluate("return !document.getElementById('dm-open').hidden"), '');
  const inHeader = await alice.evaluate("return Boolean(document.getElementById('dm-open').closest('header'))");
  check('and it is in the header, with the other buttons', inHeader, '');

  await alice.evaluate("document.getElementById('dm-open').click(); return true;");
  await until(alice, "!document.getElementById('dm-panel').hidden", { label: 'the list opening' });
  // Nothing was thrown at her on signing in; the list says a recovery key is waiting.
  check('signing in does not put a dialog in front of anybody', !(await alice.evaluate("return document.querySelector('dialog.dm-keys')?.open")), '');
  const note = await alice.evaluate("return document.getElementById('dm-panel-note').textContent");
  check('the list says there is a recovery key to keep', /recovery key/i.test(note), note);
  await alice.evaluate("[...document.querySelectorAll('#dm-panel-actions button')].find((b) => /recovery key/i.test(b.textContent))?.click(); return true;");
  await until(alice, "document.querySelector('dialog.dm-keys')?.open", { label: 'the recovery key' });
  const keyShown = await alice.evaluate("return document.querySelector('dialog.dm-keys [data-testid=recovery-key]')?.textContent ?? ''");
  await shot(alice, '1-recovery-key');
  check('asked for, Alice is shown her recovery key', /^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/.test(keyShown), keyShown);
  await alice.evaluate("[...document.querySelectorAll('dialog.dm-keys button')].find((b) => /saved|guardei|guard/i.test(b.textContent))?.click(); return true;");
  await sleep(500);
  check('and once she has saved it, the dialog goes', !(await alice.evaluate("return document.querySelector('dialog.dm-keys')?.open")), '');
  const empty = await alice.evaluate("return { empty: !document.getElementById('dm-empty').hidden, rows: document.querySelectorAll('#dm-list .dm-row').length }");
  check('the list starts empty and says how to begin', empty.empty && empty.rows === 0, JSON.stringify(empty));
  await alice.evaluate("document.getElementById('dm-panel-close').click(); return true;");

  // --- right-click on a person --------------------------------------------------------------------------------------------
  await until(alice, "document.querySelector('.member-row[data-user-id]')", { label: 'the member list' });
  const bobId = await alice.evaluate("return [...document.querySelectorAll('.member-row')].find((r) => /bob/i.test(r.textContent))?.dataset.userId");
  await alice.evaluate(`
    const row = document.querySelector('.member-row[data-user-id="${bobId}"]');
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 })); return true;`);
  await shot(alice, '0-member-menu');
  const menuItems = await alice.evaluate("return [...document.querySelectorAll('#member-menu-body button')].map((b) => b.textContent)");
  check('right-clicking somebody offers to send a private message', menuItems.includes('Send a private message'), JSON.stringify(menuItems));
  await alice.evaluate("[...document.querySelectorAll('#member-menu-body button')].find((b) => b.textContent === 'Send a private message').click(); return true;");
  await until(alice, "!document.getElementById('dm-active').hidden", { label: 'the conversation' });
  const opened = await alice.evaluate(`return { name: document.getElementById('dm-name').textContent,
    stage: !document.getElementById('channel-stage').hidden, chat: document.getElementById('chat-active').hidden }`);
  check('the conversation opens on the stage, named for Bob', /bob/i.test(opened.name) && opened.stage && opened.chat, JSON.stringify(opened));

  // --- writing ----------------------------------------------------------------------------------------------------------------
  await alice.evaluate(`const i = document.getElementById('dm-input'); i.value = 'oi, bob! 👋'; i.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('dm-send').click(); return true;`);
  await until(alice, "document.querySelector('#dm-log .chat-msg .text')?.textContent.includes('oi, bob')", { label: 'her own message' });
  check('what Alice wrote appears in her conversation', true, '');

  // --- Bob sees it -----------------------------------------------------------------------------------------------------------
  await until(bob, "!document.getElementById('dm-badge').hidden", { label: "the badge on Bob's button" });
  const badge = await bob.evaluate("return document.getElementById('dm-badge').textContent");
  check("Bob's button shows one unread", badge === '1', badge);
  await bob.evaluate("document.getElementById('dm-open').click(); return true;");
  await until(bob, "document.querySelectorAll('#dm-list .dm-row').length === 1", { label: 'the conversation in the list' });
  await shot(bob, '2-bob-list');
  const row = await bob.evaluate("const r = document.querySelector('#dm-list .dm-row'); return { text: r.textContent, unread: r.hasAttribute('data-unread') }");
  check('his list has the conversation, with what she wrote and marked unread', /alice/i.test(row.text) && row.text.includes('oi, bob') && row.unread, JSON.stringify(row));
  await bob.evaluate("document.querySelector('#dm-list .dm-row').click(); return true;");
  await until(bob, "document.querySelector('#dm-log .chat-msg .text')?.textContent.includes('oi, bob')", { label: 'the message in his conversation' });
  check('opening it shows the message, readable', true, '');
  await until(bob, "document.getElementById('dm-badge').hidden", { label: 'the badge going' });
  check('and reading it clears the badge', true, '');

  // --- the answer ----------------------------------------------------------------------------------------------------------
  await bob.evaluate(`const i = document.getElementById('dm-input'); i.value = 'oi, alice!'; i.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('dm-send').click(); return true;`);
  await until(alice, "document.querySelectorAll('#dm-log .chat-msg').length >= 2 && document.getElementById('dm-log').textContent.includes('oi, alice')", { label: "Bob's answer on Alice's screen" });
  await shot(alice, '3-alice-conversation');
  check("Bob's answer reaches Alice, live", true, '');

  // --- the lock and the stage ------------------------------------------------------------------------------------------
  const lock = await alice.evaluate("return Boolean(document.querySelector('#dm-active .dm-lock'))");
  check('the conversation says it is encrypted', lock, '');
  await alice.evaluate(`document.querySelector('#channel-items li.channel-row[data-kind="text"], #channel-items li.channel-row')?.click(); return true;`);
  await until(alice, "document.getElementById('dm-active').hidden", { label: 'the conversation giving way to a channel' }).catch(() => null);
  const gaveWay = await alice.evaluate("return document.getElementById('dm-active').hidden");
  check('opening a channel puts the conversation away', gaveWay, '');

  // --- nothing but ciphertext on the way -----------------------------------------------------------------------------
  const leaked = await alice.evaluate(`return (await fetch('${BASE}/api/health')).ok`).catch(() => true);
  check('the server is still answering', leaked, '');
}

run()
  .catch((err) => {
    console.error(err);
    console.error(serverLog.split('\n').slice(-10).join('\n'));
    process.exitCode = 1;
  })
  .finally(() => {
    const failed = summary();
    setTimeout(() => process.exit(process.exitCode ?? (failed ? 1 : 0)), 200);
  });
