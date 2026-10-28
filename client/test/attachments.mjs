// What can be sent in a text channel, through the real client.
//
//   node client/test/attachments.mjs
//
// The rule: any file, of any type and any name, as long as it is inside the
// server's size limit. Each file here goes the way a person sends one -- the
// attach button's file input, or a paste -- and the message is then read back
// from the SERVER: what the page shows proves nothing about what is stored.
//
// MediaMTX is stubbed, as in channels-ui.mjs: nothing here touches media.

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const HARMONY_PORT = 18220;
const FAKE_MTX_PORT = 20120;
const DEBUG_PORT = 9495;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-attach-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-attach-profile-'));
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

/** [name, claimed type, size in bytes] -- the awkward ones, on purpose. */
const FILES = [
  ['archive.zip', 'application/zip', 40_000],
  ['setup.exe', 'application/x-msdownload', 3_000],
  ['page.html', 'text/html', 500],
  ['logo.svg', 'image/svg+xml', 500],
  ['clip.mov', 'video/quicktime', 4_000],
  ['song.flac', 'audio/flac', 4_000],
  ['data.json', 'application/json', 200_000],
  ['.gitignore', '', 120],
  ['no-extension', '', 300],
  ['empty.txt', 'text/plain', 0],
  ['mixed CASE & "quotes" (1).txt', 'text/plain', 90],
  ['ünïcode 🎉 файл.bin', 'application/octet-stream', 700],
];

async function run() {
  await startFakeMediaMtx();
  await startServer();
  token = (await api('/api/accounts/register', { nickname: 'tester', password: 'hunter22', ownerKey })).token;
  const channel = (await api('/api/channels')).channels.find((c) => c.kind === 'text');

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
  await waitFor(cdp, "document.getElementById('chat-name').textContent.length > 0", { label: 'the text channel' });
  await sleep(500);

  /** Send one file; `how` is the file input or a paste. Returns the message the server kept. */
  async function send(name, type, size, how) {
    const before = (await api(`/api/channels/${channel.id}/messages`)).messages.length;
    await cdp.evaluate(`
      const bytes = new Uint8Array(${size}).fill(7);
      const file = new File([bytes], ${JSON.stringify(name)}, ${type ? `{ type: ${JSON.stringify(type)} }` : '{}'});
      const files = new DataTransfer(); files.items.add(file);
      if (${JSON.stringify(how)} === 'paste') {
        const input = document.getElementById('chat-input');
        input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: files, bubbles: true, cancelable: true }));
      } else {
        const input = document.getElementById('chat-file');
        input.files = files.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;`);
    await waitFor(cdp, "!document.getElementById('chat-send').disabled", { label: `${name} to be ready to send` });
    await cdp.evaluate("document.getElementById('chat-send').click(); return true;");
    const deadline = Date.now() + 15_000;
    for (;;) {
      const { messages } = await api(`/api/channels/${channel.id}/messages`);
      if (messages.length > before) return messages.at(-1);
      if (Date.now() > deadline) return null;
      await sleep(250);
    }
  }

  let i = 0;
  for (const [name, type, size] of FILES) {
    const how = i % 2 === 0 ? 'picker' : 'paste';
    i += 1;
    const message = await send(name, type, size, how);
    const ok = message
      && message.attachmentBytes === size
      && message.attachmentName === name
      && Boolean(message.attachmentHash);
    check(`${name} (${type || 'no type'}, ${size} bytes) is sent by ${how}`, Boolean(ok),
      message ? `${message.attachmentName} / ${message.attachmentBytes} bytes` : 'no message arrived');
    if (message?.attachmentHash) {
      const back = await fetch(`${BASE}/api/uploads/${message.attachmentHash}`, { headers: { Authorization: `Bearer ${token}` } });
      const got = Buffer.from(await back.arrayBuffer());
      check(`and comes back byte for byte`, got.length === size && got.every((b) => b === 7), `${got.length} bytes`);
    }
  }

  // Too big is still too big: the server's own limit is the only one.
  const limit = (await api('/api/server')).server?.maxFileBytes ?? null;
  check('the only limit left is the server\'s own, and the client knows it', Number.isFinite(limit) && limit > 0, String(limit));

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
