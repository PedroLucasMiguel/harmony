// The timer beside a voice channel: how long it has had somebody in it.
//
//   node client/test/voice-timer.mjs
//
// Other people join and leave over their own sockets, as their apps would, and
// the signed-in client is watched: the timer appears with the first person, is
// not restarted by the second, stops when the last one leaves, and starts again
// from nothing.

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const HARMONY_PORT = 18225;
const FAKE_MTX_PORT = 20125;
const DEBUG_PORT = 9500;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-timer-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-timer-profile-'));
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



const as = {};

/** A person's own connection: signed in over the socket, and able to join a channel. */
async function connectAs(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${HARMONY_PORT}/ws`);
  const replies = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.rid) replies.set(msg.rid, msg);
  });
  await new Promise((r) => ws.addEventListener('open', r));
  let n = 0;
  const request = async (type, extra = {}) => {
    n += 1;
    const rid = `${name}-${n}`;
    ws.send(JSON.stringify({ type, rid, ...extra, ...(type === 'hello' ? { token: as[name] } : {}) }));
    for (let i = 0; i < 100 && !replies.has(rid); i += 1) await sleep(40);
    return replies.get(rid);
  };
  await request('hello');
  return { ws, request };
}

async function run() {
  await startFakeMediaMtx();
  await startServer();
  for (const name of ['boss', 'ana', 'bob']) {
    const res = await fetch(`${BASE}/api/accounts/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: name, password: 'hunter22', ...(name === 'boss' ? { ownerKey } : {}) }),
    });
    as[name] = (await res.json()).token;
  }
  token = as.boss;
  const voice = (await api('/api/channels')).channels.find((c) => c.kind === 'voice');

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
  await set('username', 'boss');
  await set('account-password', 'hunter22');
  await cdp.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'the channels view' });
  await sleep(800);

  const timer = () => cdp.evaluate(`
    const t = document.querySelector('.voice-timer[data-channel="${voice.id}"]');
    if (!t) return null;
    const row = t.closest('.channel-row').getBoundingClientRect(); const box = t.getBoundingClientRect();
    return { text: t.textContent, color: getComputedStyle(t).color, atTheEnd: row.right - box.right < 40, title: t.title };`);
  const seconds = (text) => text.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);

  check('an empty voice channel has no timer', (await timer()) === null);

  const ana = await connectAs('ana');
  await ana.request('voice:join', { channelId: voice.id });
  await waitFor(cdp, `document.querySelector('.voice-timer[data-channel="${voice.id}"]')`, { label: 'the timer' });
  const first = await timer();
  check('the first person in starts it', seconds(first.text) <= 1 && /^0:0\d$/.test(first.text), first.text);
  check('it is at the end of the channel\'s name, in the live colour, and says what it is', first.atTheEnd && first.color === 'rgb(63, 208, 127)' && first.title.length > 5, JSON.stringify(first));

  await sleep(2600);
  const later = await timer();
  check('it counts', seconds(later.text) >= 2 && seconds(later.text) <= 4, later.text);

  const bob = await connectAs('bob');
  await bob.request('voice:join', { channelId: voice.id });
  await sleep(1200);
  const both = await timer();
  check('a second person does not start it again', seconds(both.text) >= seconds(later.text) + 1, `${later.text} -> ${both.text}`);

  const shot = async (name) => {
    await cdp.send('Page.enable');
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(userDataDir, name), Buffer.from(data, 'base64'));
    console.log('screenshot:', join(userDataDir, name));
  };
  await shot('timer.png');

  ana.ws.close();
  await sleep(1200);
  const one = await timer();
  check('the first one leaving does not stop it', one && seconds(one.text) >= seconds(both.text), String(one?.text));

  bob.ws.close();
  await sleep(1200);
  check('the last one leaving takes it away', (await timer()) === null);

  const again = await connectAs('ana');
  await again.request('voice:join', { channelId: voice.id });
  await waitFor(cdp, `document.querySelector('.voice-timer[data-channel="${voice.id}"]')`, { label: 'the timer again' });
  const restart = await timer();
  check('and the next person starts it from nothing', seconds(restart.text) <= 1, restart.text);
  again.ws.close();

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
