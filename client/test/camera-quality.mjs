// The webcam's resolution and frame rate, end to end: what somebody ELSE gets.
//
// Pedro turns his camera on in a voice room and changes Settings > Voice & video
// > Camera quality while it runs. Ana, a second real client on the other end of
// a real MediaMTX, measures the picture size and frame rate she actually
// receives. The camera is a stand-in that does what a real one does with a
// request: it honours the size and rate asked for, up to a ceiling of 1080p at
// 60 fps (so "native" has a best to find), and keeps a note of what it was asked.
//
//   MEDIAMTX_BIN=/path/to/mediamtx node client/test/camera-quality.mjs
//
// The camera is replaced inside each page rather than with Chromium's fake
// device, because --use-fake-device-for-media-stream would also fake screen
// capture -- see scripts/record-demo.mjs.

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
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

const HARMONY_PORT = 18180;
const MTX_API_PORT = 9997 - 30;
const MTX_WEBRTC_PORT = 8889 - 30;
const MTX_ICE_PORT = 8189 - 30;
const PORT_PEDRO = 9473;
const PORT_ANA = 9474;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-cq-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'harmony-cq-mtx-'));
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

/**
 * A microphone that hums, and a camera whose best is 1920x1080 at 60 fps.
 * Asked for a size or a rate it gives that, or its best if that is less; every
 * request is kept in window.__asked for the test to read.
 */
const STUBS = `
  const md = navigator.mediaDevices;
  md.enumerateDevices = async () => [
    { kind: 'audioinput', deviceId: 'default', label: 'Microphone', groupId: 'g1' },
    { kind: 'videoinput', deviceId: 'camera', label: 'Camera', groupId: 'g2' },
  ].map((d) => ({ ...d, toJSON: () => d }));
  window.__asked = [];
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
      const v = c.video;
      const ask = { width: v.width?.ideal, height: v.height?.ideal, frameRate: v.frameRate?.ideal, floor: v.frameRate?.min ?? null };
      // A camera that cannot reach a floor says so, as a real one does; window.__noFloor turns that on.
      // A camera of 1080p at 60: a mode bigger or faster than that is refused, as a browser does.
      if ((v.width?.min ?? 0) > 1920 || (v.height?.min ?? 0) > 1080 || (v.frameRate?.min ?? 0) > 60) { const e = new Error('no such mode'); e.name = 'OverconstrainedError'; e.constraint = 'width'; throw e; }
      if (window.__noFloor && ask.floor) { const e = new Error('no mode that fast'); e.name = 'OverconstrainedError'; window.__refused = (window.__refused ?? 0) + 1; throw e; }
      window.__asked.push(ask);
      const width = Math.min(ask.width ?? 640, 1920);
      const height = Math.min(ask.height ?? 360, 1080);
      const fps = Math.min(ask.frameRate ?? 30, 60);
      const feed = document.createElement('canvas'); feed.width = width; feed.height = height;
      const g = feed.getContext('2d');
      let n = 0;
      // Moving, so every frame differs and the encoder has work to do.
      setInterval(() => {
        n += 1;
        g.fillStyle = '#243055'; g.fillRect(0, 0, width, height);
        g.fillStyle = '#7aa2ff'; g.fillRect((n * 17) % width, 0, 80, height);
        g.fillStyle = '#ffffff'; g.font = '60px sans-serif'; g.fillText(String(n), 40, height / 2);
      }, 1000 / fps);
      const track = feed.captureStream(fps).getVideoTracks()[0];
      const real = track.getSettings.bind(track);
      track.getSettings = () => ({ ...real(), width, height, frameRate: fps, deviceId: 'camera' });
      tracks.push(track);
    }
    return new MediaStream(tracks);
  };
  return true;`;

const setInput = (id, value) => `{
  const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
  i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
}`;

