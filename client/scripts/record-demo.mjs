// Records a short video tour of the desktop app.
//
//   node scripts/record-demo.mjs [output.mp4]       (default: ../media/harmony-demo.mp4)
//
// Nothing here is a mock-up. It starts a real control server and a real
// MediaMTX in temporary directories, fills the server with a small, believable
// community (people, channels, a conversation with replies, reactions and a
// pin), launches the real Electron app and drives it through the same
// debugging protocol the UI tests use -- signing in, typing, clicking, joining
// a voice room, starting a camera, sharing a window, opening Settings -- while
// capturing the page's own frames.
//
// The recording itself needs no operating-system screen recording: it is the
// page's frames, so it looks the same on any machine. Sharing a screen is a
// different matter. The app captures a real window through the operating
// system, so on macOS whatever launches this needs the Screen Recording
// permission, and the share is of a window the script opens for the purpose
// (see record-demo-window.cjs), never of the person's own desktop. The share
// picker is filtered to that one window as it draws, so the video does not
// show anybody's other windows.
//
// Two more app windows appear while it runs: Ana, a second signed-in client
// with a camera on, and the window being shared.
//
// Needs ffmpeg on the PATH and a MediaMTX binary (MEDIAMTX_BIN, or
// ~/mediamtx/mediamtx). Takes a few minutes to run for ~2 minutes of video.
//
// The look of the tour -- captions, title cards and the pointer, which a
// protocol-driven app has none of -- is drawn by a layer injected into the
// page. It is the recording's own and is never part of the shipped app.

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, electronBin, findPage, launchApp, sleep, waitFor } from '../test/cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const serverEntry = resolve(repoRoot, 'server', 'src', 'index.js');
const OUT = resolve(process.argv[2] ?? join(repoRoot, 'media', 'harmony-demo.mp4'));

const HARMONY_PORT = 18150;
const MTX_API_PORT = 9987;
const MTX_WEBRTC_PORT = 8879;
const MTX_ICE_PORT = 8179;
const DEBUG_PORT = 9431;
const DEBUG_PORT_ANA = 9432;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;
const SIGNALING = `http://127.0.0.1:${MTX_WEBRTC_PORT}`;
const MEDIAMTX_BIN = process.env.MEDIAMTX_BIN ?? join(homedir(), 'mediamtx', 'mediamtx');
/** The window the demo shares; the share picker shows nothing else. */
const SHARED_WINDOW = 'Release 3.6.0 slides';

/**
 * The window, in device pixels: the video is exactly this, so nothing is
 * scaled. The app runs at its stock 115% inside it, as anybody's would, which
 * makes the page about 1670 x 940 CSS pixels -- a full, comfortable desktop.
 */
const WIDTH = 1920;
const HEIGHT = 1080;
/** The caption band along the top, in CSS pixels. See LAYER. */
const BAND = 96;
const VERSION = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-demo-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-demo-profile-'));
const userDataDirAna = mkdtempSync(join(tmpdir(), 'harmony-demo-ana-'));
const userDataDirSlides = mkdtempSync(join(tmpdir(), 'harmony-demo-slides-'));
const framesDir = mkdtempSync(join(tmpdir(), 'harmony-demo-frames-'));
const procs = [];
const sockets = [];
let mtxLog = '';
let serverLog = '';
let ownerKey = null;

function cleanup() {
  for (const ws of sockets) { try { ws.close(); } catch { /* already closed */ } }
  for (const p of procs) { try { p.kill(); } catch { /* already gone */ } }
  for (const dir of [dataDir, userDataDir, userDataDirAna, userDataDirSlides, framesDir]) rmSync(dir, { recursive: true, force: true });
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

// ---------------------------------------------------------------------------
// The server, and a community to put in it
// ---------------------------------------------------------------------------

async function startMediaMtx() {
  if (!existsSync(MEDIAMTX_BIN)) {
    throw new Error(`No MediaMTX at ${MEDIAMTX_BIN}. Set MEDIAMTX_BIN to one (see server/install.sh for the pinned version).`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'harmony-demo-mtx-'));
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
  throw new Error(`MediaMTX did not start:\n${mtxLog.slice(-1200)}`);
}

function startHarmonyServer() {
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        HARMONY_PORT: String(HARMONY_PORT),
        HARMONY_HOST: '127.0.0.1',
        HARMONY_DATA_DIR: dataDir,
        HARMONY_MEDIAMTX_API: `http://127.0.0.1:${MTX_API_PORT}`,
        HARMONY_SIGNALING_URL: SIGNALING,
        HARMONY_POLL_INTERVAL_MS: '500',
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
        done(p);
      }
    });
    p.stderr.on('data', (b) => (serverLog += b.toString()));
  });
}

