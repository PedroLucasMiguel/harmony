// The channels layout is as tall as the window leaves it, whatever is in the chat.
//
//   node client/test/chat-fits-window.mjs
//
// A channel with one message (no scrollbar) and one with a screenful (a scrollbar)
// must put the bottom of the app -- the composer, the strip with your name -- in the
// same place, and neither may run past the window.

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const HARMONY_PORT = 18224;
const FAKE_MTX_PORT = 20124;
const DEBUG_PORT = 9499;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-who-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-who-profile-'));
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
const ids = {};
const post = (who, body) => fetch(`${BASE}/api/channels/${channelId}/messages`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${as[who]}` }, body: JSON.stringify({ body }),
});
let channelId;

async function run() {
  await startFakeMediaMtx();
  await startServer();
  for (const name of ['boss', 'ana', 'bob', 'cy']) {
    const res = await fetch(`${BASE}/api/accounts/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: name, password: 'hunter22', ...(name === 'boss' ? { ownerKey } : {}) }),
    });
    const json = await res.json();
    as[name] = json.token;
    ids[name] = json.user.id;
  }
  token = as.boss;
  channelId = (await api('/api/channels')).channels.find((c) => c.kind === 'text').id;
  const role = async (name) => (await api('/api/roles', { name, color: '#3fb984' })).role;
  const dev = await role('Dev');
  const solo = await role('Solo');
  const give = (who, roles) => api(`/api/accounts/${ids[who]}/roles`, { roles });
  await give('ana', [dev.id]);
  await give('bob', [dev.id]);
  await give('cy', [solo.id]);

  await post('boss', 'only one');
  const extra = await api('/api/channels', { kind: 'text', name: 'busy' }); 
  for (let n = 0; n < 60; n += 1) await api(`/api/channels/${extra.channel.id}/messages`, { body: 'line ' + n });

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
  await set('username', 'ana');
  await set('account-password', 'hunter22');
  await cdp.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'the channels view' });
  await sleep(600);
  const open = async (name, count) => {
    await cdp.evaluate(`[...document.querySelectorAll('#channel-items li.channel-row')].find((li) => li.querySelector('.channel-name')?.textContent === ${JSON.stringify(name)}).click(); return true;`);
    await waitFor(cdp, `document.querySelectorAll('.chat-msg').length >= ${count}`, { label: name });
    await sleep(700);
    return cdp.evaluate(`
      const r = (q) => { const e = document.querySelector(q); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.top), Math.round(b.bottom), Math.round(b.height)]; };
      return { inner: innerHeight, scrolls: (() => { const l = document.getElementById('chat-log'); return l.scrollHeight > l.clientHeight; })(),
        body: [document.documentElement.scrollHeight, document.body.scrollHeight],
        shell: r('#app-shell'), views: r('#views'), layout: r('#view-channels'), grid: r('.channels-layout'), sidebar: r('.channels-layout > *:nth-child(1)'), stage: r('.channels-layout > *:nth-child(2)'),
        composer: r('.composer'), self: r('.self-bar, #self-bar, .self-actions'), log: r('#chat-log'), wrap: r('.chat-log-wrap') };`);
  };
  const one = await open('general', 1);
  const many = await open('busy', 40);
  const again = await open('general', 1);
  const overflow = await cdp.evaluate('return document.documentElement.scrollHeight - innerHeight;');
  check('the chat with one message has no scrollbar and the one with many has', one.scrolls === false && many.scrolls === true, JSON.stringify([one.scrolls, many.scrolls]));
  check('the layout fits the window in both: nothing runs past the bottom', one.grid[1] <= one.inner && many.grid[1] <= many.inner && many.body[0] <= many.inner, JSON.stringify({ one: one.grid, many: many.grid, body: many.body, inner: many.inner }));
  check('and the bottom of the app does not move between them',
    JSON.stringify([one.composer, one.self, one.sidebar]) === JSON.stringify([many.composer, many.self, many.sidebar])
      && JSON.stringify(again.composer) === JSON.stringify(one.composer), JSON.stringify({ one: one.composer, many: many.composer, again: again.composer }));
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
