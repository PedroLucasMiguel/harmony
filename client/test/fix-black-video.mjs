// Fix black video, and a picture that is rebuilt under its tile: two real clients against a real MediaMTX.
//
// Pedro's camera is a photograph (replaced inside the page, as camera-background.mjs does); Ana watches it. Fix black
// video lets go of every subscription and opens them again, which is a NEW stream under the same tile -- and the tile
// used to keep showing the one that had ended, so everybody's camera went black and stayed so until the call was left.
//
//   CAMERA_BACKGROUND_PHOTO=/path/to/any-picture.jpg \
//   MEDIAMTX_BIN=/path/to/mediamtx node client/test/fix-black-video.mjs
//
// Any picture will do: nothing here is looking for a person.

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const serverEntry = resolve(repoRoot, 'server', 'src', 'index.js');

const PHOTO = process.env.CAMERA_BACKGROUND_PHOTO;
const MEDIAMTX_BIN = process.env.MEDIAMTX_BIN ?? join(homedir(), 'mediamtx', 'mediamtx');

if (!PHOTO || !existsSync(PHOTO)) {
  console.log('Set CAMERA_BACKGROUND_PHOTO to a photo (any picture will do here) to run this test.');
  process.exit(0);
}
if (!existsSync(MEDIAMTX_BIN)) {
  console.log(`No MediaMTX at ${MEDIAMTX_BIN}. Set MEDIAMTX_BIN.`);
  process.exit(0);
}

const HARMONY_PORT = 18175;
const MTX_API_PORT = 9997 - 21;
const MTX_WEBRTC_PORT = 8889 - 21;
const MTX_ICE_PORT = 8189 - 21;
const PORT_PEDRO = 9475;
const PORT_ANA = 9476;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-bg-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'harmony-bg-mtx-'));
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

/** A microphone that hums and a camera that shows `photo`, in place of hardware. */
const STUBS = (photoBase64) => `
  const md = navigator.mediaDevices;
  md.enumerateDevices = async () => [
    { kind: 'audioinput', deviceId: 'default', label: 'Microphone', groupId: 'g1' },
    { kind: 'videoinput', deviceId: 'camera', label: 'Camera', groupId: 'g2' },
  ].map((d) => ({ ...d, toJSON: () => d }));
  const photo = await new Promise((resolve, reject) => {
    const i = new Image(); i.onload = () => resolve(i); i.onerror = reject;
    i.src = 'data:image/jpeg;base64,${photoBase64}';
  });
  const feed = document.createElement('canvas'); feed.width = 640; feed.height = 360;
  const g = feed.getContext('2d');
  const draw = () => {
    const s = Math.max(640 / photo.width, 360 / photo.height);
    g.drawImage(photo, (640 - photo.width * s) / 2, -photo.height * s * 0.05, photo.width * s, photo.height * s);
  };
  draw(); setInterval(draw, 40);
  md.getUserMedia = async (c = {}) => {
    const tracks = [];
    if (c.audio) {
      const ctx = new AudioContext(); const out = ctx.createMediaStreamDestination();
      const tone = ctx.createOscillator(); tone.frequency.value = 196;
      const gain = ctx.createGain(); gain.gain.value = 0.05;
      tone.connect(gain); gain.connect(out); tone.start();
      tracks.push(...out.stream.getAudioTracks());
    }
    if (c.video) tracks.push(...feed.captureStream(25).getVideoTracks());
    return new MediaStream(tracks);
  };
  return true;`;

const setInput = (id, value) => `{
  const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
  i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
}`;

async function signInAndJoin(port, nickname, stubs) {
  const app = launchApp({
    port,
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-fbv-profile-')),
    extraArgs: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  procs.push(app);
  const page = await attach(await findPage(port));
  await sleep(1500);
  await page.evaluate(stubs);
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
  }).catch(async (err) => {
    // What the app itself said is usually the whole explanation.
    const said = await page.evaluate(`return [...document.querySelectorAll('.error, #channels-error')]
      .filter((n) => !n.hidden && n.textContent.trim()).map((n) => n.textContent.trim()).join(' | ');`).catch(() => '');
    console.error(`[${nickname} said] ${said || '(nothing)'}`);
    throw err;
  });
  return page;
}

/** The average colour of the top-left corner of the camera video Ana receives, 0-255. */
const corner = (ana) => ana.evaluate(`
  const v = document.querySelector('#channel-video [data-key$=":c"] video');
  if (!v || !v.videoWidth) return null;
  const c = document.createElement('canvas'); c.width = 32; c.height = 32;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(v, 0, 0, v.videoWidth * 0.12, v.videoHeight * 0.12, 0, 0, 32, 32);
  const d = x.getImageData(0, 0, 32, 32).data; let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  const n = d.length / 4;
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];`);

