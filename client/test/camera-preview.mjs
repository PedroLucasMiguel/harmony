// Your own camera's preview: the eye on your tile is a choice that stays.
//
// Hidden to begin with; turn it on, stop the camera and start it again (or leave the
// call and come back) and it is still on; turn it off and it is still off. The camera
// is a stand-in canvas, as in camera-quality.mjs.
//
//   MEDIAMTX_BIN=/path/to/mediamtx node client/test/camera-preview.mjs

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

const HARMONY_PORT = 18440;
const MTX_API_PORT = 9997 - 300;
const MTX_WEBRTC_PORT = 8889 - 300;
const MTX_ICE_PORT = 8189 - 300;
const PORT_PEDRO = 9781;
const PORT_ANA = 9782;
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
      const ask = { width: v.width?.ideal, height: v.height?.ideal, frameRate: v.frameRate?.ideal };
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
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-cp-profile-')),
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


const tile = (page) => page.evaluate(`{
  const figure = document.querySelector('#channel-video [data-key="me:c"]');
  if (!figure) return null;
  const video = figure.querySelector('video');
  return { shown: Boolean(video.srcObject) && !video.hidden, off: figure.hasAttribute('data-preview-off'), eye: figure.querySelector('.tile-btn[data-role="preview"]')?.hasAttribute('data-on') };
}`);
const saved = (page) => page.evaluate('return window.harmony.settings.get().then((r) => (r.data ?? r).cameraPreview)');
const startCamera = async (page) => {
  await page.evaluate("document.getElementById('voice-cam').click(); return true;");
  await waitFor(page, "document.querySelector('#channel-video [data-key=\"me:c\"]')", { label: 'my camera tile', timeoutMs: 40_000 });
  await sleep(500);
};
const stopCamera = async (page) => {
  await page.evaluate("document.getElementById('voice-cam').click(); return true;");
  await waitFor(page, "!document.querySelector('#channel-video [data-key=\"me:c\"]')", { label: 'the tile going', timeoutMs: 20_000 });
};
const clickEye = (page) => page.evaluate("document.querySelector('#channel-video [data-key=\"me:c\"] .tile-btn[data-role=\"preview\"]').click(); return true;");

async function run() {
  console.log('Starting MediaMTX, the server and a client…\n');
  await startMediaMtx();
  await startServer();
  await register('pedro', { ownerKey });
  const pedro = await signInAndJoin(PORT_PEDRO, 'pedro');
  await pedro.send('Runtime.enable');
  pedro.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
    console.log('  [pedro exception]', (d.exception?.description ?? d.text).split('\n').slice(0, 3).join(' / ').slice(0, 300));
  });

  await startCamera(pedro);
  let t = await tile(pedro);
  check('your camera tile starts with the preview off', t && !t.shown && t.off && !t.eye, JSON.stringify(t));
  check('and nothing is saved yet', (await saved(pedro)) === false, String(await saved(pedro)));

  await clickEye(pedro);
  await sleep(500);
  t = await tile(pedro);
  check('the eye turns the preview on', t.shown && !t.off && t.eye, JSON.stringify(t));
  check('and that is saved', (await saved(pedro)) === true, String(await saved(pedro)));

  await stopCamera(pedro);
  await startCamera(pedro);
  t = await tile(pedro);
  check('after stopping the camera and starting it again, the preview is still on', t.shown && t.eye, JSON.stringify(t));

  // Back out of the room and in again: a fresh page of tiles.
  await pedro.evaluate("document.getElementById('voice-leave')?.click(); return true;");
  await sleep(1000);
  await pedro.evaluate(`[...document.querySelectorAll('#channel-items li.channel-row')].find((li) => li.querySelector('.channel-name')?.textContent === 'voice').click(); return true;`);
  await waitFor(pedro, "!document.getElementById('voice-active').hidden", { label: 'rejoining', timeoutMs: 40_000 });
  await startCamera(pedro);
  t = await tile(pedro);
  check('and in a new call too', t.shown && t.eye, JSON.stringify(t));

  await clickEye(pedro);
  await sleep(400);
  t = await tile(pedro);
  check('turning it off hides it', !t.shown && t.off && !t.eye, JSON.stringify(t));
  check('and that is saved', (await saved(pedro)) === false, String(await saved(pedro)));
  await stopCamera(pedro);
  await startCamera(pedro);
  t = await tile(pedro);
  check('so the next camera starts with it off', !t.shown && t.off, JSON.stringify(t));
}

try {
  await run();
} catch (err) {
  console.log('  FAIL ', err.stack);
  process.exitCode = 1;
}
summary();
process.exit(process.exitCode ?? 0);
