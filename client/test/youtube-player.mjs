// Cards under links, through the real client and server.
//
//   node client/test/youtube-player.mjs
//
// A small web server stands in for the internet. The Harmony server reads its
// pages (it is told it may, for this test only -- it will not read an address on
// the computer it runs on otherwise), keeps their pictures as files, and the
// client draws a card: site, title, text, picture, with a wide picture under the
// text and a small one beside it, and the choice of removing one or all of them.

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const HARMONY_PORT = 18227;
const FAKE_MTX_PORT = 20127;
const DEBUG_PORT = 9502;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-embeds-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-embeds-profile-'));
const { check, summary } = reporter();
const procs = [];
process.env.HARMONY_LINKS_ALLOW_PRIVATE = '1';
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

const startFakeMediaMtx = () => new Promise((done) => {
  fakeMtx = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ itemCount: 0, pageCount: 0, items: [] }));
  });
  fakeMtx.listen(FAKE_MTX_PORT, '127.0.0.1', done);
});

const startServer = () => new Promise((done, fail) => {
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
      done();
    }
  });
  p.stderr.on('data', (b) => (serverLog += b.toString()));
});

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



/** A plain picture of a given size: enough for the server to keep and the page to draw. */
function png(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}


const VIDEO = 'https://www.youtube.com/watch?v=naNpAAdfmzs';

async function run() {
  await startFakeMediaMtx();
  await startServer();
  token = (await api('/api/accounts/register', { nickname: 'tester', password: 'hunter22', ownerKey })).token;
  const channel = (await api('/api/channels')).channels.find((c) => c.kind === 'text');
  const post = (body) => api(`/api/channels/${channel.id}/messages`, { body });
  await post(VIDEO);

  const app = launchApp({ port: DEBUG_PORT, userDataDir });
  procs.push(app);
  const cdp = await attach(await findPage(DEBUG_PORT));
  await sleep(1200);
  const set = (id, value) => cdp.evaluate(`
    const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
    return true;`);
  await set('server-url', BASE);
  await sleep(1500);
  await set('username', 'tester');
  await set('account-password', 'hunter22');
  await cdp.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'the channels view' });
  await sleep(600);
  await cdp.evaluate(`
    [...document.querySelectorAll('#channel-items li.channel-row')]
      .find((li) => li.querySelector('.channel-name')?.textContent === ${JSON.stringify(channel.name)}).click();
    return true;`);
  await waitFor(cdp, "document.querySelectorAll('.chat-msg').length >= 1", { label: 'the message' });
  try {
    await waitFor(cdp, "document.querySelector('.link-embed[data-player]')", { label: 'the card', timeoutMs: 25_000 });
  } catch {
    console.log('no card: is there a connection to YouTube?');
    check('a YouTube card is drawn', false);
    return;
  }
  await sleep(800);

  const card = await cdp.evaluate(`
    const c = document.querySelector('.link-embed[data-player]');
    const r = (e) => e && Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height);
    const play = c.querySelector('[data-act="play"]');
    const open = c.querySelector('[data-act="open"]');
    const frame = c.querySelector('.link-embed-frame').getBoundingClientRect();
    const centre = (e) => { const b = e.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; };
    return {
      title: c.querySelector('.link-embed-title')?.textContent,
      stage: r(c.querySelector('.link-embed-frame')),
      play: Boolean(play), open: Boolean(open), openHref: open?.href ?? null,
      playTitle: play?.title, openTitle: open?.title,
      playSize: r(play),
      inside: play && open && [play, open].every((e) => { const b = e.getBoundingClientRect(); return b.left >= frame.left && b.right <= frame.right && b.top >= frame.top && b.bottom <= frame.bottom; }),
      playGlyph: play ? getComputedStyle(play, '::before').maskImage !== 'none' : false,
    };`);
  check('a YouTube card has a play button and a button for the browser over its picture',
    card.play && card.open && card.inside && card.playGlyph && /youtube\.com\/watch\?v=naNpAAdfmzs/.test(card.openHref), JSON.stringify(card));
  check('the buttons say what they do', card.playTitle && card.openTitle && card.playTitle !== card.openTitle, JSON.stringify(card));

  const before = await cdp.evaluate(`
    const c = document.querySelector('.link-embed[data-player]');
    return { height: Math.round(c.getBoundingClientRect().height), frames: document.querySelectorAll('iframe').length };`);
  check('nothing has gone to YouTube before the button is pressed', before.frames === 0, JSON.stringify(before));

  await cdp.send('Page.enable');
  const still = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(tmpdir(), 'harmony-youtube-card.png'), Buffer.from(still.data, 'base64'));
  await cdp.evaluate("document.querySelector('.link-embed [data-act=\"play\"]').click(); return true;");
  await sleep(800);
  const playing = await cdp.evaluate(`
    const f = document.querySelector('.link-embed iframe');
    const c = document.querySelector('.link-embed[data-player]');
    if (f) { f.__loads = 0; f.addEventListener('load', () => { f.__loads += 1; }); f.__mine = true; }
    return { frame: Boolean(f), src: f?.src, height: Math.round(c.getBoundingClientRect().height), actions: Boolean(c.querySelector('.link-embed-actions')), playing: c.hasAttribute('data-playing'),
      box: f ? Math.round(f.getBoundingClientRect().width) + 'x' + Math.round(f.getBoundingClientRect().height) : null };`);
  check('pressing play puts the player in the card, where the picture was',
    playing.frame && /^https:\/\/www\.youtube-nocookie\.com\/embed\/naNpAAdfmzs/.test(playing.src) && playing.playing && !playing.actions && playing.height === before.height, JSON.stringify({ before, playing }));
  await sleep(6000);
  await cdp.evaluate("const f = document.querySelector('.link-embed iframe'); f.__loads = 0; return true;");

  await cdp.send('Page.enable');
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const shotPath = join(tmpdir(), 'harmony-youtube-player.png');
  writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  console.log('screenshot:', shotPath);

  // The chat is drawn again for every message: the player must not start over.
  await post('a message that draws the chat again');
  await sleep(1500);
  const after = await cdp.evaluate(`
    const f = document.querySelector('.link-embed iframe');
    return { same: Boolean(f?.__mine), loads: f?.__loads ?? null, connected: Boolean(f?.isConnected), playing: document.querySelector('.link-embed[data-player]')?.hasAttribute('data-playing'),
      moves: typeof Element.prototype.moveBefore };`);
  check('the player is not started over when the chat is drawn again',
    after.same && after.loads === 0 && after.connected && after.playing, JSON.stringify(after));
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    const failed = summary();
    setTimeout(() => process.exit(process.exitCode ?? (failed ? 1 : 0)), 200);
  });
