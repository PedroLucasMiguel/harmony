// A call on a slow link.
//
// Everything the app says to the server -- the control socket, the HTTP API and
// the media relay's WHIP/WHEP -- goes through a proxy that holds each chunk back
// for a few hundred milliseconds in each direction, which is what a server on
// the other side of the world looks like to the code that waits for it. The
// races a fast network never shows are the point: joining and turning the camera
// on at once, pressing it twice, switching noise suppression on straight away.
//
// What is measured is what ANA receives from PEDRO: whether the picture is a
// picture and not black, and how loud and how steady his voice is.
//
//   MEDIAMTX_BIN=/path/to/mediamtx node client/test/high-ping.mjs
//   PING_MS=500  one-way delay in ms (default 350)

import { spawn } from 'node:child_process';
import net from 'node:net';
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

const HARMONY_PORT = 18250;
const MTX_API_PORT = 9997 - 100;
const MTX_WEBRTC_PORT = 8889 - 100;
const MTX_ICE_PORT = 8189 - 100;
const PORT_PEDRO = 9543;
const PORT_ANA = 9544;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;
/** Where the clients go: the same server, a slow road away. */
const SLOW = `http://127.0.0.1:${HARMONY_PORT + 1000}`;
const PING_MS = Number(process.env.PING_MS ?? 350);

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-hp-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'harmony-hp-mtx-'));
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
        HARMONY_SIGNALING_URL: `http://127.0.0.1:${MTX_WEBRTC_PORT + 1000}`,
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

/** A TCP proxy that holds every chunk back by PING_MS, in both directions, in order. */
function slowRoad(listenPort, targetPort) {
  const server = net.createServer((client) => {
    const up = net.connect(targetPort, '127.0.0.1');
    const carry = (from, to) => {
      from.on('data', (chunk) => setTimeout(() => { if (!to.destroyed) to.write(chunk); }, PING_MS));
      from.on('end', () => setTimeout(() => to.end(), PING_MS));
      from.on('error', () => to.destroy());
    };
    carry(client, up);
    carry(up, client);
    client.on('close', () => up.destroy());
    up.on('close', () => client.destroy());
  });
  server.listen(listenPort, '127.0.0.1');
  procs.push({ kill: () => server.close() });
}

const STUBS = `
  const md = navigator.mediaDevices;
  md.enumerateDevices = async () => [
    { kind: 'audioinput', deviceId: 'default', label: 'Microphone', groupId: 'g1' },
    { kind: 'videoinput', deviceId: 'camera', label: 'Camera', groupId: 'g2' },
  ].map((d) => ({ ...d, toJSON: () => d }));
  window.__captures = [];
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
      const feed = document.createElement('canvas'); feed.width = 320; feed.height = 180;
      const g = feed.getContext('2d'); let n = 0;
      setInterval(() => { n += 1; g.fillStyle = '#243055'; g.fillRect(0, 0, 320, 180); g.fillStyle = '#7aa2ff'; g.fillRect((n * 9) % 300, 0, 20, 180); }, 100);
      tracks.push(feed.captureStream(10).getVideoTracks()[0]);
    }
    window.__captures.push({ audio: Boolean(c.audio), video: Boolean(c.video), at: Math.round(performance.now()) });
    return new MediaStream(tracks);
  };
  window.__sinks = 0;
  const realSink = AudioContext.prototype.setSinkId;
  if (realSink) AudioContext.prototype.setSinkId = function (...a) { window.__sinks += 1; return realSink.apply(this, a); };
  window.__logs = [];
  for (const level of ['warn', 'error']) {
    const real = console[level].bind(console);
    console[level] = (...a) => { window.__logs.push(level + ': ' + a.map(String).join(' ').slice(0, 200)); real(...a); };
  }
  return true;`;

const setInput = (id, value) => `{
  const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
  i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
}`;

