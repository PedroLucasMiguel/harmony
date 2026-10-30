// The channel's streams: a square grid by default, one click to focus a stream,
// one click on it to go back to the grid.
//
// Pedro and Ana both turn a camera on in the same room, so each sees two tiles
// (their own preview and the other's camera). The cameras are stand-ins.
//
//   MEDIAMTX_BIN=/path/to/mediamtx node client/test/stream-layout.mjs

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
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

const HARMONY_PORT = 18220;
const MTX_API_PORT = 9997 - 70;
const MTX_WEBRTC_PORT = 8889 - 70;
const MTX_ICE_PORT = 8189 - 70;
const PORT_PEDRO = 9513;
const PORT_ANA = 9514;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-sl-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'harmony-sl-mtx-'));
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
  md.enumerateDevices = async () => [
    { kind: 'audioinput', deviceId: 'default', label: 'Microphone', groupId: 'g1' },
    { kind: 'videoinput', deviceId: 'camera', label: 'Camera', groupId: 'g2' },
  ].map((d) => ({ ...d, toJSON: () => d }));
  md.getUserMedia = async (c = {}) => {
    const tracks = [];
    if (c.audio) {
      const ctx = new AudioContext(); const out = ctx.createMediaStreamDestination();
      const tone = ctx.createOscillator(); tone.frequency.value = 196;
      const gain = ctx.createGain(); gain.gain.value = 0.05;
      tone.connect(gain); gain.connect(out); tone.start();
      tracks.push(...out.stream.getAudioTracks());
    }
    if (c.video) {
      const feed = document.createElement('canvas'); feed.width = 640; feed.height = 360;
      const g = feed.getContext('2d'); let n = 0;
      setInterval(() => { n += 1; g.fillStyle = '#243055'; g.fillRect(0, 0, 640, 360); g.fillStyle = '#7aa2ff'; g.fillRect((n * 9) % 600, 0, 40, 360); }, 100);
      tracks.push(feed.captureStream(10).getVideoTracks()[0]);
    }
    return new MediaStream(tracks);
  };
  return true;`;

const setInput = (id, value) => `{
  const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
  i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
}`;

async function shot(page, name) {
  if (!process.env.SL_SHOT) return;
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(process.env.SL_SHOT, `${name}.png`), Buffer.from(data, 'base64'));
}

async function signInAndJoin(port, nickname) {
  const app = launchApp({
    port,
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-sl-profile-')),
    extraArgs: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  procs.push(app);
  const page = await attach(await findPage(port));
  await sleep(1500);
  await page.evaluate(STUBS);
  await page.evaluate(`${setInput('server-url', BASE)} return true;`);
  await sleep(1500);
  await page.evaluate(`${setInput('username', nickname)} ${setInput('account-password', 'hunter22')}
    document.getElementById('continue').click(); return true;`);
  await waitFor(page, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: `${nickname} signing in` });
  await sleep(600);
  await page.evaluate(`
    [...document.querySelectorAll('#channel-items li.channel-row')]
      .find((li) => li.querySelector('.channel-name')?.textContent === 'voice').click(); return true;`);
  await waitFor(page, "!document.getElementById('voice-active').hidden && document.querySelectorAll('#voice-roster li').length >= 1", {
    label: `${nickname} joining the room`, timeoutMs: 40_000,
  });
  return page;
}

async function run() {
  console.log('Starting MediaMTX, the server and two clients…\n');
  await startMediaMtx();
  await startServer();
  await register('pedro', { ownerKey });
  await register('ana');
  const ana = await signInAndJoin(PORT_ANA, 'ana');
  const pedro = await signInAndJoin(PORT_PEDRO, 'pedro');
  for (const page of [ana, pedro]) {
    await page.send('Runtime.enable');
    page.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
      console.log('  [exception]', (d.exception?.description ?? d.text).split('\n').slice(0, 3).join(' / ').slice(0, 300));
    });
  }
  await pedro.evaluate("document.getElementById('voice-cam').click(); return true;");
  await ana.evaluate("document.getElementById('voice-cam').click(); return true;");
  await waitFor(ana, "document.querySelectorAll('#channel-video .channel-tile video').length >= 2 && [...document.querySelectorAll('#channel-video .channel-tile video')].every((v) => v.videoWidth > 0 || v.hidden)", {
    label: 'Ana seeing both cameras', timeoutMs: 40_000,
  });
  await sleep(1500);

  const layout = () => ana.evaluate(`
    const root = document.getElementById('channel-video');
    const tiles = [...document.querySelectorAll('#channel-video .channel-tile')].map((t) => {
      const r = t.getBoundingClientRect();
      return { key: t.dataset.key, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top),
        focus: t.hasAttribute('data-focus'), inFocusArea: !!t.closest('.channel-focus'), inStrip: !!t.closest('.channel-strip') };
    });
    return { layout: root.dataset.layout, tiles, cols: getComputedStyle(root.querySelector('.channel-strip')).getPropertyValue('--cols').trim() };`);

  // --- the default is the grid ---------------------------------------------------------------------------------
  let l = await layout();
  check('it opens as a grid', l.layout === 'grid', JSON.stringify(l));
  check('with a tile for each of the two streams', l.tiles.length === 2, String(l.tiles.length));
  check('all the same size', l.tiles.every((t) => t.w === l.tiles[0].w && t.h === l.tiles[0].h), JSON.stringify(l.tiles));
  // The stage here is a narrow column, so two 16:9 pictures are twice the size
  // stacked as they would be side by side; the columns follow the room there is.
  const [p, q] = l.tiles;
  check('arranged without overlapping, to fill the stage', (q.y >= p.y + p.h || q.x >= p.x + p.w) && p.w * p.h > 100000, JSON.stringify(l.tiles));
  check('and none of them in focus', l.tiles.every((t) => !t.focus && !t.inFocusArea), JSON.stringify(l.tiles));
  await shot(ana, 'grid');

  // --- pointing at a tile lights it, yours included (a mirrored camera preview hid the outline) -----------------------------------
  await ana.evaluate("document.querySelector('#channel-video .channel-tile[data-own] [data-role=preview]').click(); return true;");
  await sleep(800);
  const ring = async (selector) => {
    const pt = await ana.evaluate(`const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 };`);
    await ana.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', buttons: 0 });
    await sleep(400);
    return ana.evaluate(`return Object.fromEntries([...document.querySelectorAll('#channel-video .channel-tile')].map((t) => [t.hasAttribute('data-own') ? 'own' : 'theirs', getComputedStyle(t, '::after').boxShadow]));`);
  };
  const onOwn = await ring('#channel-video .channel-tile[data-own]');
  const onTheirs = await ring('#channel-video .channel-tile:not([data-own])');
  const wide = (shadow) => Number(/(\d+)px inset/.exec(shadow ?? '')?.[1] ?? 0);
  check('the camera preview of your own is mirrored, which is what hid the ring', await ana.evaluate("return getComputedStyle(document.querySelector('#channel-video .channel-tile[data-own] video')).transform !== 'none'"));
  check('pointing at your own tile lights it, over its picture', wide(onOwn.own) === 2 && /inset/.test(onOwn.own), JSON.stringify(onOwn));
  check('and not the other one', wide(onOwn.theirs) === 0, JSON.stringify(onOwn));
  check('pointing at theirs lights theirs, and yours is back to its thin line', wide(onTheirs.theirs) === 2 && wide(onTheirs.own) === 1, JSON.stringify(onTheirs));
  await ana.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, button: 'none', buttons: 0 });

  // --- a click gives one the space ----------------------------------------------------------------------------------
  const theirs = l.tiles.find((t) => t.key.endsWith(':c') && !t.key.startsWith('me:')).key;
  const click = (key) => ana.evaluate(`
    const t = [...document.querySelectorAll('#channel-video .channel-tile')].find((x) => x.dataset.key === ${JSON.stringify(key)});
    const r = t.getBoundingClientRect();
    const target = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    target.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true;`);
  await click(theirs);
  await sleep(600);
  l = await layout();
  const big = l.tiles.find((t) => t.key === theirs);
  check('clicking a stream switches to the focus layout', l.layout === 'focus', l.layout);
  check('that stream is the big one', big.focus && big.inFocusArea, JSON.stringify(big));
  check('the other drops to the strip, smaller', l.tiles.some((t) => t.inStrip && t.w < big.w), JSON.stringify(l.tiles));
  await shot(ana, 'focus');

  // --- a click on a control does not change layout -------------------------------------------------------------------
  await ana.evaluate(`
    const t = document.querySelector('#channel-video .channel-focus .channel-tile');
    t.querySelector('.tile-btn[data-role="mute"]')?.click(); return true;`);
  await sleep(300);
  check('muting the focused stream leaves the layout alone', (await layout()).layout === 'focus');

  // A press on a control that ends off it (a slider drag does this): the click
  // lands on the tile, and must not change the layout.
  await ana.evaluate(`
    const t = document.querySelector('#channel-video .channel-focus .channel-tile');
    t.querySelector('.tile-btn[data-role="fullscreen"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    t.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true;`);
  await sleep(300);
  check('pressing a control and releasing off it does not change the layout', (await layout()).layout === 'focus');
  await ana.evaluate(`
    const t = document.querySelector('#channel-video .channel-focus .channel-tile');
    t.querySelector('.tile-btn[data-role="fullscreen"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); return true;`);
  await sleep(300);
  check('nor does clicking the fullscreen button itself', (await layout()).layout === 'focus');

  // --- a click on the focused one goes back --------------------------------------------------------------------------------
  await click(theirs);
  await sleep(600);
  l = await layout();
  check('clicking the focused stream returns to the grid', l.layout === 'grid' && l.tiles.every((t) => !t.focus), JSON.stringify(l));
  check('with equal tiles again', l.tiles.every((t) => t.w === l.tiles[0].w), JSON.stringify(l.tiles));

  // --- focus, then focus another, then back -------------------------------------------------------------------------------------
  await click(theirs);
  await sleep(500);
  const mine = l.tiles.find((t) => t.key !== theirs).key;
  await click(mine);
  await sleep(600);
  l = await layout();
  check('clicking the other one in the strip moves the focus to it', l.layout === 'focus' && l.tiles.find((t) => t.key === mine).focus, JSON.stringify(l.tiles));

  // --- other people's cameras are not watched while the window is out of sight ----------------------------------------------
  const setHidden = (hidden) => ana.evaluate(`
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => ${hidden} });
    document.dispatchEvent(new Event('visibilitychange')); return true;`);
  const theirTiles = () => ana.evaluate("return document.querySelectorAll('#channel-video .channel-tile[data-key]:not([data-own]):not(.ghost-tile)').length");
  const voices = () => ana.evaluate('return window.__harmony().voice.subs.filter((s) => s.tracks > 0).length');
  // Tests run with the pausing off (see cdp.mjs); this one wants it on.
  await ana.evaluate(`const i = document.getElementById('pause-hidden-cameras'); i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  await sleep(500);
  check('Pedro\'s camera is on screen to start with', (await theirTiles()) === 1, String(await theirTiles()));
  await setHidden(true);
  await sleep(2000);
  check('a short alt-tab does not drop it', (await theirTiles()) === 1, String(await theirTiles()));
  await sleep(4500);
  check('hidden for a while, the camera is let go', (await theirTiles()) === 0, `${await theirTiles()} ${JSON.stringify(await ana.evaluate('const d = window.__harmony().voice; return { paused: d.camerasPaused, hidden: document.hidden, setting: document.getElementById("pause-hidden-cameras").checked }'))}`);
  check('but his voice is still being heard', (await voices()) === 1, String(await voices()));
  await setHidden(false);
  await waitFor(ana, "document.querySelectorAll('#channel-video .channel-tile[data-key]:not([data-own]):not(.ghost-tile)').length === 1", { label: 'the camera coming back', timeoutMs: 20_000 });
  check('shown again, the camera is back', (await theirTiles()) === 1, String(await theirTiles()));
  await ana.evaluate("delete document.hidden; return true;");

  // --- the stream in focus ends: back to the grid, not to some other one ------------------------------------------------------------
  await click(theirs);
  await sleep(500);
  await pedro.evaluate("document.getElementById('voice-cam').click(); return true;");
  await sleep(4000);
  l = await layout();
  check('when the stream in focus ends the grid comes back', l.layout === 'grid', JSON.stringify(l));
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
