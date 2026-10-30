// The microphone's volume, sensitivity and processing switches, applied to a
// call that is already running: Ana measures what she actually receives from
// Pedro while he changes them in Settings, and nobody leaves or rejoins.
//
// Pedro's microphone is Chromium's own fake device, REAL capture rather than a
// stand-in, because the thing that went wrong lives in Chromium: a second
// capture of a device that is already open is given the first one's echo
// cancellation and noise suppression whatever it asked for. Every capture is
// noted with what it asked for and what the browser says it got.
//
//   MEDIAMTX_BIN=/path/to/mediamtx node client/test/mic-live.mjs

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

const HARMONY_PORT = 18230;
const MTX_API_PORT = 9997 - 80;
const MTX_WEBRTC_PORT = 8889 - 80;
const MTX_ICE_PORT = 8189 - 80;
const PORT_PEDRO = 9523;
const PORT_ANA = 9524;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-ml-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'harmony-ml-mtx-'));
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

/** Chromium's fake microphone (a beep every second), noted as it is opened. */
const STUBS = `
  const md = navigator.mediaDevices;
  const real = md.getUserMedia.bind(md);
  window.__got = [];
  md.getUserMedia = async (c = {}) => {
    const stream = await real(c);
    if (c.audio) {
      const s = stream.getAudioTracks()[0].getSettings();
      window.__got.push({ asked: { e: c.audio.echoCancellation, n: c.audio.noiseSuppression },
        got: { e: s.echoCancellation, n: s.noiseSuppression } });
    }
    return stream;
  };
  return true;`;

const setInput = (id, value) => `{
  const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
  i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
}`;

async function signInAndJoin(port, nickname) {
  const app = launchApp({
    port,
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-ml-profile-')),
    extraArgs: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
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

  /** What Ana hears of Pedro, averaged over two seconds. */
  const heard = async () => {
    await sleep(1500);
    return ana.evaluate(`
      let sum = 0, n = 0;
      for (let i = 0; i < 50; i++) {
        const sub = window.__harmony().voice.subs.find((s) => s.tracks > 0 && s.mid !== undefined);
        if (sub) { sum += sub.level; n += 1; }
        await new Promise((r) => setTimeout(r, 100));
      }
      return n ? sum / n : -1;`);
  };
  const open = () => pedro.evaluate(`
    const d = document.getElementById('devices');
    if (!d.open) document.getElementById('voice-config').click();
    document.querySelector('.settings-tab[data-tab="voice"]').click(); return true;`);
  const flip = async (id) => {
    await pedro.evaluate(`
      const i = document.getElementById(${JSON.stringify(id)});
      i.checked = !i.checked; i.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
    await sleep(1200);
  };
  const got = () => pedro.evaluate('return window.__got.slice()');

  await sleep(2500);
  await open();
  const base = await heard();
  check('Ana hears Pedro\'s microphone', base > 0.003, base.toFixed(4));

  // --- volume ------------------------------------------------------------------------------------------
  // 25% against 200%: eight times apart in the gain, far less in what is heard of the fake
  // microphone's loud beep (clipped at the top, levelled by automatic gain), so the bar is a clear step, not the ratio.
  await pedro.evaluate(`${setInput('mic-gain', '25')} return true;`);
  const quiet = await heard();
  await pedro.evaluate(`${setInput('mic-gain', '200')} return true;`);
  const loud = await heard();
  check('and the call applies it in the worker, not through an audio thread',
    (await pedro.evaluate('return window.__harmony().voice.micGate')) === 'worker');
  check('turning the input volume from 25% to 200% is heard without leaving', loud > quiet * 1.4, `${quiet.toFixed(4)} -> ${loud.toFixed(4)}`);
  await pedro.evaluate(`${setInput('mic-gain', '100')} return true;`);

  // --- sensitivity (the gate) -----------------------------------------------------------------------------
  await pedro.evaluate(`${setInput('mic-gate', '100')} return true;`);
  await sleep(500);
  check('the gate follows the slider as it moves', await pedro.evaluate(`return document.getElementById('mic-gate-label').textContent === '100'`));
  await pedro.evaluate(`${setInput('mic-gate', '0')} return true;`);
  const reopened = await heard();
  check('with it off the microphone is heard', reopened > 0.003, reopened.toFixed(4));

  // --- processing, on the real capture ------------------------------------------------------------------------------
  let captures = await got();
  check('the call opened its microphone with both switched off',
    captures[0].asked.e === false && captures[0].asked.n === false && captures[0].got.e === false && captures[0].got.n === false, JSON.stringify(captures[0]));

  await flip('mic-echo-cancellation');
  captures = await got();
  check('echo cancellation on: the browser really gives the new capture echo cancellation',
    captures.at(-1).asked.e === true && captures.at(-1).got.e === true, JSON.stringify(captures.at(-1)));
  await flip('mic-noise-suppression');
  captures = await got();
  check('noise suppression on: and really gives it noise suppression, with echo cancellation kept',
    captures.at(-1).got.n === true && captures.at(-1).got.e === true, JSON.stringify(captures.at(-1)));
  await flip('mic-echo-cancellation');
  captures = await got();
  check('echo cancellation off again is really off, with noise suppression kept',
    captures.at(-1).got.e === false && captures.at(-1).got.n === true, JSON.stringify(captures.at(-1)));
  await flip('mic-noise-suppression');
  captures = await got();
  check('and both off', captures.at(-1).got.e === false && captures.at(-1).got.n === false, JSON.stringify(captures.at(-1)));

  // --- still audible, and still adjustable, after all that reopening ------------------------------------------------------
  // Compared with each other rather than with the start: automatic gain
  // control re-learns the level after every reopening, so the absolute level
  // drifts, but the same capture at 25% and at 200% is eight times apart.
  await pedro.evaluate(`${setInput('mic-gain', '25')} return true;`);
  const low = await heard();
  await pedro.evaluate(`${setInput('mic-gain', '200')} return true;`);
  const high = await heard();
  check('the call is still heard', low > 0.002, low.toFixed(4));
  check('and volume still works on the reopened microphone', high > low * 1.4, `${low.toFixed(4)} -> ${high.toFixed(4)}`);
  check('and the call is still up', await pedro.evaluate("return !document.getElementById('voice-active').hidden"));
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
