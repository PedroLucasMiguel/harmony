// Cropping, zooming and turning a profile picture or a banner, and GIFs that keep moving.
//
//   - the arithmetic: the mask is always covered by the picture, whatever it is moved, zoomed or turned to
//   - the editor: opens on a picked file, shows the mask (a circle, or the banner's strip), and the hand and the controls
//     move, zoom and turn the picture without ever showing an edge inside the mask
//   - what is saved is what is under the mask: an animated GIF is kept as a GIF with its frames and timing, cut to the
//     part chosen; a still is a JPEG of the part chosen; both fit what the server takes
//   - cancelling changes nothing
//
//   node client/test/image-editor.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';
import { GIFEncoder, applyPalette, quantize } from '../src/renderer/gifenc.js';
import { clampPlacement, extents, minScale, rotateBy, startPlacement, zoomAt } from '../src/renderer/image-crop.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const HARMONY_PORT = 18230;
const FAKE_MTX_PORT = 20130;
const DEBUG_PORT = 9530;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-ie-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-ie-profile-'));
const { check, summary } = reporter();
const procs = [];
let fakeMtx = null;
let serverLog = '';
let ownerKey = null;

process.on('exit', () => {
  for (const p of procs) {
    try { p.kill(); } catch { /* already gone */ }
  }
  try { fakeMtx?.close(); } catch { /* already closed */ }
});
process.on('SIGINT', () => process.exit(130));

function startFakeMediaMtx() {
  return new Promise((done) => {
    fakeMtx = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ itemCount: 0, pageCount: 0, items: [] }));
    });
    fakeMtx.listen(FAKE_MTX_PORT, '127.0.0.1', done);
  });
}

function startHarmonyServer() {
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        HARMONY_PORT: String(HARMONY_PORT),
        HARMONY_HOST: '127.0.0.1',
        HARMONY_DATA_DIR: dataDir,
        HARMONY_MEDIAMTX_API: `http://127.0.0.1:${FAKE_MTX_PORT}`,
        HARMONY_SIGNALING_URL: 'http://127.0.0.1:8889',
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

let token = null;
const api = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
};

const post = (channelId, body) => api(`/api/channels/${channelId}/messages`, { body });

/** Where the log is scrolled, as the renderer sees it. */
const logState = (cdp) => cdp.evaluate(`
  const log = document.getElementById('chat-log');
  const rows = [...log.querySelectorAll('.chat-msg')];
  const last = rows.at(-1);
  return {
    top: Math.round(log.scrollTop),
    fromBottom: Math.round(log.scrollHeight - log.scrollTop - log.clientHeight),
    scrollable: log.scrollHeight > log.clientHeight + 100,
    count: rows.length,
    lastText: last?.textContent ?? '',
    title: document.getElementById('chat-name').textContent,
  };
`);

const openChannel = async (cdp, name) => {
  await cdp.evaluate(`
    const li = [...document.querySelectorAll('#channel-items li.channel-row')]
      .find((row) => row.querySelector('.channel-name')?.textContent === ${JSON.stringify(name)});
    li.click();
    return true;
  `);
  await waitFor(
    cdp,
    `document.getElementById('chat-name').textContent === '#${name}'
      && document.querySelectorAll('#chat-log .chat-msg').length > 0`,
    { label: `#${name} to show its messages` },
  );
  // Let the scroll that follows the render settle.
  await sleep(250);
};

// --- fixtures ---------------------------------------------------------------------------------------------------------
/** A GIF 300x150, the left half red and the right half blue, with a white square that moves one step each frame. */
function makeGif(frames = 5, w = 300, h = 150) {
  const gif = GIFEncoder();
  for (let f = 0; f < frames; f += 1) {
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const o = (y * w + x) * 4;
        const square = x >= 20 + f * 40 && x < 44 + f * 40 && y >= 10 && y < 34;
        const [r, g, b] = square ? [255, 255, 255] : x < w / 2 ? [230, 20, 20] : [20, 20, 230];
        rgba.set([r, g, b, 255], o);
      }
    }
    const palette = quantize(rgba, 16);
    gif.writeFrame(applyPalette(rgba, palette), w, h, { palette, delay: 100 });
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}

const approx = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