async function signIn(port, nickname) {
  const app = launchApp({
    port,
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-hp-profile-')),
    extraArgs: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  procs.push(app);
  const page = await attach(await findPage(port));
  await sleep(1500);
  await page.evaluate(STUBS);
  await page.evaluate(`${setInput('server-url', SLOW)} return true;`);
  await sleep(4000);
  await page.evaluate(`${setInput('username', nickname)} ${setInput('account-password', 'hunter22')}
    document.getElementById('continue').click(); return true;`);
  await waitFor(page, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: `${nickname} signing in`, timeoutMs: 60_000 });
  await sleep(1500);
  return page;
}

/** Click the voice channel, and return as soon as the call panel is up -- NOT when the microphone is published. */
const clickJoin = (page) => page.evaluate(`
  [...document.querySelectorAll('#channel-items li.channel-row')]
    .find((li) => li.querySelector('.channel-name')?.textContent === 'voice').click(); return true;`);
const inCall = (page) => waitFor(page, "!document.getElementById('voice-active').hidden", { label: 'the call panel', timeoutMs: 60_000 });
const settled = (page) => waitFor(page, "document.querySelectorAll('#voice-roster li').length >= 1 && window.__harmony().voice.mic?.connection !== undefined || true", { label: 'settled' });

async function run() {
  console.log(`Starting MediaMTX, the server, a ${PING_MS} ms road each way and two clients…\n`);
  await startMediaMtx();
  await startServer();
  slowRoad(HARMONY_PORT + 1000, HARMONY_PORT);
  slowRoad(MTX_WEBRTC_PORT + 1000, MTX_WEBRTC_PORT);
  await register('pedro', { ownerKey });
  await register('ana');
  const ana = await signIn(PORT_ANA, 'ana');
  const pedro = await signIn(PORT_PEDRO, 'pedro');
  for (const [name, page] of [['ana', ana], ['pedro', pedro]]) {
    await page.send('Runtime.enable');
    page.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
      console.log(`  [${name} exception]`, (d.exception?.description ?? d.text).split('\n').slice(0, 3).join(' / ').slice(0, 300));
    });
  }
  await clickJoin(ana);
  await inCall(ana);
  await sleep(8000);

  /** What Ana hears of Pedro, sampled every 100 ms for `ms`: {mean, max}. */
  const hear = async (ms = 3000) => ana.evaluate(`
    const levels = [];
    const end = performance.now() + ${ms};
    while (performance.now() < end) {
      const sub = window.__harmony().voice.subs.find((s) => s.tracks > 0);
      levels.push(sub ? sub.level : -1);
      await new Promise((r) => setTimeout(r, 100));
    }
    const ok = levels.filter((l) => l >= 0);
    return { mean: ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : -1, max: ok.length ? Math.max(...ok) : -1, n: ok.length };`);

  /** Is the picture Ana gets from Pedro a picture? Mean brightness of the tile, 0 for black. */
  const picture = () => ana.evaluate(`
    const v = document.querySelector('#channel-video .channel-tile video');
    if (!v || !v.videoWidth) return { shown: false, brightness: -1 };
    const c = document.createElement('canvas'); c.width = 64; c.height = 36;
    const g = c.getContext('2d'); g.drawImage(v, 0, 0, 64, 36);
    const d = g.getImageData(0, 0, 64, 36).data; let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    return { shown: true, brightness: Math.round(sum / (d.length / 4)), w: v.videoWidth };`);
  const waitPicture = async (limit = 40_000) => {
    const end = Date.now() + limit;
    let p = { shown: false };
    while (Date.now() < end) {
      p = await picture();
      if (p.shown) return p;
      await sleep(500);
    }
    return p;
  };
  const camState = () => pedro.evaluate(`return { label: document.getElementById('voice-cam').textContent.trim(), on: document.getElementById('voice-cam').hasAttribute('data-on'),
    captures: window.__captures.filter((c) => c.video).length, logs: window.__logs.slice(-6) }`);
  const leave = async () => {
    await pedro.evaluate("document.getElementById('voice-leave').click(); return true;");
    await waitFor(pedro, "document.getElementById('voice-active').hidden", { label: 'leaving', timeoutMs: 60_000 });
    await sleep(3000);
  };

  // --- the baseline: Pedro joins, waits, and his voice is steady -------------------------------------------------------------
  await clickJoin(pedro);
  await inCall(pedro);
  await sleep(10_000);
  const base = await hear(3000);
  check('Ana hears Pedro over the slow road', base.mean > 0.005, JSON.stringify(base));
  console.log('  baseline', JSON.stringify(base));

  // --- turning the camera on in a settled call --------------------------------------------------------------------------------
  await pedro.evaluate("document.getElementById('voice-cam').click(); return true;");
  let p = await waitPicture();
  console.log('  settled call camera:', JSON.stringify(p), JSON.stringify(await camState()));
  check('a camera turned on in a settled call arrives as a picture', p.shown && p.brightness > 20, JSON.stringify(p));
  await pedro.evaluate("document.getElementById('voice-cam').click(); return true;");
  await sleep(4000);
  await leave();

  // --- join and turn the camera on AT ONCE --------------------------------------------------------------------------------------
  for (let round = 1; round <= 3; round += 1) {
    await clickJoin(pedro);
    await inCall(pedro);
    // No wait: the call panel is up, the microphone's publish is still crossing the road.
    await pedro.evaluate("document.getElementById('voice-cam').click(); return true;");
    p = await waitPicture();
    await sleep(3000);
    const cam = await camState();
    const voice = await hear(3000);
    console.log(`  round ${round} camera:`, JSON.stringify(p), JSON.stringify(cam), 'voice', JSON.stringify(voice));
    check(`round ${round}: a camera turned on at once is a picture, not black`, p.shown && p.brightness > 20, JSON.stringify(p));
    check(`round ${round}: and his voice stays as steady as before`, voice.max < Math.max(0.2, base.max * 3), `${JSON.stringify(base)} -> ${JSON.stringify(voice)}`);
    await pedro.evaluate("document.getElementById('voice-cam').click(); return true;").catch(() => {});
    await sleep(2000);
    await leave();
  }

  // --- the same button pressed twice, as a hotkey or an impatient click does -----------------------------------------------------
  await clickJoin(pedro);
  await inCall(pedro);
  await sleep(6000);
  const before = (await camState()).captures;
  await pedro.evaluate("const b = document.getElementById('voice-cam'); b.click(); setTimeout(() => b.click(), 300); return true;");
  await sleep(500);
  const opening = await pedro.evaluate("const b = document.getElementById('voice-cam'); return { label: b.textContent.trim(), disabled: b.disabled }");
  check('while the camera opens the button says so and cannot be pressed again', opening.label === 'Starting camera…' && opening.disabled, JSON.stringify(opening));
  p = await waitPicture();
  await sleep(3000);
  const twice = await camState();
  console.log('  double press:', JSON.stringify(p), JSON.stringify(twice));
  check('pressed twice, only one camera is opened', twice.captures === before + 1, `${before} -> ${twice.captures}`);
  check('and it arrives as a picture', twice.on && p.shown && p.brightness > 20, `${JSON.stringify(twice)} ${JSON.stringify(p)}`);
  check('with the button back to Stop camera', twice.label === 'Stop camera', twice.label);
  await pedro.evaluate("document.getElementById('voice-cam').click(); return true;");
  await sleep(3000);

  // --- the device list changing -------------------------------------------------------------------------------------------------------
  // What opening a camera does on a Mac, over and over: the output device must
  // not be re-applied each time, because every re-apply restarts the audio.
  const sinks0 = await pedro.evaluate('return window.__sinks');
  await pedro.evaluate("for (let i = 0; i < 6; i += 1) setTimeout(() => navigator.mediaDevices.dispatchEvent(new Event('devicechange')), i * 300); return true;");
  const duringChanges = await hear(5000);
  const sinks1 = await pedro.evaluate('return window.__sinks');
  check('device changes do not re-apply the output device', sinks1 === sinks0, `${sinks0} -> ${sinks1}`);
  check('and his voice is untouched by them', duringChanges.max < Math.max(0.2, base.max * 3) && duringChanges.mean > base.mean * 0.7, JSON.stringify(duringChanges));
  await leave();

  // --- noise suppression on, straight after joining --------------------------------------------------------------------------------
  await clickJoin(pedro);
  await inCall(pedro);
  await sleep(2000);
  await pedro.evaluate(`
    const d = document.getElementById('devices'); if (!d.open) document.getElementById('voice-config').click();
    document.querySelector('.settings-tab[data-tab="voice"]').click();
    const i = document.getElementById('mic-noise-suppression'); i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true }));
    return true;`);
  const ns = await hear(10_000);
  console.log('  noise suppression on at once:', JSON.stringify(ns));
  check('noise suppression switched on straight after joining leaves his voice steady', ns.max < Math.max(0.2, base.max * 3), `${JSON.stringify(base)} -> ${JSON.stringify(ns)}`);
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
