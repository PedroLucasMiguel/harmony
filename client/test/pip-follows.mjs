// Picture in picture follows the stage: over a text channel, never over the voice
// channel's own grid, and out of Harmony while it is minimised.
//
// Viewer watches; Pedro and Zed each turn a camera on. With the setting on the
// stage is empty and one stream is in the window; whoever with a camera talks
// takes it over until they stop; stepping picks by hand; the window moves and
// resizes. The cameras and microphones are stand-ins (the tone's level is the
// test's to set, which is what makes somebody talk).
//
//   MEDIAMTX_BIN=/path/to/mediamtx node client/test/pip-follows.mjs

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

const HARMONY_PORT = 18299;
const MTX_API_PORT = 9997 - 139;
const MTX_WEBRTC_PORT = 8889 - 139;
const MTX_ICE_PORT = 8189 - 139;
const PORT_PEDRO = 9551;
const PORT_ANA = 9552;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-follow-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'harmony-follow-mtx-'));
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
      const gain = ctx.createGain(); gain.gain.value = 0; (window.__gains ??= []).push(gain);
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
  if (!process.env.PIP_SHOT) return;
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(process.env.PIP_SHOT, `${name}.png`), Buffer.from(data, 'base64'));
}

async function signInAndJoin(port, nickname) {
  const app = launchApp({
    port,
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-follow-profile-')),
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

async function enter(port, nickname) {
  const page = await signInAndJoin(port, nickname);
  await page.send('Runtime.enable');
  page.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
    console.log(`  [${nickname} exception]`, (d.exception?.description ?? d.text).split('\n').slice(0, 3).join(' / ').slice(0, 300));
  });
  return page;
}

/** The popped-out window, as a page of its own, once it exists. */
async function popup(port, { gone = false } = {}) {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const t = targets.find((x) => x.type === 'page' && x.url.endsWith('/pip.html'));
    if (gone ? !t : t) return t ? attach(t) : null;
    await sleep(200);
  }
  throw new Error(gone ? 'the window did not close' : 'the window did not open');
}

async function run() {
  console.log('Starting MediaMTX, the server and three clients…\n');
  await startMediaMtx();
  await startServer();
  await register('viewer', { ownerKey });
  await register('pedro');
  await register('zed');
  const viewer = await enter(PORT_ANA, 'viewer');
  const pedro = await enter(PORT_PEDRO, 'pedro');
  const zed = await enter(9553, 'zed');
  for (const page of [pedro, zed]) await page.evaluate("document.getElementById('voice-cam').click(); return true;");
  await waitFor(viewer, "document.querySelectorAll('#channel-video .channel-tile[data-key]:not([data-own])').length >= 2", {
    label: 'the viewer seeing both cameras', timeoutMs: 40_000,
  });
  await sleep(1500);

  const state = () => viewer.evaluate(`
    const pip = document.getElementById('pip');
    const stage = document.getElementById('channel-video');
    const playing = [...document.querySelectorAll('#pip-body video')].some((v) => v.videoWidth > 0 && !v.paused);
    return { layout: stage.dataset.layout, pipShown: Boolean(pip) && !pip.hidden && pip.getBoundingClientRect().width > 0,
      inWindow: document.querySelectorAll('#pip-body .channel-tile').length, playing,
      chat: !document.getElementById('chat-active').hidden, gridTiles: document.querySelectorAll('#channel-video .channel-strip .channel-tile').length };`);
  const settle = async (predicate, label, timeoutMs = 8000) => {
    const end = Date.now() + timeoutMs;
    let v;
    while (Date.now() < end) { v = await state(); if (predicate(v)) return v; await sleep(150); }
    throw new Error(`timed out: ${label} (last: ${JSON.stringify(v)})`);
  };
  const clickChannel = (name) => viewer.evaluate(`
    [...document.querySelectorAll('#channel-items li.channel-row')].find((li) => li.querySelector('.channel-name')?.textContent === ${JSON.stringify(name)}).click(); return true;`);

  // On: with the voice channel's own streams showing, they are the stage, as a grid.
  await viewer.evaluate("const i = document.getElementById('picture-in-picture'); i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); return true;");
  await sleep(800);
  let v = await state();
  check('enabled, the voice channel still shows the grid, with no window over it', v.layout === 'grid' && !v.pipShown && v.gridTiles === 2, JSON.stringify(v));

  // Opening a text channel starts it.
  await clickChannel('general');
  v = await settle((x) => x.pipShown && x.chat, 'the window starting over the text channel');
  check('opening a text channel starts the window', v.pipShown && v.chat && v.inWindow === 1 && v.layout === 'pip', JSON.stringify(v));
  v = await settle((x) => x.playing, 'the picture playing');
  check('with a stream playing in it', v.playing, JSON.stringify(v));

  // Clicking the voice channel puts the streams back on the stage.
  await clickChannel('voice');
  v = await settle((x) => !x.pipShown && x.layout === 'grid', 'back to the grid');
  check('clicking the voice channel goes back to the grid', v.layout === 'grid' && !v.pipShown && !v.chat && v.gridTiles === 2 && v.inWindow === 0, JSON.stringify(v));

  // And again: a second round trip.
  await clickChannel('general');
  await settle((x) => x.pipShown, 'the window starting again');
  await clickChannel('voice');
  v = await settle((x) => !x.pipShown && x.layout === 'grid', 'back to the grid again');
  check('and the same the second time', v.layout === 'grid' && v.gridTiles === 2, JSON.stringify(v));

  // Minimised on the text channel: out of the app. Back: in the app again.
  const hide = (hidden) => viewer.evaluate(`
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => ${hidden} });
    document.dispatchEvent(new Event('visibilitychange')); return true;`);
  await clickChannel('general');
  await settle((x) => x.pipShown, 'the window over the text channel');
  await hide(true);
  const win = await popup(PORT_ANA);
  await sleep(1200);
  const out = await win.evaluate("const v = document.querySelector('#pip-body video'); return { tiles: document.querySelectorAll('#pip-body .channel-tile').length, playing: Boolean(v && v.videoWidth > 0 && !v.paused) }");
  check('minimised on a text channel, the window pops out and plays', out.tiles === 1 && out.playing, JSON.stringify(out));
  await hide(false);
  await popup(PORT_ANA, { gone: true });
  v = await settle((x) => x.pipShown, 'the window back over the chat');
  check('and when Harmony returns it is back over the text channel', v.pipShown && v.chat && v.inWindow === 1, JSON.stringify(v));

  // Minimised on the voice channel's grid: also out, and back to the grid after.
  await clickChannel('voice');
  await settle((x) => x.layout === 'grid', 'the grid');
  await hide(true);
  const win2 = await popup(PORT_ANA);
  await sleep(1200);
  const out2 = await win2.evaluate("const v = document.querySelector('#pip-body video'); return { tiles: document.querySelectorAll('#pip-body .channel-tile').length, playing: Boolean(v && v.videoWidth > 0 && !v.paused) }");
  check('minimised on the voice channel, it pops out as well', out2.tiles === 1 && out2.playing, JSON.stringify(out2));
  await hide(false);
  await popup(PORT_ANA, { gone: true });
  v = await settle((x) => x.layout === 'grid' && !x.pipShown && x.gridTiles === 2, 'the grid coming back');
  check('and on return the grid comes back, not a window over it', v.layout === 'grid' && !v.pipShown && v.gridTiles === 2, JSON.stringify(v));
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