async function signInAndJoin(port, nickname) {
  const app = launchApp({
    port,
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-cq-profile-')),
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
  await waitFor(page, "document.querySelector('.view[data-active]')?.id === 'view-channels'", {
    label: `${nickname} signing in`,
  });
  await sleep(600);
  await page.evaluate(`
    [...document.querySelectorAll('#channel-items li.channel-row')]
      .find((li) => li.querySelector('.channel-name')?.textContent === 'voice').click();
    return true;`);
  await waitFor(page, "!document.getElementById('voice-active').hidden && document.querySelectorAll('#voice-roster li').length >= 1", {
    label: `${nickname} joining the room`, timeoutMs: 40_000,
  });
  return page;
}

/** The size of the camera video Ana is receiving. */
const sizeOf = (ana) => ana.evaluate(`
  const v = document.querySelector('#channel-video [data-key$=":c"] video');
  return v && v.videoWidth ? [v.videoWidth, v.videoHeight] : null;`);

/** Frames per second Ana is actually getting, counted over a few seconds. */
const rateOf = (ana, ms = 3000) => ana.evaluate(`
  const v = document.querySelector('#channel-video [data-key$=":c"] video');
  if (!v) return 0;
  let n = 0; const end = performance.now() + ${ms};
  await new Promise((done) => {
    const tick = () => { n += 1; if (performance.now() < end) v.requestVideoFrameCallback(tick); else done(); };
    v.requestVideoFrameCallback(tick);
  });
  return n / (${ms} / 1000);`);

async function run() {
  console.log('Starting MediaMTX, the server and two clients…\n');
  await startMediaMtx();
  await startServer();
  await register('pedro', { ownerKey });
  await register('ana');

  const ana = await signInAndJoin(PORT_ANA, 'ana');
  const pedro = await signInAndJoin(PORT_PEDRO, 'pedro');
  await pedro.send('Runtime.enable');
  pedro.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
    console.log('  [pedro exception]', (d.exception?.description ?? d.text).split('\n').slice(0, 3).join(' / ').slice(0, 300));
  });

  const open = () => pedro.evaluate(`
    const dialog = document.getElementById('devices');
    if (!dialog.open) document.getElementById('voice-config').click();
    document.querySelector('.settings-tab[data-tab="voice"]').click();
    return true;`);
  const pick = async (id, value) => {
    await open();
    await pedro.evaluate(`${setInput(id, value)} return true;`);
  };
  const asked = () => pedro.evaluate('return window.__asked.at(-1)');
  const options = (id) => pedro.evaluate(`return [...document.getElementById(${JSON.stringify(id)}).options].map((o) => o.textContent)`);

  // --- the controls --------------------------------------------------------------
  await open();
  await sleep(800);
  check('Settings offers 360p, 480p, 720p, 1080p and Native',
    (await options('cam-resolution')).join() === '360p,480p,720p,1080p,Native', (await options('cam-resolution')).join());
  check('and 24, 30, 60 fps and Native',
    (await options('cam-framerate')).join() === '24 fps,30 fps,60 fps,Native', (await options('cam-framerate')).join());
  const initial = await pedro.evaluate(`return [document.getElementById('cam-resolution').value, document.getElementById('cam-framerate').value]`);
  check('the default is what the camera always sent: 360p at 24 fps', initial.join() === '360,24', initial.join());

  // --- the camera starts at the default -------------------------------------------
  await pedro.evaluate("document.getElementById('devices').close(); document.getElementById('voice-cam').click(); return true;");
  await waitFor(ana, "document.querySelector('#channel-video [data-key$=\":c\"] video')?.videoWidth > 0", {
    label: "Ana receiving Pedro's camera", timeoutMs: 40_000,
  });
  await sleep(2000);
  let a = await asked();
  check('the camera is asked for 640x360 at 24 fps', a.width === 640 && a.height === 360 && a.frameRate === 24, JSON.stringify(a));
  let size = await sizeOf(ana);
  let fps = await rateOf(ana);
  check('Ana receives 640x360', size?.join('x') === '640x360', String(size));
  check('at about 24 fps', fps > 18 && fps < 28, `${fps.toFixed(1)} fps`);

  // --- resolution, live -------------------------------------------------------------
  await pick('cam-resolution', '720');
  await sleep(4500);
  a = await asked();
  size = await sizeOf(ana);
  check('720p is asked for with the camera running', a.width === 1280 && a.height === 720 && a.frameRate === 24, JSON.stringify(a));
  check('and Ana receives 1280x720', size?.join('x') === '1280x720', String(size));

  // --- frame rate, live ---------------------------------------------------------------
  await pick('cam-framerate', '60');
  await sleep(4500);
  a = await asked();
  fps = await rateOf(ana, 4000);
  check('60 fps is asked for', a.frameRate === 60 && a.width === 1280, JSON.stringify(a));
  check('and Ana gets more than 45 frames a second', fps > 45, `${fps.toFixed(1)} fps`);

  await pick('cam-resolution', '1080');
  await sleep(4500);
  size = await sizeOf(ana);
  check('1080p reaches Ana at full size', size?.join('x') === '1920x1080', String(size));

  // --- native: whatever the camera does best ------------------------------------------------
  await pick('cam-resolution', 'native');
  await pick('cam-framerate', '0');
  await sleep(5000);
  a = await asked();
  size = await sizeOf(ana);
  fps = await rateOf(ana, 4000);
  check('native goes down from the biggest picture and the best rate until the camera says yes: 1080p, at 30 fps or more', a.width === 1920 && a.height === 1080 && a.floor === 30, JSON.stringify(a));
  check('and sends the camera\'s best, 1920x1080', size?.join('x') === '1920x1080', String(size));
  check('at its full rate, with no ceiling left over from before', fps > 45, `${fps.toFixed(1)} fps`);

  // --- a camera that has no mode as fast as the floor still opens ----------------------------
  await pedro.evaluate('window.__noFloor = true; return true;');
  await pick('cam-resolution', '720');
  await pick('cam-framerate', '30');
  await sleep(5000);
  a = await asked();
  size = await sizeOf(ana);
  const refused = await pedro.evaluate('return window.__refused ?? 0');
  check('a camera that cannot reach the floor is asked again without it, and opens', refused >= 1 && a.floor === null && size?.join('x') === '1280x720', JSON.stringify({ refused, a, size }));
  await pedro.evaluate('window.__noFloor = false; return true;');

  // --- back down -------------------------------------------------------------------------------
  await pick('cam-resolution', '480');
  await pick('cam-framerate', '30');
  await sleep(5000);
  size = await sizeOf(ana);
  fps = await rateOf(ana, 4000);
  check('480p arrives as 854x480', size?.join('x') === '854x480', String(size));
  check('at about 30 fps', fps > 24 && fps < 36, `${fps.toFixed(1)} fps`);

  // --- remembered -------------------------------------------------------------------------------
  const saved = await pedro.evaluate(`
    const s = await harmony.settings.get(); const d = s.data ?? s;
    return [d.cameraResolution, d.cameraFramerate];`);
  check('the choice is saved', saved.join() === '480,30', saved.join());
  await pedro.evaluate("document.getElementById('devices').close(); return true;");
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
