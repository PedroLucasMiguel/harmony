// Picture in picture, popped out of Harmony into a window of its own.
//
// Viewer watches; Pedro and Zed each turn a camera on. With the setting on the
// stage is empty and one stream is in the window; whoever with a camera talks
// takes it over until they stop; stepping picks by hand; the window moves and
// resizes. The cameras and microphones are stand-ins (the tone's level is the
// test's to set, which is what makes somebody talk).
//
//   MEDIAMTX_BIN=/path/to/mediamtx node client/test/pip-popout.mjs

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

const HARMONY_PORT = 18297;
const MTX_API_PORT = 9997 - 137;
const MTX_WEBRTC_PORT = 8889 - 137;
const MTX_ICE_PORT = 8189 - 137;
const PORT_PEDRO = 9541;
const PORT_ANA = 9542;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-popout-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'harmony-popout-mtx-'));
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
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-popout-profile-')),
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
  const zed = await enter(9543, 'zed');
  for (const page of [pedro, zed]) await page.evaluate("document.getElementById('voice-cam').click(); return true;");
  await waitFor(viewer, "document.querySelectorAll('#channel-video .channel-tile[data-key]:not([data-own])').length >= 2", {
    label: 'the viewer seeing both cameras', timeoutMs: 40_000,
  });
  await sleep(1500);
  const talk = (page, on) => page.evaluate(`for (const g of window.__gains ?? []) g.gain.value = ${on ? 0.3 : 0}; return true;`);

  await viewer.evaluate("const i = document.getElementById('picture-in-picture'); i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); return true;");
  await viewer.evaluate("[...document.querySelectorAll('#channel-items li.channel-row')].find((li) => li.querySelector('.channel-name')?.textContent === 'general').click(); return true;");
  await waitFor(viewer, "document.getElementById('channel-video').dataset.layout === 'pip'", { label: 'the window in the app' });
  const inApp = await viewer.evaluate("return { here: Boolean(document.getElementById('pip')), detachButton: !document.getElementById('pip-detach').hidden }");
  check('first it is in the app, with a button to pop it out', inApp.here && inApp.detachButton, JSON.stringify(inApp));

  // --- popped out by hand --------------------------------------------------------------------------------------------------
  await viewer.evaluate("document.getElementById('pip-detach').click(); return true;");
  const win = await popup(PORT_ANA);
  await sleep(1500);
  const out = await win.evaluate(`
    const pip = document.getElementById('pip');
    const v = document.querySelector('#pip-body video');
    return { has: Boolean(pip), detached: pip?.hasAttribute('data-detached'), tiles: document.querySelectorAll('#pip-body .channel-tile').length,
      playing: Boolean(v && v.videoWidth > 0 && !v.paused), count: document.getElementById('pip-count').textContent,
      filled: pip ? Math.round(pip.getBoundingClientRect().width) >= innerWidth - 2 : false,
      themed: document.documentElement.dataset.lacks !== undefined, bg: getComputedStyle(document.body).backgroundColor };`);
  check('the window pops out into a page of its own', out.has && out.detached, JSON.stringify(out));
  check('with the stream playing in it', out.tiles === 1 && out.playing && out.count === '1/2', JSON.stringify(out));
  check('filling the window', out.filled, JSON.stringify(out));
  const left = await viewer.evaluate("return { here: Boolean(document.getElementById('pip')), stageShowing: !document.getElementById('channel-video').hidden && getComputedStyle(document.getElementById('channel-video')).display !== 'none' }");
  check('and it is no longer in the app', !left.here && !left.stageShowing, JSON.stringify(left));
  await shot(win, 'popout');

  // --- it still works out there ---------------------------------------------------------------------------------------
  const keyBefore = await win.evaluate("return document.querySelector('#pip-body .channel-tile').dataset.key");
  await win.evaluate("document.getElementById('pip-next').click(); return true;");
  await sleep(500);
  const keyAfter = await win.evaluate("return { key: document.querySelector('#pip-body .channel-tile').dataset.key, playing: document.querySelector('#pip-body video').videoWidth > 0 && !document.querySelector('#pip-body video').paused }");
  check('the arrows step between streams out there', keyAfter.key !== keyBefore && keyAfter.playing, JSON.stringify({ keyBefore, keyAfter }));

  // The one that was not showing now is; the other one talks and takes the window.
  await win.evaluate("document.getElementById('pip-next').click(); return true;");
  await sleep(300);
  const shownKey = await win.evaluate("return document.querySelector('#pip-body .channel-tile').dataset.key");
  const otherKey = await viewer.evaluate(`return [...document.querySelectorAll('.channel-tile[data-key]:not([data-own])')].map((t) => t.dataset.key)`).then((all) => all.find((k) => k !== shownKey));
  void otherKey;
  // Wait out the rest the hand pick gave the automatic switch, then have somebody talk.
  await sleep(12_500);
  const names = await win.evaluate("return [...document.querySelectorAll('.channel-tile .tile-name')].map((n) => n.textContent)");
  void names;
  await talk(pedro, true); await talk(zed, false);
  const pedroShown = await (async () => {
    const end = Date.now() + 10_000;
    while (Date.now() < end) {
      const r = await win.evaluate("return { name: document.querySelector('#pip-body .tile-name')?.textContent ?? '', note: document.getElementById('pip-note').textContent }");
      if (/pedro/.test(r.name) && /talking|falando|hablando/i.test(r.note)) return r;
      await sleep(200);
    }
    return null;
  })();
  check('somebody talking still takes the window out there', Boolean(pedroShown), JSON.stringify(pedroShown));
  await talk(pedro, false);

  // --- brought back by the button --------------------------------------------------------------------------------------
  await win.evaluate("document.getElementById('pip-detach').click(); return true;");
  await popup(PORT_ANA, { gone: true });
  await sleep(800);
  const back = await viewer.evaluate(`
    const v = document.querySelector('#pip-body video');
    return { here: Boolean(document.getElementById('pip')), detached: document.getElementById('pip')?.hasAttribute('data-detached'),
      playing: Boolean(v && v.videoWidth > 0 && !v.paused), tiles: document.querySelectorAll('#pip-body .channel-tile').length };`);
  check('the button brings it back into the app, still playing', back.here && !back.detached && back.playing && back.tiles === 1, JSON.stringify(back));

  // --- closing the window brings it back -------------------------------------------------------------------------------
  await viewer.evaluate("document.getElementById('pip-detach').click(); return true;");
  const second = await popup(PORT_ANA);
  await sleep(1000);
  await second.evaluate("window.close(); return true;").catch(() => {});
  await popup(PORT_ANA, { gone: true });
  await sleep(800);
  const closed = await viewer.evaluate(`return { here: Boolean(document.getElementById('pip')), hidden: document.getElementById('pip')?.hidden, tiles: document.querySelectorAll('#pip-body .channel-tile').length, layout: document.getElementById('channel-video').dataset.layout }`);
  check('closing the window puts it back in the app', closed.here && !closed.hidden && closed.tiles === 1 && closed.layout === 'pip', JSON.stringify(closed));

  // --- minimising pops it out, and coming back puts it away ---------------------------------------------------------------
  const hide = (hidden) => viewer.evaluate(`
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => ${hidden} });
    document.dispatchEvent(new Event('visibilitychange')); return true;`);
  await hide(true);
  const auto = await popup(PORT_ANA);
  await sleep(1200);
  const autoOut = await auto.evaluate("const v = document.querySelector('#pip-body video'); return { tiles: document.querySelectorAll('#pip-body .channel-tile').length, playing: Boolean(v && v.videoWidth > 0 && !v.paused) }");
  check('when Harmony is out of sight the window pops out by itself', autoOut.tiles === 1 && autoOut.playing, JSON.stringify(autoOut));
  const cameras = await viewer.evaluate('return window.__harmony().voice.camerasPaused');
  check("and the cameras it shows are not paused for being hidden", cameras === false, String(cameras));
  await hide(false);
  console.log('  [state after coming back]', JSON.stringify(await viewer.evaluate('return window.__harmonyPip()').catch((e) => String(e))));
  await popup(PORT_ANA, { gone: true });
  await sleep(600);
  const home = await viewer.evaluate("return { here: Boolean(document.getElementById('pip')), hidden: document.getElementById('pip')?.hidden }");
  check('and goes back in when Harmony does', home.here && !home.hidden, JSON.stringify(home));

  // --- not when it is switched off ----------------------------------------------------------------------------------------------
  await viewer.evaluate("const i = document.getElementById('pip-pop-out'); i.checked = false; i.dispatchEvent(new Event('change', { bubbles: true })); return true;");
  await hide(true);
  await sleep(1800);
  const targets = await (await fetch(`http://127.0.0.1:${PORT_ANA}/json/list`)).json();
  check('switched off, nothing pops out when Harmony is hidden', !targets.some((x) => x.url.endsWith('/pip.html')), JSON.stringify(targets.map((x) => x.url)));
  await hide(false);
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