/** Whether every corner of the mask (a rectangle) lies inside the picture placed as `p`. */
function covers(p, iw, ih, mask) {
  const cos = Math.cos((p.deg * Math.PI) / 180);
  const sin = Math.sin((p.deg * Math.PI) / 180);
  const corners = mask.shape === 'circle'
    ? [0, 1, 2, 3].map((i) => [mask.x + mask.w / 2 + (mask.w / 2) * Math.cos(i * Math.PI / 2), mask.y + mask.h / 2 + (mask.w / 2) * Math.sin(i * Math.PI / 2)])
    : [[mask.x, mask.y], [mask.x + mask.w, mask.y], [mask.x, mask.y + mask.h], [mask.x + mask.w, mask.y + mask.h]];
  return corners.every(([x, y]) => {
    const dx = x - p.cx;
    const dy = y - p.cy;
    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    return Math.abs(lx) <= (p.s * iw) / 2 + 1e-6 && Math.abs(ly) <= (p.s * ih) / 2 + 1e-6;
  });
}

function arithmetic() {
  const circle = { x: 40, y: 40, w: 200, h: 200, shape: 'circle' };
  const strip = { x: 20, y: 30, w: 300, h: 100, shape: 'rect' };
  for (const [name, mask, iw, ih] of [['circle', circle, 800, 500], ['circle', circle, 300, 150], ['strip', strip, 900, 900], ['strip', strip, 400, 100]]) {
    let p = startPlacement(iw, ih, mask);
    check(`${name} ${iw}x${ih}: the picture starts covering the mask, as small as it may be`, covers(p, iw, ih, mask) && approx(p.s, minScale(iw, ih, mask, 0)), JSON.stringify(p));
    let ok = true;
    let tries = 0;
    // A long, rough walk: moved far, zoomed in and out, turned by every few degrees.
    for (let i = 0; i < 400; i += 1) {
      const r = Math.sin(i * 12.9898) * 43758.5453;
      const f = r - Math.floor(r);
      const pick = i % 4;
      if (pick === 0) p = clampPlacement({ ...p, cx: p.cx + (f - 0.5) * 900, cy: p.cy + (f - 0.3) * 900 }, iw, ih, mask);
      else if (pick === 1) p = zoomAt(p, 0.3 + f * 2.2, { x: mask.x + f * mask.w, y: mask.y + (1 - f) * mask.h }, iw, ih, mask);
      else if (pick === 2) p = rotateBy(p, (f - 0.5) * 120, iw, ih, mask);
      else p = clampPlacement({ ...p, s: p.s * (0.5 + f), deg: p.deg + (f - 0.5) * 400 }, iw, ih, mask);
      tries += 1;
      if (!covers(p, iw, ih, mask)) { ok = false; break; }
    }
    check(`${name} ${iw}x${ih}: after ${tries} random moves, zooms and turns the mask is still wholly covered`, ok, JSON.stringify(p));
  }
  // Turning a circle needs no more of the picture; turning a strip does.
  check('a circle needs the same picture at every turn', approx(minScale(400, 300, circle, 0), minScale(400, 300, circle, 37)), '');
  check('a strip needs more of the picture turned a quarter than not', minScale(900, 900, strip, 0) < minScale(900, 900, strip, 90) + 1e-9 && extents(strip, 90).ex < extents(strip, 0).ex, '');
  // Zooming keeps the point under the cursor where it was (where nothing stops it).
  let p = zoomAt(startPlacement(2000, 2000, circle), 2, { x: 140, y: 140 }, 2000, 2000, circle);
  const point = { x: 90, y: 150 };
  const local = { x: (point.x - p.cx) / p.s, y: (point.y - p.cy) / p.s };
  const q = zoomAt(p, 1.5, point, 2000, 2000, circle);
  check('zooming about a point keeps that point of the picture under it', approx((point.x - q.cx) / q.s, local.x, 1e-6) && approx((point.y - q.cy) / q.s, local.y, 1e-6), JSON.stringify([p, q]));
  // Turning is about the middle of the mask.
  const r = rotateBy(startPlacement(2000, 2000, circle), 90, 2000, 2000, circle);
  check('a quarter turn is about the middle of the mask and leaves it covered', approx(r.deg, 90) && approx(r.cx, 140, 1e-6) && approx(r.cy, 140, 1e-6) && covers(r, 2000, 2000, circle), JSON.stringify(r));
  check('a turn past a half is counted the short way round', approx(clampPlacement({ ...p, deg: 270 }, 2000, 2000, circle).deg, -90), '');
}

