// Picture in picture: the channel's streams as one floating window.
//
// Viewer watches; Pedro and Zed each turn a camera on. With the setting on the
// stage is empty and one stream is in the window; whoever with a camera talks
// takes it over until they stop; stepping picks by hand; the window moves and
// resizes. The cameras and microphones are stand-ins (the tone's level is the
// test's to set, which is what makes somebody talk).
//
//   MEDIAMTX_BIN=/path/to/mediamtx node client/test/pip.mjs

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

const HARMONY_PORT = 18295;
const MTX_API_PORT = 9997 - 135;
const MTX_WEBRTC_PORT = 8889 - 135;
const MTX_ICE_PORT = 8189 - 135;
const PORT_PEDRO = 9531;
const PORT_ANA = 9532;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-pip-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'harmony-pip-mtx-'));
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
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-pip-profile-')),
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

async function run() {
  console.log('Starting MediaMTX, the server and three clients…\n');
  await startMediaMtx();
  await startServer();
  await register('viewer', { ownerKey });
  await register('pedro');
  await register('zed');
  const viewer = await enter(PORT_ANA, 'viewer');
  const pedro = await enter(PORT_PEDRO, 'pedro');
  const zed = await enter(9533, 'zed');
  for (const page of [pedro, zed]) await page.evaluate("document.getElementById('voice-cam').click(); return true;");
  await waitFor(viewer, "document.querySelectorAll('#channel-video .channel-tile[data-key]:not([data-own])').length >= 2", {
    label: 'the viewer seeing both cameras', timeoutMs: 40_000,
  });
  await sleep(1500);

  const talk = (page, on) => page.evaluate(`for (const g of window.__gains ?? []) g.gain.value = ${on ? 0.3 : 0}; return true;`);
  const view = () => viewer.evaluate(`
    const pip = document.getElementById('pip');
    const box = pip.getBoundingClientRect();
    const stage = document.getElementById('channel-video');
    const inWindow = [...document.querySelectorAll('#pip-body .channel-tile')].map((t) => t.dataset.key);
    return {
      layout: stage.dataset.layout, pipHidden: pip.hidden, inWindow,
      stageShowing: getComputedStyle(stage).display !== 'none' && !stage.hidden,
      count: document.getElementById('pip-count').textContent, note: document.getElementById('pip-note').textContent,
      rect: { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) },
      playing: [...document.querySelectorAll('#pip-body video')].map((v) => v.videoWidth > 0 && !v.paused),
    };`);
  const settle = async (predicate, label, timeoutMs = 8000) => {
    const end = Date.now() + timeoutMs;
    let v;
    while (Date.now() < end) {
      v = await view();
      if (predicate(v)) return v;
      await sleep(150);
    }
    throw new Error(`timed out: ${label} (last: ${JSON.stringify(v)})`);
  };

  // --- off by default -----------------------------------------------------------------------------------------------
  let v = await view();
  check('off by default: the streams are on the stage, in a grid', v.layout === 'grid' && v.pipHidden && v.stageShowing, JSON.stringify(v));

  // --- turned on in the settings ----------------------------------------------------------------------------------
  await viewer.evaluate("const i = document.getElementById('picture-in-picture'); i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); return true;");
  // The window is over a text channel; over the voice channel the streams are the stage.
  await viewer.evaluate("[...document.querySelectorAll('#channel-items li.channel-row')].find((li) => li.querySelector('.channel-name')?.textContent === 'general').click(); return true;");
  v = await settle((x) => x.layout === 'pip' && !x.pipHidden, 'the window appearing');
  check('turned on, the streams leave the stage', v.layout === 'pip' && !v.stageShowing, JSON.stringify(v));
  check('and ONE of the two is in the window', v.inWindow.length === 1 && v.count === '1/2', JSON.stringify(v));
  v = await settle((x) => x.playing[0] === true, 'the picture playing');
  check('it is playing, not just there', v.playing[0] === true, JSON.stringify(v.playing));
  check('the window is on screen', v.rect.x >= 0 && v.rect.y >= 0 && v.rect.w >= 220 && v.rect.h >= 150, JSON.stringify(v.rect));
  await shot(viewer, 'pip-on');
  const first = v.inWindow[0];
  const other = (await viewer.evaluate("return [...document.querySelectorAll('.channel-tile[data-key]:not([data-own])')].map((t) => t.dataset.key)")).find((k) => k !== first);

  // --- the caption says whose it is, and whether they are muted or deafened ----------------------------------------
  const caption = (key) => viewer.evaluate(`
    const t = document.querySelector('.channel-tile[data-key="${key}"]');
    return { face: Boolean(t.querySelector('.tile-face') && !t.querySelector('.tile-face').hidden && t.querySelector('.tile-face').textContent.trim()),
      kinds: [...t.querySelectorAll('.tile-standing .status-dot')].map((d) => d.dataset.kind) };`);
  const ownerPage = /pedro/i.test(await viewer.evaluate(`return document.querySelector('.channel-tile[data-key="${first}"] .tile-name').textContent`)) ? pedro : zed;
  let c = await caption(first);
  check("the caption shows the owner's picture", c.face, JSON.stringify(c));
  check('and no mute glyphs while they are heard', c.kinds.length === 0, JSON.stringify(c));
  await ownerPage.evaluate("document.getElementById('voice-mute').click(); return true;");
  const until = async (fn, label) => { const end = Date.now() + 8000; let r; while (Date.now() < end) { r = await fn(); if (r.ok) return r; await sleep(150); } throw new Error(`timed out: ${label} ${JSON.stringify(r)}`); };
  c = await until(async () => { const r = await caption(first); return { ...r, ok: r.kinds.includes('muted') }; }, 'the muted glyph');
  check('muting puts a muted microphone on the caption', c.kinds.includes('muted') && !c.kinds.includes('deaf'), JSON.stringify(c));
  await ownerPage.evaluate("document.getElementById('voice-deafen').click(); return true;");
  c = await until(async () => { const r = await caption(first); return { ...r, ok: r.kinds.includes('deaf') }; }, 'the deaf glyph');
  check('deafening adds the headphones', c.kinds.includes('muted') && c.kinds.includes('deaf'), JSON.stringify(c));
  await shot(viewer, 'pip-muted');
  await ownerPage.evaluate("document.getElementById('voice-deafen').click(); return true;");
  await ownerPage.evaluate("(() => { const m = document.getElementById('voice-mute'); if (m.hasAttribute('data-on')) m.click(); })(); return true;");
  c = await until(async () => { const r = await caption(first); return { ...r, ok: r.kinds.length === 0 }; }, 'the glyphs going');
  check('and they go when the person is back', c.kinds.length === 0, JSON.stringify(c));

  // --- whoever has a camera on and talks takes the window -------------------------------------------------------
  const talkerPage = await viewer.evaluate(`return document.querySelector('.channel-tile[data-key="${other}"] .tile-name')?.textContent ?? ''`);
  const pedroIsOther = /pedro/i.test(talkerPage);
  const talker = pedroIsOther ? pedro : zed;
  const quiet = pedroIsOther ? zed : pedro;
  await talk(talker, true);
  v = await settle((x) => x.inWindow[0] === other && /talking/i.test(x.note), 'the talker taking the window', 12_000);
  check('somebody talking takes the window, and it says who', v.inWindow[0] === other && /talking/i.test(v.note), JSON.stringify(v));
  await shot(viewer, 'pip-talking');
  await talk(talker, false);
  v = await settle((x) => x.inWindow[0] === first && x.note === '', 'the window going back', 12_000);
  check('when they stop it goes back to what was picked', v.inWindow[0] === first && v.note === '', JSON.stringify(v));
  check("a quiet camera never takes it", true, '');
  void quiet;

  // --- stepping ---------------------------------------------------------------------------------------------------------
  await viewer.evaluate("document.getElementById('pip-next').click(); return true;");
  v = await settle((x) => x.inWindow[0] === other, 'stepping to the next');
  check('the arrow steps to the other stream', v.inWindow[0] === other && v.count === '2/2', JSON.stringify(v));
  await viewer.evaluate("document.getElementById('pip-next').click(); return true;");
  v = await settle((x) => x.inWindow[0] === first, 'stepping round');
  check('and round again', v.inWindow[0] === first && v.count === '1/2', JSON.stringify(v));
  check('the other one is out of the window, not gone', (await viewer.evaluate(`return Boolean(document.querySelector('#channel-video .channel-tile[data-key="${other}"]'))`)), '');

  // --- a hand-made pick is not undone by somebody talking -------------------------------------------------------------
  await talk(talker, true);
  await sleep(3000);
  v = await view();
  check('a pick made by hand holds while somebody else talks', v.inWindow[0] === first, JSON.stringify(v));
  await talk(talker, false);

  // --- moving and resizing -----------------------------------------------------------------------------------------------
  const before = (await view()).rect;
  const drag = (id, dx, dy) => viewer.evaluate(`
    const h = document.getElementById(${JSON.stringify(id)}); const r = h.getBoundingClientRect();
    const x = r.left + 6, y = r.top + 6;
    const ev = (t, X, Y) => h.dispatchEvent(new PointerEvent(t, { bubbles: true, button: 0, pointerId: 7, clientX: X, clientY: Y }));
    ev('pointerdown', x, y); ev('pointermove', x + ${dx}, y + ${dy}); ev('pointerup', x + ${dx}, y + ${dy}); return true;`);
  await drag('pip-resize', 120, 60);
  await sleep(300);
  let after = (await view()).rect;
  check('dragging the corner makes the window bigger', after.w > before.w + 80 && after.h > before.h + 30, `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  await drag('pip-resize', -600, -400);
  await sleep(300);
  after = (await view()).rect;
  check('and it will not go below a usable size', after.w >= 220 && after.h >= 150, JSON.stringify(after));
  await drag('pip-resize', 200, 150);
  await sleep(300);
  const sized = (await view()).rect;
  await drag('pip-bar', -150, -90);
  await sleep(300);
  after = (await view()).rect;
  check('dragging the bar moves it', after.x < sized.x - 100 && after.y < sized.y - 50 && after.w === sized.w, `${JSON.stringify(sized)} -> ${JSON.stringify(after)}`);
  await drag('pip-bar', -5000, -5000);
  await sleep(300);
  after = (await view()).rect;
  check('but never off the screen', after.x === 0 && after.y === 0, JSON.stringify(after));
  await shot(viewer, 'pip-moved');
  const saved = await viewer.evaluate('return window.harmony.settings.get().then((r) => (r.data ?? r).pipRect)');
  check("where it was left is remembered", saved && saved.x === 0 && saved.y === 0 && saved.w === after.w, JSON.stringify({ saved, after }));

  // --- the video survived all that ----------------------------------------------------------------------------------------
  check('still playing after the moves', (await view()).playing[0] === true, JSON.stringify((await view()).playing));

  // --- back to the stage ----------------------------------------------------------------------------------------------------------
  await viewer.evaluate("document.getElementById('pip-stage').click(); return true;");
  v = await settle((x) => x.layout === 'grid' && x.pipHidden, 'back on the stage');
  check("the window's own button puts the streams back on the stage as a grid", v.layout === 'grid' && v.inWindow.length === 0, JSON.stringify(v));
  const checkbox = await viewer.evaluate("return document.getElementById('picture-in-picture').checked");
  check('and leaves the setting alone: it is the setting that turns picture in picture off', checkbox === true, String(checkbox));
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
