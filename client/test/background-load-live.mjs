// The camera's background effect on a machine that cannot keep up.
//
// Pedro turns the effect on and starts his camera in a call, and his CPU is then
// slowed to a crawl (Chromium's own CPU throttling, applied to the page). The
// effect must back off -- segment and draw fewer frames -- and when that is not
// enough, stop and send the plain camera, tell him, and leave the camera on and
// the setting as he chose it. Without the throttle it must simply run.
//
// The camera is a canvas stand-in; the segmenter finds nothing in it, which is
// fine: what is measured is the cost of the work, not what it finds.
//
//   MEDIAMTX_BIN=/path/to/mediamtx node client/test/background-load-live.mjs

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

const HARMONY_PORT = 18270;
const MTX_API_PORT = 9997 - 120;
const MTX_WEBRTC_PORT = 8889 - 120;
const MTX_ICE_PORT = 8189 - 120;
const PORT_PEDRO = 9573;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-bl-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'harmony-bl-mtx-'));
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
      const tone = ctx.createOscillator(); tone.frequency.value = 220;
      const gain = ctx.createGain(); gain.gain.value = 0.05;
      tone.connect(gain); gain.connect(out); tone.start();
      tracks.push(...out.stream.getAudioTracks());
    }
    if (c.video) {
      const feed = document.createElement('canvas'); feed.width = 1280; feed.height = 720;
      const g = feed.getContext('2d'); let n = 0;
      setInterval(() => { n += 1; g.fillStyle = '#243055'; g.fillRect(0, 0, 1280, 720); g.fillStyle = '#7aa2ff'; g.fillRect((n * 9) % 1200, 0, 60, 720); }, 33);
      tracks.push(feed.captureStream(30).getVideoTracks()[0]);
    }
    return new MediaStream(tracks);
  };
  return true;`;

const setInput = (id, value) => `{
  const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
  i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
}`;

async function signIn(port, nickname) {
  const app = launchApp({
    port,
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-bl-profile-')),
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

/** Poll the effect's own numbers until a condition on them holds; false on timeout. */
async function effectUntil(page, test, limit = 45_000) {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    const b = await page.evaluate('return (await window.__harmonyAudio()).background').catch(() => null);
    if (test(b)) return true;
    await sleep(700);
  }
  return false;
}

async function run() {
  console.log('Starting MediaMTX, the server and a client…\n');
  await startMediaMtx();
  await startServer();
  await register('pedro', { ownerKey });
  const pedro = await signIn(PORT_PEDRO, 'pedro');
  await pedro.send('Runtime.enable');
  await pedro.evaluate(`
    [...document.querySelectorAll('#channel-items li.channel-row')]
      .find((li) => li.querySelector('.channel-name')?.textContent === 'voice').click(); return true;`);
  await waitFor(pedro, "!document.getElementById('voice-active').hidden", { label: 'the call panel', timeoutMs: 30_000 });
  await sleep(3000);

  // The effect, on: blur is the cheapest to ask for and needs no picture.
  await pedro.evaluate("document.querySelector('#bg-mode button[data-value=blur]').click(); return true;");
  await sleep(500);
  await pedro.evaluate("document.getElementById('voice-cam').click(); return true;");
  const running = await effectUntil(pedro, (b) => b?.frames > 5);
  if (!running) {
    console.log('  The background effect did not start here (no WebGL, or the model is missing): nothing to measure.');
    return;
  }
  await sleep(3000);
  const stats = (await pedro.evaluate('return (await window.__harmonyAudio()).background'));
  console.log('  running, unthrottled:', JSON.stringify(stats));
  check('the effect runs and reports itself', stats.frames > 5 && stats.fps > 0 && ['GPU', 'CPU'].includes(stats.delegate), JSON.stringify(stats));
  const unthrottled = stats;

  // --- the machine slows to a crawl ---------------------------------------------------------------------------------------
  await pedro.send('Emulation.setCPUThrottlingRate', { rate: 30 });
  let sawBackOff = false;
  let gone = false;
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    await sleep(1500);
    const now = await pedro.evaluate('return (await window.__harmonyAudio()).background').catch(() => null);
    if (now) {
      if (now.segmentStride > 1 || now.renderStride > 1) sawBackOff = true;
    } else {
      gone = true;
      break;
    }
  }
  await pedro.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  check('on a slow machine the effect first does less: fewer frames segmented or drawn', sawBackOff || gone, 'it never backed off');
  check('and when that is not enough it stops itself', gone, 'it was still running after a minute');

  await sleep(2500);
  const after = await pedro.evaluate(`return {
    camera: document.getElementById('voice-cam').hasAttribute('data-on'),
    setting: document.querySelector('#bg-mode button[aria-checked=true]')?.dataset.value,
    note: [...document.querySelectorAll('body *')].some((e) => e.children.length === 0 && /background effect was switched off/.test(e.textContent)),
  }`);
  check('the camera is still on, as the plain camera', after.camera, JSON.stringify(after));
  check('the setting is left as he chose it', after.setting === 'blur', JSON.stringify(after));
  check('and he is told', after.note, JSON.stringify(after));

  // A fresh choice is a fresh try.
  await pedro.evaluate("document.querySelector('#bg-mode button[data-value=off]').click(); return true;");
  await sleep(1500);
  await pedro.evaluate("document.querySelector('#bg-mode button[data-value=blur]').click(); return true;");
  const again = await effectUntil(pedro, (b) => b?.frames > 5);
  check('choosing the background again tries it again', again, 'it did not come back');
  console.log('  first reading was', JSON.stringify(unthrottled));
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
