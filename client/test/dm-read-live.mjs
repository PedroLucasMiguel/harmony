// What happens to a private conversation that is OPEN while messages arrive and are sent: its line, its counters,
// where it scrolls. (Two real app windows against a real server.)
//
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

const HARMONY_PORT = 18281;
const MTX_API_PORT = 9997 - 131;
const MTX_WEBRTC_PORT = 8889 - 131;
const MTX_ICE_PORT = 8189 - 131;
const PORT_ALICE = 9585;
const PORT_BOB = 9586;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-dr-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'harmony-dr-mtx-'));
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
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-dr-profile-')),
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
  // Private messages are the first bubble on the rail; the button that used to sit in the corner is gone.
  await until(alice, "document.querySelector('#server-rail .rail-home') && !document.querySelector('#server-rail .rail-home').disabled", { label: 'the rail\'s first bubble' });
  check('private messages are the first bubble on the rail', await alice.evaluate("return Boolean(document.querySelector('#server-rail .rail-home'))"), '');
  check('and the old button in the top bar is gone', await alice.evaluate("return !document.getElementById('dm-open') && !document.getElementById('dm-badge')"), '');

  await alice.evaluate("document.querySelector('#server-rail .rail-home').click(); return true;");
  await until(alice, "document.querySelector('.view[data-active]')?.id === 'view-dms' && document.getElementById('dm-panel').offsetParent !== null", { label: 'the list opening' });
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
  // Back to the server through the rail's first bubble.
  await alice.evaluate("document.querySelector('#server-rail .rail-home').click(); return true;");
  await until(alice, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'back on the server' });

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
    view: document.querySelector('.view[data-active]')?.id, picked: document.getElementById('dm-none').hidden }`);
  check('the conversation opens on the private messages page, named for Bob', /bob/i.test(opened.name) && opened.view === 'view-dms' && opened.picked, JSON.stringify(opened));

  // --- writing ----------------------------------------------------------------------------------------------------------------
  await alice.evaluate(`const i = document.getElementById('dm-input'); i.value = 'oi, bob! 👋'; i.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('dm-send').click(); return true;`);
  await until(alice, "document.querySelector('#dm-log .chat-msg .text')?.textContent.includes('oi, bob')", { label: 'her own message' });
  check('what Alice wrote appears in her conversation', true, '');

  // --- Bob sees it -----------------------------------------------------------------------------------------------------------
  await until(bob, "document.querySelector('#server-rail .rail-home .rail-badge')", { label: "the badge on Bob's bubble" });
  const badge = await bob.evaluate("return document.querySelector('#server-rail .rail-home .rail-badge').textContent");
  check("Bob's button shows one unread", badge === '1', badge);
  await bob.evaluate("document.querySelector('#server-rail .rail-home').click(); return true;");
  await until(bob, "document.querySelectorAll('#dm-list .dm-row').length === 1", { label: 'the conversation in the list' });
  await shot(bob, '2-bob-list');
  const row = await bob.evaluate("const r = document.querySelector('#dm-list .dm-row'); return { text: r.textContent, unread: r.hasAttribute('data-unread') }");
  check('his list has the conversation, with what she wrote and marked unread', /alice/i.test(row.text) && row.text.includes('oi, bob') && row.unread, JSON.stringify(row));
  await bob.evaluate("document.querySelector('#dm-list .dm-row').click(); return true;");
  await until(bob, "document.querySelector('#dm-log .chat-msg .text')?.textContent.includes('oi, bob')", { label: 'the message in his conversation' });
  check('opening it shows the message, readable', true, '');
  const firstNews = await bob.evaluate(`
    const line = document.querySelector('#dm-log .new-divider');
    return { line: Boolean(line), label: line?.textContent ?? '', before: line?.nextElementSibling?.textContent ?? '' };`);
  check('a line says where the news began: "New messages", just above what she wrote', firstNews.line && /new/i.test(firstNews.label) && /oi, bob/.test(firstNews.before), JSON.stringify(firstNews));
  await until(bob, "!document.querySelector('#server-rail .rail-home .rail-badge')", { label: 'the badge going' });
  check('and reading it clears the badge', true, '');

  // --- a conversation that is open while the window says it has no focus ------------------------------------------------------
  // (Bob's window is one of two on this machine: the page says it has no focus, as a phone's WebView or a window that was
  // brought forward without a click can.) Looking at it is shown by touching it.
  const watchState = (page) => page.evaluate(`
    const l = document.getElementById('dm-log');
    const row = document.querySelector('#dm-list .dm-row');
    return {
      divider: Boolean(l.querySelector('.new-divider')),
      railBadge: document.querySelector('#server-rail .rail-home .rail-badge')?.textContent ?? null,
      rowUnread: row?.hasAttribute('data-unread') ?? null,
      fromBottom: Math.round(l.scrollHeight - l.scrollTop - l.clientHeight),
      rows: l.querySelectorAll('.chat-msg').length,
    };`);
  const sendFrom = (page, words) => page.evaluate(`const i = document.getElementById('dm-input'); i.value = ${JSON.stringify(words)};
    i.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('dm-send').click(); return true;`);
  const touch = (page) => page.evaluate("document.getElementById('dm-log').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return true;");
  check('the page really says it has no focus here', (await bob.evaluate('return document.hasFocus()')) === false, '');

  await sendFrom(alice, 'second one');
  await until(bob, "document.getElementById('dm-log').textContent.includes('second one')", { label: 'second one on his screen' });
  await sleep(600);
  let st = await watchState(bob);
  check('with nobody touching the window, a message in the open conversation is counted', st.railBadge === '1' && st.rowUnread === true, JSON.stringify(st));
  await touch(bob);
  await until(bob, "!document.querySelector('#server-rail .rail-home .rail-badge')", { label: 'the counter going when he touches the conversation' });
  st = await watchState(bob);
  check('touching the conversation reads it: the bubble and the list are cleared, though the window has no focus', st.railBadge === null && st.rowUnread === false, JSON.stringify(st));
  check('and the line is still there: nothing has told it he has seen the news', st.divider === true, JSON.stringify(st));
  await sendFrom(alice, 'third one');
  await until(bob, "document.getElementById('dm-log').textContent.includes('third one')", { label: 'third one on his screen' });
  await sleep(600);
  st = await watchState(bob);
  check('with him there, a message that comes is read as it comes', st.railBadge === null && st.rowUnread === false, JSON.stringify(st));
  check('and the line over the news goes: at the bottom, he has seen them', st.divider === false && st.fromBottom < 40, JSON.stringify(st));

  // --- coming back to news, and answering from far up -----------------------------------------------------------------------------
  await bob.evaluate("document.querySelector('#server-rail .rail-item[data-server]').click(); return true;");
  await until(bob, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: "Bob's server" });
  await alice.evaluate(`(async () => {
    const input = document.getElementById('dm-input');
    for (let i = 1; i <= 14; i += 1) { input.value = 'filler number ' + i; input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('dm-send').click(); await new Promise((r) => setTimeout(r, 200)); }
    return true; })()`);
  await until(bob, "document.querySelector('#server-rail .rail-home .rail-badge')?.textContent === '14'", { label: 'all of the news on the rail' });
  await bob.evaluate("document.querySelector('#server-rail .rail-home').click(); return true;");
  await until(bob, "document.querySelectorAll('#dm-list .dm-row').length === 1", { label: 'the list' });
  await bob.evaluate("document.querySelector('#dm-list .dm-row').click(); return true;");
  await until(bob, "document.querySelector('#dm-log .new-divider')", { label: 'the line, with news' });
  await sleep(600);
  st = await watchState(bob);
  check('opened with news there is a line, and it is cleared from the counters', st.divider && st.railBadge === null && st.rowUnread === false, JSON.stringify(st));
  // a short log, so that what there is more than it holds whatever the size of the window
  await sleep(1500);
  await bob.evaluate("const l = document.getElementById('dm-log'); l.dispatchEvent(new WheelEvent('wheel', { bubbles: true })); l.style.maxHeight = '260px'; return true;");
  await sleep(300);
  await bob.evaluate("const l = document.getElementById('dm-log'); l.scrollTop = 0; l.dispatchEvent(new Event('scroll')); return true;");
  await sleep(300);
  const far = await bob.evaluate("const l = document.getElementById('dm-log'); return { top: l.scrollTop, h: l.scrollHeight, c: l.clientHeight, view: document.querySelector('.view[data-active]')?.id };");
  check('he is reading from far up', (await watchState(bob)).fromBottom > 150, JSON.stringify(far));
  await sendFrom(bob, 'my answer');
  await until(bob, "document.getElementById('dm-log').textContent.includes('my answer')", { label: 'his answer' });
  await sleep(1500);
  st = await watchState(bob);
  check('answering takes him to the bottom, to what he sent', st.fromBottom < 40, JSON.stringify(st));
  check('and the line over the news goes, as does anything left in the counters', st.divider === false && st.railBadge === null && st.rowUnread === false, JSON.stringify(st));
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