async function api(path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

/** Stay connected, so the person shows as online and can sit in a voice room. */
function connectPresence(token) {
  return new Promise((resolveSocket, reject) => {
    const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws`);
    sockets.push(ws);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', token, rid: 'hello' })));
    ws.addEventListener('message', (event) => {
      if (JSON.parse(event.data).type === 'hello-ok') resolveSocket(ws);
    });
    ws.addEventListener('error', () => reject(new Error('presence socket failed')));
  });
}

async function seed() {
  const people = {};
  const register = async (nickname, displayName, extra = {}) => {
    const { token } = await api('/api/accounts/register', {
      body: { nickname, password: 'hunter22', ...extra },
    });
    await api('/api/accounts/display-name', { token, body: { displayName } });
    people[nickname] = token;
    return token;
  };

  await register('pedro', 'Pedro', { ownerKey });
  await register('ana', 'Ana');
  await register('bruno', 'Bruno');
  await register('carla', 'Carla');
  await register('dave', 'Dave');
  const owner = people.pedro;

  const channels = (await api('/api/channels', { token: owner })).channels;
  const general = channels.find((c) => c.kind === 'text');
  const voice = channels.find((c) => c.kind === 'voice');
  await api(`/api/channels/${voice.id}`, { token: owner, body: { name: 'Lobby' } }).catch(() => {});
  const dev = (await api('/api/channels', { token: owner, body: { kind: 'text', name: 'dev' } })).channel;
  const random = (await api('/api/channels', { token: owner, body: { kind: 'text', name: 'random' } })).channel;
  const gameNight = (await api('/api/channels', { token: owner, body: { kind: 'voice', name: 'Game night' } })).channel;
  await api('/api/channels', { token: owner, body: { kind: 'voice', name: 'Focus' } });

  const say = async (nickname, channel, body, replyTo) => (await api(`/api/channels/${channel.id}/messages`, {
    token: people[nickname], body: { body, ...(replyTo ? { replyTo: replyTo.id } : {}) },
  })).message;
  const react = (nickname, message, emoji) =>
    api(`/api/messages/${message.id}/react`, { token: people[nickname], body: { emoji } });

  await say('ana', general, 'morning everyone');
  await say('carla', general, 'morning! coffee first, questions later');
  const release = await say('bruno', general, '3.6.0 is out. Screen shares can now keep Harmony\'s own sound out of the stream on macOS and Linux too');
  const echo = await say('carla', general, 'finally, no more hearing the whole channel back in the stream');
  await react('ana', echo, '🎉');
  await react('bruno', echo, '🎉');
  await react('dave', echo, '👍');
  await react('carla', release, '🔥');
  await react('ana', release, '🔥');
  await say('ana', general, 'and the settings page has tabs now, much easier to find things', release);
  await say('bruno', general, 'can somebody pin the release notes?');
  const notes = await say('pedro', general, 'Release notes: audio exclusion on every OS, tabbed settings, drawers close with a swipe, text channels remember where you were');
  await api(`/api/messages/${notes.id}/pin`, { token: owner, body: { pinned: true } });
  await say('dave', general, 'tested it on the Steam Deck, works great');

  await say('bruno', dev, 'CI is green on all three platforms');
  await say('ana', dev, 'the macOS helper builds as a universal binary, nice');
  await say('carla', random, 'friday movie night anyone?');

  // Bruno and Carla are online; Carla is already in a voice room. Ana is a
  // real client, signed in by the script (see joinAsAna), and Dave is away.
  const sockets = {};
  for (const nick of ['bruno', 'carla']) sockets[nick] = await connectPresence(people[nick]);
  sockets.carla.send(JSON.stringify({ type: 'voice:join', channelId: gameNight.id, rid: 'join' }));

  return { general, dev, random, gameNight };
}

// ---------------------------------------------------------------------------
// Capturing frames
// ---------------------------------------------------------------------------

const frames = [];

/** Which window the video is showing right now. Only its frames are kept. */
let activeSource = 'pedro';

async function startCapture(page, name) {
  page.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
    // Unacknowledged, the page sends nothing more -- kept or not.
    page.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    if (activeSource !== name) return;
    const file = `${String(frames.length).padStart(6, '0')}.jpg`;
    writeFileSync(join(framesDir, file), Buffer.from(data, 'base64'));
    frames.push({ name: file, at: metadata.timestamp });
  });
  await page.send('Page.startScreencast', {
    format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1,
  });
}

/** Dress a window for the recording: the layer on top, and exactly WIDTH x HEIGHT. */
async function prepareForRecording(page) {
  // The page's own CSP forbids inline styles, which the overlay is made of.
  await page.send('Page.enable');
  await page.send('Page.setBypassCSP', { enabled: true });
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  // Sized as a window being dragged would be, so the layout and its media
  // queries see exactly WIDTH x HEIGHT whatever the real window measures.
  await page.setViewport(WIDTH, HEIGHT);
  await sleep(800);
  await page.evaluate(`${LAYER}; return true;`);
}

/**
 * Frames arrive when the picture changes, not at a rate, so each one is shown
 * for as long as it lasted: a list of (file, duration) that ffmpeg turns into
 * a constant 30 fps.
 */
function encode() {
  if (frames.length < 2) throw new Error(`only ${frames.length} frames were captured`);
  const lines = [];
  frames.forEach((frame, i) => {
    const next = frames[i + 1];
    const seconds = next ? Math.max(0.001, next.at - frame.at) : 1;
    lines.push(`file '${join(framesDir, frame.name)}'`, `duration ${seconds.toFixed(4)}`);
  });
  // concat ignores the duration of the last entry unless it is repeated.
  lines.push(`file '${join(framesDir, frames.at(-1).name)}'`);
  const list = join(framesDir, 'frames.txt');
  writeFileSync(list, lines.join('\n'));

  mkdirSync(dirname(OUT), { recursive: true });
  const run = spawnSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', 'fps=30,scale=1920:1080:flags=lanczos:force_original_aspect_ratio=decrease,'
      + 'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p',
    '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-movflags', '+faststart',
    OUT,
  ], { stdio: 'inherit' });
  if (run.status !== 0) throw new Error('ffmpeg failed');
}

// ---------------------------------------------------------------------------
// The layer drawn over the page: captions, cards and a pointer
// ---------------------------------------------------------------------------

const LAYER = `(() => {
  if (window.__demo) return;
  const BAND = ${BAND};

  /*
   * A popover rather than a plain fixed element: a modal <dialog> (Settings)
   * lives in the browser's top layer, which no z-index can beat, so anything
   * drawn the ordinary way vanished behind it. Showing the layer again after
   * a dialog opens puts it back on top (see raise).
   */
  const layer = document.createElement('div');
  layer.id = 'demo-layer';
  layer.setAttribute('popover', 'manual');
  layer.style.cssText = 'position:fixed;inset:0;margin:0;padding:0;border:0;width:100%;height:100%;'
    + 'max-width:none;max-height:none;overflow:visible;background:transparent;color:inherit;'
    + 'pointer-events:none;font-family:"Segoe UI",system-ui,-apple-system,sans-serif;';
  document.body.append(layer);
  layer.showPopover();

  const make = (css, parent = layer) => {
    const node = document.createElement('div');
    node.style.cssText = css;
    parent.append(node);
    return node;
  };

  /*
   * The caption has a band of its own, above the app, and the app is pushed
   * down to make room: it is the same inset the Android build uses for the
   * status bar, so every view already knows how to sit under it. A caption
   * drawn over the app hid whatever it was describing.
   */
  document.documentElement.style.setProperty('--safe-area-inset-top', BAND + 'px');
  const band = make('position:absolute;left:0;right:0;top:0;height:' + BAND + 'px;display:flex;'
    + 'align-items:center;justify-content:center;padding:0 48px;box-sizing:border-box;'
    + 'background:linear-gradient(180deg,#0b0d12,#10131b);border-bottom:2px solid #5b8cff;'
    + 'box-shadow:0 6px 30px rgba(0,0,0,.45);');
  const text = make('color:#fff;font-size:38px;font-weight:700;letter-spacing:.2px;text-align:center;'
    + 'line-height:1.2;opacity:0;transform:translateY(-6px);'
    + 'transition:opacity .35s ease,transform .35s ease;', band);

  // Cards: the title and the closing screen. Above everything, band included.
  const card = make('position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;'
    + 'justify-content:center;gap:22px;color:#fff;text-align:center;opacity:0;'
    + 'background:radial-gradient(1400px 800px at 50% 35%,#1b2235 0%,#0b0d12 70%);'
    + 'transition:opacity .7s ease;');

  // The pointer, and the ring that marks a click.
  const pointer = make('position:absolute;left:0;top:0;width:36px;height:36px;opacity:0;'
    + 'filter:drop-shadow(0 2px 4px rgba(0,0,0,.6));'
    + 'transition:transform .75s cubic-bezier(.45,.05,.25,1),opacity .3s ease;');
  pointer.innerHTML = '<svg viewBox="0 0 24 24" width="36" height="36"><path d="M4 2l15 10-6.5 1.5L9 20z"'
    + ' fill="#fff" stroke="#0b0d12" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  const ring = make('position:absolute;left:0;top:0;width:56px;height:56px;margin:-28px 0 0 -28px;'
    + 'border-radius:50%;border:4px solid #5b8cff;opacity:0;');

  const centre = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const at = (x, y) => { pointer.style.transform = 'translate(' + x + 'px,' + y + 'px)'; };

  /** Elements built with the CSSOM: the page's policy refuses inline style attributes in markup. */
  const el = (css, content) => {
    const node = document.createElement('div');
    node.style.cssText = css;
    if (content) node.textContent = content;
    return node;
  };

  window.__demo = {
    say(words) {
      if (!words) { text.style.opacity = '0'; text.style.transform = 'translateY(-6px)'; return; }
      text.textContent = words;
      text.style.opacity = '1';
      text.style.transform = 'translateY(0)';
    },
    /** instant: already showing on the first frame, rather than fading in. */
    card(spec, instant = false) {
      if (!spec) { card.style.opacity = '0'; return; }
      pointer.style.opacity = '0';
      card.replaceChildren(
        el('width:150px;height:150px;background:#5b8cff;-webkit-mask:url(logo.png) center/contain no-repeat;'
          + 'mask:url(logo.png) center/contain no-repeat;'),
        el('font-size:84px;font-weight:700;letter-spacing:-1.5px;', spec.title),
        el('font-size:34px;color:#aab4cc;max-width:1100px;line-height:1.4;', spec.subtitle),
        ...(spec.lines ?? []).map((line) => el('font-size:30px;color:#e8ecf7;padding:13px 32px;border-radius:16px;'
          + 'background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);', line)),
      );
      if (instant) card.style.transition = 'none';
      card.style.opacity = '1';
      if (instant) { void card.offsetWidth; card.style.transition = 'opacity .7s ease'; }
    },
    /** Glide the pointer onto an element; true if it was there to find. */
    move(find, dx = 0, dy = 0) {
      const target = find();
      if (!target) return false;
      const { x, y } = centre(target);
      pointer.style.opacity = '1';
      at(x + dx - 8, y + dy - 4);
      return true;
    },
    ring(x, y) {
      ring.style.transition = 'none';
      ring.style.left = x + 'px'; ring.style.top = y + 'px';
      ring.style.opacity = '.95'; ring.style.transform = 'scale(.4)';
      void ring.offsetWidth;
      ring.style.transition = 'opacity .55s ease,transform .55s ease';
      ring.style.opacity = '0'; ring.style.transform = 'scale(1.5)';
    },
    centre(find) { const target = find(); return target ? centre(target) : null; },
    hidePointer() { pointer.style.opacity = '0'; },
    /** Back above whatever was opened since: a modal dialog sits in the top layer. */
    raise() { layer.hidePopover(); layer.showPopover(); },
  };
})()`;

/*
 * What the share picker may show.
 *
 * It lists every window and screen on the machine, with a thumbnail of each --
 * which is exactly what a recording of somebody's desk must not contain. So
 * anything but the window made for the demo is hidden the moment it is drawn
 * (a MutationObserver runs before the next paint, so it is never on screen),
 * and so are the other applications in the "keep this app's sound out" list.
 */
const PRIVACY = `(() => {
  const allowed = new RegExp(${JSON.stringify(SHARED_WINDOW)}, 'i');
  const tidy = () => {
    for (const source of document.querySelectorAll('#source-grid .source')) {
      const label = source.querySelector('.label')?.textContent ?? '';
      source.style.display = allowed.test(label) ? '' : 'none';
    }
    for (const option of [...document.querySelectorAll('#exclude-app option')]) {
      if (option.value && !/^Harmony/.test(option.textContent)) option.remove();
    }
  };
  new MutationObserver(tidy).observe(document.getElementById('picker'), { childList: true, subtree: true });
  tidy();
})()`;

// ---------------------------------------------------------------------------
// Driving the app like a person
// ---------------------------------------------------------------------------

let cdp = null;
/** Ana's window, for the moment the video shows the share arriving. */
let ana = null;

const evalIn = (expression) => cdp.evaluate(expression);
const caption = (text) => evalIn(`window.__demo.say(${JSON.stringify(text)}); return true;`);
const card = (spec, { instant = false } = {}) =>
  evalIn(`window.__demo.card(${JSON.stringify(spec)}, ${instant}); return true;`);

/** An element, found by an expression evaluated in the page. */
const finder = (expr) => `() => ${expr}`;

/** Glide to something and give the eye time to follow. */
async function pointAt(expr, { dx = 0, dy = 0, settle = 250 } = {}) {
  const found = await evalIn(`return window.__demo.move(${finder(expr)}, ${dx}, ${dy});`);
  if (!found) throw new Error(`nothing to point at: ${expr}`);
  await sleep(800 + settle);
}

/** Point at it, press it (ring and all), and give the result a moment. */
async function click(expr, { after = 500, dx = 0, dy = 0, how = 'click' } = {}) {
  await pointAt(expr, { dx, dy, settle: 100 });
  const spot = await evalIn(`return window.__demo.centre(${finder(expr)});`);
  await evalIn(`window.__demo.ring(${spot.x + dx}, ${spot.y + dy}); return true;`);
  await evalIn(`
    const el = (${finder(expr)})();
    if (${JSON.stringify(how)} === 'contextmenu') {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 }));
    } else {
      el.click();
    }
    return true;
  `);
  // Whatever that opened (Settings is a modal dialog) must not cover the layer.
  await evalIn('window.__demo.raise(); return true;');
  await sleep(after);
}

/** Type like a person, one character at a time, into whatever the expression finds. */
async function type(expr, text, { speed = 55, clear = false } = {}) {
  await pointAt(expr, { settle: 50 });
  await evalIn(`
    const el = (${finder(expr)})();
    el.focus();
    if (${clear}) { el.select?.(); }
    return true;
  `);
  for (const char of text) {
    await cdp.send('Input.insertText', { text: char });
    await sleep(speed + Math.random() * 35);
  }
}

const pressEnter = async () => {
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r', unmodifiedText: '\r' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
};

/** Slide a range input from where it is to a value, so the fill and the number are seen moving. */
async function slide(id, to, { steps = 24, ms = 900 } = {}) {
  await pointAt(`document.getElementById(${JSON.stringify(id)})`, { settle: 100 });
  const from = Number(await evalIn(`return document.getElementById(${JSON.stringify(id)}).value;`));
  for (let i = 1; i <= steps; i += 1) {
    const value = Math.round(from + ((to - from) * i) / steps);
    await evalIn(`
      const input = document.getElementById(${JSON.stringify(id)});
      input.value = ${value};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `);
    await sleep(ms / steps);
  }
  await evalIn(`document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event('change', { bubbles: true })); return true;`);
}

const channelRow = (name) =>
  `[...document.querySelectorAll('#channel-items li.channel-row')].find((li) => li.querySelector('.channel-name')?.textContent === ${JSON.stringify(name)})`;
const messageContaining = (text) =>
  `[...document.querySelectorAll('#chat-log .chat-msg')].find((m) => m.textContent.includes(${JSON.stringify(text)}))`;
const tab = (name) => `document.querySelector('.settings-tab[data-tab=${JSON.stringify(name)}]')`;

const cardSpec = (title, subtitle, lines = []) => ({ title, subtitle, lines });

// ---------------------------------------------------------------------------
// The second person in the room
// ---------------------------------------------------------------------------

/*
 * Neither --use-fake-device-for-media-stream nor --use-fake-ui-for-media-stream.
 *
 * The first fakes the microphone and camera, but also screen capture -- the
 * "shared window" came out as Chromium's green test pattern. The second is
 * worse: it makes real screen capture fail outright ("Could not start video
 * source"), which was measured against a bare Electron and not just this app.
 * And the window being shared is the point. So each window gets stand-in
 * devices inside the page instead (see mediaStubs), which touch no hardware
 * and show no permission prompt, and the app's own permission handler grants
 * the rest.
 */
const APP_FLAGS = [
  // Nobody clicks in a scripted window, and an audio context that has not
  // had a gesture stays silent -- which would leave the stand-in microphone mute.
  '--autoplay-policy=no-user-gesture-required',
  // A window behind others must go on painting, or there is nothing to record.
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  // The people in the room are test tones and nobody wants them on the speakers.
  '--mute-audio',
];

/**
 * A microphone and a camera that are not there.
 *
 * The microphone is a tone that swells and fades like speech, so the level
 * meter and the speaking ring have something to show; the camera is a drawn
 * avatar that keeps moving, because a still picture would not look like video.
 * enumerateDevices names them, which also keeps the app from probing for
 * labels with a real getUserMedia. Real getDisplayMedia is left alone.
 */
const mediaStubs = ({ initials, hue }) => `(() => {
  const devices = [
    { kind: 'audioinput', deviceId: 'default', label: 'Microphone', groupId: 'g1' },
    { kind: 'audiooutput', deviceId: 'default', label: 'Speakers', groupId: 'g1' },
    { kind: 'videoinput', deviceId: 'camera', label: 'Camera', groupId: 'g2' },
  ].map((d) => ({ ...d, toJSON: () => d }));
  const md = navigator.mediaDevices;
  md.enumerateDevices = async () => devices;

  const microphone = () => {
    const ctx = new AudioContext();
    const out = ctx.createMediaStreamDestination();
    const tone = ctx.createOscillator(); tone.frequency.value = 196;
    const swell = ctx.createGain(); swell.gain.value = 0.12;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 1.7;
    const depth = ctx.createGain(); depth.gain.value = 0.11;
    lfo.connect(depth); depth.connect(swell.gain);
    tone.connect(swell); swell.connect(out);
    tone.start(); lfo.start();
    return out.stream.getAudioTracks();
  };

  const camera = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 360;
    const g = canvas.getContext('2d');
    const t0 = performance.now();
    const draw = () => {
      const t = (performance.now() - t0) / 1000;
      const sky = g.createLinearGradient(0, 0, 640, 360);
      sky.addColorStop(0, 'hsl(${hue} 55% 32%)'); sky.addColorStop(1, 'hsl(${hue + 40} 60% 16%)');
      g.fillStyle = sky; g.fillRect(0, 0, 640, 360);
      g.fillStyle = 'hsla(${hue} 80% 70% / .18)';
      for (let i = 0; i < 6; i += 1) {
        g.beginPath();
        g.arc(320 + Math.sin(t * 0.7 + i) * 240, 180 + Math.cos(t * 0.9 + i * 1.7) * 120, 46 + i * 9, 0, 7);
        g.fill();
      }
      g.fillStyle = 'hsl(${hue} 50% 78%)';
      g.beginPath(); g.arc(320, 150 + Math.sin(t * 2) * 4, 62, 0, 7); g.fill();
      g.beginPath(); g.ellipse(320, 330, 128, 112, 0, Math.PI, 0); g.fill();
      g.fillStyle = 'hsl(${hue} 55% 22%)'; g.font = '700 54px system-ui, sans-serif';
      g.textAlign = 'center'; g.fillText(${JSON.stringify(initials)}, 320, 168 + Math.sin(t * 2) * 4);
    };
    draw();
    // A timer, not requestAnimationFrame: a window behind others does not get frames.
    setInterval(draw, 40);
    return canvas.captureStream(25).getVideoTracks();
  };

  // Kept for the failure report: what screen capture was asked for, and how it ended.
  const realDisplay = md.getDisplayMedia.bind(md);
  md.getDisplayMedia = async (constraints) => {
    window.__display = { asked: JSON.stringify(constraints) };
    try {
      const stream = await realDisplay(constraints);
      window.__display.got = JSON.stringify(stream.getVideoTracks()[0]?.getSettings());
      return stream;
    } catch (error) {
      window.__display.failed = error.name + ': ' + error.message;
      throw error;
    }
  };

  md.getUserMedia = async (constraints = {}) => {
    const tracks = [];
    if (constraints.audio) tracks.push(...microphone());
    if (constraints.video) tracks.push(...camera());
    return new MediaStream(tracks);
  };
})()`;

/**
 * A second, real client: signs in as Ana, joins the voice room and turns her
 * camera on, so the person being recorded walks into a room that is already
 * in use -- and receives real media from somebody else.
 */
async function joinAsAna() {
  const app = launchApp({ port: DEBUG_PORT_ANA, userDataDir: userDataDirAna, extraArgs: APP_FLAGS });
  procs.push(app);
  const ana = await attach(await findPage(DEBUG_PORT_ANA));
  await sleep(1500);
  await ana.evaluate(`${mediaStubs({ initials: 'AN', hue: 160 })}; return true;`);

  const set = (id, value) => ana.evaluate(`
    const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `);
  await set('server-url', BASE);
  await sleep(1500);
  await set('username', 'ana');
  await set('account-password', 'hunter22');
  await ana.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(ana, "document.querySelector('.view[data-active]')?.id === 'view-channels'", {
    label: 'Ana reaching the channels view',
  });
  await sleep(800);

  await ana.evaluate(`
    [...document.querySelectorAll('#channel-items li.channel-row')]
      .find((li) => li.querySelector('.channel-name')?.textContent === 'Game night').click();
    return true;
  `);
  await waitFor(ana, "!document.getElementById('voice-active').hidden && document.querySelectorAll('#voice-roster li').length >= 1", {
    label: 'Ana joining the voice room', timeoutMs: 40_000,
  });
  await sleep(500);
  await ana.evaluate("document.getElementById('voice-cam').click(); return true;");
  await waitFor(ana, "document.getElementById('voice-cam').hasAttribute('data-on')", {
    label: "Ana's camera turning on", timeoutMs: 30_000,
  });
  return ana;
}

// ---------------------------------------------------------------------------
// The tour
// ---------------------------------------------------------------------------

async function tour() {
  // --- title ---------------------------------------------------------------
  // Already showing: main() puts it up before the first frame is captured, so
  // the video opens on it rather than on whatever the app was doing underneath.
  await sleep(3800);
  await card(null);
  await sleep(900);

  // --- signing in ----------------------------------------------------------
  await caption('Point the app at your own server, and sign in');
  await type('document.getElementById("server-url")', BASE.replace('http://', ''), { speed: 70 });
  await sleep(900);
  await click('document.getElementById("server-continue")', { after: 600 });
  await waitFor(cdp, "!document.getElementById('step-account').hidden", { label: 'the account step' });
  await sleep(700);
  await type('document.getElementById("username")', 'an-username');
  await type('document.getElementById("account-password")', 'an-password');
  await sleep(300);
  await click('document.querySelector("details.options summary")', { after: 1500 });
  await caption('Everything optional lives under Options');
  await sleep(1400);
  await click('document.querySelector("details.options summary")', { after: 500 });
  await click('document.getElementById("continue")', { after: 400 });
  await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'", {
    label: 'the channels view',
  });
  await sleep(1800);

  // --- the layout ----------------------------------------------------------
  await caption('Text channels, voice rooms and your people, side by side');
  await pointAt(channelRow('Game night'));
  await sleep(1200);
  await caption('Voice rooms show who is in them before you join');
  await pointAt(`document.querySelector('#member-items .member-row')`);
  await sleep(900);
  await caption('Everyone on the server, online or not');
  await sleep(1500);

  // --- chat ----------------------------------------------------------------
  await click(channelRow('general'), { after: 1500 });
  await caption('Chat with replies, reactions and pinned messages');
  await sleep(1800);
  await pointAt(`document.querySelector('.pinned-strip .pinned-line')`);
  await sleep(900);
  await caption('Pinned messages stay one click away');
  await click(`document.querySelector('.pinned-strip .pinned-line')`, { after: 1600 });

  const target = messageContaining('3.6.0 is out');
  await pointAt(target, { dx: 120 });
  await caption('Reply to a message, with the original quoted above');
  await click(`${target}.querySelector('.msg-tool[title*="eply"], .msg-tool:first-child')`, { after: 700 });
  await type('document.getElementById("chat-input")', '@ana the new settings tabs are great, thank you!', { speed: 48 });
  await sleep(500);
  await pressEnter();
  await sleep(1800);

  await caption('Reactions are one click');
  const reaction = `document.querySelector('#chat-log .reaction')`;
  await click(reaction, { after: 1500 });

  await caption('Search the history, people and media');
  await type('document.getElementById("chat-search")', 'release', { speed: 70 });
  await sleep(1800);
  await click('document.getElementById("chat-search-clear")', { after: 1200 });

  await caption('Switch channels and come back: it remembers where you were');
  await click(channelRow('dev'), { after: 1500 });
  await click(channelRow('general'), { after: 1500 });

  // --- voice, camera and screen sharing -----------------------------------
  await caption('Join a voice room: whoever is in it, and their camera, appear at once');
  await click(channelRow('Game night'), { after: 400 });
  await waitFor(
    cdp,
    "!document.getElementById('voice-active').hidden && document.querySelectorAll('#voice-roster li').length >= 2",
    { label: 'joining the voice room', timeoutMs: 40_000 },
  );
  await waitFor(cdp, "document.querySelectorAll('#channel-video .channel-tile video').length >= 1", {
    label: "Ana's camera arriving", timeoutMs: 40_000,
  });
  await sleep(3200);

  await caption('Turn on your own camera');
  await click('document.getElementById("voice-cam")', { after: 400 });
  await waitFor(cdp, "document.querySelectorAll('#channel-video .channel-tile video').length >= 2", {
    label: 'the camera tile', timeoutMs: 30_000,
  });
  await sleep(3000);

  await caption('Share a screen, or a single window');
  await click('document.getElementById("voice-screen")', { after: 300 });
  await waitFor(cdp, "document.getElementById('picker').open", { label: 'the share picker' });
  // The picker is a modal dialog and opened after the layer was last raised.
  await evalIn('window.__demo.raise(); return true;');
  await sleep(900);
  await click('document.querySelector(\'#picker .tab[data-kind="window"]\')', { after: 1600 });
  await waitFor(
    cdp,
    "[...document.querySelectorAll('#source-grid .source')].some((b) => b.style.display !== 'none')",
    { label: 'the shared window in the picker', timeoutMs: 20_000 },
  );
  await caption('Pick what to share, then the quality, up to native resolution and 120 fps');
  await sleep(1200);
  await click("[...document.querySelectorAll('#source-grid .source')].find((b) => b.style.display !== 'none')", { after: 1500 });
  await pointAt('document.getElementById("framerate")');
  await sleep(1600);
  await caption('Harmony\'s own sound stays out of the stream, so the room never hears itself');
  await pointAt('document.getElementById("audio-note")');
  await sleep(2600);
  await click('document.getElementById("start-stream")', { after: 600 });
  await waitFor(
    cdp,
    "document.querySelector('.view[data-active]')?.id === 'view-channels' && document.querySelector('#channel-video [data-key$=\":s\"]')",
    { label: 'the share starting', timeoutMs: 40_000 },
  );
  await caption('Click your own share to see exactly what is going out');
  await click('document.querySelector(\'#channel-video [data-key$=":s"]\')', { after: 3800 });

  await caption('And here it is on Ana\'s screen, live');
  activeSource = 'ana';
  await ana.evaluate("window.__demo.say('Seen from Ana\\'s window: the shared screen, live'); return true;");
  await ana.evaluate(`
    const tile = document.querySelector('#channel-video [data-key$=":s"]');
    tile?.click();
    return Boolean(tile);
  `);
  await sleep(6500);
  activeSource = 'pedro';
  await sleep(500);

  await caption('Mute, deafen and leave are always one click away');
  await click('document.getElementById("voice-mute")', { after: 1100 });
  await click('document.getElementById("voice-mute")', { after: 800 });
  await click('document.getElementById("voice-deafen")', { after: 1100 });
  await click('document.getElementById("voice-deafen")', { after: 800 });
  await caption('Stop sharing whenever you like');
  await click('document.getElementById("voice-screen")', { after: 900 });
  await click("[...document.querySelectorAll('.menu-item')].find((n) => /stop streaming/i.test(n.textContent))", { after: 1400 });
  await click('document.getElementById("voice-leave")', { after: 1800 });
  await caption(null);
  await sleep(600);

  // --- settings ------------------------------------------------------------
  await caption('Settings, organised by area');
  await click('document.getElementById("voice-config")', { after: 1400 });
  await caption('Pick a colour palette. It is yours alone, nothing is sent to the server');
  await click(`[...document.querySelectorAll('.theme-swatch')].find((b) => b.textContent.trim() === 'Ocean')`, { after: 1300 });
  await click(`[...document.querySelectorAll('.theme-swatch')].find((b) => b.textContent.trim() === 'Forest')`, { after: 1300 });
  await click(`[...document.querySelectorAll('.theme-swatch')].find((b) => b.textContent.trim() === 'Ember')`, { after: 1300 });
  await click(`[...document.querySelectorAll('.theme-swatch')].find((b) => b.textContent.trim() === 'Lavender')`, { after: 1500 });

  await caption('Voice and video: devices, input volume and a noise gate with a live meter');
  await click(tab('voice'), { after: 1100 });
  await slide('mic-gain', 140);
  await sleep(500);
  await slide('mic-gain', 100, { steps: 14, ms: 600 });
  await slide('mic-gate', 35);
  await sleep(900);

  await caption('Sounds for joins, leaves and mentions');
  await click(tab('sounds'), { after: 1200 });
  await click('document.getElementById("voice-sounds")', { after: 900 });
  await click('document.getElementById("voice-sounds")', { after: 600 });
  await slide('sound-volume', 60);
  await sleep(500);

  await caption('Global hotkeys for mute and deafen, even while a game has focus');
  await click(tab('hotkeys'), { after: 2300 });
  await caption('And updates, straight from GitHub Releases');
  await click(tab('updates'), { after: 2300 });
  await click('document.getElementById("devices-close")', { after: 1500 });

  // --- closing -------------------------------------------------------------
  await caption(null);
  await evalIn('window.__demo.hidePointer(); return true;');
  await card(cardSpec(
    `Harmony ${VERSION}`,
    'Free and open source. Windows, macOS, Linux and Android.',
    ['github.com/PedroLucasMiguel/harmony'],
  ));
  await sleep(4500);
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('Starting MediaMTX and the control server…');
  await startMediaMtx();
  await startHarmonyServer();
  console.log('Seeding the community…');
  await seed();

  console.log('Opening the window that will be shared…');
  // Without ELECTRON_RUN_AS_NODE: some shells export it, and Electron then
  // runs as plain Node and never opens a window (launchApp does the same).
  const { ELECTRON_RUN_AS_NODE: _ignored, ...cleanEnv } = process.env;
  procs.push(spawn(electronBin, [join(here, 'record-demo-window.cjs'), SHARED_WINDOW,
    `--user-data-dir=${userDataDirSlides}`, '--mute-audio'], { stdio: 'ignore', env: cleanEnv }));

  console.log('Signing Ana in, with her camera on…');
  ana = await joinAsAna();
  await prepareForRecording(ana);

  console.log('Launching the app…');
  const app = launchApp({ port: DEBUG_PORT, userDataDir, extraArgs: APP_FLAGS });
  procs.push(app);
  cdp = await attach(await findPage(DEBUG_PORT));
  await sleep(1500);
  await cdp.evaluate(`${mediaStubs({ initials: 'PE', hue: 255 })}; return true;`);
  await prepareForRecording(cdp);
  // Before anything is recorded, not when the picker opens: the picker draws
  // the instant it is shown, and a filter that arrives after it would let a
  // few frames through with every window on the machine in them.
  await evalIn(PRIVACY);
  // Up before the first frame, so the video opens on the title and not on the
  // sign-in screen the app starts on.
  await card(cardSpec('Harmony', 'Self-hosted voice, video and chat for your own community'), { instant: true });
  await sleep(300);

  // Both windows are recorded and only the one being shown is kept.
  await startCapture(ana, 'ana');
  await startCapture(cdp, 'pedro');
  await sleep(600);

  console.log('Recording the tour…');
  await tour();
  await sleep(300);
  await cdp.send('Page.stopScreencast').catch(() => {});
  await ana.send('Page.stopScreencast').catch(() => {});

  console.log(`Encoding ${frames.length} frames…`);
  encode();
  console.log(`\nWrote ${OUT}`);
  app.kill();
}

main()
  .catch(async (err) => {
    console.error(err);
    // What the app itself was saying when it stopped, which is usually the reason.
    const said = await cdp?.evaluate(`return [...document.querySelectorAll('.error, #channels-error, #audio-note, #broadcast-title')]
      .filter((n) => !n.hidden && n.textContent.trim()).map((n) => n.id + ': ' + n.textContent.trim()).join(' | ');`).catch(() => null);
    if (said) console.error(`[app said] ${said}`);
    const display = await cdp?.evaluate('return JSON.stringify(window.__display ?? null);').catch(() => null);
    if (display) console.error(`[screen capture] ${display}`);
    console.error(serverLog.split('\n').slice(-12).join('\n'));
    if (mtxLog) console.error(`--- mediamtx ---\n${mtxLog.slice(-1500)}`);
    process.exitCode = 1;
  })
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300));
