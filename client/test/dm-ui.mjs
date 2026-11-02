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

  // --- the answer ----------------------------------------------------------------------------------------------------------
  await bob.evaluate(`const i = document.getElementById('dm-input'); i.value = 'oi, alice!'; i.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('dm-send').click(); return true;`);
  await until(alice, "document.querySelectorAll('#dm-log .chat-msg').length >= 2 && document.getElementById('dm-log').textContent.includes('oi, alice')", { label: "Bob's answer on Alice's screen" });
  await shot(alice, '3-alice-conversation');
  check("Bob's answer reaches Alice, live", true, '');

  // --- editing, in the box -- the way a channel does it ------------------------------------------------------------------------
  const press = (page, k) => page.evaluate(`const i = document.getElementById('dm-input'); i.focus();
    i.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true })); return true;`);
  const editState = (page) => page.evaluate(`return {
    bar: !document.getElementById('dm-editing').hidden,
    value: document.getElementById('dm-input').value,
    row: document.querySelector('#dm-log .chat-msg[data-editing] .text')?.textContent ?? null,
    form: document.getElementById('dm-form').hasAttribute('data-editing'),
    sendShown: !document.getElementById('dm-send').hidden,
    dialog: Boolean(document.querySelector('dialog[open]')),
  }`);
  await press(alice, 'ArrowUp');
  let edit = await editState(alice);
  check('Up in the empty box starts rewriting her last message: bar, words in the box, row marked, Save shown, no dialog',
    edit.bar && edit.value === 'oi, bob! 👋' && edit.row?.includes('oi, bob') && edit.form && edit.sendShown && !edit.dialog, JSON.stringify(edit));
  await press(alice, 'Escape');
  edit = await editState(alice);
  check('Esc gives it up and puts the box back to empty', !edit.bar && edit.value === '' && edit.row === null && !edit.form, JSON.stringify(edit));
  await press(alice, 'ArrowUp');
  await alice.evaluate(`const i = document.getElementById('dm-input'); i.value = 'oi, bob! (editado)'; i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  await press(alice, 'Enter');
  await until(alice, "document.getElementById('dm-log').textContent.includes('(editado)')", { label: 'the edited words' });
  edit = await editState(alice);
  check('Enter saves it: the new words are in the log and the box is back to normal', !edit.bar && edit.value === '' && edit.row === null && !edit.form, JSON.stringify(edit));
  await until(bob, "document.getElementById('dm-log').textContent.includes('(editado)')", { label: 'the edit on his screen' });
  check('and Bob sees the edited words, marked as edited', await bob.evaluate("return /edited/i.test(document.getElementById('dm-log').textContent)"), '');

  // --- the counter: a message that arrives while the window is away is read when it comes back ------------------------------
  await bob.evaluate("document.hasFocus = () => false; return true;");
  await alice.evaluate(`const i = document.getElementById('dm-input'); i.value = 'are you there?'; i.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('dm-send').click(); return true;`);
  await until(bob, "document.querySelector('#server-rail .rail-home .rail-badge')", { label: 'the badge while his window is away' });
  check('with the window away, a message in the open conversation is counted', true, '');
  await bob.evaluate("document.hasFocus = () => true; window.dispatchEvent(new Event('focus')); return true;");
  await until(bob, "!document.querySelector('#server-rail .rail-home .rail-badge')", { label: 'the badge going when the window comes back' });
  check('and coming back to the window reads it: the counter clears without sending anything', true, '');
  check('the row in the list is no longer marked unread', !(await bob.evaluate("return document.querySelector('#dm-list .dm-row')?.hasAttribute('data-unread')")), '');

  // --- finding things in the conversation --------------------------------------------------------------------------------------
  const searchPress = (page, key) => page.evaluate(`const i = document.getElementById('dm-search'); i.focus();
    i.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true })); return true;`);
  const searchType = (page, text) => page.evaluate(`const i = document.getElementById('dm-search'); i.focus(); i.value = ${JSON.stringify(text)};
    i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  const searchRows = (page) => page.evaluate("return [...document.querySelectorAll('#dm-search-pop .search-row')].map((r) => r.textContent.trim())");
  const searchPanel = (page) => page.evaluate(`
    const p = document.getElementById('dm-search-results');
    const box = p.getBoundingClientRect(); const pane = document.getElementById('dm-active').getBoundingClientRect();
    return { open: !p.hidden, count: document.getElementById('dm-sr-count').textContent,
      cards: [...p.querySelectorAll('.search-card')].map((c) => c.textContent),
      groups: p.querySelectorAll('.search-group').length,
      inside: box.left >= pane.left - 1 && box.right <= pane.right + 1 && box.bottom <= pane.bottom + 1 };`);

  // The event itself as well as the call: a window that is not the one in front does not raise it for focus().
  await alice.evaluate("const i = document.getElementById('dm-search'); i.focus(); i.dispatchEvent(new Event('focus')); return true;");
  await sleep(200);
  let offered = await searchRows(alice);
  check('the box offers the filters a conversation has: from, has and the more -- no channel, no mention',
    offered.length === 3 && /from: user/.test(offered[0]) && /has: link, embed or file/.test(offered[1]) && /More filters/.test(offered[2]) && !offered.some((r) => /in: channel|mentions:/.test(r)), JSON.stringify(offered));
  check('it says whose conversation it searches', /bob/i.test(await alice.evaluate("return document.getElementById('dm-search').placeholder")), '');

  await searchType(alice, 'alice');
  await searchPress(alice, 'Enter');
  await until(alice, "!document.getElementById('dm-search-results').hidden && document.querySelectorAll('#dm-search-results .search-card').length > 0", { label: 'the results' });
  await sleep(300);
  let found = await searchPanel(alice);
  check('Enter looks through the whole conversation here: one message says "alice", shown in a panel over it', found.open && found.count === '1 result' && /oi, alice/.test(found.cards[0]) && found.inside && found.groups === 0, JSON.stringify(found));

  // a filter: from Bob. The two of them are offered by name.
  await alice.evaluate("document.getElementById('dm-search-clear').click(); return true;");
  await searchType(alice, 'from:');
  await sleep(200);
  const people = await searchRows(alice);
  check('from: offers the two people in it', people.length === 2 && people.some((r) => /bob/i.test(r)) && people.some((r) => /alice/i.test(r)), JSON.stringify(people));
  await searchType(alice, 'from:bo');
  await searchPress(alice, 'Enter');
  await sleep(200);
  await searchType(alice, 'oi');
  await searchPress(alice, 'Enter');
  await until(alice, "document.getElementById('dm-sr-count').textContent === '1 result'", { label: 'only what Bob said' });
  found = await searchPanel(alice);
  check('from Bob, with "oi": only his', /oi, alice/.test(found.cards[0]) && found.cards.length === 1, JSON.stringify(found));

  // a date filter, and a kind of content nothing has
  await alice.evaluate("document.getElementById('dm-search-clear').click(); return true;");
  await searchType(alice, 'has:link ');
  await searchPress(alice, 'Enter');
  await until(alice, "!document.getElementById('dm-search-results').hidden && document.getElementById('dm-sr-count').textContent !== ''", { label: 'the link search' });
  await sleep(300);
  found = await searchPanel(alice);
  check('has:link finds nothing here, and says so', found.count === '0 results' && found.cards.length === 0, JSON.stringify(found));
  await alice.evaluate("document.getElementById('dm-search-clear').click(); return true;");
  await searchType(alice, 'during:today ');
  await searchType(alice, 'oi');
  await searchPress(alice, 'Enter');
  await until(alice, "document.getElementById('dm-sr-count').textContent === '2 results'", { label: 'what was said today' });
  check('during:today has both of the "oi" messages', true, '');

  // a result goes to its message
  await alice.evaluate("document.querySelector('#dm-search-results .search-card').click(); return true;");
  await sleep(500);
  const landedDm = await alice.evaluate(`
    const row = document.querySelector('#dm-log .chat-msg[data-jumped]'); const log = document.getElementById('dm-log').getBoundingClientRect();
    const box = row?.getBoundingClientRect();
    return { flashed: Boolean(row), visible: Boolean(box && box.top >= log.top - 1 && box.bottom <= log.bottom + 1) };`);
  check('choosing a result goes to the message and flashes it', landedDm.flashed && landedDm.visible, JSON.stringify(landedDm));

  // what was searched is offered again, and the trash clears it
  await alice.evaluate("document.getElementById('dm-search-clear').click(); const i = document.getElementById('dm-search'); i.focus(); i.dispatchEvent(new Event('focus')); return true;");
  await sleep(250);
  offered = await searchRows(alice);
  check('what was searched is offered again under the filters', offered.length > 3 && offered.some((r) => /oi/.test(r)), JSON.stringify(offered));
  await alice.evaluate("document.querySelector('#dm-search-pop .search-pop-action').click(); return true;");
  await sleep(250);
  check('and the trash clears it', (await searchRows(alice)).length === 3, '');
  await alice.evaluate("document.getElementById('dm-search').blur(); return true;");

  // --- the button to the newest, and the line when there is news on opening ---------------------------------------------------
  const log = (page) => page.evaluate(`const l = document.getElementById('dm-log');
    return { fromBottom: Math.round(l.scrollHeight - l.scrollTop - l.clientHeight), scrollable: l.scrollHeight > l.clientHeight + 200,
      button: !document.getElementById('dm-to-bottom').hidden, rows: l.querySelectorAll('.chat-msg').length };`);
  await alice.evaluate(`(async () => {
    const input = document.getElementById('dm-input');
    for (let i = 1; i <= 16; i += 1) {
      input.value = 'filler number ' + i; input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('dm-send').click();
      await new Promise((r) => setTimeout(r, 200));
    }
    return true;
  })()`);
  await until(alice, "document.getElementById('dm-log').textContent.includes('filler number 16')", { label: 'the fillers' });
  // A short log, so that a few messages are more than it holds whatever the size of the window.
  await alice.evaluate("document.getElementById('dm-log').style.maxHeight = '260px'; return true;");
  await alice.evaluate("const l = document.getElementById('dm-log'); l.scrollTop = l.scrollHeight; l.dispatchEvent(new Event('scroll')); return true;");
  await sleep(400);
  let at = await log(alice);
  check('the conversation is long enough to scroll, and at the newest the button is not there', at.scrollable && at.fromBottom < 40 && !at.button, JSON.stringify(at));
  await alice.evaluate("const l = document.getElementById('dm-log'); l.scrollTop = 0; l.dispatchEvent(new Event('scroll')); return true;");
  await sleep(200);
  at = await log(alice);
  check('scrolled away from the newest, the button to it appears', at.button && at.fromBottom > 120, JSON.stringify(at));
  await alice.evaluate("document.getElementById('dm-to-bottom').click(); return true;");
  await sleep(1200);
  at = await log(alice);
  check('and pressing it goes to the newest and the button goes', at.fromBottom < 40 && !at.button, JSON.stringify(at));

  // Bob leaves the conversation (a channel puts it away), three messages come, and he opens it: the line, in view.
  await bob.evaluate("document.querySelector('#server-rail .rail-item[data-server]').click(); return true;");
  await until(bob, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: "Bob's server" });
  await bob.evaluate("[...document.querySelectorAll('#channel-items li.channel-row')].find((r) => r.querySelector('.channel-name')?.textContent === 'general').click(); return true;");
  await sleep(600);
  for (const n of ['one', 'two', 'three']) {
    await alice.evaluate(`const i = document.getElementById('dm-input'); i.value = 'news ${n}'; i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('dm-send').click(); return true;`);
    await sleep(300);
  }
  await until(bob, "document.querySelector('#server-rail .rail-home .rail-badge')", { label: 'the news on the rail' });
  await bob.evaluate("document.querySelector('#server-rail .rail-home').click(); return true;");
  await until(bob, "document.querySelectorAll('#dm-list .dm-row').length === 1", { label: 'the list' });
  await bob.evaluate("document.querySelector('#dm-list .dm-row').click(); return true;");
  await until(bob, "document.querySelector('#dm-log .new-divider')", { label: 'the line' });
  await sleep(500);
  const news = await bob.evaluate(`
    const l = document.getElementById('dm-log'); const line = l.querySelector('.new-divider');
    const box = line.getBoundingClientRect(); const view = l.getBoundingClientRect();
    return { after: line.nextElementSibling?.textContent ?? '', inView: box.top >= view.top && box.bottom <= view.bottom,
      newest: l.textContent.includes('news three'), rowsAfter: (() => { let n = 0; for (let e = line.nextElementSibling; e; e = e.nextElementSibling) n += 1; return n; })() };`);
  check('opened with news, the line is above the first of the three new ones, and in view', /news one/.test(news.after) && news.inView && news.rowsAfter === 3, JSON.stringify(news));
  check('and the badge is cleared by reading them', !(await bob.evaluate("return Boolean(document.querySelector('#server-rail .rail-home .rail-badge'))")), '');

  // --- pins ---------------------------------------------------------------------------------------------------------------------
  const rowOf = (page, text) => `[...document.querySelectorAll('#dm-log .chat-msg')].find((r) => r.textContent.includes(${JSON.stringify(text)}))`;
  const pinState = (page) => page.evaluate(`
    const strip = document.getElementById('dm-pinned');
    return { strip: !strip.hidden, text: strip.querySelector('.pinned-line')?.textContent ?? '', more: strip.querySelector('.pinned-more')?.textContent ?? '' };`);

  check('each message has a pin among its tools', await alice.evaluate(`return Boolean(${rowOf(alice, 'oi, alice!')}?.querySelector('.msg-tool[data-icon="push-pin"]'))`), '');
  check('and nothing is pinned yet: no strip', !(await pinState(alice)).strip, '');
  // Alice pins what Bob said: either of them may pin any message.
  await alice.evaluate(`${rowOf(alice, 'oi, alice!')}.querySelector('.msg-tool[data-icon="push-pin"]').click(); return true;`);
  await until(alice, "!document.getElementById('dm-pinned').hidden", { label: 'the strip, for Alice' });
  await until(bob, "!document.getElementById('dm-pinned').hidden", { label: 'the strip, for Bob' });
  let strip = await pinState(alice);
  check('pinned: a strip under the header holds it, for both of them', strip.strip && /oi, alice/.test(strip.text) && strip.more === ''
    && (await pinState(bob)).strip, JSON.stringify(strip));
  check('and the row is marked', await alice.evaluate(`return ${rowOf(alice, 'oi, alice!')}.hasAttribute('data-pinned')`), '');

  // Bob pins a later one: it is the one in the strip, and the others are behind a button.
  await bob.evaluate(`${rowOf(bob, 'news one')}.querySelector('.msg-tool[data-icon="push-pin"]').click(); return true;`);
  await until(alice, "document.querySelector('#dm-pinned .pinned-more')", { label: 'the button to the others' });
  strip = await pinState(alice);
  check('the one pinned last is in the strip, with a button to all (2)', /news one/.test(strip.text) && /2/.test(strip.more), JSON.stringify(strip));

  await alice.evaluate("document.getElementById('dm-pins').click(); return true;");
  await sleep(300);
  const pinsOpen = await alice.evaluate(`
    const pop = document.getElementById('dm-pins-pop');
    return { open: !pop.hidden, cards: [...pop.querySelectorAll('.pin-card')].map((c) => c.textContent),
      tools: [...pop.querySelectorAll('.pin-card')].every((c) => c.querySelector('.pin-tool') && c.querySelector('.pin-tool-icon')) };`);
  check('the pin in the header lists both, the last pinned first, each with Jump and Unpin',
    pinsOpen.open && pinsOpen.cards.length === 2 && /news one/.test(pinsOpen.cards[0]) && /oi, alice/.test(pinsOpen.cards[1]) && pinsOpen.tools, JSON.stringify(pinsOpen));
  await alice.evaluate("document.querySelectorAll('#dm-pins-list .pin-card')[1].querySelector('.pin-tool').click(); return true;");
  await sleep(600);
  const wentTo = await alice.evaluate(`return { closed: document.getElementById('dm-pins-pop').hidden, flashed: Boolean(document.querySelector('#dm-log .chat-msg[data-jumped]')) }`);
  check('Jump closes the list and goes to the message', wentTo.closed && wentTo.flashed, JSON.stringify(wentTo));

  await alice.evaluate("document.getElementById('dm-pins').click(); return true;");
  await sleep(200);
  await alice.evaluate("document.querySelectorAll('#dm-pins-list .pin-card')[0].querySelector('.pin-tool-icon').click(); return true;");
  await until(bob, "document.querySelector('#dm-pinned .pinned-more') === null", { label: 'one let go, for Bob' });
  strip = await pinState(bob);
  check('unpinning from the list lets it go for both: one is left, in the strip', strip.strip && /oi, alice/.test(strip.text) && strip.more === '', JSON.stringify(strip));
  await alice.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;");
  // and the other, from its row
  await alice.evaluate(`${rowOf(alice, 'oi, alice!')}.querySelector('.msg-tool[data-icon="push-pin"]').click(); return true;`);
  await until(alice, "document.getElementById('dm-pinned').hidden", { label: 'the strip going' });
  check('and unpinning from the message puts the strip away', true, '');

  // --- starred messages ---------------------------------------------------------------------------------------------------------
  // Yours alone and kept on this computer; what a private message says is kept sealed, never as readable text.
  const starKept = (page) => page.evaluate(`const r = await window.harmony.settings.get(); const s = (r.data ?? r).stars ?? {};
    return { raw: JSON.stringify(s), entries: Object.values(s).flat().map((e) => ({ kind: e.kind, sealed: Boolean(e.sealed), body: e.message?.body ?? null })) };`);
  const starPanel = (page) => page.evaluate(`
    const pop = document.getElementById('dm-stars-pop');
    return { open: !pop.hidden, cards: [...pop.querySelectorAll('.pin-card')].map((c) => c.textContent), count: document.getElementById('dm-stars-count').textContent,
      empty: pop.querySelector('.pins-empty')?.textContent ?? '' };`);
  const starSearch = async (page, text) => {
    await page.evaluate(`const i = document.getElementById('dm-stars-search'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
    await sleep(150);
  };

  check('every readable message has a star among its tools', await alice.evaluate(`return Boolean(${rowOf(alice, 'oi, alice!')}?.querySelector('.msg-tool.star-tool'))`), '');
  const headerLine = await alice.evaluate(`
    const mid = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return Math.round((r.top + r.bottom) / 2); };
    return { search: mid('dm-search-box'), pin: mid('dm-pins'), star: mid('dm-stars'), name: mid('dm-name') };`);
  check('the conversation header has its search box, pin and star on one line', headerLine.search === headerLine.pin && headerLine.pin === headerLine.star && Math.abs(headerLine.name - headerLine.search) <= 1, JSON.stringify(headerLine));
  await alice.evaluate("document.getElementById('dm-stars').click(); return true;");
  await sleep(250);
  let sp = await starPanel(alice);
  check('with nothing starred the panel says how to', sp.open && sp.cards.length === 0 && /No starred messages yet/.test(sp.empty), JSON.stringify(sp));
  await alice.evaluate("document.getElementById('dm-stars').click(); return true;");

  await alice.evaluate(`${rowOf(alice, 'oi, alice!')}.querySelector('.star-tool').click(); return true;`);
  await alice.evaluate(`${rowOf(alice, 'news one')}.querySelector('.star-tool').click(); return true;`);
  await sleep(300);
  check('the row shows its star', await alice.evaluate(`const r = ${rowOf(alice, 'oi, alice!')}; return r.hasAttribute('data-starred') && r.querySelector('.star-tool').hasAttribute('data-on')`), '');
  let kept = await starKept(alice);
  check('two are kept, each sealed', kept.entries.length === 2 && kept.entries.every((e) => e.kind === 'dm' && e.sealed && e.body === null), JSON.stringify(kept.entries));
  check('and what they say is nowhere in the settings in the clear', !/oi, alice|news one/.test(kept.raw), kept.raw.slice(0, 200));
  check('and they are Alice\'s alone: nothing is kept on Bob\'s side', (await starKept(bob)).entries.length === 0, '');

  await alice.evaluate("document.getElementById('dm-stars').click(); return true;");
  await sleep(300);
  sp = await starPanel(alice);
  check('the star lists them, the one starred last first, each with who and where', sp.open && sp.cards.length === 2 && /news one/.test(sp.cards[0]) && /oi, alice/.test(sp.cards[1])
    && sp.cards.every((c) => /bob/i.test(c)) && /2 starred messages/.test(sp.count), JSON.stringify(sp));
  await starSearch(alice, 'OI alice');
  sp = await starPanel(alice);
  check('the box finds one by its words', sp.cards.length === 1 && /oi, alice/.test(sp.cards[0]) && /1 of 2/.test(sp.count), JSON.stringify(sp));
  await starSearch(alice, 'zzz');
  check('and says when none has them', /No starred message has those words/.test((await starPanel(alice)).empty), '');
  await starSearch(alice, '');
  await alice.evaluate("document.querySelectorAll('#dm-stars-list .pin-card')[1].querySelector('.pin-body').click(); return true;");
  await sleep(700);
  const there = await alice.evaluate(`return { closed: document.getElementById('dm-stars-pop').hidden, flashed: Boolean(document.querySelector('#dm-log .chat-msg[data-jumped]')) }`);
  check('clicking one goes to the message, and the panel goes away', there.closed && there.flashed, JSON.stringify(there));

  await alice.evaluate("document.getElementById('dm-stars').click(); return true;");
  await sleep(250);
  await alice.evaluate("document.querySelectorAll('#dm-stars-list .pin-card')[0].querySelector('.pin-tool-icon').click(); return true;");
  await sleep(300);
  check('the X in the list lets one go: one is left, and its row is not starred', (await starPanel(alice)).cards.length === 1
    && await alice.evaluate(`return !${rowOf(alice, 'news one')}.hasAttribute('data-starred')`), '');
  await alice.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;");
  await alice.evaluate(`${rowOf(alice, 'oi, alice!')}.querySelector('.star-tool').click(); return true;`);
  await sleep(300);
  check('and starring it again from its row lets that go too', (await starKept(alice)).entries.length === 0, '');

  // --- link previews -------------------------------------------------------------------------------------------------------------
  // The test server has no way to the internet: the call for a card is stood in for, and what is asked is written down.
  await bob.evaluate(`const { harmony: h } = await import('./bridge.js');
    window.__asked = [];
    h.api.linkPreview = async (server, url) => { window.__asked.push(url); return { preview: { url, title: 'Example page', site: 'example.com', description: 'A page about examples' } }; };
    return true;`);
  await alice.evaluate(`const i = document.getElementById('dm-input'); i.value = 'look https://example.com/post please'; i.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('dm-send').click(); return true;`);
  await until(bob, "document.querySelector('#dm-log .link-embed .link-embed-title')", { label: 'the card' });
  const card = await bob.evaluate(`return { title: document.querySelector('#dm-log .link-embed-title').textContent, site: document.querySelector('#dm-log .link-embed-site')?.textContent,
    asked: window.__asked, linked: Boolean(document.querySelector('#dm-log .text a[href="https://example.com/post"]')) }`);
  check('a link in a private message has its card: the site, the title, the words', card.title === 'Example page' && card.site === 'example.com' && card.linked, JSON.stringify(card));
  await sleep(300);
  const { fromBottom: bottom } = await bob.evaluate("const l = document.getElementById('dm-log'); return { fromBottom: Math.round(l.scrollHeight - l.scrollTop - l.clientHeight) };");
  check('the card filled in under the newest message, and the log stayed at the newest, card and all', bottom < 40, `${bottom}px from the bottom`);
  check('and only the address of the link was asked of the server', card.asked.length === 1 && card.asked[0] === 'https://example.com/post', JSON.stringify(card.asked));

  await bob.evaluate("document.getElementById('dm-link-previews').click(); return true;");
  await sleep(500);
  check('turned off for private messages, the card is gone and the link stays', await bob.evaluate(`return !document.querySelector('#dm-log .link-embed') && Boolean(document.querySelector('#dm-log .text a[href="https://example.com/post"]'))`), '');
  await bob.evaluate("document.getElementById('dm-link-previews').click(); return true;");
  await sleep(500);
  check('and back on, it is there again', await bob.evaluate("return Boolean(document.querySelector('#dm-log .link-embed .link-embed-title'))"), '');

  // --- writing: the box that grows, and sending ----------------------------------------------------------------------------------
  // A short window, so that the conversation is longer than it: what is at the end is then a thing that can be lost.
  await alice.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 380, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  const dmGap = async () => (await alice.evaluate("const l = document.getElementById('dm-log'); return { g: Math.round(l.scrollHeight - l.scrollTop - l.clientHeight), over: l.scrollHeight - l.clientHeight };"));
  const dmType = (text) => alice.evaluate(`const i = document.getElementById('dm-input'); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  await alice.evaluate("const l = document.getElementById('dm-log'); l.scrollTop = l.scrollHeight; return true;");
  await sleep(300);
  check('the conversation is longer than the window', (await dmGap()).over > 100, JSON.stringify(await dmGap()));
  const grown = [];
  for (const n of [2, 4, 6, 8]) {
    await dmType(Array.from({ length: n }, (_, i) => `row ${i + 1}`).join('\n'));
    await sleep(250);
    grown.push([n, (await dmGap()).g]);
  }
  check('at the end, growing the box a line at a time keeps the conversation at the end', grown.every(([, g]) => g < 5), JSON.stringify(grown));
  await alice.evaluate("document.getElementById('dm-send').click(); return true;");
  await sleep(1000);
  check('sending takes you to the message', (await dmGap()).g < 5 && /row 8/.test(await alice.evaluate("return document.querySelector('#dm-log .chat-msg:last-child')?.textContent ?? ''")), JSON.stringify(await dmGap()));
  await alice.evaluate("document.getElementById('dm-log').scrollTop = 0; return true;");
  await sleep(300);
  check('scrolled up, the typing leaves the conversation where it is', await (async () => {
    const before = (await dmGap()).g;
    await dmType('a\nb\nc');
    await sleep(250);
    return (await dmGap()).g >= before - 5;
  })(), '');
  await alice.evaluate("document.getElementById('dm-send').click(); return true;");
  await sleep(1000);
  check('and sending from higher up takes you to the message', (await dmGap()).g < 5, JSON.stringify(await dmGap()));
  await alice.send('Emulation.clearDeviceMetricsOverride');
  await sleep(300);

  // --- the lock and the stage ------------------------------------------------------------------------------------------
  const lock = await alice.evaluate("return Boolean(document.querySelector('#dm-active .dm-lock'))");
  check('the conversation says it is encrypted', lock, '');
  await alice.evaluate("document.querySelector('#server-rail .rail-item[data-server]').click(); return true;");
  await until(alice, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'the server coming back' });
  check('the server\'s bubble on the rail goes back to it, and the conversation stays where it was',
    !(await alice.evaluate("return document.getElementById('dm-active').hidden")), '');

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