const near = (got, want, tolerance = 45) =>
  Array.isArray(got) && got.every((value, i) => Math.abs(value - want[i]) <= tolerance);

const framesOf = (ana) => ana.evaluate(`
  const v = document.querySelector('#channel-video [data-key$=":c"] video');
  return v ? Math.round(v.currentTime * 100) : 0;`);

async function run() {
  console.log('Starting MediaMTX, the server and two clients…\n');
  await startMediaMtx();
  await startServer();
  await register('pedro', { ownerKey });
  await register('ana');
  const photo = readFileSync(PHOTO).toString('base64');
  const ana = await signInAndJoin(PORT_ANA, 'ana', `${STUBS(photo)}`);
  const pedro = await signInAndJoin(PORT_PEDRO, 'pedro', `${STUBS(photo)}`);
  for (const [name, page] of [['pedro', pedro], ['ana', ana]]) {
    await page.send('Runtime.enable');
    page.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => console.log(`  [${name} exception]`, (d.exception?.description ?? d.text).split('\n').slice(0, 3).join(' / ').slice(0, 300)));
  }
  await pedro.evaluate("document.getElementById('voice-cam').click(); return true;");
  await waitFor(ana, "document.querySelector('#channel-video [data-key$=\":c\"] video')?.videoWidth > 0", { label: "Ana receiving Pedro's camera", timeoutMs: 40_000 });
  await sleep(2000);
  const playing = () => ana.evaluate(`
    const v = document.querySelector('#channel-video [data-key$=":c"] video');
    return v ? { w: v.videoWidth, t: Math.round(v.currentTime * 10), paused: v.paused, has: Boolean(v.srcObject) } : null;`);
  const first = await playing();
  await sleep(1500);
  const second = await playing();
  check('before anything, Ana is receiving moving video', first && second && second.t > first.t, JSON.stringify({ first, second }));

  // The picture Ana's tile holds: the stream it shows, and whether that stream is alive.
  const tile = () => ana.evaluate(`
    const v = document.querySelector('#channel-video [data-key$=":c"] video');
    const t = v?.srcObject?.getVideoTracks()[0];
    return v ? { w: v.videoWidth, live: t?.readyState === 'live' } : null;`);

  // --- Fix black video, pressed by the one watching ---------------------------------------------------------------------
  // It lets go of every subscription and opens them again, which is a NEW stream under the same tile. The tile used to
  // keep the old one (ended: black, for good), though the new picture was arriving and being decoded.
  await ana.evaluate("document.getElementById('voice-config').click(); document.querySelector('.settings-tab[data-tab=\"voice\"]').click(); return true;");
  await sleep(500);
  await ana.evaluate("document.getElementById('fix-black-video').click(); return true;");
  await waitFor(ana, "document.querySelector('#channel-video [data-key$=\":c\"] video')?.videoWidth > 100", { label: 'the camera tile showing a picture again', timeoutMs: 25_000 })
    .then(() => check('after Fix black video the camera tile shows a picture again', true, ''))
    .catch(async () => check('after Fix black video the camera tile shows a picture again', false, JSON.stringify(await tile())));
  const held = await tile();
  check('and what it holds is the new, live stream, not the one that was let go of', held?.live === true, JSON.stringify(held));
  const a = await playing();
  await sleep(2500);
  const b = await playing();
  check('moving, not a still', a && b && b.t > a.t && b.paused === false, JSON.stringify({ a, b }));
  const c = await corner(ana);
  check('and it is the picture, not black', Array.isArray(c) && c.some((x) => x > 1), `corner ${c}`);

  // --- pressed by the one sending, and again by the one watching --------------------------------------------------------------
  await pedro.evaluate("document.getElementById('voice-config').click(); document.querySelector('.settings-tab[data-tab=\"voice\"]').click(); return true;");
  await sleep(500);
  await pedro.evaluate("document.getElementById('fix-black-video').click(); return true;");
  await sleep(4000);
  const d = await playing();
  await sleep(2500);
  const e = await playing();
  check('pressed by the one sending, what Ana receives goes on', d && e && e.t > d.t && e.w > 100, JSON.stringify({ d, e }));
  for (let n = 0; n < 2; n += 1) {
    await ana.evaluate("document.getElementById('fix-black-video').click(); return true;");
    await sleep(3000);
  }
  const f = await tile();
  await sleep(2000);
  check('and pressed again and again by Ana it still comes back every time', (await tile())?.live === true && (await playing())?.w > 100, JSON.stringify(f));
}

run()
  .catch((err) => {
    console.error(err);
    console.error(serverLog.split('\n').slice(-8).join('\n'));
    process.exitCode = 1;
  })
  .finally(() => {
    const failed = summary();
    setTimeout(() => process.exit(process.exitCode ?? (failed ? 1 : 0)), 200);
  });
