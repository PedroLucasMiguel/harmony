// A camera that starts small, and a voice that is marked as the one that matters.
//
// Turning a camera on used to send its full rate at once, on the same home line
// as the voice; the voice's packets waited behind it and crackled. The camera now
// opens at a low ceiling and steps up, and the senders say which of them is the
// voice. Every call to setParameters on a sender is recorded in the page, so what
// is checked is what the browser was actually told, and when.
//
//   MEDIAMTX_BIN=/path/to/mediamtx node client/test/cam-ramp.mjs

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

const HARMONY_PORT = 18260;
const MTX_API_PORT = 9997 - 110;
const MTX_WEBRTC_PORT = 8889 - 110;
const MTX_ICE_PORT = 8189 - 110;
const PORT_PEDRO = 9553;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-cr-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'harmony-cr-mtx-'));
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
      const [w, h] = window.__camSize ?? [1280, 720];
      const feed = document.createElement('canvas'); feed.width = w; feed.height = h;
      const g = feed.getContext('2d'); let n = 0;
      setInterval(() => { n += 1; g.fillStyle = '#243055'; g.fillRect(0, 0, w, h); g.fillStyle = '#7aa2ff'; g.fillRect((n * 9) % (w - 20), 0, 20, h); }, 100);
      tracks.push(feed.captureStream(10).getVideoTracks()[0]);
    }
    return new MediaStream(tracks);
  };
  window.__params = [];
  const realSet = RTCRtpSender.prototype.setParameters;
  RTCRtpSender.prototype.setParameters = function (p) {
    const e = p.encodings?.[0] ?? {};
    window.__params.push({ kind: this.track?.kind ?? '?', at: Math.round(performance.now()), maxBitrate: e.maxBitrate ?? null, priority: e.priority ?? null, networkPriority: e.networkPriority ?? null });
    return realSet.call(this, p);
  };
  return true;`;

const setInput = (id, value) => `{
  const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
  i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
}`;

async function signIn(port, nickname) {
  const app = launchApp({
    port,
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-cr-profile-')),
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
  await sleep(4000);

  const params = () => pedro.evaluate('return window.__params');
  const audio = (await params()).filter((p) => p.kind === 'audio' && p.priority);
  check('the voice sender is told it is the high priority one',
    audio.some((p) => p.priority === 'high' && p.networkPriority === 'high'), JSON.stringify(audio));

  const camButton = "document.getElementById('voice-cam').click(); return true;";
  const ceilings = async () => (await params()).filter((p) => p.kind === 'video' && p.maxBitrate);
  const reset = () => pedro.evaluate('window.__params.length = 0; return true;');

  // A 720p camera at 24 fps asks for about 1.66 Mbit/s: what is it allowed to send, and when?
  await pedro.evaluate(camButton);
  await waitFor(pedro, "document.getElementById('voice-cam').hasAttribute('data-on')", { label: 'the camera on', timeoutMs: 30_000 });
  await sleep(1000);
  let video = await ceilings();
  const asked = Math.max(...(await (async () => { await sleep(5200); return (await ceilings()).map((p) => p.maxBitrate); })()));
  video = await ceilings();
  console.log('  ceilings over time:', JSON.stringify(video.map((p) => [p.at, p.maxBitrate])));
  check('the camera asked for more than the climb\'s middle step', asked > 600_000, String(asked));
  check('it opens at a low ceiling, not what was asked for', video[0]?.maxBitrate === 250_000, JSON.stringify(video.map((p) => p.maxBitrate)));
  check('and is marked as low priority', (await params()).some((p) => p.kind === 'video' && p.priority === 'low' && p.networkPriority === 'low'), '');
  check('it steps up through 600 kbit/s', video.some((p) => p.maxBitrate === 600_000), JSON.stringify(video.map((p) => p.maxBitrate)));
  check('and ends at the full rate', video[video.length - 1]?.maxBitrate === asked, JSON.stringify(video.map((p) => p.maxBitrate)));
  const gap = (video.find((p) => p.maxBitrate === 600_000)?.at ?? 0) - video[0].at;
  check('the first step comes after about two and a half seconds, not at once', gap > 2000 && gap < 3500, `${gap} ms`);

  // A quality change made during the climb is the person's choice and replaces it.
  await pedro.evaluate(camButton);
  await sleep(2500);
  await reset();
  await pedro.evaluate(camButton);
  await waitFor(pedro, "document.getElementById('voice-cam').hasAttribute('data-on')", { label: 'the camera on again', timeoutMs: 30_000 });
  await sleep(800);
  await pedro.evaluate(`
    const d = document.getElementById('devices'); if (!d.open) document.getElementById('voice-config').click();
    document.querySelector('.settings-tab[data-tab="voice"]').click();
    ${setInput('cam-framerate', '30')} return true;`);
  await sleep(6500);
  video = await ceilings();
  console.log('  with a change during the climb:', JSON.stringify(video.map((p) => [p.at, p.maxBitrate])));
  const retuned = video.filter((p) => p.maxBitrate > 1_800_000);
  check('the new setting is applied', retuned.length >= 1, JSON.stringify(video.map((p) => p.maxBitrate)));
  const after = video.slice(video.indexOf(retuned[0]));
  check('and nothing from the climb lowers it afterwards', after.every((p) => p.maxBitrate === retuned[0].maxBitrate), JSON.stringify(after.map((p) => p.maxBitrate)));
  await pedro.evaluate("document.getElementById('devices').close(); return true;");
  await pedro.evaluate(camButton);
  await sleep(1000);

  // A camera whose own rate is under the start ceiling is never raised past it.
  await pedro.evaluate('window.__camSize = [320, 180]; return true;');
  await reset();
  await pedro.evaluate(camButton);
  await waitFor(pedro, "document.getElementById('voice-cam').hasAttribute('data-on')", { label: 'the small camera on', timeoutMs: 30_000 });
  await sleep(6500);
  video = await ceilings();
  console.log('  small camera:', JSON.stringify(video.map((p) => [p.at, p.maxBitrate])));
  check('a camera that asks for 300 kbit/s is never allowed more than that', video.length > 0 && video.every((p) => p.maxBitrate <= 300_000), JSON.stringify(video.map((p) => p.maxBitrate)));
  await pedro.evaluate(camButton);
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
