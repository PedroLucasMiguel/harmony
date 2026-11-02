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
// The video has a sound of its own, made by demo-audio.mjs: a soundtrack, and a
// click wherever the pointer pressed something, a tick for every key typed and a
// chime when a message goes. The app itself is muted while it is recorded, so
// nothing but that is heard.
//
// It also leaves new pictures of the app in media/ (the ones the README shows),
// taken at 1341 x 1045 with no caption over them, unless told not to (--no-shots).
//
//   DEMO_SCENES=stars,dms node scripts/record-demo.mjs /tmp/try.mp4 --no-shots
//
// plays only the scenes named (the sign-in always runs first), which is how a
// scene is worked on without sitting through the whole tour. See SCENES.
//
// Needs ffmpeg on the PATH and a MediaMTX binary (MEDIAMTX_BIN, or
// ~/mediamtx/mediamtx). Takes several minutes to run for ~5 minutes of video.
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
import { GIFEncoder, applyPalette, quantize } from '../src/renderer/gifenc.js';
import { RATE, renderDemoAudio, wavOf } from './demo-audio.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const serverEntry = resolve(repoRoot, 'server', 'src', 'index.js');
const args = process.argv.slice(2);
const OUT = resolve(args.find((a) => !a.startsWith('--')) ?? join(repoRoot, 'media', 'harmony-demo.mp4'));
const MEDIA_DIR = join(repoRoot, 'media');
/** --no-shots: leave the pictures in media/ as they are. */
const TAKE_SHOTS = !args.includes('--no-shots');
/** DEMO_SCENES=a,b: only these scenes, after the sign-in (see SCENES). Empty is all of them. */
const ONLY = (process.env.DEMO_SCENES ?? '').split(',').map((n) => n.trim()).filter(Boolean);
/** DEMO_PEEK=dir: a picture of the window wherever the script calls peek(), for working on a scene. */
const PEEK_DIR = process.env.DEMO_PEEK || null;

const HARMONY_PORT = 18150;
const MTX_API_PORT = 9987;
const MTX_WEBRTC_PORT = 8879;
const MTX_ICE_PORT = 8179;
const DEBUG_PORT = 9431;
const DEBUG_PORT_ANA = 9432;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;
const SIGNALING = `http://127.0.0.1:${MTX_WEBRTC_PORT}`;
const MEDIAMTX_BIN = process.env.MEDIAMTX_BIN ?? join(homedir(), 'mediamtx', 'mediamtx');
const VERSION = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version;
/** The window the demo shares; the share picker shows nothing else. */
const SHARED_WINDOW = `Release ${VERSION} slides`;

/**
 * The window, in device pixels: the video is exactly this, so nothing is
 * scaled. The app runs at its stock 115% inside it, as anybody's would, which
 * makes the page about 1670 x 940 CSS pixels -- a full, comfortable desktop.
 */
const WIDTH = 1920;
const HEIGHT = 1080;
/** The caption band along the top, in CSS pixels. See LAYER. */
const BAND = 96;

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

/** Everybody's token, by nickname, and what the server calls them. */
const people = {};
const userIds = {};

