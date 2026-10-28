// Echo cancellation and noise suppression for the microphone, end to end.
//
// Pedro joins a voice room on a real server and MediaMTX, and opens Settings >
// Voice & video. The microphone is a stand-in that keeps a note of the
// constraints it was opened with, so the test can see what the browser would
// have been asked for: both off by default, each switch reopening the live
// microphone with the new choice, the choice kept in the settings, and the
// next call opening with it.
//
//   MEDIAMTX_BIN=/path/to/mediamtx node client/test/mic-processing.mjs

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

const HARMONY_PORT = 18190;
const MTX_API_PORT = 9997 - 40;
const MTX_WEBRTC_PORT = 8889 - 40;
const MTX_ICE_PORT = 8189 - 40;
const PORT_PEDRO = 9483;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-mp-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'harmony-mp-mtx-'));
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

/** A microphone that hums, and a note of every audio request it is given. */
const STUBS = `
  const md = navigator.mediaDevices;
  md.enumerateDevices = async () => [
    { kind: 'audioinput', deviceId: 'default', label: 'Microphone', groupId: 'g1' },
  ].map((d) => ({ ...d, toJSON: () => d }));
  window.__asked = [];
  md.getUserMedia = async (c = {}) => {
    const tracks = [];
    if (c.audio) {
      window.__asked.push(c.audio);
      const ctx = new AudioContext(); const out = ctx.createMediaStreamDestination();
      const tone = ctx.createOscillator(); tone.frequency.value = 196;
      const gain = ctx.createGain(); gain.gain.value = 0.05;
      tone.connect(gain); gain.connect(out); tone.start();
      tracks.push(...out.stream.getAudioTracks());
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
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-mp-profile-')),
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
  return page;
}

const joinVoice = async (page) => {
  await page.evaluate(`
    [...document.querySelectorAll('#channel-items li.channel-row')]
      .find((li) => li.querySelector('.channel-name')?.textContent === 'voice').click();
    return true;`);
  await waitFor(page, "!document.getElementById('voice-active').hidden && document.querySelectorAll('#voice-roster li').length >= 1", {
    label: 'joining the room', timeoutMs: 40_000,
  });
  await sleep(800);
};

async function run() {
  console.log('Starting MediaMTX, the server and a client…\n');
  await startMediaMtx();
  await startServer();
  await register('pedro', { ownerKey });

  const pedro = await signIn(PORT_PEDRO, 'pedro');
  await pedro.send('Runtime.enable');
  pedro.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
    console.log('  [pedro exception]', (d.exception?.description ?? d.text).split('\n').slice(0, 3).join(' / ').slice(0, 300));
  });

  const asked = () => pedro.evaluate('return window.__asked.at(-1)');
  const count = () => pedro.evaluate('return window.__asked.length');
  const switches = () => pedro.evaluate(`return [
    document.getElementById('mic-echo-cancellation').checked,
    document.getElementById('mic-noise-suppression').checked]`);
  const flip = async (id) => {
    await pedro.evaluate(`
      const i = document.getElementById(${JSON.stringify(id)});
      i.checked = !i.checked; i.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
    await sleep(800);
  };
  const open = () => pedro.evaluate(`
    const dialog = document.getElementById('devices');
    if (!dialog.open) document.getElementById('voice-config').click();
    document.querySelector('.settings-tab[data-tab="voice"]').click();
    return true;`);
  const saved = () => pedro.evaluate(`
    const s = await harmony.settings.get(); const d = s.data ?? s;
    return [d.micEchoCancellation, d.micNoiseSuppression];`);

  // --- off by default, and joining honours it -----------------------------------------------
  await open();
  await sleep(500);
  check('both switches are off by default', (await switches()).join() === 'false,false', (await switches()).join());
  check('and nothing is saved as on', (await saved()).join() === 'false,false', (await saved()).join());
  await pedro.evaluate("document.getElementById('devices').close(); return true;");

  await joinVoice(pedro);
  let a = await asked();
  check('the microphone opens with echo cancellation off', a.echoCancellation === false, JSON.stringify(a));
  check('and with noise suppression off', a.noiseSuppression === false, JSON.stringify(a));

  // --- each switch reopens the live microphone ------------------------------------------------
  await open();
  let before = await count();
  await flip('mic-echo-cancellation');
  a = await asked();
  check('turning echo cancellation on reopens the microphone', (await count()) === before + 1, String(await count()));
  check('with echo cancellation on and noise suppression still off',
    a.echoCancellation === true && a.noiseSuppression === false, JSON.stringify(a));

  before = await count();
  await flip('mic-noise-suppression');
  a = await asked();
  check('turning noise suppression on reopens it again', (await count()) === before + 1, String(await count()));
  check('with both on', a.echoCancellation === true && a.noiseSuppression === true, JSON.stringify(a));
  check('the call is still published', await pedro.evaluate("return !document.getElementById('voice-active').hidden"));
  check('both choices are saved', (await saved()).join() === 'true,true', (await saved()).join());

  before = await count();
  await flip('mic-echo-cancellation');
  await flip('mic-noise-suppression');
  a = await asked();
  check('turning both off again asks for neither', a.echoCancellation === false && a.noiseSuppression === false, JSON.stringify(a));
  check('through two reopenings, one per switch', (await count()) === before + 2, String(await count()));

  // --- remembered across a call ----------------------------------------------------------------
  await flip('mic-noise-suppression');
  await pedro.evaluate("document.getElementById('devices').close(); document.getElementById('voice-leave').click(); return true;");
  await waitFor(pedro, "document.getElementById('voice-active').hidden", { label: 'leaving the room' });
  await sleep(800);
  await joinVoice(pedro);
  a = await asked();
  check('the next call opens with noise suppression on', a.noiseSuppression === true, JSON.stringify(a));
  check('and echo cancellation still off', a.echoCancellation === false, JSON.stringify(a));
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
