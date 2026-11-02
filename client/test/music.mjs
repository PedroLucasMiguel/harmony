// Music Buddy, through two real clients in one voice channel.
//
//   - the button is for the people who may play music, the strip is for everybody in the call
//   - what is added plays for everybody, from the same place: the same file, each client's own copy
//   - the controls of the one who may reach everybody; the one who may not can only listen, and has a volume of
//     their own that changes nobody else's
//   - leaving stops it, joining in the middle starts in the middle, and the owner's switch puts it all away
//
// A real server and a real MediaMTX; yt-dlp is the fake in server/test/fixtures, so nothing leaves the machine.
//
//   MEDIAMTX_BIN=/path/to/mediamtx node client/test/music.mjs

import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const serverEntry = resolve(repoRoot, 'server', 'src', 'index.js');
const mediamtxConfig = resolve(repoRoot, 'server', 'mediamtx.yml');
const FAKE_YTDLP = resolve(repoRoot, 'server', 'test', 'fixtures', 'fake-ytdlp.mjs');

const MEDIAMTX_BIN = process.env.MEDIAMTX_BIN ?? `${process.env.HOME}/mediamtx/mediamtx`;

const HARMONY_PORT = 18710;
const MTX_API_PORT = 9988;
const MTX_WEBRTC_PORT = 8880;
const MTX_ICE_PORT = 8180;
const PORT_DJ = 9701;
const PORT_FAN = 9702;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-music-ui-'));
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
  if (!existsSync(MEDIAMTX_BIN)) throw new Error('Set MEDIAMTX_BIN to a MediaMTX binary to run this test.');
  const dir = mkdtempSync(join(tmpdir(), 'harmony-mtx-m-'));
  const cfg = join(dir, 'mediamtx.yml');
  copyFileSync(mediamtxConfig, cfg);
  const p = spawn(MEDIAMTX_BIN, [cfg], {
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

function startHarmonyServer() {
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
        HARMONY_YTDLP_BIN: FAKE_YTDLP,
        FAKE_DURATION: '30',
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

const api = async (path, { token, body } = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
};

const setInput = (id, value) => `const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
  i.dispatchEvent(new Event('input', {bubbles:true})); i.dispatchEvent(new Event('change', {bubbles:true}));`;

async function signIn(port, nickname) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-mp-'));
  const app = launchApp({
    port,
    userDataDir,
    // Chromium's fake microphone, and no gesture needed before a sound may start: nobody clicks in a scripted window.
    extraArgs: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  procs.push(app);
  const cdp = await attach(await findPage(port));
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  // What the page throws is the first thing to know when a check does not hold.
  await cdp.send('Runtime.enable');
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
    console.log(`  [${nickname} exception]`, (d.exception?.description ?? d.text).split('\n').slice(0, 3).join(' / ').slice(0, 300));
  });
  await sleep(1400);
  await cdp.evaluate(`${setInput('server-url', BASE)} return true;`);
  await sleep(1400);
  await cdp.evaluate(`${setInput('username', nickname)} return true;`);
  await cdp.evaluate(`${setInput('account-password', 'hunter22')} return true;`);
  await cdp.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: `${nickname} on the channels view` });
  await sleep(600);
  return cdp;
}

const joinRoom = async (cdp, who) => {
  await cdp.evaluate(`[...document.querySelectorAll('#channel-items li.channel-row')]
    .find((li) => li.querySelector('.channel-name')?.textContent === 'Game night').click(); return true;`);
  await waitFor(cdp, "!document.getElementById('voice-active').hidden && document.querySelectorAll('#voice-roster li').length >= 1", {
    label: `${who} joining the room`, timeoutMs: 40_000,
  });
};

/** The element the music plays from, as one number: where it is and whether it is going. */
const audioOf = (cdp) => cdp.evaluate(`
  const a = document.getElementById('music-audio');
  return a ? { src: a.src, paused: a.paused, at: a.currentTime, ready: a.readyState, error: a.error?.message ?? null, ended: a.ended } : null;`);

const strip = (cdp) => cdp.evaluate(`
  const s = document.getElementById('music-strip');
  return { shown: !s.hidden, title: document.getElementById('music-title').textContent,
    artist: document.getElementById('music-artist').textContent, paused: s.hasAttribute('data-paused'),
    shuffle: !document.getElementById('music-flag-shuffle').hidden, repeat: !document.getElementById('music-flag-repeat').hidden,
    fill: document.getElementById('music-bar-fill').style.width };`);