/** A file put on the server, ready to be a picture or an attachment: the hash. */
async function upload(token, bytes, contentType) {
  const res = await fetch(`${BASE}/api/uploads`, {
    method: 'POST', headers: { 'Content-Type': contentType, Authorization: `Bearer ${token}` }, body: bytes,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`upload: ${res.status} ${JSON.stringify(json)}`);
  return json.hash;
}

/*
 * The pictures the community wears: profile pictures, banners and a photo. There is no art to ship and nobody's face to
 * borrow, so a window of the app draws them -- an emoji on a gradient, an aurora, a sunset -- on a canvas, and hands the
 * bytes back. The one animated picture comes back as frames, which gifenc turns into a GIF (see paintGif).
 */
const ART = `(() => {
  const canvas = (w, h) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    return [c, c.getContext('2d', { willReadFrequently: true })];
  };
  const base64 = (c, type = 'image/png', quality = 0.9) => c.toDataURL(type, quality).split(',')[1];
  const emojiFont = (size) => Math.round(size) + 'px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

  const face = (g, size, emoji, hueA, hueB, { bounce = 0, tilt = 0 } = {}) => {
    const fill = g.createLinearGradient(0, 0, size, size);
    fill.addColorStop(0, 'hsl(' + hueA + ' 72% 58%)');
    fill.addColorStop(1, 'hsl(' + hueB + ' 70% 34%)');
    g.fillStyle = fill; g.fillRect(0, 0, size, size);
    g.fillStyle = 'hsla(' + hueA + ' 90% 80% / .22)';
    g.beginPath(); g.arc(size * 0.2, size * 0.15, size * 0.45, 0, 7); g.fill();
    g.save(); g.translate(size / 2, size / 2 + bounce); g.rotate(tilt);
    g.font = emojiFont(size * 0.56); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(emoji, 0, size * 0.04); g.restore();
  };

  const banner = (hueA, hueB, seed) => {
    const [c, g] = canvas(960, 320);
    const sky = g.createLinearGradient(0, 0, 960, 320);
    sky.addColorStop(0, 'hsl(' + hueA + ' 55% 14%)'); sky.addColorStop(1, 'hsl(' + hueB + ' 60% 22%)');
    g.fillStyle = sky; g.fillRect(0, 0, 960, 320);
    for (let i = 0; i < 5; i += 1) {
      g.beginPath();
      g.moveTo(0, 320);
      for (let x = 0; x <= 960; x += 20) {
        g.lineTo(x, 150 + i * 22 + Math.sin(x / 120 + i * 1.3 + seed) * 46 + Math.sin(x / 47 + i + seed) * 12);
      }
      g.lineTo(960, 320); g.closePath();
      g.fillStyle = 'hsla(' + (hueA + i * 24) + ' 85% 62% / .22)'; g.fill();
    }
    for (let i = 0; i < 70; i += 1) {
      g.fillStyle = 'rgba(255,255,255,' + (0.25 + ((i * 37 + seed * 11) % 10) / 16) + ')';
      g.fillRect((i * 97 + seed * 31) % 960, (i * 53 + seed * 17) % 170, 2, 2);
    }
    return base64(c, 'image/jpeg', 0.86);
  };

  const photo = () => {
    const [c, g] = canvas(900, 560);
    const sky = g.createLinearGradient(0, 0, 0, 560);
    sky.addColorStop(0, '#2b2f77'); sky.addColorStop(0.5, '#d4577b'); sky.addColorStop(0.72, '#ffb05a');
    g.fillStyle = sky; g.fillRect(0, 0, 900, 560);
    g.fillStyle = '#fff4cf'; g.beginPath(); g.arc(610, 330, 74, 0, 7); g.fill();
    g.fillStyle = 'rgba(255,244,207,.18)'; g.beginPath(); g.arc(610, 330, 130, 0, 7); g.fill();
    const ridge = (y, amp, color, phase) => {
      g.beginPath(); g.moveTo(0, 560);
      for (let x = 0; x <= 900; x += 10) g.lineTo(x, y - Math.abs(Math.sin(x / 140 + phase)) * amp - Math.sin(x / 41 + phase) * 8);
      g.lineTo(900, 560); g.closePath(); g.fillStyle = color; g.fill();
    };
    ridge(400, 90, '#6d3b6b', 0.4); ridge(450, 70, '#3e2250', 1.7); ridge(510, 40, '#1d1233', 3.1);
    return base64(c, 'image/jpeg', 0.88);
  };

  const badge = () => {
    const [c, g] = canvas(128, 128);
    const fill = g.createRadialGradient(64, 50, 8, 64, 64, 70);
    fill.addColorStop(0, '#ffe083'); fill.addColorStop(1, '#e0912a');
    g.fillStyle = fill; g.beginPath(); g.arc(64, 64, 62, 0, 7); g.fill();
    g.font = emojiFont(74); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('🚀', 64, 70);
    return base64(c);
  };

  const people = {
    pedro: ['🦊', 22, 330], ana: ['🐼', 160, 210], bruno: ['🐙', 285, 200], carla: ['🦉', 40, 8], dave: ['🐢', 120, 170],
  };
  const avatars = {};
  for (const [nick, [emoji, a, b]] of Object.entries(people)) {
    const [c, g] = canvas(192, 192);
    face(g, 192, emoji, a, b);
    avatars[nick] = base64(c);
  }

  // Bruno's picture moves, and so will Pedro's once he picks his in the tour: a head that bobs and sways while the colours turn.
  const moving = (emoji, hueA, hueB) => {
    const frames = [];
    const [gc, gg] = canvas(160, 160);
    for (let f = 0; f < 16; f += 1) {
      const turn = (f / 16) * Math.PI * 2;
      gg.clearRect(0, 0, 160, 160);
      face(gg, 160, emoji, hueA + Math.sin(turn) * 28, hueB + Math.cos(turn) * 30, { bounce: Math.sin(turn) * 9, tilt: Math.sin(turn + 1) * 0.22 });
      const px = gg.getImageData(0, 0, 160, 160).data;
      let text = '';
      for (let i = 0; i < px.length; i += 8192) text += String.fromCharCode(...px.subarray(i, i + 8192));
      frames.push(btoa(text));
    }
    return frames;
  };

  return {
    avatars, frames: { bruno: moving('🐙', 285, 200), pedro: moving('🦊', 22, 330) }, badge: badge(), photo: photo(),
    banners: { pedro: banner(255, 310, 1), carla: banner(15, 345, 4), ana: banner(165, 200, 7) },
  };
})()`;

/** Draw everything the community wears, in a window of the app. */
async function paintArt(page) {
  const art = await page.evaluate(`return ${ART};`);
  art.gifs = {};
  for (const [nick, frames] of Object.entries(art.frames)) {
    const gif = GIFEncoder();
    for (const frame of frames) {
      const rgba = Uint8Array.from(Buffer.from(frame, 'base64'));
      const palette = quantize(rgba, 128);
      gif.writeFrame(applyPalette(rgba, palette), 160, 160, { palette, delay: 70 });
    }
    gif.finish();
    art.gifs[nick] = Buffer.from(gif.bytes());
  }
  return art;
}

/** Register people, say what they say, and make the server look lived in. */
async function seed(art) {
  const register = async (nickname, displayName, extra = {}) => {
    const { token, user } = await api('/api/accounts/register', {
      body: { nickname, password: 'hunter22', ...extra },
    });
    await api('/api/accounts/display-name', { token, body: { displayName } });
    people[nickname] = token;
    userIds[nickname] = user?.id;
    return token;
  };

  await register('pedro', 'Pedro', { ownerKey });
  await register('ana', 'Ana');
  await register('bruno', 'Bruno');
  await register('carla', 'Carla');
  await register('dave', 'Dave');
  const owner = people.pedro;
  for (const user of (await api('/api/accounts', { token: owner })).users) userIds[user.nickname] = user.id;

  // --- how they look -------------------------------------------------------------------------------------------------------
  const wear = async (nick, bytes, type, route) => {
    const hash = await upload(people[nick], bytes, type);
    await api(route, { token: people[nick], body: { hash } });
  };
  for (const nick of ['pedro', 'ana', 'carla', 'dave']) {
    await wear(nick, Buffer.from(art.avatars[nick], 'base64'), 'image/png', '/api/accounts/avatar');
  }
  await wear('bruno', art.gifs.bruno, 'image/gif', '/api/accounts/avatar');
  for (const nick of ['pedro', 'carla', 'ana']) {
    await wear(nick, Buffer.from(art.banners[nick], 'base64'), 'image/jpeg', '/api/accounts/banner');
  }
  await api('/api/accounts/banner-dim', { token: people.pedro, body: { dim: 40 } });
  // Names in their own colour and type.
  await api('/api/accounts/name-color', { token: people.ana, body: { nameColor: { mode: 'gradient', colors: ['#ff7ab8', '#ffb86b'], speed: 6 } } });
  await api('/api/accounts/name-color', { token: people.bruno, body: { nameColor: { mode: 'rainbow', speed: 8 } } });
  await api('/api/accounts/name-font', { token: people.carla, body: { font: 'caveat' } });
  await api('/api/accounts/name-color', { token: people.carla, body: { nameColor: { mode: 'solid', color: '#ffb347' } } });
  await api('/api/accounts/name-color', { token: people.dave, body: { nameColor: { mode: 'solid', color: '#6fd6a5' } } });

  // Roles, with a colour each, and a badge.
  const dev = (await api('/api/roles', { token: owner, body: { name: 'Dev', color: '#5b8cff', permissions: ['messages.pin', 'channels.edit'] } })).role;
  const design = (await api('/api/roles', { token: owner, body: { name: 'Design', color: '#ff7ab8' } })).role;
  await api(`/api/accounts/${userIds.bruno}/roles`, { token: owner, body: { roles: [dev.id] } });
  await api(`/api/accounts/${userIds.ana}/roles`, { token: owner, body: { roles: [design.id] } });
  await api(`/api/accounts/${userIds.carla}/roles`, { token: owner, body: { roles: [design.id] } });
  const badge = (await api('/api/badges', {
    token: owner,
    body: { name: 'Early supporter', description: 'Here before the first release', imageHash: await upload(owner, Buffer.from(art.badge, 'base64'), 'image/png') },
  })).badge;
  for (const nick of ['carla', 'bruno']) await api(`/api/accounts/${userIds[nick]}/badges`, { token: owner, body: { badges: [badge.id] } });

  // --- the rooms -------------------------------------------------------------------------------------------------------------
  const channels = (await api('/api/channels', { token: owner })).channels;
  const general = channels.find((c) => c.kind === 'text');
  const voice = channels.find((c) => c.kind === 'voice');
  await api(`/api/channels/${voice.id}`, { token: owner, body: { name: 'Lobby' } }).catch(() => {});
  const dev2 = (await api('/api/channels', { token: owner, body: { kind: 'text', name: 'dev' } })).channel;
  const random = (await api('/api/channels', { token: owner, body: { kind: 'text', name: 'random' } })).channel;
  const gameNight = (await api('/api/channels', { token: owner, body: { kind: 'voice', name: 'Game night' } })).channel;
  await api('/api/channels', { token: owner, body: { kind: 'voice', name: 'Focus' } });

  const say = async (nickname, channel, body, extra = {}) => (await api(`/api/channels/${channel.id}/messages`, {
    token: people[nickname], body: { body, ...extra },
  })).message;
  const react = (nickname, message, emoji) =>
    api(`/api/messages/${message.id}/react`, { token: people[nickname], body: { emoji } });
  const attach = async (nickname, channel, body, bytes, type, name) => say(nickname, channel, body, {
    attachmentHash: await upload(people[nickname], bytes, type), attachmentName: name,
  });

  await say('ana', general, 'morning everyone');
  await say('carla', general, 'morning! coffee first, questions later');
  const release = await say('bruno', general, `${VERSION} is out. Profile pictures can move now, and there is a window to crop, zoom and turn them`);
  const looks = await say('carla', general, 'finally, look at my banner 😄');
  await react('ana', looks, '🎉');
  await react('bruno', looks, '🎉');
  await react('dave', looks, '👍');
  await react('carla', release, '🔥');
  await react('ana', release, '🔥');
  await say('ana', general, 'and every slider moves with the mouse wheel now, volumes too', { replyTo: release.id });
  await say('bruno', general, 'can somebody pin the release notes?');
  const notes = await say('pedro', general, 'Release notes: animated profile pictures, a crop window for pictures and banners, stars, search that runs as you type, and a phone layout that fits');
  await api(`/api/messages/${notes.id}/pin`, { token: owner, body: { pinned: true } });
  await say('dave', general, 'tested it on the Steam Deck, works great');
  await say('bruno', general, 'the deploy checklist:\n1. tag the release\n2. wait for CI\n3. **celebrate** with `make coffee`');
  const view = await attach('dave', general, 'the view from the trip last weekend', Buffer.from(art.photo, 'base64'), 'image/jpeg', 'sunset.jpg');
  await api(`/api/messages/${view.id}/pin`, { token: owner, body: { pinned: true } });
  await attach('bruno', general, 'logs from last night\'s test', Buffer.from('PK\u0003\u0004harmony demo'), 'application/zip', 'test-logs.zip');

  await say('bruno', dev2, 'CI is green on all three platforms');
  await say('ana', dev2, 'the macOS helper builds as a universal binary, nice');
  await say('carla', random, 'friday movie night anyone?');

  // Bruno and Carla are online; Carla is already in a voice room. Ana is a
  // real client, signed in by the script (see signInAna), and Dave is away.
  const live = {};
  for (const nick of ['bruno', 'carla']) live[nick] = await connectPresence(people[nick]);
  live.carla.send(JSON.stringify({ type: 'voice:join', channelId: gameNight.id, rid: 'join' }));

  return { general, dev: dev2, random, gameNight };
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

/** What is to be heard, and when (seconds since the epoch, as the frames are stamped): see demo-audio.mjs for the kinds. */
const sounds = [];
const hear = (kind) => sounds.push({ at: Date.now() / 1000, kind });

/**
 * Frames arrive when the picture changes, not at a rate, so each one is shown
 * for as long as it lasted: a list of (file, duration) that ffmpeg turns into
 * a constant 30 fps. The sound is laid over it afterwards, from the same clock.
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
  const length = frames.at(-1).at - frames[0].at + 1;

  // The video is whatever size each frame is -- a phone's is tall and narrow -- put on the one screen, centred, on the
  // colour of the title card so a phone has a dark stage and not black bars.
  const silent = join(framesDir, 'silent.mp4');
  mkdirSync(dirname(OUT), { recursive: true });
  let run = spawnSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', list,
    '-vf', 'fps=30,scale=1920:1080:flags=lanczos:force_original_aspect_ratio=decrease,'
      + 'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0b0d12,format=yuv420p',
    '-c:v', 'libx264', '-crf', '23', '-preset', 'slow', '-movflags', '+faststart',
    silent,
  ], { stdio: 'inherit' });
  if (run.status !== 0) throw new Error('ffmpeg failed');

  // The sound: the music, and the clicks where they happened.
  const t0 = frames[0].at;
  const events = sounds.map((e) => ({ at: e.at - t0, kind: e.kind })).filter((e) => e.at >= 0 && e.at < length);
  console.log(`Mixing ${events.length} sounds under ${length.toFixed(0)} s of music…`);
  const wav = join(framesDir, 'sound.wav');
  writeFileSync(wav, wavOf(renderDemoAudio(events, length)));
  run = spawnSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', silent, '-i', wav,
    // Evened out to a level a video is usually heard at, then into AAC.
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=9',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', String(RATE), '-movflags', '+faststart', '-shortest',
    OUT,
  ], { stdio: 'inherit' });
  if (run.status !== 0) throw new Error('ffmpeg could not add the sound');
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
      target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
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
    /**
     * The caption band for a phone's narrow screen, or the desktop's again. A phone is recorded at the size of one -- the
     * app has a layout of its own there -- and the band shrinks with it, still above the app and not over it.
     */
    phone(on) {
      const height = on ? 84 : BAND;
      band.style.height = height + 'px';
      band.style.padding = on ? '0 16px' : '0 48px';
      text.style.fontSize = on ? '21px' : '38px';
      text.style.lineHeight = on ? '1.25' : '1.2';
      document.documentElement.style.setProperty('--safe-area-inset-top', height + 'px');
    },
    /** The window with nothing of the recording on it (for a picture of the app), or dressed again. */
    dress(on, height = BAND) {
      layer.style.visibility = on ? 'visible' : 'hidden';
      document.documentElement.style.setProperty('--safe-area-inset-top', on ? height + 'px' : '0px');
    },
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

/** A picture of the window as it is, for working on a scene (DEMO_PEEK=dir). */
let peeked = 0;
async function peek(name, page = cdp) {
  if (!PEEK_DIR) return;
  mkdirSync(PEEK_DIR, { recursive: true });
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(PEEK_DIR, `${String((peeked += 1)).padStart(2, '0')}-${name}.png`), Buffer.from(data, 'base64'));
}

/** The size of the pictures the README shows. */
const SHOT_WIDTH = 1341;
const SHOT_HEIGHT = 1045;

/**
 * A picture of the app for media/, with nothing of the recording over it, at the size the others are. Taken when nothing
 * is being recorded: the window is resized for it, and put back.
 */
async function mediaShot(name, page = cdp, { phone = false } = {}) {
  if (!TAKE_SHOTS) return;
  // The search box is left with its list of filters open whenever it has been used; nobody is typing in it in a picture.
  await page.evaluate(`window.__demo.hidePointer(); window.__demo.say(null); window.__demo.dress(false);
    document.getElementById('chat-search')?.blur(); const pop = document.getElementById('search-pop'); if (pop) pop.hidden = true; return true;`);
  if (phone) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 860, deviceScaleFactor: 2, mobile: true });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  } else {
    await page.setViewport(SHOT_WIDTH, SHOT_HEIGHT);
  }
  await sleep(1400);
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  mkdirSync(MEDIA_DIR, { recursive: true });
  writeFileSync(join(MEDIA_DIR, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`  picture: media/${name}.png`);
  if (phone) await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await page.setViewport(WIDTH, HEIGHT);
  await page.evaluate('window.__demo.dress(true); return true;');
  await sleep(900);
}

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
  // The pointer drawn is only a picture; the page's own idea of where the mouse is moves there too, so what shows
  // under a real pointer -- the tools on a message, a tile's controls, a tooltip -- shows.
  const spot = await evalIn(`return window.__demo.centre(${finder(expr)});`);
  if (spot) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x + dx, y: spot.y + dy });
}

