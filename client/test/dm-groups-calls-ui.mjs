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
const FAKE_YTDLP = resolve(repoRoot, 'server', 'test', 'fixtures', 'fake-ytdlp.mjs');

const MEDIAMTX_BIN = process.env.MEDIAMTX_BIN ?? join(homedir(), 'mediamtx', 'mediamtx');
if (!existsSync(MEDIAMTX_BIN)) {
  console.log(`No MediaMTX at ${MEDIAMTX_BIN}. Set MEDIAMTX_BIN.`);
  process.exit(0);
}

const HARMONY_PORT = 18290;
const MTX_API_PORT = 9997 - 140;
const MTX_WEBRTC_PORT = 8889 - 140;
const MTX_ICE_PORT = 8189 - 140;
const PORTS = { alice: 9591, bob: 9592, carol: 9593 };
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
        // Music Buddy in a call: yt-dlp is the fake in server/test/fixtures, so nothing leaves the machine.
        HARMONY_YTDLP_BIN: FAKE_YTDLP,
        FAKE_DURATION: '60',
        HARMONY_MUSIC_NO_THUMBNAILS: '1',
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
  return (await res.json()).token;
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

async function run() {
  console.log('Starting MediaMTX, the server and three clients…\n');
  await startMediaMtx();
  await startServer();
  const aliceToken = await register('alice', { ownerKey });
  await register('bob');
  await register('carol');
  const alice = await signIn('alice');
  const bob = await signIn('bob');
  const carol = await signIn('carol');
  await sleep(3000);

  // --- making a group ---------------------------------------------------------------------------------------------
  await openList(alice);
  await until(alice, "!document.getElementById('dm-new-group').hidden", { label: 'the new-group button' });
  check('the list has a button for a new group', true, '');
  await click(alice, '#dm-new-group');
  await until(alice, "document.querySelector('dialog.dm-keys')?.open && document.getElementById('dm-group-name')", { label: 'the new-group dialog' });
  await shot(alice, 'group-dialog');
  const offered = await alice.evaluate("return [...document.querySelectorAll('.dm-picker-name')].map((n) => n.textContent).sort()");
  check('everybody but yourself is offered', JSON.stringify(offered) === JSON.stringify(['bob', 'carol']), JSON.stringify(offered));
  check('the button to create waits for a name and for people', await alice.evaluate("return document.getElementById('dm-group-go').disabled"), '');
  await alice.evaluate(`{ const n = document.getElementById('dm-group-name'); n.value = 'Weekend plans'; n.dispatchEvent(new Event('input', { bubbles: true })); }
    for (const box of document.querySelectorAll('.dm-picker input[type=checkbox]')) { box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); }
    return true;`);
  check('and takes them once both are given', await alice.evaluate("return !document.getElementById('dm-group-go').disabled"), '');
  await click(alice, '#dm-group-go');
  await until(alice, "!document.getElementById('dm-active').hidden && document.getElementById('dm-name').textContent === 'Weekend plans'", { label: 'the group opening' });
  check('the group opens with its name', true, '');
  const header = await alice.evaluate("return { count: document.getElementById('dm-count').textContent, members: !document.getElementById('dm-members').hidden, safety: document.getElementById('dm-safety').hidden, call: !document.getElementById('dm-call').hidden }");
  check('the header says how many are in it, has people and a call button, and no safety number', header.count === '3 people' && header.members && header.safety && header.call, JSON.stringify(header));
  await shot(alice, 'group-open');

  for (const [who, page] of [['bob', bob], ['carol', carol]]) {
    await openList(page);
    await until(page, "[...document.querySelectorAll('#dm-list .dm-row .dm-row-name')].some((n) => n.textContent === 'Weekend plans')", { label: `${who} seeing the group` });
    check(`${who} is told about it, and sees its name`, true, '');
  }

  // --- talking ----------------------------------------------------------------------------------------------------
  await write(alice, 'who is coming? 🍕');
  await openRow(bob, 'Weekend plans');
  await until(bob, "[...document.querySelectorAll('#dm-log .chat-msg')].some((m) => m.textContent.includes('who is coming?'))", { label: 'bob reading it' });
  // The group's first line and her message are one block (the same person, close together): the name is on the block.
  const author = await bob.evaluate("return [...document.querySelectorAll('#dm-log .chat-msg .who')].map((w) => w.textContent)");
  check('Bob reads what Alice wrote, under her name', author.includes('alice'), JSON.stringify(author));
  // Her picture in the group, pressed: her profile on this server.
  await bob.evaluate("document.querySelector('#dm-log .chat-msg .msg-avatar[data-profile-user]').click(); return true;");
  await until(bob, "!document.querySelector('.profile-card').hidden", { label: 'her profile in the group' });
  check('pressing somebody\'s picture in a group opens their profile', (await bob.evaluate("return document.querySelector('.profile-card-name')?.textContent")) === 'alice', '');
  await bob.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;");
  await write(bob, 'me!');
  await until(alice, "[...document.querySelectorAll('#dm-log .chat-msg')].some((m) => m.textContent.includes('me!'))", { label: 'alice reading bob' });
  check('and Alice reads his answer', true, '');
  await openRow(carol, 'Weekend plans');
  await until(carol, "[...document.querySelectorAll('#dm-log .chat-msg')].filter((m) => m.querySelector('.who') || m.hasAttribute('data-grouped')).length >= 2", { label: 'carol reading' });
  const preview = await alice.evaluate("return document.querySelector('#dm-list .dm-row .dm-row-text')?.textContent");
  check('the list shows who said the last thing', /^bob: me!/.test(preview ?? ''), String(preview));
  await shot(bob, 'group-chat');

  // --- who is in it -----------------------------------------------------------------------------------------------
  await click(alice, '#dm-members');
  await until(alice, "document.querySelector('dialog.dm-keys .dm-members-list')", { label: 'the people dialog' });
  const mine = await alice.evaluate("return { names: [...document.querySelectorAll('.dm-members-list .dm-picker-name')].map((n) => n.textContent), removes: document.querySelectorAll('.dm-members-list button[data-user-id]').length, add: [...document.querySelectorAll('dialog.dm-keys button')].some((b) => b.textContent === 'Add people') }");
  check('the one who runs it sees everybody, a way to remove each of the others, and to add', mine.names.length === 3 && mine.removes === 2 && mine.add, JSON.stringify(mine));
  await shot(alice, 'group-members');
  // Their profile, from the people dialog: the card opens over it, not behind.
  await alice.evaluate("[...document.querySelectorAll('.dm-members-list li')].find((li) => li.textContent.includes('bob')).querySelector('[data-profile-user]').click(); return true;");
  await until(alice, "!document.querySelector('.profile-card').hidden", { label: 'bob\'s profile over the dialog' });
  const over = await alice.evaluate(`const card = document.querySelector('.profile-card'); const r = card.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 40);
    return { name: card.querySelector('.profile-card-name')?.textContent, onTop: card.contains(hit), inDialog: Boolean(card.closest('dialog')), readOnly: card.querySelectorAll('.profile-card-actions button').length === 0 };`);
  check('pressing somebody in the people dialog opens their profile, above the dialog', over.name === 'bob' && over.onTop && over.inDialog, JSON.stringify(over));
  check('and it is only for looking', over.readOnly, JSON.stringify(over));
  await shot(alice, 'group-member-profile');
  await alice.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;");
  await alice.evaluate("document.querySelector('dialog.dm-keys').close(); return true;");
  await click(bob, '#dm-members');
  await until(bob, "document.querySelector('dialog.dm-keys .dm-members-list')", { label: 'bob\'s people dialog' });
  const his = await bob.evaluate("return { removes: document.querySelectorAll('.dm-members-list button[data-user-id]').length, add: [...document.querySelectorAll('dialog.dm-keys button')].some((b) => b.textContent === 'Add people') }");
  check('somebody who was added can neither remove nor add', his.removes === 0 && !his.add, JSON.stringify(his));
  await bob.evaluate("document.querySelector('dialog.dm-keys').close(); return true;");
  await click(bob, '#dm-menu-button');
  const bobMenu = await bob.evaluate("return [...document.querySelectorAll('.dm-menu .menu-item')].map((b) => b.textContent)");
  check('and his menu has leaving, and nothing to rename', bobMenu.includes('Leave group') && !bobMenu.includes('Rename'), JSON.stringify(bobMenu));
  await click(bob, '#dm-menu-button');

  // --- a call to the group ----------------------------------------------------------------------------------------
  await click(alice, '#dm-call');
  await until(alice, "!document.getElementById('call-screen').hidden", { label: 'alice\'s call screen', timeoutMs: 40_000 });
  const screen0 = await alice.evaluate(`const s = document.getElementById('call-screen'); const r = s.getBoundingClientRect(); const log = document.getElementById('dm-log').getBoundingClientRect();
    return { view: document.querySelector('.view[data-active]')?.id, title: document.getElementById('call-title').textContent, status: document.getElementById('call-status').textContent,
      buttons: [...document.querySelectorAll('#call-controls .call-btn')].filter((b) => !b.hidden).map((b) => b.id), tiles: document.querySelectorAll('#call-stage .call-tile').length,
      above: r.bottom <= log.top + 1, bar: !document.getElementById('call-bar').hidden };`);
  check('starting a call keeps Alice on the conversation, with the call screen over it', screen0.view === 'view-dms' && screen0.above, JSON.stringify(screen0));
  check('the screen has the group\'s name, and says it is ringing', /Weekend plans/.test(screen0.title) && /Ringing/.test(screen0.status), JSON.stringify(screen0));
  check('with camera, screen, microphone, headphones and hang up, and a tile for her', ['cs-camera', 'cs-screen', 'cs-mute', 'cs-deafen', 'cs-hangup'].every((id) => screen0.buttons.includes(id)) && screen0.tiles >= 1, JSON.stringify(screen0));
  check('and no bar saying there is a call, which is what it stands in for', screen0.bar === false, JSON.stringify(screen0));
  await shot(alice, 'call-screen-ringing');
  // The controls are the call's: the microphone button mutes her.
  await alice.evaluate("document.getElementById('cs-mute').click(); return true;");
  await until(alice, "document.getElementById('cs-mute').hasAttribute('data-on') && document.getElementById('cs-mute').dataset.icon === 'microphone-slash'", { label: 'the microphone button muted' });
  check('the microphone button mutes her, and shows it', await alice.evaluate("return document.getElementById('voice-mute').hasAttribute('data-on')"), '');
  await alice.evaluate("document.getElementById('cs-mute').click(); return true;");
  await until(alice, "!document.getElementById('cs-mute').hasAttribute('data-on')", { label: 'the microphone button unmuted' });
  await until(bob, "document.querySelector('#incoming-calls .incoming-call')", { label: 'bob\'s phone ringing' });
  await until(carol, "document.querySelector('#incoming-calls .incoming-call')", { label: 'carol\'s phone ringing' });
  const ring = await bob.evaluate("return document.querySelector('#incoming-calls .incoming-call strong').textContent");
  check('the group rings for everybody in it, saying who is calling', /alice is calling Weekend plans/.test(ring), ring);
  await shot(bob, 'ringing');
  const card = await bob.evaluate("const c = document.querySelector('.incoming-call'); const r = c.getBoundingClientRect(); const [d, a] = [...c.querySelectorAll('.incoming-call-buttons button')].map((b) => b.getBoundingClientRect()); return { sameRow: Math.abs(d.top - a.top) < 2, equal: Math.abs(d.width - a.width) < 2, inside: d.left >= r.left && a.right <= r.right }");
  check('the card has Decline and Answer side by side, the same size, inside it', card.sameRow && card.equal && card.inside, JSON.stringify(card));

  await click(carol, '#incoming-calls .incoming-call-decline');
  await until(carol, "!document.querySelector('#incoming-calls .incoming-call')", { label: 'carol\'s card going' });
  check('Carol turns it down, and it stops ringing for her', true, '');

  await click(bob, '#incoming-calls .incoming-call-answer');
  await until(bob, "!document.getElementById('call-screen').hidden && document.querySelectorAll('#call-stage .call-tile[data-kind=person]').length === 2", { label: 'bob in the call', timeoutMs: 40_000 });
  await until(alice, "document.querySelectorAll('#call-stage .call-tile[data-kind=person]').length === 2", { label: 'alice seeing bob' });
  const bobSees = await bob.evaluate("return { view: document.querySelector('.view[data-active]')?.id, name: document.getElementById('dm-name').textContent, tiles: [...document.querySelectorAll('#call-stage .call-tile[data-kind=person] .call-name')].map((n) => n.textContent) }");
  check('Bob answers and is brought to the conversation, with both of them on the screen', bobSees.view === 'view-dms' && bobSees.tiles.length === 2 && bobSees.tiles.some((n) => /alice/.test(n)) && bobSees.tiles.some((n) => /bob/.test(n)), JSON.stringify(bobSees));
  const answered = await alice.evaluate("return document.getElementById('call-status').textContent");
  check('and it no longer says it is ringing: it counts the time', !/Ringing/.test(answered) && /^\d+:\d\d$/.test(answered), answered);
  await shot(bob, 'call-screen-two');

  check('a call has no soundboard', await alice.evaluate("return document.getElementById('voice-soundboard').hidden"), '');

  // --- music in the call --------------------------------------------------------------------------------------------
  const strip = (page) => page.evaluate(`{
    const s = document.getElementById('music-strip');
    return { shown: !s.hidden, title: document.getElementById('music-title').textContent, transport: !document.getElementById('music-strip-transport').hidden };
  }`);
  const audioOf = (page) => page.evaluate(`{
    const a = document.getElementById('music-audio');
    return a ? { src: a.src, paused: a.paused, at: a.currentTime, error: a.error?.message ?? null } : null;
  }`);
  check('with the feature off, nobody has the button, in a call either',
    await alice.evaluate("return document.getElementById('voice-music').hidden") && await bob.evaluate("return document.getElementById('voice-music').hidden"), '');
  const on = await fetch(`${BASE}/api/server`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${aliceToken}` }, body: JSON.stringify({ musicEnabled: true }),
  });
  check('the owner switches it on', on.status === 200, String(on.status));
  await until(alice, "!document.getElementById('voice-music').hidden", { label: 'the button, for the owner, in the call' });
  check('then the owner has the Music Buddy button in a call', true, '');
  check('and Bob, who may not play, does not', await bob.evaluate("return document.getElementById('voice-music').hidden"), '');
  await click(alice, '#cs-music');
  await until(alice, "!document.getElementById('music-pop').hidden", { label: 'the music panel from the call screen' });
  const popAt = await alice.evaluate(`const pop = document.getElementById('music-pop').getBoundingClientRect(); const b = document.getElementById('cs-music').getBoundingClientRect();
    return { pop: { l: Math.round(pop.left), t: Math.round(pop.top), b: Math.round(pop.bottom) }, button: { l: Math.round(b.left), t: Math.round(b.top), b: Math.round(b.bottom) } };`);
  check('the music button on the call screen opens the panel beside itself, not in a corner of the window', popAt.pop.l <= popAt.button.l + 2 && (popAt.pop.b <= popAt.button.t + 2 || popAt.pop.t >= popAt.button.b - 2), JSON.stringify(popAt));
  await alice.evaluate(`${setInput('music-input', 'podcast')} return true;`);
  await alice.evaluate("document.getElementById('music-find').requestSubmit(); return true;");
  await until(alice, "document.querySelectorAll('#music-results .music-result').length === 3", { label: 'the results' });
  await alice.evaluate("document.querySelector('#music-results .music-result .primary').click(); return true;");
  await until(bob, "!document.getElementById('music-strip').hidden", { label: 'the strip, for Bob', timeoutMs: 30_000 });
  await until(alice, "!document.getElementById('music-strip').hidden", { label: 'the strip, for Alice', timeoutMs: 30_000 });
  const musicOn = await bob.evaluate(`const strip = document.getElementById('music-strip'); const host = document.getElementById('call-music'); const r = host.getBoundingClientRect(); const ctl = document.getElementById('call-controls').getBoundingClientRect();
    return { inScreen: Boolean(strip.closest('#call-screen')), hostShown: !host.hidden, above: r.bottom <= ctl.top + 1, title: document.getElementById('music-title').textContent, playing: document.getElementById('cs-music').hasAttribute('data-playing') };`);
  check('what is playing is shown on Bob\'s call screen, above the controls, with its title', musicOn.inScreen && musicOn.hostShown && musicOn.above && /podcast/.test(musicOn.title), JSON.stringify(musicOn));
  check('what Alice adds shows as playing on the call for Bob too', /^podcast 1$/.test((await strip(bob)).title), JSON.stringify(await strip(bob)));
  await until(bob, "document.getElementById('music-audio') && !document.getElementById('music-audio').paused && document.getElementById('music-audio').currentTime > 0.3", { label: 'Bob hearing it', timeoutMs: 30_000 });
  await until(alice, "document.getElementById('music-audio') && !document.getElementById('music-audio').paused && document.getElementById('music-audio').currentTime > 0.3", { label: 'Alice hearing it', timeoutMs: 30_000 });
  const [heard, hearing] = [await audioOf(alice), await audioOf(bob)];
  check('they play the same file, each its own copy, without an error',
    heard.src === hearing.src && !heard.error && !hearing.error && Math.abs(heard.at - hearing.at) < 1.5, JSON.stringify({ heard, hearing }));
  check('Bob can listen but has no transport to steer it with', !(await strip(bob)).transport && (await strip(alice)).transport, '');
  await alice.evaluate("document.getElementById('music-s-play').click(); return true;");
  await until(bob, "document.getElementById('music-audio')?.paused === true", { label: 'Bob\'s music pausing' });
  check('what Alice steers is steered for Bob', true, '');
  await alice.evaluate("document.getElementById('music-s-play').click(); return true;");
  await until(bob, "document.getElementById('music-audio') && !document.getElementById('music-audio').paused", { label: 'Bob\'s music going on' });
  await alice.evaluate("{ const pop = document.getElementById('music-pop'); if (!pop.hidden) document.getElementById('voice-music').click(); } return true;");

  // The conversation says a call is going on, to one who is not in it.
  await openList(carol);
  await openRow(carol, 'Weekend plans');
  await until(carol, "[...document.querySelectorAll('#dm-banner .dm-banner-row')].some((r) => /call is on/.test(r.textContent))", { label: 'carol\'s banner' });
  check('somebody not in it sees that there is a call, with a way to join', await carol.evaluate("return [...document.querySelectorAll('#dm-banner button')].some((b) => b.textContent === 'Join the call')"), '');

  // Cameras go over the same paths as a channel's.
  // From the call screen's own button: it presses the camera's, and follows it.
  await click(alice, '#cs-camera');
  await until(alice, "document.getElementById('voice-cam').textContent === 'Stop camera' && document.getElementById('cs-camera').hasAttribute('data-on')", { label: 'alice\'s camera', timeoutMs: 40_000 });
  await until(bob, "document.querySelectorAll('#call-video-host #channel-video .channel-tile').length > 0 && !document.getElementById('call-video-host').hidden", { label: 'bob seeing her camera on the screen', timeoutMs: 40_000 });
  const stageOf = await bob.evaluate(`const r = (n) => { const b = n.getBoundingClientRect(); return { t: Math.round(b.top), h: Math.round(b.height), w: Math.round(b.width) }; };
    const video = document.getElementById('channel-video'); const people = document.getElementById('call-stage'); const tile = video.querySelector('.channel-tile');
    return { inScreen: Boolean(video.closest('#call-screen')), video: r(video), tile: tile && r(tile), caption: tile?.querySelector('.tile-name')?.textContent, people: r(people), screenStreams: document.getElementById('call-screen').hasAttribute('data-streams'),
      persons: document.querySelectorAll('#call-stage .call-tile[data-kind=person]').length, outside: document.querySelectorAll('#channel-stage #channel-video').length };`);
  check('Alice turns her camera on from the screen, and Bob sees it on the voice channel\'s own stage, inside the call screen', stageOf.inScreen && stageOf.tile && /alice/.test(stageOf.caption ?? '') && stageOf.screenStreams && stageOf.outside === 0, JSON.stringify(stageOf));
  check('with the people as a row under it, and the stage taking the room above', stageOf.persons === 2 && stageOf.people.t >= stageOf.video.t + stageOf.video.h - 2 && stageOf.video.h > 120, JSON.stringify(stageOf));
  const controlsOf = await bob.evaluate(`const tile = document.querySelector('#call-video-host .channel-tile'); return { roles: [...tile.querySelectorAll('.tile-btn')].map((b) => b.dataset.role), who: tile.querySelector('.tile-name')?.textContent };`);
  const ownTile = await alice.evaluate(`const tile = document.querySelector('#call-video-host .channel-tile[data-own]'); return { roles: tile ? [...tile.querySelectorAll('.tile-btn')].map((b) => b.dataset.role) : null };`);
  check('a camera on the call has the controls it has in a voice channel: full screen for others, a preview switch for its owner', controlsOf.roles.includes('fullscreen') && Array.isArray(ownTile.roles) && ownTile.roles.includes('preview'), JSON.stringify({ controlsOf, ownTile }));
  // Right-click on somebody: how loudly you hear them, and muting them for yourself, as in a voice channel.
  await bob.evaluate(`const t = document.querySelector('#call-stage .call-tile[data-kind=person]:not([data-own])'); const r = t.getBoundingClientRect();
    t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 20 })); return true;`);
  await until(bob, "!document.getElementById('peer-menu').hidden", { label: 'the menu on her tile' });
  const menu = await bob.evaluate("return { name: document.getElementById('peer-menu-name').textContent, volume: Boolean(document.querySelector('#peer-menu .peer-volume')), mute: Boolean(document.querySelector('#peer-menu .peer-mute')) }");
  check('right-clicking somebody on the call shows their menu, with a volume and a mute for you', /alice/.test(menu.name) && menu.volume && menu.mute, JSON.stringify(menu));
  await bob.evaluate("document.querySelector('#peer-menu .peer-mute').click(); return true;");
  await until(bob, "document.querySelector('#call-stage .call-tile[data-kind=person]:not([data-own])').hasAttribute('data-local-muted')", { label: 'her tile greyed' });
  check('muting her for yourself greys her tile', true, '');
  await bob.evaluate("document.querySelector('#peer-menu .peer-mute').click(); return true;");
  await until(bob, "!document.querySelector('#call-stage .call-tile[data-kind=person]:not([data-own])').hasAttribute('data-local-muted')", { label: 'her tile back' });
  await bob.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;");
  await shot(bob, 'call-camera');

  // Carol changes her mind and joins from the conversation.
  await click(carol, '#dm-banner button.primary');
  await until(carol, "!document.getElementById('voice-active').hidden && document.querySelectorAll('#voice-roster li').length === 3", { label: 'carol joining', timeoutMs: 40_000 });
  check('Carol joins it later from the conversation, and there are three of them', true, '');
  await until(carol, "document.getElementById('music-audio') && !document.getElementById('music-audio').paused", { label: 'Carol hearing the music in the middle', timeoutMs: 30_000 });
  const mid = await audioOf(carol);
  check('and she joins the music in the middle of it', mid.at > 1 && !mid.error, JSON.stringify(mid));

  // --- hanging up, and the line it leaves --------------------------------------------------------------------------
  await click(carol, '#voice-leave');
  await click(bob, '#voice-leave');
  await click(alice, '#voice-leave');
  await until(alice, "document.getElementById('voice-active').hidden", { label: 'alice out' });
  check('the music is over with the call: no strip and no sound for any of them',
    (await Promise.all([alice, bob, carol].map((p) => p.evaluate("return document.getElementById('music-strip').hidden && !document.getElementById('music-audio')")))).every(Boolean), '');
  await openList(alice);
  await openRow(alice, 'Weekend plans');
  await until(alice, "[...document.querySelectorAll('#dm-log .chat-msg')].some((m) => /^Call · /.test(m.querySelector('.text')?.textContent ?? ''))", { label: 'the line of the call' });
  check('the call leaves a line in the conversation, with how long it was', true, '');
  await shot(alice, 'call-line');

  // --- a call between two -------------------------------------------------------------------------------------------
  // Bob opens the conversation with Alice from the member list, as anybody would.
  const openWith = async (page, name) => {
    if ((await view(page)) !== 'view-channels') await click(page, '#server-rail .rail-home');
    await until(page, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'the server' });
    await page.evaluate("if (document.getElementById('member-list').hidden) document.getElementById('channels-members').click(); return true;");
    await until(page, `[...document.querySelectorAll('.member-row')].some((r) => r.textContent.includes(${JSON.stringify(name)}))`, { label: 'the member list' });
    await page.evaluate(`
      const row = [...document.querySelectorAll('.member-row')].find((r) => r.textContent.includes(${JSON.stringify(name)}));
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 })); return true;`);
    await page.evaluate("[...document.querySelectorAll('#member-menu-body button')].find((b) => b.textContent === 'Send a private message').click(); return true;");
    await until(page, `!document.getElementById('dm-active').hidden && document.getElementById('dm-name').textContent === ${JSON.stringify(name)}`, { label: `the conversation with ${name}` });
  };
  // Bob finds Alice with the search box on the list rather than the member list.
  await openList(bob);
  const find = (value) => bob.evaluate(`{ const i = document.getElementById('dm-find'); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); } return true;`);
  const listed = () => bob.evaluate("return [...document.querySelectorAll('#dm-list > li')].map((li) => li.className.includes('dm-find-head') ? '#head' : li.className.includes('dm-find-none') ? '#none' : li.querySelector('.dm-row-name')?.textContent)");
  check('the list has a box to find somebody', await bob.evaluate("return !document.getElementById('dm-find-box').hidden"), '');
  await find('week');
  check('a name that is a conversation narrows the list to it, and offers nobody else', JSON.stringify(await listed()) === '["Weekend plans"]', JSON.stringify(await listed()));
  await find('ALI');
  await shot(bob, 'find-people');
  check('a part of somebody\'s name, in any case, finds the group they are in and offers them, by name', JSON.stringify(await listed()) === '["Weekend plans","#head","alice"]', JSON.stringify(await listed()));
  await find('zzz');
  check('and when nobody matches it says so', JSON.stringify(await listed()) === '["#none"]', JSON.stringify(await listed()));
  await find('ali');
  await bob.evaluate("document.querySelector('#dm-list .dm-person').click(); return true;");
  await until(bob, "!document.getElementById('dm-active').hidden && document.getElementById('dm-name').textContent === 'alice'", { label: 'the conversation with alice' });
  check('clicking her opens the conversation with her, and clears the box', await bob.evaluate("return document.getElementById('dm-find').value === ''"), '');
  await find('ali');
  check('and once there is a conversation she is not offered twice', JSON.stringify(await listed()) === '["alice","Weekend plans"]' || JSON.stringify(await listed()) === '["Weekend plans","alice"]', JSON.stringify(await listed()));
  await shot(bob, 'find');
  await find('');
  const pair = await bob.evaluate("return { name: document.getElementById('dm-name').textContent, members: document.getElementById('dm-members').hidden, call: !document.getElementById('dm-call').hidden, safety: !document.getElementById('dm-safety').hidden }");
  check('a conversation of two has a call button and its safety number, and no list of people', pair.name === 'alice' && pair.members && pair.call && pair.safety, JSON.stringify(pair));

  await click(bob, '#dm-call');
  await until(alice, "document.querySelector('#incoming-calls .incoming-call')", { label: 'alice\'s phone ringing' });
  const one = await alice.evaluate("return document.querySelector('#incoming-calls .incoming-call strong').textContent");
  check('a call to one person rings them, by name', /bob is calling you/.test(one), one);
  await click(alice, '#incoming-calls .incoming-call-decline');
  await until(bob, "document.getElementById('voice-active').hidden", { label: 'bob\'s call ending' });
  check('when she turns it down his call is over', true, '');
  await openList(bob);
  await openRow(bob, 'alice');
  await until(bob, "[...document.querySelectorAll('#dm-log .chat-msg')].some((m) => /call was declined/.test(m.textContent))", { label: 'the line about the declined call' });
  check('and the conversation says it was declined', true, '');

  await click(alice, '#server-rail .rail-home').catch(() => {});
  await openList(alice);
  await openRow(alice, 'bob');
  await until(alice, "[...document.querySelectorAll('#dm-log .chat-msg')].some((m) => /You declined a call/.test(m.textContent))", { label: 'her line' });
  check('and says so to her too', true, '');

  // Answered this time.
  await click(bob, '#dm-call');
  await until(alice, "document.querySelector('#incoming-calls .incoming-call')", { label: 'alice\'s phone ringing again' });
  await click(alice, '#incoming-calls .incoming-call-answer');
  await until(alice, "!document.getElementById('call-screen').hidden && document.querySelectorAll('#call-stage .call-tile[data-kind=person]').length === 2", { label: 'alice in the call', timeoutMs: 40_000 });
  await until(bob, "!document.getElementById('call-screen').hidden && document.querySelectorAll('#call-stage .call-tile[data-kind=person]').length === 2", { label: 'bob in the call', timeoutMs: 40_000 });
  check('a call of two, answered, has both of them on the screen of each', true, '');
  const bar = await bob.evaluate("return document.getElementById('call-bar').hidden");
  check('the call bar stays out of the way on the page with the call', bar === true, String(bar));
  // Away from the conversation, the bar is how to get back to it.
  await bob.evaluate("document.getElementById('dm-close').click(); return true;");
  await until(bob, "document.getElementById('call-screen').hidden && !document.getElementById('call-bar').hidden", { label: 'bob off the conversation, with the bar' });
  check('but off that conversation (in the list, say) the bar shows the call, to get back to it', true, '');
  await click(bob, '#call-bar-return');
  await until(bob, "document.querySelector('.view[data-active]')?.id === 'view-dms' && !document.getElementById('call-screen').hidden", { label: 'bob back on his call' });
  check('and pressing it comes back to the conversation, and its screen', true, '');
  await click(bob, '#cs-hangup');
  await until(bob, "document.getElementById('voice-active').hidden", { label: 'bob out' });
  await until(alice, "document.getElementById('voice-active').hidden", { label: 'alice sent out with the last one leaving' });
  check('the one left alone is out when the other hangs up', true, '');

  // --- taking somebody out ----------------------------------------------------------------------------------------
  await openList(alice);
  await openRow(alice, 'Weekend plans');
  await click(alice, '#dm-members');
  await until(alice, "document.querySelector('dialog.dm-keys .dm-members-list')", { label: 'the people dialog' });
  const carolId = await alice.evaluate("return [...document.querySelectorAll('.dm-members-list li')].find((li) => li.textContent.includes('carol')).querySelector('button[data-user-id]').dataset.userId");
  await alice.evaluate(`document.querySelector('.dm-members-list button[data-user-id="${carolId}"]').click(); return true;`);
  await until(alice, "document.getElementById('ask').open", { label: 'the confirmation' });
  await click(alice, '#ask-ok');
  await openList(carol);
  await until(carol, "![...document.querySelectorAll('#dm-list .dm-row .dm-row-name')].some((n) => n.textContent === 'Weekend plans')", { label: 'the group leaving carol\'s list' });
  check('somebody taken out of the group loses it at once', true, '');
  const left = await alice.evaluate("return document.getElementById('dm-count').textContent");
  check('and the group says it is two now', left === '2 people', left);
  await shot(alice, 'group-after-removal');

}

run().then(() => process.exit(summary() ? 1 : 0)).catch((err) => {
  console.error(err);
  summary();
  process.exit(1);
});
