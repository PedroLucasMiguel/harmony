// The debug log (Settings > Debug): off at every start, a text file while it is on, with the
// connections, the machine and the app in it, and nothing that names anybody.
//
//   MEDIAMTX_BIN=/path/to/mediamtx node client/test/debug-log.mjs

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
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

const HARMONY_PORT = 18450;
const MTX_API_PORT = 9997 - 310;
const MTX_WEBRTC_PORT = 8889 - 310;
const MTX_ICE_PORT = 8189 - 310;
const PORT_PEDRO = 9791;
const PORT_ANA = 9792;
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

async function signInAndJoin(port, nickname, userDataDir) {
  const app = launchApp({
    port,
    userDataDir,
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



const profile = mkdtempSync(join(tmpdir(), 'harmony-debuglog-profile-'));
const logsDir = join(profile, 'logs');
const logFiles = () => (existsSync(logsDir) ? readdirSync(logsDir).filter((f) => f.endsWith('.txt')) : []);
const readLog = () => {
  const [name] = logFiles().sort().slice(-1);
  return name ? readFileSync(join(logsDir, name), 'utf8') : '';
};

const openSettings = async (page) => {
  await page.evaluate("const d = document.getElementById('devices'); if (!d.open) document.getElementById('voice-config').click(); return true;");
  await sleep(500);
  await page.evaluate("document.querySelector('.settings-tab[data-tab=\"debug\"]').click(); return true;");
  await sleep(300);
};
const toggle = (page) => page.evaluate("document.getElementById('debug-log').click(); return true;");
const checked = (page) => page.evaluate("return document.getElementById('debug-log').checked");
const startCamera = async (page) => {
  await page.evaluate("document.getElementById('voice-cam').click(); return true;");
  await waitFor(page, "document.querySelector('#channel-video [data-key=\"me:c\"]')", { label: 'my camera tile', timeoutMs: 40_000 });
};

async function run() {
  console.log('Starting MediaMTX, the server and a client…\n');
  await startMediaMtx();
  await startServer();
  await register('pedro', { ownerKey });
  const pedro = await signInAndJoin(PORT_PEDRO, 'pedro', profile);
  const firstApp = procs.at(-1);
  await pedro.send('Runtime.enable');
  pedro.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
    console.log('  [pedro exception]', (d.exception?.description ?? d.text).split('\n').slice(0, 3).join(' / ').slice(0, 300));
  });

  // --- the page -----------------------------------------------------------------------------------------------------------------
  await openSettings(pedro);
  const page = await pedro.evaluate(`{
    const tab = document.querySelector('.settings-tab[data-tab="debug"]');
    const section = document.querySelector('.settings-page[data-page="debug"]');
    return { tab: tab?.textContent.trim(), tabShown: tab?.offsetParent !== null, shown: !section.hidden, toggle: document.getElementById('debug-log').checked,
      button: document.getElementById('debug-open-folder').textContent.trim(), label: document.querySelector('.settings-page[data-page="debug"] .setting-title').textContent };
  }`);
  check('Settings has a Debug tab with a "Dump to log" switch, off, and a button for the folder',
    page.tab === 'Debug' && page.tabShown && page.shown && page.toggle === false && page.label === 'Dump to log' && /log folder/i.test(page.button), JSON.stringify(page));
  check('nothing has been written while it is off', logFiles().length === 0, JSON.stringify(logFiles()));

  // --- turned on, in a call with a camera -------------------------------------------------------------------------------------
  await pedro.evaluate("document.getElementById('devices').close(); return true;");
  await startCamera(pedro);
  await openSettings(pedro);
  await toggle(pedro);
  await waitFor(pedro, "!document.getElementById('debug-log-file').hidden", { label: 'the file name shown', timeoutMs: 10_000 });
  check('turning it on shows where it is being written', (await pedro.evaluate("return document.getElementById('debug-log-file').textContent")).includes('harmony-debug-'), '');
  await sleep(9000);
  const text = readLog();
  check('a new text file has been started', logFiles().length === 1 && /^harmony-debug-\d{8}-\d{6}\.txt$/.test(logFiles()[0]), JSON.stringify(logFiles()));
  const has = (re) => re.test(text);
  check('it begins with what the machine is: the app, the system, the processor, the graphics, the memory', has(/^Harmony debug log/) && has(/\napp\s+4\./) && has(/\ncpu\s+/) && has(/\ngpu\s+/) && has(/\nmemory\s+/) && has(/\nsystem\s+/), text.slice(0, 600));
  check('and the devices and the settings that matter', has(/\nmics\s+Microphone/) && has(/\ncameras\s+Camera/) && has(/\nsettings\s+.*cameraResolution=360/), '');
  check('the machine\'s load is written every few seconds: processor, memory and each process of the app', has(/ SYS\s+cpu=\d+%/) && has(/ PROC\s+.*Renderer#\d+:cpu=/) && has(/GPU#\d+:cpu=/), '');
  check('and what the page itself is doing: stalls and memory', has(/ PAGE\s+lagMax=\d+ms/) && has(/jsHeap=\d+MB/), '');
  check('the microphone\'s connection is described: loss, delay, the path it took and what it sent', has(/ NET\s+mic .*state=connected/) && has(/outAudio\.packetsSent=\+\d+/) && has(/path\.rtt_ms=\d+/) && has(/path\.local=host\//), '');
  check('and the camera\'s: the codec, the encoder, frames per second and the time to encode one', has(/ NET\s+cam .*outVideo\.codec=video\/H264/) && has(/outVideo\.encodedFps=/) && has(/outVideo\.encodeMsPerFrame=/) && has(/outVideo\.h264=/), '');
  check('with what the devices really delivered and whether the audio contexts ran', has(/ AUDIO\s+micTrack .*sampleRate=/) && has(/ AUDIO\s+camTrack .*size=/) && has(/ AUDIO\s+ctx\.capture .*state=running/), '');
  check('and the events: the call, and the camera starting', has(/ EVENT\s+voice: cam: starting/) || has(/ EVENT\s+logging on; in a call: yes/), '');
  check('it holds no name, no address and no server', !/pedro/i.test(text) && !/127\.0\.0\.1/.test(text) && !/hunter22/.test(text) && !new RegExp(`:${HARMONY_PORT}`).test(text), (text.match(/.*(pedro|127\.0\.0\.1).*/i) ?? [''])[0].slice(0, 200));

  // --- turned off ----------------------------------------------------------------------------------------------------------------
  await toggle(pedro);
  await sleep(800);
  check('turning it off hides the file name', await pedro.evaluate("return document.getElementById('debug-log-file').hidden"), '');
  const size = statSync(join(logsDir, logFiles()[0])).size;
  await sleep(4500);
  check('and the file stops growing', statSync(join(logsDir, logFiles()[0])).size === size, '');
  check('with a last line saying it was stopped', /LOG\s+stopped by the user\n$/.test(readLog()), readLog().slice(-120));

  // --- the folder button --------------------------------------------------------------------------------------------------------
  await pedro.evaluate("document.getElementById('debug-open-folder').click(); return true;");
  await sleep(600);
  check('the folder button works, with no error', await pedro.evaluate("return document.getElementById('debug-log-error').hidden"), '');

  // --- off at every start -------------------------------------------------------------------------------------------------------
  await pedro.evaluate("if (!document.getElementById('debug-log').checked) document.getElementById('debug-log').click(); return true;");
  await sleep(2500);
  check('turned on again, ready for the next test', await checked(pedro), '');
  const before = logFiles().length;
  try { firstApp.kill(); } catch { /* gone */ }
  await sleep(2500);
  // The server and MediaMTX go on running; only the app is started again, with the same profile.
  const app2 = launchApp({ port: PORT_PEDRO + 1, userDataDir: profile, extraArgs: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const reopened = await attach(await findPage(PORT_PEDRO + 1));
  await sleep(3000);
  await reopened.evaluate(STUBS);
  await openSettings(reopened);
  const again = await reopened.evaluate("return { toggle: document.getElementById('debug-log').checked, file: document.getElementById('debug-log-file').hidden }");
  check('after the app is closed and opened again with it left on, it is off', again.toggle === false && again.file === true, JSON.stringify(again));
  await sleep(4000);
  const files = logFiles();
  const last = files.sort().slice(-1)[0];
  const sizeThen = statSync(join(logsDir, last)).size;
  await sleep(3500);
  check('and nothing is being written', files.length === before && statSync(join(logsDir, last)).size === sizeThen, JSON.stringify({ before, files }));
  const status = await reopened.evaluate("return window.harmony.debug.status().then((r) => r.data ?? r)");
  check('the main process agrees it is off', status.enabled === false, JSON.stringify(status));
  app2.kill();
}

try {
  await run();
} catch (err) {
  console.log('  FAIL ', err.stack);
  process.exitCode = 1;
}
summary();
process.exit(process.exitCode ?? 0);