/** Point at it, press it (ring and all), and give the result a moment. */
async function click(expr, { after = 500, dx = 0, dy = 0, how = 'click', sound = 'click' } = {}) {
  await pointAt(expr, { dx, dy, settle: 100 });
  const spot = await evalIn(`return window.__demo.centre(${finder(expr)});`);
  await evalIn(`window.__demo.ring(${spot.x + dx}, ${spot.y + dy}); return true;`);
  hear(sound);
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
    if (char !== ' ') hear('key');
    await sleep(speed + Math.random() * 35);
  }
}

const pressEnter = async ({ sound = 'send' } = {}) => {
  if (sound) hear(sound);
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r', unmodifiedText: '\r' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
};

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

/** A second, real client: Ana's window, with stand-in devices, still at the connect screen. */
async function launchAna() {
  const app = launchApp({ port: DEBUG_PORT_ANA, userDataDir: userDataDirAna, extraArgs: APP_FLAGS });
  procs.push(app);
  const ana = await attach(await findPage(DEBUG_PORT_ANA));
  await sleep(1500);
  await ana.evaluate(`${mediaStubs({ initials: 'AN', hue: 160 })}; return true;`);
  return ana;
}

/**
 * Signs Ana in, has her join the voice room and turn her camera on, so the person
 * being recorded walks into a room that is already in use -- and receives real
 * media from somebody else.
 */
