// Opening a text channel for the first time in a session lands at the newest message,
// and stays there while pictures and the rest of the page settle; and the button
// next to the scroll bar takes you back down.
//
//   node client/test/chat-bottom.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const HARMONY_PORT = 18307;
const FAKE_MTX_PORT = 20150;
const DEBUG_PORT = 9593;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-bottom-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-bottom-profile-'));
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


/** A real PNG, so the page has a real picture to wait for. */
function png(width, height, seed) {
  const crc = (buf) => {
    let c; let crcv = 0xffffffff;
    for (const byte of buf) {
      c = (crcv ^ byte) & 0xff;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcv = (crcv >>> 8) ^ c;
    }
    return (crcv ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = (x * 255 / width + seed * 40) % 255;
      raw[row + 2 + x * 3] = (y * 255 / height) % 255;
      raw[row + 3 + x * 3] = ((x ^ y) + seed * 70) % 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function upload(buffer) {
  const res = await fetch(`${BASE}/api/uploads`, {
    method: 'POST', headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${token}` }, body: buffer,
  });
  if (!res.ok) throw new Error(`upload: ${res.status}`);
  return (await res.json()).hash;
}

async function run() {
  await startFakeMediaMtx();
  await startServer();
  token = (await api('/api/accounts/register', { nickname: 'tester', password: 'hunter22', ownerKey })).token;
  const channel = (await api('/api/channels')).channels.find((c) => c.kind === 'text');

  // A long channel with pictures in it, before anybody opens it.
  const hashes = [];
  for (let i = 0; i < 4; i += 1) hashes.push(await upload(png(900, 600, i)));
  for (let i = 1; i <= 80; i += 1) {
    const withPicture = i % 7 === 0;
    await api(`/api/channels/${channel.id}/messages`, {
      body: `message number ${i}${i % 5 === 0 ? ' -- ' + 'a longer one that goes on for a while '.repeat(4) : ''}`,
      ...(withPicture ? { attachmentHash: hashes[i % 4], attachmentName: `picture-${i}.png` } : {}),
    });
  }
  await api(`/api/channels/${channel.id}/messages`, { body: 'the newest message of all', attachmentHash: hashes[0], attachmentName: 'last.png' });

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
  await sleep(800);

  const gap = () => cdp.evaluate("const l = document.getElementById('chat-log'); return Math.round(l.scrollHeight - l.scrollTop - l.clientHeight)");
  await cdp.evaluate(`
    [...document.querySelectorAll('#channel-items li.channel-row')]
      .find((li) => li.querySelector('.channel-name')?.textContent === ${JSON.stringify(channel.name)}).click();
    return true;`);
  await waitFor(cdp, "document.querySelectorAll('#chat-log .chat-msg').length >= 30", { label: 'the messages', timeoutMs: 20_000 });

  // The first time this session: sampled while the pictures arrive.
  const samples = [];
  for (const wait of [100, 400, 700, 1000, 1500, 2000, 3000]) {
    await sleep(wait === 100 ? 100 : 300);
    samples.push(await gap());
  }
  const settled = await cdp.evaluate("return [...document.querySelectorAll('#chat-log img')].filter((i) => !i.complete).length");
  await sleep(1500);
  samples.push(await gap());
  console.log('  distance from the bottom, over time:', JSON.stringify(samples), `(pictures still loading: ${settled})`);
  check('opened for the first time, it is at the newest message', samples[samples.length - 1] <= 40, JSON.stringify(samples));
  check('and stayed there while the pictures arrived', samples.every((g) => g <= 40), JSON.stringify(samples));
  const newestVisible = await cdp.evaluate(`
    const l = document.getElementById('chat-log'); const last = l.lastElementChild; const a = l.getBoundingClientRect(); const b = last.getBoundingClientRect();
    return b.bottom <= a.bottom + 2 && b.top >= a.top - 2 || b.bottom > a.top`);
  check('the newest message is in view', newestVisible, '');

  // --- the button next to the scroll bar ----------------------------------------------------------------------------------------
  const button = () => cdp.evaluate(`
    const b = document.getElementById('chat-to-bottom'); if (!b) return null;
    const r = b.getBoundingClientRect(); const l = document.getElementById('chat-log').getBoundingClientRect();
    return { shown: !b.hidden && r.width > 0, fromRight: Math.round(l.right - r.right), fromBottom: Math.round(l.bottom - r.bottom), size: Math.round(r.width) };`);
  let b = await button();
  check('at the bottom there is no button', b && !b.shown, JSON.stringify(b));
  await cdp.evaluate("const l = document.getElementById('chat-log'); l.scrollTop = 200; l.dispatchEvent(new Event('scroll')); return true;");
  await sleep(400);
  b = await button();
  check('scrolled up, it appears', b?.shown, JSON.stringify(b));
  check('right beside the scroll bar, above the composer', b && b.fromRight >= 0 && b.fromRight <= 40 && b.fromBottom >= 0 && b.fromBottom <= 40, JSON.stringify(b));
  await cdp.evaluate("document.getElementById('chat-to-bottom').click(); return true;");
  // A smooth scroll over a long log takes a moment to arrive.
  let arrived = await gap();
  for (let i = 0; i < 20 && arrived > 40; i += 1) { await sleep(250); arrived = await gap(); }
  check('pressing it goes to the newest message', arrived <= 40, String(arrived));
  b = await button();
  check('and it goes away', b && !b.shown, JSON.stringify(b));

  // --- somebody reading old messages is not dragged down ----------------------------------------------------------------------------
  await cdp.evaluate("const l = document.getElementById('chat-log'); l.scrollTop = 0; l.dispatchEvent(new Event('scroll')); return true;");
  await api(`/api/channels/${channel.id}/messages`, { body: 'one that arrives while reading old ones' });
  await sleep(800);
  const top = await cdp.evaluate("return document.getElementById('chat-log').scrollTop");
  check('a message arriving while reading old ones does not take them down', top < 100, String(top));
  b = await button();
  check('and the button is there to go to it', b?.shown, JSON.stringify(b));
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