const panel = (cdp) => cdp.evaluate(`
  const p = document.getElementById('music-pop');
  const vis = (id) => { const n = document.getElementById(id); return Boolean(n) && !n.hidden; };
  return { open: !p.hidden, find: vis('music-find'), now: vis('music-now'), transport: ['music-play', 'music-next', 'music-prev', 'music-shuffle', 'music-repeat'].every(vis),
    clear: vis('music-clear'), rows: [...document.querySelectorAll('#music-queue .music-track')].map((r) => ({ title: r.querySelector('strong').textContent, current: r.hasAttribute('data-current'), tools: r.querySelectorAll('.music-track-tools button').length })),
    count: document.getElementById('music-queue-count').textContent, empty: vis('music-empty'), note: document.getElementById('music-note').textContent };`);

const click = (cdp, selector) => cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); return true;`);

async function run() {
  console.log('Starting MediaMTX, the control server and two clients…\n');
  await startMediaMtx();
  await startHarmonyServer();

  const reg = async (nickname, extra = {}) => (await api('/api/accounts/register', { body: { nickname, password: 'hunter22', ...extra } }));
  const boss = await reg('boss', { ownerKey });
  const dj = await reg('dj');
  const fan = await reg('fan');
  const role = (await api('/api/roles', { token: boss.token, body: { name: 'DJ', permissions: ['music.control'] } })).role;
  await api(`/api/accounts/${dj.user.id}/roles`, { token: boss.token, body: { roles: [role.id] } });
  const channels = (await api('/api/channels', { token: boss.token })).channels;
  const lobby = channels.find((c) => c.kind === 'voice');
  await api(`/api/channels/${lobby.id}`, { token: boss.token, body: { name: 'Game night' } });

  const djPage = await signIn(PORT_DJ, 'dj');
  const fanPage = await signIn(PORT_FAN, 'fan');

  // --- off until the owner says so -------------------------------------------------------------------------------------------------
  await joinRoom(djPage, 'dj');
  await joinRoom(fanPage, 'fan');
  check('with the feature off, nobody sees the button', !(await djPage.evaluate("return !document.getElementById('voice-music').hidden")), '');

  await api('/api/server', { token: boss.token, body: { musicEnabled: true } });
  await waitFor(djPage, "!document.getElementById('voice-music').hidden", { label: 'the button for the one who may' });
  check('switched on: the person whose role allows it has the button', true, '');
  check('and the one who may not does not', await fanPage.evaluate("return document.getElementById('voice-music').hidden"), '');
  check('it is a button of its own, not the soundboard', await djPage.evaluate("return document.getElementById('voice-music') !== document.getElementById('voice-soundboard') && !document.getElementById('soundpad').contains(document.getElementById('music-pop')) && !document.getElementById('music-pop').contains(document.getElementById('soundpad'))"), '');
  check('there is no strip until there is music', !(await strip(djPage)).shown && !(await strip(fanPage)).shown, '');

  // --- finding and adding --------------------------------------------------------------------------------------------------------
  await click(djPage, '#voice-music');
  await sleep(300);
  let p = await panel(djPage);
  check('the panel opens with a box to search in, and says nothing is playing', p.open && p.find && !p.now && p.empty, JSON.stringify(p));
  await djPage.evaluate(`${setInput('music-input', 'daft punk')} return true;`);
  await djPage.evaluate("document.getElementById('music-find').requestSubmit(); return true;");
  await waitFor(djPage, "document.querySelectorAll('#music-results .music-result').length === 3", { label: 'the three results' });
  check('a search lists what it found, each with Add and Play next', await djPage.evaluate("return [...document.querySelectorAll('#music-results .music-result')].every((r) => r.querySelectorAll('button').length === 2)"), '');
  await djPage.evaluate("document.querySelector('#music-results .music-result .primary').click(); return true;");

  await waitFor(fanPage, "!document.getElementById('music-strip').hidden", { label: "the listener's strip", timeoutMs: 20_000 });
  await waitFor(djPage, "!document.getElementById('music-strip').hidden", { label: "the dj's strip", timeoutMs: 20_000 });
  let s = await strip(fanPage);
  check('the song starts for the listener too: the strip names it', /^daft punk 1$/.test(s.title) && /Artist/.test(s.artist), JSON.stringify(s));

  await waitFor(fanPage, "document.getElementById('music-audio') && !document.getElementById('music-audio').paused && document.getElementById('music-audio').currentTime > 0.3", { label: 'the listener hearing it', timeoutMs: 20_000 });
  await waitFor(djPage, "document.getElementById('music-audio') && !document.getElementById('music-audio').paused && document.getElementById('music-audio').currentTime > 0.3", { label: 'the dj hearing it', timeoutMs: 20_000 });
  const [a1, a2] = await Promise.all([audioOf(djPage), audioOf(fanPage)]);
  check('both play the same file, from the app\'s own media route', a1.src === a2.src && /^harmony:\/\/app\/media\/[0-9a-f]{64}$/.test(a1.src), `${a1.src} / ${a2.src}`);
  check('without an error, and within a second of each other', !a1.error && !a2.error && Math.abs(a1.at - a2.at) < 1, `${a1.at} / ${a2.at}`);
  await sleep(1500);
  const later = await audioOf(fanPage);
  check('and it goes on', later.at > a2.at + 1, `${a2.at} -> ${later.at}`);
  s = await strip(fanPage);
  check('the bar fills as it goes', parseFloat(s.fill) > 0, s.fill);

  // --- what the listener can and cannot do -----------------------------------------------------------------------------------------------
  await click(fanPage, '#music-open');
  await sleep(300);
  p = await panel(fanPage);
  check('the listener can open the queue, and sees what plays', p.open && p.now && p.rows.length === 1 && p.rows[0].current, JSON.stringify(p));
  check('but has no box to search in, no controls and no tools on a song', !p.find && !p.transport && !p.clear && p.rows.every((r) => r.tools === 0), JSON.stringify(p));
  await click(fanPage, '#music-close');

  // --- controls ------------------------------------------------------------------------------------------------------------------
  p = await panel(djPage);
  check('the dj has the controls', p.now && p.transport && p.clear && p.rows[0].tools === 4, JSON.stringify(p));
  await djPage.evaluate("document.getElementById('music-play').click(); return true;");
  await waitFor(fanPage, "document.getElementById('music-audio').paused === true", { label: 'the listener paused', timeoutMs: 10_000 });
  check('pause pauses it for everybody, and the strip says so', (await strip(fanPage)).paused && (await audioOf(djPage)).paused, '');
  const at = (await audioOf(fanPage)).at;
  await sleep(1200);
  check('and it stays where it was', Math.abs((await audioOf(fanPage)).at - at) < 0.3, '');
  await djPage.evaluate("document.getElementById('music-play').click(); return true;");
  await waitFor(fanPage, "document.getElementById('music-audio').paused === false", { label: 'the listener playing again', timeoutMs: 10_000 });

  // more songs, then shuffle and repeat are shown to everybody
  await djPage.evaluate("document.querySelectorAll('#music-results .music-result')[1].querySelector('.primary').click(); return true;");
  await djPage.evaluate("document.querySelectorAll('#music-results .music-result')[2].querySelector('button:not(.primary)').click(); return true;");
  await waitFor(djPage, "document.querySelectorAll('#music-queue .music-track').length === 3", { label: 'three songs queued' });
  p = await panel(djPage);
  check('Add goes to the end and Play next goes after the current one', JSON.stringify(p.rows.map((r) => r.title)) === JSON.stringify(['daft punk 1', 'daft punk 3', 'daft punk 2']), JSON.stringify(p.rows));
  await djPage.evaluate("document.getElementById('music-shuffle').click(); document.getElementById('music-repeat').click(); return true;");
  await waitFor(fanPage, "!document.getElementById('music-flag-shuffle').hidden && !document.getElementById('music-flag-repeat').hidden", { label: 'the flags on the listener\'s strip' });
  check('shuffle and repeat show on every strip', true, '');
  check('the strip has the transport for the one who may steer, and not for the one who may not',
    await djPage.evaluate("return !document.getElementById('music-strip-transport').hidden && document.getElementById('music-s-shuffle').hasAttribute('data-on') && document.getElementById('music-s-repeat').hasAttribute('data-on')")
    && await fanPage.evaluate("return document.getElementById('music-strip-transport').hidden"), '');

  await djPage.evaluate("document.getElementById('music-next').click(); return true;");
  await waitFor(fanPage, "document.getElementById('music-title').textContent !== 'daft punk 1'", { label: 'the next song on the listener\'s strip', timeoutMs: 20_000 });
  await waitFor(fanPage, "document.getElementById('music-audio') && !document.getElementById('music-audio').paused", { label: 'it playing', timeoutMs: 20_000 });
  check('Next moves everybody on, and it plays', true, (await strip(fanPage)).title);

  // --- the one in control stays with everybody ---------------------------------------------------------------------------------
  const together = async (label, tolerance = 0.6) => {
    await sleep(900);
    const [d, f] = await Promise.all([audioOf(djPage), audioOf(fanPage)]);
    return check(label, d && f && d.paused === f.paused && Math.abs(d.at - f.at) < tolerance, `${d?.at} / ${f?.at} paused=${d?.paused}/${f?.paused}`);
  };
  await together('after Next, the one who pressed it and the listener are at the same place');
  const lat = await Promise.all([djPage, fanPage].map((pg) => pg.evaluate("return Number(document.getElementById('music-strip').dataset.latency)")));
  check('each client has measured how long the server takes to answer', lat.every((n) => Number.isFinite(n) && n >= 0 && n < 500), JSON.stringify(lat));

  await djPage.evaluate("const r = document.getElementById('music-seek'); r.value = 500; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); return true;");
  await waitFor(fanPage, "document.getElementById('music-audio').currentTime > 13", { label: 'the listener jumping to the middle', timeoutMs: 10_000 });
  await together('a seek by the one in control takes the listener to the same place');
  await djPage.evaluate("document.getElementById('music-play').click(); return true;");
  await waitFor(fanPage, "document.getElementById('music-audio').paused === true", { label: 'paused', timeoutMs: 10_000 });
  await together('paused: both stopped at the same place', 0.3);
  await djPage.evaluate("document.getElementById('music-play').click(); return true;");
  await waitFor(fanPage, "document.getElementById('music-audio').paused === false", { label: 'playing again', timeoutMs: 10_000 });
  await together('and resumed: both going from the same place');
  // the same moves from the strip, without the panel
  await djPage.evaluate("document.getElementById('music-s-play').click(); return true;");
  await waitFor(fanPage, "document.getElementById('music-audio').paused === true", { label: 'paused from the strip', timeoutMs: 10_000 });
  check('the strip\'s pause button pauses it for everybody, and shows play', await djPage.evaluate("return document.getElementById('music-s-play').dataset.icon === 'play'"), '');
  await djPage.evaluate("document.getElementById('music-s-play').click(); return true;");
  await waitFor(fanPage, "document.getElementById('music-audio').paused === false", { label: 'playing from the strip', timeoutMs: 10_000 });
  await together('resumed from the strip: both going from the same place');

  // A client that falls behind is put right by the heartbeat, without anybody pressing anything.
  await fanPage.evaluate("document.getElementById('music-audio').currentTime = 2; return true;");
  await waitFor(fanPage, "Math.abs(document.getElementById('music-audio').currentTime - 17) < 3 || document.getElementById('music-audio').currentTime > 5", { label: 'the listener put right', timeoutMs: 20_000 });
  await together('a listener who drifted is set right again, by the server\'s heartbeat', 0.8);

  // --- editing the queue, live ------------------------------------------------------------------------------------------------------
  const rowsOf = (pg) => pg.evaluate("return [...document.querySelectorAll('#music-queue .music-track')].map((r) => r.querySelector('strong').textContent + (r.hasAttribute('data-current') ? '*' : ''))");
  await djPage.evaluate("const b = document.getElementById('music-shuffle'); if (b.hasAttribute('data-on')) b.click(); return true;");
  await waitFor(fanPage, "document.getElementById('music-flag-shuffle').hidden", { label: 'shuffle off for everybody' });
  // two more songs, from another search, so there is something to rearrange
  await djPage.evaluate(`${setInput('music-input', 'more songs')} document.getElementById('music-find').requestSubmit(); return true;`);
  await waitFor(djPage, "document.querySelectorAll('#music-results .music-result').length === 3", { label: 'the second search' });
  await djPage.evaluate("document.querySelectorAll('#music-results .music-result')[0].querySelector('.primary').click(); return true;");
  await djPage.evaluate("document.querySelectorAll('#music-results .music-result')[1].querySelector('.primary').click(); return true;");
  await waitFor(djPage, "document.querySelectorAll('#music-queue .music-track').length === 5", { label: 'five songs' });
  await click(fanPage, '#music-open');
  await waitFor(fanPage, "document.querySelectorAll('#music-queue .music-track').length === 5", { label: 'five songs for the listener too' });

  // MUSIC_SHOT_DIR=dir: pictures of the panel and the strip, for looking at.
  if (process.env.MUSIC_SHOT_DIR) {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(process.env.MUSIC_SHOT_DIR, { recursive: true });
    for (const [name, pg] of [['dj', djPage], ['fan', fanPage]]) {
      const shot = await pg.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(process.env.MUSIC_SHOT_DIR, `music-${name}.png`), Buffer.from(shot.data, 'base64'));
    }
    // the strip with the popover out of the way
    for (const [name, pg] of [['dj', djPage], ['fan', fanPage]]) {
      const was = await pg.evaluate("const p = document.getElementById('music-pop'); const was = p.hidden; p.hidden = true; return was;");
      await sleep(300);
      const shot = await pg.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(process.env.MUSIC_SHOT_DIR, `strip-${name}.png`), Buffer.from(shot.data, 'base64'));
      await pg.evaluate(`document.getElementById('music-pop').hidden = ${was}; return true;`);
    }
    // and on a phone
    for (const [name, pg] of [['dj', djPage], ['fan', fanPage]]) {
      await pg.setViewport(390, 780);
      await sleep(500);
      for (const shown of [true, false]) {
        await pg.evaluate(`document.getElementById('music-pop').hidden = ${!shown}; ${shown ? "window.dispatchEvent(new Event('resize'));" : ''} return true;`);
        await sleep(400);
        const shot = await pg.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(process.env.MUSIC_SHOT_DIR, `phone-${name}-${shown ? 'pop' : 'strip'}.png`), Buffer.from(shot.data, 'base64'));
      }
      await pg.clearViewport();
      await pg.evaluate("document.getElementById('music-pop').hidden = false; window.dispatchEvent(new Event('resize')); return true;");
    }
  }

  let order = await rowsOf(djPage);
  // drag the last song to the top
  await djPage.evaluate(`const rows = [...document.querySelectorAll('#music-queue .music-track')]; const dt = new DataTransfer();
    const top = rows[0].getBoundingClientRect().top + 2;
    rows.at(-1).dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    rows[0].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientY: top, dataTransfer: dt }));
    rows[0].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientY: top, dataTransfer: dt }));
    rows.at(-1).dispatchEvent(new DragEvent('dragend', { bubbles: true })); return true;`);
  await waitFor(fanPage, `document.querySelector('#music-queue .music-track strong').textContent === ${JSON.stringify(order.at(-1).replace('*', ''))}`, { label: 'the dragged song on top for the listener' });
  const moved = await rowsOf(djPage);
  check('dragging a song to a new place moves it for everybody', moved[0].replace('*', '') === order.at(-1).replace('*', '') && JSON.stringify(moved) === JSON.stringify(await rowsOf(fanPage)), JSON.stringify(moved));

  // Pressing a song plays it: the first one now, with four to come after it
  await djPage.evaluate("document.querySelector('#music-queue .music-track').click(); return true;");
  await waitFor(fanPage, "document.querySelector('#music-queue .music-track').hasAttribute('data-current')", { label: 'the first song playing for the listener', timeoutMs: 15_000 });
  check('pressing a song in the queue plays it, for everybody', true, '');

  // the tool that puts a song right after the one playing
  order = await rowsOf(djPage);
  const playing = order.findIndex((x) => x.endsWith('*'));
  const far = order.length - 1;
  await djPage.evaluate(`const rows = [...document.querySelectorAll('#music-queue .music-track')]; rows[${far}].querySelector('[data-icon="skip-forward"]').click(); return true;`);
  await waitFor(fanPage, `[...document.querySelectorAll('#music-queue .music-track')][${playing + 1}]?.querySelector('strong').textContent === ${JSON.stringify(order[far].replace('*', ''))}`, { label: 'the song put next, for the listener' });
  check('"Play next" puts a song right after the current one, for everybody', JSON.stringify(await rowsOf(djPage)) === JSON.stringify(await rowsOf(fanPage)), JSON.stringify(await rowsOf(djPage)));

  // mixing what is left, again and again
  order = await rowsOf(djPage);
  let mixed = order;
  for (let i = 0; i < 6 && JSON.stringify(mixed) === JSON.stringify(order); i += 1) {
    await djPage.evaluate("document.getElementById('music-mix').click(); return true;");
    await sleep(500);
    mixed = await rowsOf(djPage);
  }
  const keep = (x) => x.slice(0, playing + 1);
  check('"Mix" shuffles what is still to come and leaves what was played and the current song', JSON.stringify(mixed) !== JSON.stringify(order) && JSON.stringify(keep(mixed)) === JSON.stringify(keep(order)) && JSON.stringify([...mixed].sort()) === JSON.stringify([...order].sort()), JSON.stringify({ order, mixed }));
  check('and the listener sees the same new order', JSON.stringify(mixed) === JSON.stringify(await rowsOf(fanPage)), '');

  // removing one that is not playing
  const doomed = mixed.findIndex((x) => !x.endsWith('*'));
  await djPage.evaluate(`const rows = [...document.querySelectorAll('#music-queue .music-track')]; rows[${doomed}].querySelector('[data-icon="x"]').click(); return true;`);
  await waitFor(fanPage, "document.querySelectorAll('#music-queue .music-track').length === 4", { label: 'four songs left for the listener' });
  check('removing a song takes it out of everybody\'s queue, and what plays goes on', (await audioOf(fanPage)).paused === false && !(await rowsOf(fanPage)).includes(mixed[doomed]) || (await rowsOf(fanPage)).length === 4, '');
  await click(fanPage, '#music-close');

  // --- a volume of one's own ------------------------------------------------------------------------------------------------------
  await fanPage.evaluate(`const v = document.getElementById('music-volume'); v.value = 40;
    v.dispatchEvent(new Event('input', { bubbles: true })); v.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  await sleep(600);
  const saved = await fanPage.evaluate("const s = (await window.harmony.settings.get()); const d = s.data ?? s; return { v: d.musicVolume, m: d.musicMuted, label: document.getElementById('music-volume-label').textContent, soundpad: d.soundpadVolume };");
  check('the listener\'s own volume is saved, and is not the soundpad\'s', saved.v === 40 && saved.m === false && saved.label === '40%' && saved.soundpad === 100, JSON.stringify(saved));
  await click(fanPage, '#music-mute');
  await sleep(500);
  const muted = await fanPage.evaluate("const s = (await window.harmony.settings.get()); const d = s.data ?? s; return { m: d.musicMuted, label: document.getElementById('music-volume-label').textContent, icon: document.getElementById('music-mute').dataset.icon };");
  check('muting it keeps the volume and says so', muted.m === true && /^muted$/i.test(muted.label) && muted.icon === 'speaker-x', JSON.stringify(muted));
  const djVolume = await djPage.evaluate("return document.getElementById('music-volume').value + '/' + document.getElementById('music-volume-label').textContent");
  check('and changes nothing for the dj', djVolume === '100/100%', djVolume);
  check('the music kept playing under the mute', !(await audioOf(fanPage)).paused, '');
  await click(fanPage, '#music-mute');

  // --- leaving, joining in the middle ------------------------------------------------------------------------------------------------
  await click(fanPage, '#voice-leave');
  await waitFor(fanPage, "document.getElementById('voice-active').hidden", { label: 'the listener out of the call' });
  check('leaving the call stops the music, and takes its element and strip away', (await audioOf(fanPage)) === null && !(await strip(fanPage)).shown, '');
  await sleep(1500);
  await joinRoom(fanPage, 'fan');
  await waitFor(fanPage, "document.getElementById('music-audio') && !document.getElementById('music-audio').paused && document.getElementById('music-audio').currentTime > 0.2", { label: 'the music again after joining', timeoutMs: 20_000 });
  const [d2, f2] = await Promise.all([audioOf(djPage), audioOf(fanPage)]);
  check('joining in the middle of a song is joining in the middle of it', Math.abs(d2.at - f2.at) < 1.2 && f2.at > 1, `${d2.at} / ${f2.at}`);

  // --- the owner's switch --------------------------------------------------------------------------------------------------------
  await api('/api/server', { token: boss.token, body: { musicEnabled: false } });
  await waitFor(djPage, "document.getElementById('voice-music').hidden && document.getElementById('music-strip').hidden", { label: 'the dj\'s screen with it off' });
  await waitFor(fanPage, "document.getElementById('music-strip').hidden && document.getElementById('music-audio').paused", { label: 'the listener\'s screen with it off' });
  const quiet = (a) => a === null || (a.paused && !a.src);
  check('switched off, it is quiet and gone for everybody at once', quiet(await audioOf(djPage)) && quiet(await audioOf(fanPage)), '');

  for (const [name, page] of [['dj', djPage], ['fan', fanPage]]) page.close?.();
  void djPage; void fanPage;
}

run()
  .catch((err) => {
    console.error(err);
    console.error(serverLog.split('\n').slice(-12).join('\n'));
    if (mtxLog) console.error(`--- mediamtx ---\n${mtxLog.slice(-1200)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    const failed = summary();
    setTimeout(() => process.exit(process.exitCode ?? (failed ? 1 : 0)), 300);
  });