async function joinAsAna(ana) {
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
// More ways of driving the app
// ---------------------------------------------------------------------------

/** Turn a wheel over something, a notch at a time, as a hand does. */
async function wheel(expr, deltaY, { times = 1, gap = 130 } = {}) {
  await pointAt(expr, { settle: 80 });
  const spot = await evalIn(`return window.__demo.centre(${finder(expr)});`);
  for (let i = 0; i < times; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: spot.x, y: spot.y, deltaX: 0, deltaY });
    hear('key');
    await sleep(gap);
  }
}

/** Drag from the middle of something by (dx, dy), the picture's pointer going along with the real one. */
async function drag(expr, dx, dy, { ms = 800, steps = 16 } = {}) {
  await pointAt(expr, { settle: 80 });
  const spot = await evalIn(`return window.__demo.centre(${finder(expr)});`);
  const mouse = (type, x, y) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  await mouse('mousePressed', spot.x, spot.y);
  for (let i = 1; i <= steps; i += 1) {
    const x = spot.x + (dx * i) / steps;
    const y = spot.y + (dy * i) / steps;
    await evalIn(`window.__demo.move(() => ({ getBoundingClientRect: () => ({ left: ${x}, top: ${y}, width: 0, height: 0 }) }), 0, 0); return true;`);
    await mouse('mouseMoved', x, y);
    await sleep(ms / steps);
  }
  await mouse('mouseReleased', spot.x + dx, spot.y + dy);
  await sleep(300);
}

/** Files into the message box, the way a paste or a picker puts them: [{ name, type, base64 }]. */
const putFiles = (how, files) => evalIn(`
  const files = new DataTransfer();
  for (const f of ${JSON.stringify(files)}) {
    const data = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
    files.items.add(new File([data], f.name, { type: f.type }));
  }
  if (${JSON.stringify(how)} === 'paste') {
    document.getElementById('chat-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: files, bubbles: true, cancelable: true }));
  } else {
    const input = document.getElementById(${JSON.stringify(how)});
    input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return true;
`);

