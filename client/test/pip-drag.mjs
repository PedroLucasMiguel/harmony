// Moving the picture-in-picture window about, and the button in its corner.
//
//   MEDIAMTX_BIN=/path/to/mediamtx node client/test/pip-drag.mjs

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

const HARMONY_PORT = 18305;
const MTX_API_PORT = 9997 - 145;
const MTX_WEBRTC_PORT = 8889 - 145;
const MTX_ICE_PORT = 8189 - 145;
const PORT_PEDRO = 9581;
const PORT_ANA = 9582;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-drag-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'harmony-drag-mtx-'));
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
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-drag-profile-')),
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
  const zed = await enter(9583, 'zed');
  for (const page of [pedro, zed]) await page.evaluate("document.getElementById('voice-cam').click(); return true;");
  await waitFor(viewer, "document.querySelectorAll('#channel-video .channel-tile[data-key]:not([data-own])').length >= 2", {
    label: 'the viewer seeing both cameras', timeoutMs: 40_000,
  });
  await sleep(1500);

  // Somebody talking keeps the speaking poll busy, as in any real call.
  await pedro.evaluate("for (const g of window.__gains ?? []) g.gain.value = 0.3; return true;");

  const clickChannel = (name) => viewer.evaluate(`
    [...document.querySelectorAll('#channel-items li.channel-row')].find((li) => li.querySelector('.channel-name')?.textContent === ${JSON.stringify(name)}).click(); return true;`);
  const rect = () => viewer.evaluate("const r = document.getElementById('pip').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }");
  const setting = () => viewer.evaluate("return window.harmony.settings.get().then((r) => (r.data ?? r).pictureInPicture)");

  // This is about the window inside the app: overlapping test windows must not pop it out.
  await viewer.evaluate("const o = document.getElementById('pip-pop-out'); o.checked = false; o.dispatchEvent(new Event('change', { bubbles: true })); return true;");
  await viewer.evaluate("const i = document.getElementById('picture-in-picture'); i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); return true;");
  await sleep(500);
  await clickChannel('general');
  await waitFor(viewer, "!document.getElementById('pip').hidden", { label: 'the window over the chat' });
  await sleep(1000);

  // --- a drag, sampled all the way along ----------------------------------------------------------------------------------
  /** Press on `id`, move in `steps` small steps with a pause between (the poll runs meanwhile), reporting the window after each. */
  const drag = (id, dx, dy, steps = 12) => viewer.evaluate(`
    return (async () => {
      const h = document.getElementById(${JSON.stringify(id)}); const r = h.getBoundingClientRect();
      const pip = document.getElementById('pip');
      const x0 = r.left + r.width / 3, y0 = r.top + r.height / 2;
      const ev = (t, X, Y) => h.dispatchEvent(new PointerEvent(t, { bubbles: true, button: 0, pointerId: 11, clientX: X, clientY: Y }));
      const start = pip.getBoundingClientRect();
      ev('pointerdown', x0, y0);
      const seen = [];
      for (let i = 1; i <= ${steps}; i += 1) {
        const X = x0 + (${dx} * i) / ${steps}, Y = y0 + (${dy} * i) / ${steps};
        ev('pointermove', X, Y);
        await new Promise((res) => setTimeout(res, 70));
        const b = pip.getBoundingClientRect();
        seen.push({ want: [Math.round(start.left + (${dx} * i) / ${steps}), Math.round(start.top + (${dy} * i) / ${steps})], got: [Math.round(b.left), Math.round(b.top)] });
      }
      ev('pointerup', x0 + ${dx}, y0 + ${dy});
      return seen;
    })();`);
  const off = (seen) => Math.max(...seen.map((s) => Math.max(Math.abs(s.want[0] - s.got[0]), Math.abs(s.want[1] - s.got[1]))));

  let seen = await drag('pip-bar', -140, -90);
  check('dragging the bar: the window stays under the pointer the whole way', off(seen) <= 2, `worst miss ${off(seen)}px: ${JSON.stringify(seen.filter((s) => Math.abs(s.want[0] - s.got[0]) > 2).slice(0, 3))}`);
  await sleep(600);
  const afterFirst = await rect();

  seen = await drag('pip-bar', 60, 40);
  check('and a second drag starts from where the first one left it, not from somewhere older', off(seen) <= 2, `worst miss ${off(seen)}px`);
  await sleep(600);

  // --- by the picture ---------------------------------------------------------------------------------------------------------
  const before = await rect();
  seen = await drag('pip-body', -50, -30);
  const after = await rect();
  check('the picture itself can be dragged, not only the bar', Math.abs(after.x - (before.x - 50)) <= 2 && Math.abs(after.y - (before.y - 30)) <= 2, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  void afterFirst;

  // --- the corner button ----------------------------------------------------------------------------------------------------------------
  for (let i = 0; i < 3; i += 1) {
    await viewer.evaluate("document.getElementById('pip-stage').click(); return true;");
    await sleep(400);
    await clickChannel('general');
    await sleep(600);
  }
  check('the button in the corner never turns the setting off', (await setting()) === true, String(await setting()));
  check('so the window is there again each time a text channel is opened', await viewer.evaluate("return !document.getElementById('pip').hidden"), '');
  const box = await viewer.evaluate("return document.getElementById('picture-in-picture').checked");
  void box;

  await viewer.evaluate("document.getElementById('pip-stage').click(); return true;");
  await sleep(600);
  const onStage = await viewer.evaluate("return { layout: document.getElementById('channel-video').dataset.layout, pipHidden: document.getElementById('pip').hidden, chat: !document.getElementById('chat-active').hidden }");
  check('what it does is put the streams back on the stage, as a grid', onStage.layout === 'grid' && onStage.pipHidden && !onStage.chat, JSON.stringify(onStage));
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