async function run() {
  arithmetic();
  console.log('\nStarting the control server and the client…\n');
  await startFakeMediaMtx();
  await startHarmonyServer();

  const me = await api('/api/accounts/register', { nickname: 'tester', password: 'hunter22', ownerKey });
  token = me.token;
  const app = launchApp({ port: DEBUG_PORT, userDataDir });
  procs.push(app);
  const cdp = await attach(await findPage(DEBUG_PORT));
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await sleep(1200);
  const set = (id, value) => cdp.evaluate(`
    const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
    i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  await set('server-url', BASE);
  await sleep(1500);
  await set('username', 'tester');
  await set('account-password', 'hunter22');
  await cdp.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'the channels view' });
  await sleep(600);

  const gif = makeGif();

  /** Puts a file in a picker, as choosing it does. */
  const pick = (inputId, bytes, name, type) => cdp.evaluate(`
    const data = Uint8Array.from(atob(${JSON.stringify(Buffer.from(bytes).toString('base64'))}), (c) => c.charCodeAt(0));
    const files = new DataTransfer(); files.items.add(new File([data], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
    const input = document.getElementById(${JSON.stringify(inputId)}); input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  const editor = () => cdp.evaluate(`
    const d = document.querySelector('dialog.image-editor');
    if (!d?.open) return { open: false };
    const stage = d.querySelector('.ie-stage').getBoundingClientRect();
    const mask = d.querySelector('.ie-mask'); const m = mask.getBoundingClientRect();
    const img = d.querySelector('.ie-image');
    const matrix = new DOMMatrix(getComputedStyle(img).transform);
    const inv = matrix.inverse();
    // What has to be covered: a circle's whole edge, a strip's four corners.
    const edge = mask.dataset.shape === 'circle'
      ? Array.from({ length: 24 }, (_, i) => [m.left + m.width / 2 + (m.width / 2) * Math.cos(i * Math.PI / 12), m.top + m.height / 2 + (m.height / 2) * Math.sin(i * Math.PI / 12)])
      : [[m.left, m.top], [m.right, m.top], [m.left, m.bottom], [m.right, m.bottom]];
    const corners = edge.map(([x, y]) => inv.transformPoint(new DOMPoint(x - stage.left, y - stage.top)));
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const covered = corners.every((c) => c.x >= -0.5 && c.x <= iw + 0.5 && c.y >= -0.5 && c.y <= ih + 0.5);
    const scale = Math.hypot(matrix.a, matrix.b);
    return { open: true, title: d.querySelector('h3').textContent, shape: mask.dataset.shape, mask: { w: Math.round(m.width), h: Math.round(m.height) },
      covered, scale: Math.round(scale * 1000) / 1000, deg: Math.round(Math.atan2(matrix.b, matrix.a) * 180 / Math.PI), zoom: Number(d.querySelector('.ie-zoom').value), strip: Boolean(d.querySelector('.ie-strip')),
      stage: { x: Math.round(stage.left), y: Math.round(stage.top), w: Math.round(stage.width), h: Math.round(stage.height) }, mid: { x: Math.round(m.left + m.width / 2), y: Math.round(m.top + m.height / 2) }, iw, ih };`);
  const mouse = (type, x, y, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
  const drag = async (from, dx, dy) => {
    await mouse('mousePressed', from.x, from.y);
    for (let i = 1; i <= 6; i += 1) await mouse('mouseMoved', from.x + (dx * i) / 6, from.y + (dy * i) / 6);
    await mouse('mouseReleased', from.x + dx, from.y + dy);
    await sleep(120);
  };
  const decode = (bytes) => cdp.evaluate(`
    const data = Uint8Array.from(atob(${JSON.stringify(Buffer.from(bytes).toString('base64'))}), (c) => c.charCodeAt(0));
    const head = String.fromCharCode(...data.slice(0, 4));
    const type = head.startsWith('GIF') ? 'image/gif' : head.startsWith('\\x89PNG') ? 'image/png' : 'image/jpeg';
    const decoder = new ImageDecoder({ data, type }); await decoder.tracks.ready; await decoder.completed;
    const count = decoder.tracks.selectedTrack.frameCount;
    const frames = [];
    for (let i = 0; i < count; i += 1) {
      const { image } = await decoder.decode({ frameIndex: i });
      const c = document.createElement('canvas'); c.width = image.displayWidth; c.height = image.displayHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0);
      const px = (x, y) => Array.from(ctx.getImageData(Math.floor(x * c.width), Math.floor(y * c.height), 1, 1).data.slice(0, 3));
      frames.push({ w: c.width, h: c.height, delay: Math.round((image.duration ?? 0) / 1000), centre: px(0.5, 0.5), left: px(0.2, 0.5), right: px(0.8, 0.5), hash: Array.from(ctx.getImageData(0, 0, c.width, Math.floor(c.height * 0.5)).data).reduce((a, b, i) => (a + b * (i % 97)) % 1000003, 0) });
      image.close();
    }
    return { type, count, frames };`);
  const mine = async () => (await api('/api/accounts/me')).user;
  const download = async (hash) => {
    const res = await fetch(`${BASE}/api/uploads/${hash}`, { headers: { Authorization: `Bearer ${token}` } });
    return { type: res.headers.get('content-type'), bytes: Buffer.from(await res.arrayBuffer()) };
  };
  const waitForAvatar = async (before) => {
    const deadline = Date.now() + 20000;
    for (;;) {
      const user = await mine();
      if (user.avatarHash && user.avatarHash !== before) return user.avatarHash;
      if (Date.now() > deadline) return null;
      await sleep(300);
    }
  };

  // --- a GIF as a profile picture -------------------------------------------------------------------------------------------------
  await pick('avatar-file', gif, 'moving.gif', 'image/gif');
  await waitFor(cdp, "document.querySelector('dialog.image-editor')?.open === true", { label: 'the editor' });
  await sleep(500);
  let ed = await editor();
  check('choosing a GIF opens the editor, with a circle for a mask', ed.open && ed.shape === 'circle' && ed.mask.w === ed.mask.h && /Profile picture/.test(ed.title), JSON.stringify(ed));
  check('the picture starts covering the mask, as small as it may be, and is the whole GIF', ed.covered && ed.zoom < 1 && ed.iw === 300 && ed.ih === 150, JSON.stringify(ed));
  check('the picture in the editor is the GIF, moving: it is the file itself', await cdp.evaluate("return { gif: document.querySelector('dialog.image-editor .ie-image').src.startsWith('blob:') }").then((r) => r.gif), '');
  const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })).data;
  (await import('node:fs')).writeFileSync(`${process.env.SHOT_DIR ?? tmpdir()}/image-editor-avatar.png`, Buffer.from(shot, 'base64'));

  // dragging cannot pull an edge into the mask
  await drag(ed.mid, 400, 300);
  let after = await editor();
  check('dragging far moves it as far as the mask allows and no further: no edge comes in', after.covered, JSON.stringify(after));
  await drag(after.mid, -900, -900);
  check('and the other way', (await editor()).covered, '');
  // zoom: the slider, then the wheel
  await cdp.evaluate("const z = document.querySelector('dialog.image-editor .ie-zoom'); z.value = '60'; z.dispatchEvent(new Event('input', { bubbles: true })); return true;");
  await sleep(100);
  const zoomed = await editor();
  check('the slider zooms in', zoomed.scale > ed.scale * 2 && zoomed.covered, JSON.stringify([ed.scale, zoomed.scale]));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: zoomed.mid.x, y: zoomed.mid.y, deltaX: 0, deltaY: 400 });
  await sleep(100);
  const out = await editor();
  check('the wheel zooms out, and not past where the mask is covered', out.scale < zoomed.scale && out.covered, JSON.stringify([zoomed.scale, out.scale]));
  await cdp.evaluate("const z = document.querySelector('dialog.image-editor .ie-zoom'); z.value = '0'; z.dispatchEvent(new Event('input', { bubbles: true })); return true;");
  check('all the way out is the smallest that covers it', Math.abs((await editor()).scale - ed.scale) < 0.01, '');
  // turning
  await cdp.evaluate("document.querySelector('dialog.image-editor .ie-tool[aria-label=\"Turn 90° right\"]').click(); return true;");
  await sleep(100);
  let turned = await editor();
  check('the quarter-turn button turns it, and the mask is still covered', turned.deg === 90 && turned.covered, JSON.stringify(turned));
  await cdp.evaluate("const r = document.querySelector('dialog.image-editor .ie-rotate'); r.value = '33'; r.dispatchEvent(new Event('input', { bubbles: true })); return true;");
  await sleep(100);
  turned = await editor();
  check('the slider turns it to any angle, and the mask is still covered', turned.deg === 33 && turned.covered, JSON.stringify(turned));
  await cdp.evaluate("document.querySelector('dialog.image-editor .ie-reset').click(); return true;");
  await sleep(100);
  ed = await editor();
  check('Start over puts it back', ed.deg === 0 && ed.zoom < 1 && ed.covered, JSON.stringify(ed));

  // cancel changes nothing
  const before = (await mine()).avatarHash;
  await cdp.evaluate("document.querySelector('dialog.image-editor .ie-cancel').click(); return true;");
  await sleep(500);
  check('Cancel closes it and keeps the picture as it was', !(await editor()).open && (await mine()).avatarHash === before, '');

  // choose the red half only, and save
  await pick('avatar-file', gif, 'moving.gif', 'image/gif');
  await waitFor(cdp, "document.querySelector('dialog.image-editor')?.open === true", { label: 'the editor again' });
  await sleep(400);
  ed = await editor();
  await drag(ed.mid, 120, 0);
  ed = await editor();
  check('moved to the left half, the mask is still covered', ed.covered, JSON.stringify(ed));
  await cdp.evaluate("document.querySelector('dialog.image-editor .ie-save').click(); return true;");
  const hash = await waitForAvatar(before);
  check('Save makes it the picture', Boolean(hash), '');
  const kept = await download(hash);
  const decoded = await decode(kept.bytes);
  check('what is kept is a GIF, with every frame, 160 x 160, as the editor drew it out', kept.type === 'image/gif' && decoded.type === 'image/gif' && decoded.count === 5 && decoded.frames.every((f) => f.w === 160 && f.h === 160),
    JSON.stringify({ type: kept.type, count: decoded.count, size: decoded.frames[0] && [decoded.frames[0].w, decoded.frames[0].h], bytes: kept.bytes.length }));
  check('it fits what the server takes of a GIF', kept.bytes.length <= 1024 * 1024, String(kept.bytes.length));
  check('and it keeps its time: a tenth of a second a frame', decoded.frames.every((f) => f.delay >= 90 && f.delay <= 110), JSON.stringify(decoded.frames.map((f) => f.delay)));
  const red = (c) => c[0] > 180 && c[1] < 70 && c[2] < 70;
  check('only the part chosen is in it: the middle of what was kept is the red half', decoded.frames.every((f) => red(f.centre) && red(f.left)), JSON.stringify(decoded.frames.map((f) => [f.centre, f.left])));
  check('and it still moves: the frames are not all alike', new Set(decoded.frames.map((f) => f.hash)).size > 1, JSON.stringify(decoded.frames.map((f) => f.hash)));

  // --- a still as a profile picture ------------------------------------------------------------------------------------------------
  const wide = await cdp.evaluate(`
    const c = document.createElement('canvas'); c.width = 900; c.height = 300; const x = c.getContext('2d');
    x.fillStyle = '#2d9d2d'; x.fillRect(0, 0, 600, 300); x.fillStyle = '#d4a017'; x.fillRect(600, 0, 300, 300);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png')); const b = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (const v of b) s += String.fromCharCode(v); return { b64: btoa(s) };`).then((r) => Buffer.from(r.b64, 'base64'));
  const before2 = (await mine()).avatarHash;
  await pick('avatar-file', wide, 'wide.png', 'image/png');
  await waitFor(cdp, "document.querySelector('dialog.image-editor')?.open === true", { label: 'the editor for a still' });
  await sleep(400);
  ed = await editor();
  check('a still opens the same editor', ed.open && ed.shape === 'circle' && ed.iw === 900 && ed.ih === 300 && ed.covered, JSON.stringify(ed));
  await cdp.evaluate("document.querySelector('dialog.image-editor .ie-save').click(); return true;");
  const stillHash = await waitForAvatar(before2);
  const stillKept = await download(stillHash);
  const stillDecoded = await decode(stillKept.bytes);
  check('a still is kept as a JPEG, 256 x 256, within what the server takes', stillKept.type === 'image/jpeg' && stillDecoded.frames[0].w === 256 && stillDecoded.frames[0].h === 256 && stillKept.bytes.length <= 256 * 1024, JSON.stringify({ type: stillKept.type, bytes: stillKept.bytes.length }));
  check('the middle of a wide picture is what was kept: green, not the yellow at its end', stillDecoded.frames[0].centre[1] > stillDecoded.frames[0].centre[0] && stillDecoded.frames[0].right[1] > stillDecoded.frames[0].right[2], JSON.stringify(stillDecoded.frames[0]));

  // --- a banner --------------------------------------------------------------------------------------------------------------------
  const beforeBanner = (await mine()).bannerHash ?? null;
  await pick('profile-banner-file', gif, 'moving.gif', 'image/gif');
  await waitFor(cdp, "document.querySelector('dialog.image-editor')?.open === true", { label: 'the editor for a banner' });
  await sleep(400);
  ed = await editor();
  check('a banner is cropped under a strip three times as wide as it is tall, with the member list\'s strip marked', ed.shape === 'rect' && Math.abs(ed.mask.w / ed.mask.h - 3) < 0.05 && ed.strip && /Banner/.test(ed.title) && ed.covered, JSON.stringify(ed));
  const shot2 = (await cdp.send('Page.captureScreenshot', { format: 'png' })).data;
  (await import('node:fs')).writeFileSync(`${process.env.SHOT_DIR ?? tmpdir()}/image-editor-banner.png`, Buffer.from(shot2, 'base64'));
  await cdp.evaluate("document.querySelector('dialog.image-editor .ie-save').click(); return true;");
  let bannerHash = null;
  for (const deadline = Date.now() + 25000; Date.now() < deadline && !bannerHash; await sleep(300)) {
    const user = await mine();
    if (user.bannerHash && user.bannerHash !== beforeBanner) bannerHash = user.bannerHash;
  }
  const banner = await download(bannerHash);
  const bannerDecoded = await decode(banner.bytes);
  check('an animated banner is kept as a GIF, 720 x 240, all its frames', banner.type === 'image/gif' && bannerDecoded.count === 5 && bannerDecoded.frames[0].w === 720 && bannerDecoded.frames[0].h === 240 && banner.bytes.length <= 2 * 1024 * 1024, JSON.stringify({ type: banner.type, count: bannerDecoded.count, size: [bannerDecoded.frames[0]?.w, bannerDecoded.frames[0]?.h], bytes: banner.bytes.length }));

  const beforeBanner2 = bannerHash;
  await pick('profile-banner-file', wide, 'wide.png', 'image/png');
  await waitFor(cdp, "document.querySelector('dialog.image-editor')?.open === true", { label: 'the editor for a still banner' });
  await sleep(400);
  await cdp.evaluate("document.querySelector('dialog.image-editor .ie-save').click(); return true;");
  let stillBanner = null;
  for (const deadline = Date.now() + 25000; Date.now() < deadline && !stillBanner; await sleep(300)) {
    const user = await mine();
    if (user.bannerHash && user.bannerHash !== beforeBanner2) stillBanner = user.bannerHash;
  }
  const stillBannerKept = await download(stillBanner);
  const sb = await decode(stillBannerKept.bytes);
  check('a still banner is a JPEG, 960 x 320', stillBannerKept.type === 'image/jpeg' && sb.frames[0].w === 960 && sb.frames[0].h === 320, JSON.stringify({ type: stillBannerKept.type, size: [sb.frames[0].w, sb.frames[0].h] }));

  // --- something that is not a picture ----------------------------------------------------------------------------------------------
  const shown = await cdp.evaluate("return { editor: Boolean(document.querySelector('dialog.image-editor')) }");
  check('no editor is left open behind', !shown.editor, JSON.stringify(shown));

  app.kill();
}

run()
  .catch((err) => {
    console.error(err);
    console.error(serverLog.split('\n').slice(-15).join('\n'));
    process.exitCode = 1;
  })
  .finally(() => {
    const failed = summary();
    setTimeout(() => process.exit(process.exitCode ?? (failed ? 1 : 0)), 200);
  });