/** A range input by selector: the fill and the number are seen moving. */
async function slideTo(selector, to, { steps = 24, ms = 900 } = {}) {
  const find = `document.querySelector(${JSON.stringify(selector)})`;
  await pointAt(find, { settle: 100 });
  const from = Number(await evalIn(`return ${find}.value;`));
  for (let i = 1; i <= steps; i += 1) {
    const value = Math.round(from + ((to - from) * i) / steps);
    await evalIn(`const input = ${find}; input.value = ${value}; input.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
    await sleep(ms / steps);
  }
  await evalIn(`${find}.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
}

/** Put the window's mouse on a slider's number, press it, and type an exact value. */
async function typeExact(labelExpr, value) {
  await pointAt(labelExpr, { settle: 150 });
  await click(labelExpr, { after: 500 });
  await waitFor(cdp, "Boolean(document.querySelector('.volume-exact'))", { label: 'the box for an exact volume' });
  for (const char of String(value)) {
    await cdp.send('Input.insertText', { text: char });
    hear('key');
    await sleep(160);
  }
  await sleep(500);
  await pressEnter({ sound: 'send' });
  await sleep(900);
}

const raise = () => evalIn('window.__demo.raise(); return true;');
const memberRow = (name) =>
  `[...document.querySelectorAll('#member-items .member-row')].find((r) => r.querySelector('.member-name')?.textContent.trim() === ${JSON.stringify(name)})`;
const rail = (which) => (which === 'home' ? 'document.querySelector("#server-rail .rail-home")' : 'document.querySelector("#server-rail .rail-item:not(.rail-home):not(.rail-add)")');

/** Back to the usual place between scenes: the channels view, #general, nothing open. */
async function backToGeneral() {
  await evalIn(`
    for (const id of ['stars-pop', 'pins-pop']) { const pop = document.getElementById(id); if (pop && !pop.hidden) pop.hidden = true; }
    document.getElementById('chat-search-clear')?.click();
    return true;
  `);
  if (await evalIn("return document.querySelector('.view[data-active]')?.id !== 'view-channels'")) {
    await click(rail('server'), { after: 800 });
  }
  const here = await evalIn("return document.getElementById('chat-name')?.textContent");
  if (here !== '#general') await click(channelRow('general'), { after: 1200 });
}

// ---------------------------------------------------------------------------
// The tour, as scenes
// ---------------------------------------------------------------------------

/** [name, what it plays]. The first two always run; the rest can be picked with DEMO_SCENES. */
const SCENES = [];
const scene = (name, play) => SCENES.push({ name, play });

scene('title', async () => {
  // Already showing: main() puts it up before the first frame is captured, so
  // the video opens on it rather than on whatever the app was doing underneath.
  await sleep(3800);
  await card(null);
  await sleep(900);
});

scene('signin', async () => {
  await caption('Point the app at your own server, and sign in');
  await type('document.getElementById("server-url")', BASE.replace('http://', ''), { speed: 70 });
  await sleep(900);
  await click('document.getElementById("server-continue")', { after: 600 });
  await waitFor(cdp, "!document.getElementById('step-account').hidden", { label: 'the account step' });
  await sleep(700);
  await type('document.getElementById("username")', 'pedro');
  await type('document.getElementById("account-password")', 'hunter22');
  await sleep(300);
  await click('document.querySelector("details.options summary")', { after: 1500 });
  await caption('Everything optional lives under Options');
  await sleep(1400);
  await click('document.querySelector("details.options summary")', { after: 500 });
  await click('document.getElementById("continue")', { after: 400 });
  await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'the channels view' });
  await sleep(1800);
});

scene('layout', async () => {
  // The chat, not the empty pane a server opens on.
  await click(channelRow('general'), { after: 900 });
  await caption('A rail of servers, with your private messages first');
  await pointAt(rail('home'));
  await sleep(700);
  await pointAt(rail('server'));
  await sleep(900);
  await caption('Text channels, voice rooms and your people, side by side');
  await pointAt(channelRow('Game night'));
  await sleep(1200);
  await caption('Voice rooms show who is in them before you join');
  await pointAt(`document.querySelector('#member-items .member-row')`);
  await sleep(900);
  await caption('Everyone on the server, in the colour of their role, with their picture and banner');
  await sleep(2200);

  await caption('Look somebody up in the member list');
  await type('document.getElementById("member-search")', 'ca', { speed: 140 });
  await sleep(1600);
  await click('document.getElementById("member-search-clear")', { after: 900 });

  await caption('Click anybody for their card: their picture, banner, roles and badges');
  await click(memberRow('Carla'), { after: 2800 });
  await peek('profile-card');
  await evalIn("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;");
  await sleep(700);
});

scene('chat', async () => {
  await click(channelRow('general'), { after: 1500 });
  await caption('Chat with replies, reactions and pinned messages');
  await sleep(1800);
  await pointAt(`document.querySelector('.pinned-strip .pinned-line, #chat-pinned .pinned-line')`);
  await sleep(900);
  await caption('A pinned file or picture shows what it is, not only its name');
  await click(`document.querySelector('.pinned-strip .pinned-line, #chat-pinned .pinned-line')`, { after: 1600 });

  const target = messageContaining(`${VERSION} is out`);
  await pointAt(target, { dx: 120 });
  await caption('Reply to a message, with the original quoted above');
  await click(`${target}.querySelector('.msg-tool[title*="eply"], .msg-tool:first-child')`, { after: 700 });
  await type('document.getElementById("chat-input")', '@ana the new crop window is great, thank you!', { speed: 48 });
  await sleep(500);
  await pressEnter();
  await sleep(1800);

  await caption('Reactions are one click');
  await click(`document.querySelector('#chat-log .reaction')`, { after: 1500 });

  await caption('Markdown, emoji and mentions, as you type');
  await type('document.getElementById("chat-input")', 'Shipping **today**: `make release` and then 🎉', { speed: 55 });
  await sleep(500);
  await pressEnter();
  await sleep(1800);

  await caption('Paste a picture or drop files: each is shown before it goes');
  const photo = { name: 'banner-idea.jpg', type: 'image/jpeg', base64: ART_DATA.banners.ana };
  const notes = { name: 'notes.zip', type: 'application/zip', base64: Buffer.from('PK\u0003\u0004harmony demo').toString('base64') };
  await pointAt('document.getElementById("chat-input")');
  await putFiles('paste', [photo, notes]);
  await sleep(2200);
  await peek('pending-files');
  await caption('Several files go one after the other, and your words go with the last');
  await type('document.getElementById("chat-input")', 'the picture and the notes', { speed: 50 });
  await sleep(500);
  await pressEnter();
  await sleep(2800);
});

scene('stars', async () => {
  await backToGeneral();
  await caption('Star a message to keep a private copy: only you can see them');
  const first = messageContaining('deploy checklist');
  await pointAt(first, { dx: 160 });
  await sleep(500);
  await peek('star-hover');
  await click(`${first}.querySelector('.star-tool')`, { after: 900, sound: 'toggle' });
  const second = messageContaining('Release notes:');
  await pointAt(second, { dx: 160 });
  await click(`${second}.querySelector('.star-tool')`, { after: 900, sound: 'toggle' });
  await caption('The star in the header lists them, and a box searches them');
  await click('document.getElementById("chat-stars")', { after: 1400 });
  await type('document.getElementById("stars-search")', 'release', { speed: 90 });
  await sleep(1500);
  await peek('stars-panel');
  await caption('Click a starred message to jump straight to it');
  await click(`[...document.querySelectorAll('#stars-pop .pin-card')][0].querySelector('.pin-body')`, { after: 2200 });
});

scene('search', async () => {
  await backToGeneral();
  await caption('Search the whole server: words, people, files and links');
  await click('document.getElementById("chat-search")', { after: 1300 });
  await peek('search-filters');
  await caption('Filters narrow it down, and the results appear as you type');
  await type('document.getElementById("chat-search")', 'release', { speed: 80 });
  await sleep(2000);
  await type('document.getElementById("chat-search")', ' from:bruno ', { speed: 80 });
  await sleep(2200);
  await peek('search-results');
  await caption('Every result goes to its message, in its channel');
  await click(`document.querySelector('#search-results .search-card, #search-results .pin-card')`, { after: 2200 });
  await click('document.getElementById("chat-search-clear")', { after: 900 });
});

scene('dms', async () => {
  await backToGeneral();
  await caption('Private messages are end-to-end encrypted: the server only ever holds ciphertext');
  await click(rail('home'), { after: 1600 });
  await peek('dm-list');
  // The first thing a conversation asks for is a recovery key: the only way to read the history on another computer.
  await click(`[...document.querySelectorAll('#dm-panel-actions button')].find((b) => /recovery key/i.test(b.textContent))`, { after: 900 });
  await waitFor(cdp, "Boolean(document.querySelector('dialog.dm-keys')?.open)", { label: 'the recovery key' });
  await raise();
  await caption('A recovery key brings your history to another computer');
  await sleep(3600);
  await peek('dm-key');
  await click(`[...document.querySelectorAll('dialog.dm-keys button')].find((b) => /saved/i.test(b.textContent))`, { after: 1000 });
  await click(rail('server'), { after: 1000 });

  await caption('Right-click somebody to write to them');
  await click(memberRow('Ana'), { how: 'contextmenu', after: 1100 });
  await peek('member-menu');
  await click(`[...document.querySelectorAll('#member-menu-body button')].find((b) => /private message/i.test(b.textContent))`, { after: 1600 });
  await waitFor(cdp, "!document.getElementById('dm-active').hidden", { label: 'the conversation' });
  await type('document.getElementById("dm-input")', 'hey Ana, did you see the new stars? 👋', { speed: 52 });
  await sleep(400);
  await click('document.getElementById("dm-send")', { after: 1200, sound: 'send' });
  await waitFor(cdp, "document.getElementById('dm-log').textContent.includes('new stars')", { label: 'the message sent' });

  // Ana answers from her own window, with her own recovery key.
  await ana.evaluate(`
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#server-rail .rail-home').click();
    await wait(1200);
    [...document.querySelectorAll('#dm-panel-actions button')].find((b) => /recovery key/i.test(b.textContent))?.click();
    await wait(900);
    [...document.querySelectorAll('dialog.dm-keys button')].find((b) => /saved/i.test(b.textContent))?.click();
    await wait(900);
    document.querySelector('#dm-list .dm-row')?.click();
    await wait(1200);
    const input = document.getElementById('dm-input');
    input.value = 'yes! and the search is so much faster 🚀';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('dm-send').click();
    return true;
  `);
  await waitFor(cdp, "document.getElementById('dm-log').textContent.includes('so much faster')", { label: "Ana's answer", timeoutMs: 20_000 });
  hear('send');
  await sleep(1400);
  await peek('dm');
  await caption('Stars, pins and search work here too');
  const reply = `[...document.querySelectorAll('#dm-log .chat-msg')].find((m) => m.textContent.includes('so much faster'))`;
  await pointAt(reply, { dx: 140 });
  await click(`${reply}.querySelector('.star-tool')`, { after: 1000, sound: 'toggle' });
  await sleep(1600);
  await click(rail('server'), { after: 1000 });
});

scene('voice', async () => {
  await backToGeneral();
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

  await caption('Right-click anybody: volumes move with the wheel, and take a typed number');
  await click(`[...document.querySelectorAll('#channel-items .channel-member')].find((r) => /carla/i.test(r.textContent))`, { how: 'contextmenu', after: 900 });
  await waitFor(cdp, "!document.getElementById('peer-menu').hidden && document.querySelector('#peer-menu .peer-volume')", { label: "somebody's volume menu" });
  await wheel('document.querySelector("#peer-menu .peer-volume")', 100, { times: 5 });
  await sleep(400);
  await wheel('document.querySelector("#peer-menu .peer-volume")', -100, { times: 9 });
  await sleep(500);
  await peek('peer-volume');
  await typeExact('document.querySelector("#peer-menu .peer-volume-label")', 200);
  await sleep(1400);
  await evalIn(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.getElementById('peer-menu').hidden = true; return true;`);
  await sleep(600);

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
  await raise();
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
  await click('document.getElementById("voice-mute")', { after: 1100, sound: 'toggle' });
  await click('document.getElementById("voice-mute")', { after: 800, sound: 'toggle' });
  await click('document.getElementById("voice-deafen")', { after: 1100, sound: 'toggle' });
  await click('document.getElementById("voice-deafen")', { after: 800, sound: 'toggle' });
  await caption('Stop sharing whenever you like');
  await click('document.getElementById("voice-screen")', { after: 900 });
  await click("[...document.querySelectorAll('.menu-item')].find((n) => /stop streaming/i.test(n.textContent))", { after: 1400 });
  await click('document.getElementById("voice-leave")', { after: 1800 });
  await caption(null);
  await sleep(600);
});

scene('profile', async () => {
  await backToGeneral();
  await caption('Your profile: a picture, a banner and a style for your name');
  await click('document.getElementById("voice-config")', { after: 1400 });
  await click(tab('profile'), { after: 1400 });
  await peek('profile-tab');

  await caption('Pick a picture, and a GIF keeps moving');
  await pointAt('document.getElementById("profile-choose")');
  await evalIn(`
    const data = Uint8Array.from(atob(${JSON.stringify(ART_DATA.gifs.pedro.toString('base64'))}), (c) => c.charCodeAt(0));
    const files = new DataTransfer(); files.items.add(new File([data], 'fox.gif', { type: 'image/gif' }));
    const input = document.getElementById('avatar-file'); input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  await waitFor(cdp, "document.querySelector('dialog.image-editor')?.open === true", { label: 'the image editor' });
  await raise();
  await sleep(1400);
  await caption('Crop, zoom and turn it under the mask before it is saved');
  await peek('editor');
  const stage = 'document.querySelector("dialog.image-editor .ie-stage")';
  await wheel(stage, -100, { times: 6, gap: 150 });
  await sleep(500);
  await drag(stage, -34, 22);
  await sleep(500);
  await slideTo('dialog.image-editor .ie-rotate', 18, { steps: 18, ms: 900 });
  await sleep(600);
  await slideTo('dialog.image-editor .ie-zoom', 30, { steps: 14, ms: 700 });
  await sleep(900);
  await click('document.querySelector("dialog.image-editor .ie-save")', { after: 400 });
  await waitFor(cdp, "!document.querySelector('dialog.image-editor')", { label: 'the editor closing', timeoutMs: 30_000 });
  await sleep(2400);

  await caption('A banner gets the same treatment, with the strip the member list shows marked');
  await pointAt('document.getElementById("profile-banner-choose")');
  await evalIn(`
    const data = Uint8Array.from(atob(${JSON.stringify(ART_DATA.banners.carla)}), (c) => c.charCodeAt(0));
    const files = new DataTransfer(); files.items.add(new File([data], 'banner.jpg', { type: 'image/jpeg' }));
    const input = document.getElementById('profile-banner-file'); input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  await waitFor(cdp, "document.querySelector('dialog.image-editor')?.open === true", { label: 'the banner editor' });
  await raise();
  await sleep(1400);
  await drag('document.querySelector("dialog.image-editor .ie-stage")', 30, -12);
  await sleep(500);
  await click('document.querySelector("dialog.image-editor .ie-save")', { after: 400 });
  await waitFor(cdp, "!document.querySelector('dialog.image-editor')", { label: 'the banner editor closing', timeoutMs: 30_000 });
  await sleep(2200);

  await caption('A font and a colour for your name, one only you choose');
  await click(`[...document.querySelectorAll('#profile-font-grid > *')][0]`, { after: 1200 });
  await click(`[...document.querySelectorAll('#profile-font-grid > *')][2]`, { after: 1200 });
  await click(`[...document.querySelectorAll('#profile-font-grid > *')][5]`, { after: 1400 });
  // And back to the plain one, which is how the rest of the tour (and its pictures) shows the name.
  await click(`[...document.querySelectorAll('#profile-font-grid > *')][0]`, { after: 1200 });
  await peek('profile-name');
  await click('document.getElementById("devices-close")', { after: 1500 });
  await caption(null);
});

scene('settings', async () => {
  await caption('Settings, organised by area');
  await click('document.getElementById("voice-config")', { after: 1400 });
  await click(tab('appearance'), { after: 900 });
  await caption('Pick a colour palette. It is yours alone, nothing is sent to the server');
  await click(`[...document.querySelectorAll('.theme-swatch')].find((b) => b.textContent.trim() === 'Ocean')`, { after: 1300 });
  await click(`[...document.querySelectorAll('.theme-swatch')].find((b) => b.textContent.trim() === 'Forest')`, { after: 1300 });
  await click(`[...document.querySelectorAll('.theme-swatch')].find((b) => b.textContent.trim() === 'Ember')`, { after: 1300 });
  await click(`[...document.querySelectorAll('.theme-swatch')].find((b) => b.textContent.trim() === 'Lavender')`, { after: 1500 });
  // Back to the usual one, so the rest of the tour (and its pictures) is in the colours of the app as it ships.
  await click(`document.querySelector('.theme-swatch')`, { after: 900 });

  await caption('Voice and video: devices, a noise gate with a live meter, and volumes you can type');
  await click(tab('voice'), { after: 1100 });
  await wheel('document.getElementById("mic-gain")', -100, { times: 8 });
  await sleep(500);
  await typeExact(`document.getElementById("mic-gain").closest('label, .row, div').querySelector('.value-pill, .volume-value')`, 120);
  await slideTo('#mic-gate', 35);
  await sleep(900);

  await caption('Sounds for joins, leaves and mentions, and a master volume');
  await click(tab('sounds'), { after: 1200 });
  await click('document.getElementById("voice-sounds")', { after: 900, sound: 'toggle' });
  await click('document.getElementById("voice-sounds")', { after: 600, sound: 'toggle' });
  await slideTo('#sound-volume', 60);
  await sleep(500);

  await caption('Global hotkeys for mute and deafen, even while a game has focus');
  await click(tab('hotkeys'), { after: 2300 });
  await caption('And updates, straight from GitHub Releases');
  await click(tab('updates'), { after: 2300 });
  await click('document.getElementById("devices-close")', { after: 1500 });
});

scene('admin', async () => {
  await backToGeneral();
  await caption('Roles with a colour and exact permissions, for you to define');
  await click('document.getElementById("server-settings")', { after: 1500 });
  await raise();
  await click(`document.querySelector('.settings-tab[data-tab="roles"]')`, { after: 1400 });
  await click(`document.querySelector('#roles-list li')`, { after: 2600 });
  await peek('roles');
  await caption('Badges you design and hand out, and a say in who can do what');
  await click(`document.querySelector('.settings-tab[data-tab="badges"]')`, { after: 2000 });
  await click(`document.querySelector('.settings-tab[data-tab="members"]')`, { after: 2000 });
  await click('document.getElementById("server-cancel")', { after: 1200 });
});

scene('phone', async () => {
  await backToGeneral();
  await caption(null);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 930, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await evalIn('window.__demo.phone(true); return true;');
  await sleep(1800);
  await caption('On a phone: a strip of servers, the chat full width, and drawers for the rest');
  await sleep(2200);
  await peek('phone-chat');
  await click('document.getElementById("channels-menu")', { after: 1400 });
  await caption('The channel list slides in');
  await sleep(1400);
  await peek('phone-drawer');
  await click(channelRow('dev'), { after: 1400 });
  await caption('Write, and the chat follows the message down');
  await type('document.getElementById("chat-input")', 'on my phone, on the bus 🚌', { speed: 60 });
  await sleep(400);
  await pressEnter();
  await sleep(1800);
  await caption('Search takes the whole screen, and stars are one tap away');
  await click('document.getElementById("chat-search")', { after: 1000 });
  await type('document.getElementById("chat-search")', 'universal', { speed: 90 });
  await pressEnter({ sound: 'click' });
  await sleep(2400);
  await peek('phone-search');
  await click('document.getElementById("chat-search-clear")', { after: 900 });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await evalIn('window.__demo.phone(false); return true;');
  await cdp.setViewport(WIDTH, HEIGHT);
  await sleep(1200);
  await click(channelRow('general'), { after: 800 });
});

scene('closing', async () => {
  await caption(null);
  await evalIn('window.__demo.hidePointer(); return true;');
  await card(cardSpec(
    `Harmony ${VERSION}`,
    'Free and open source. Windows, macOS, Linux and Android.',
    ['github.com/PedroLucasMiguel/harmony'],
  ));
  await sleep(4500);
});

/** Which scenes play: the first two always, the closing card only when everything does. */
const planned = () => SCENES.filter((s) => ['title', 'signin'].includes(s.name)
  || (ONLY.length === 0 ? true : ONLY.includes(s.name)));

async function tour() {
  for (const { name, play } of planned()) {
    console.log(`  scene: ${name}`);
    try {
      await play();
    } catch (err) {
      await peek(`failed-${name}`).catch(() => {});
      err.message = `in the ${name} scene: ${err.message}`;
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Pictures of the app, for media/ and the README
// ---------------------------------------------------------------------------

async function pictures() {
  if (!TAKE_SHOTS) return;
  console.log('Taking the pictures for media/…');
  await evalIn('window.__demo.card(null); return true;');
  await backToGeneral();
  // Back in the room, as the picture of a server in use should be.
  await click(channelRow('Game night'), { after: 400 });
  await waitFor(cdp, "!document.getElementById('voice-active').hidden && document.querySelectorAll('#voice-roster li').length >= 2", {
    label: 'joining the room for the picture', timeoutMs: 40_000,
  });
  await click(channelRow('general'), { after: 1500 });
  await mediaShot('server_view');

  await click('document.getElementById("voice-screen")', { after: 300 });
  await waitFor(cdp, "document.getElementById('picker').open", { label: 'the share picker' });
  await click('document.querySelector(\'#picker .tab[data-kind="window"]\')', { after: 1600 });
  await waitFor(cdp, "[...document.querySelectorAll('#source-grid .source')].some((b) => b.style.display !== 'none')", {
    label: 'the shared window in the picker', timeoutMs: 20_000,
  });
  await click("[...document.querySelectorAll('#source-grid .source')].find((b) => b.style.display !== 'none')", { after: 1200 });
  await mediaShot('streamer_view');
  await click('document.getElementById("picker-back")', { after: 800 });
  await click('document.getElementById("voice-leave")', { after: 1200 });

  // Stars: two messages starred, and the list open.
  await backToGeneral();
  for (const text of ['deploy checklist', 'Release notes:']) {
    await evalIn(`const row = ${messageContaining(text)}; if (row && !row.hasAttribute('data-starred')) row.querySelector('.star-tool')?.click(); return true;`);
  }
  await click('document.getElementById("chat-stars")', { after: 1200 });
  await mediaShot('stars_view');
  await click('document.getElementById("chat-stars")', { after: 500 });

  // A private conversation, if the tour had one.
  await click(rail('home'), { after: 1500 });
  if (await evalIn("return Boolean(document.querySelector('#dm-list .dm-row'))")) {
    await click("document.querySelector('#dm-list .dm-row')", { after: 1500 });
    await mediaShot('dm_view');
  }
  await click(rail('server'), { after: 1000 });

  // The phone's layout, in a channel with a conversation in it.
  await click(channelRow('general'), { after: 1500 });
  await mediaShot('phone_view', cdp, { phone: true });
}

// ---------------------------------------------------------------------------

let ART_DATA = null;

async function main() {
  console.log('Starting MediaMTX and the control server…');
  await startMediaMtx();
  await startHarmonyServer();

  console.log('Opening the window that will be shared…');
  // Without ELECTRON_RUN_AS_NODE: some shells export it, and Electron then
  // runs as plain Node and never opens a window (launchApp does the same).
  const { ELECTRON_RUN_AS_NODE: _ignored, ...cleanEnv } = process.env;
  procs.push(spawn(electronBin, [join(here, 'record-demo-window.cjs'), SHARED_WINDOW, VERSION,
    `--user-data-dir=${userDataDirSlides}`, '--mute-audio'], { stdio: 'ignore', env: cleanEnv }));

  console.log('Opening Ana\'s window, and drawing the pictures the community wears…');
  ana = await launchAna();
  ART_DATA = await paintArt(ana);
  console.log('Seeding the community…');
  await seed(ART_DATA);

  console.log('Signing Ana in, with her camera on…');
  await joinAsAna(ana);
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

  // The connect screen, as the README shows it, before the title goes up over it.
  await sleep(600);
  await mediaShot('home_screen');
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

  // The pictures first: encoding holds this process for minutes, and the people seeded as online are only online while it
  // answers the server's pings.
  await pictures();
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
