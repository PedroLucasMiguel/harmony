// Where a text channel opens, driven through the real client.
//
//   - the first time in a session: at the bottom, with the newest messages
//   - after scrolling up, going to another channel and coming back: where it
//     was left, even with messages arriving in the meantime
//   - after leaving it at the bottom: at the bottom again, with what arrived
//
// MediaMTX is stubbed, as in channels-ui.mjs: nothing here touches media.
//
//   node client/test/chat-scroll.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const HARMONY_PORT = 18140;
const FAKE_MTX_PORT = 20020;
const DEBUG_PORT = 9421;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-scroll-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-scroll-profile-'));
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

async function run() {
  console.log('Starting the control server and the client…\n');
  await startFakeMediaMtx();
  await startHarmonyServer();

  // --- an account, two text channels, a long history in each -------------
  const registered = await api('/api/accounts/register', {
    nickname: 'tester', password: 'hunter22', ownerKey,
  });
  token = registered.token;
  const general = (await api('/api/channels')).channels.find((c) => c.kind === 'text');
  const random = (await api('/api/channels', { kind: 'text', name: 'random' })).channel;
  for (let i = 1; i <= 70; i += 1) {
    await post(general.id, `general message ${i}`);
    await post(random.id, `random message ${i}`);
  }

  const app = launchApp({ port: DEBUG_PORT, userDataDir });
  procs.push(app);
  const cdp = await attach(await findPage(DEBUG_PORT));
  await sleep(1200);

  const set = (id, value) => cdp.evaluate(`
    const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `);
  await set('server-url', BASE);
  await sleep(1500);
  await set('username', 'tester');
  await set('account-password', 'hunter22');
  await cdp.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'", {
    label: 'the channels view',
  }).catch(async (err) => {
    console.error(await cdp.evaluate(`return JSON.stringify({
      view: document.querySelector('.view[data-active]')?.id,
      button: document.getElementById('continue').textContent,
      error: document.getElementById('connect-error').textContent,
      stepAccount: !document.getElementById('step-account').hidden,
      stepServer: !document.getElementById('step-server').hidden,
      user: document.getElementById('username').value,
    })`));
    throw err;
  });
  await sleep(500);

  // --- the first visit ----------------------------------------------------
  await openChannel(cdp, general.name);
  let s = await logState(cdp);
  check('the history is long enough to scroll', s.scrollable, `${s.count} messages`);
  check(
    'the first time a channel is opened it is at the bottom, on the newest message',
    s.fromBottom < 40 && s.lastText.includes('general message 70'),
    `${s.fromBottom}px from the bottom`,
  );

  // --- scroll up, leave, come back ---------------------------------------
  await cdp.evaluate("document.getElementById('chat-log').scrollTop = 700; return true;");
  await sleep(150);
  const before = await logState(cdp);
  const firstSeenBefore = await cdp.evaluate(`
    const log = document.getElementById('chat-log');
    const top = log.getBoundingClientRect().top;
    const row = [...log.querySelectorAll('.chat-msg')].find((r) => r.getBoundingClientRect().bottom > top + 1);
    return { id: row.dataset.id, offset: Math.round(row.getBoundingClientRect().top - top) };
  `);

  await openChannel(cdp, random.name);
  s = await logState(cdp);
  check(
    'a different channel, opened for the first time, is at the bottom too',
    s.fromBottom < 40 && s.lastText.includes('random message 70'),
    `${s.title}, ${s.fromBottom}px from the bottom`,
  );

  // Something arrives in the channel that was left, while nobody is looking.
  await post(general.id, 'general message arrived while away');
  await sleep(300);

  await openChannel(cdp, general.name);
  s = await logState(cdp);
  const firstSeenAfter = await cdp.evaluate(`
    const log = document.getElementById('chat-log');
    const top = log.getBoundingClientRect().top;
    const row = [...log.querySelectorAll('.chat-msg')].find((r) => r.getBoundingClientRect().bottom > top + 1);
    return { id: row.dataset.id, offset: Math.round(row.getBoundingClientRect().top - top) };
  `);
  // Not compared in pixels: the page the server sends is the newest 50, so
  // the message that arrived meanwhile pushes the oldest off the top and the
  // same place is a different number of pixels down. The message is the answer.
  check(
    'coming back to a channel scrolled up does not throw it to the bottom',
    s.fromBottom > 40,
    `${s.fromBottom}px from the bottom (was ${before.fromBottom})`,
  );
  check(
    'the same message is at the top of the view, the same distance down',
    firstSeenAfter.id === firstSeenBefore.id && Math.abs(firstSeenAfter.offset - firstSeenBefore.offset) <= 3,
    `message ${firstSeenBefore.id}@${firstSeenBefore.offset} -> ${firstSeenAfter.id}@${firstSeenAfter.offset}`,
  );
  check(
    'and the message that arrived meanwhile is in the history, below the view',
    (await cdp.evaluate("return document.getElementById('chat-log').textContent")).includes('arrived while away'),
  );

  // --- left at the bottom: comes back at the bottom -----------------------
  await cdp.evaluate(`
    const log = document.getElementById('chat-log'); log.scrollTop = log.scrollHeight; return true;
  `);
  await sleep(150);
  await openChannel(cdp, random.name);
  await post(random.id, 'random message arrived while away');
  await sleep(300);
  await openChannel(cdp, general.name);
  await cdp.evaluate(`
    const log = document.getElementById('chat-log'); log.scrollTop = log.scrollHeight; return true;
  `);
  await sleep(150);
  await openChannel(cdp, random.name);
  s = await logState(cdp);
  check(
    'a channel left at the bottom comes back at the bottom, with what arrived',
    s.fromBottom < 40 && s.lastText.includes('arrived while away'),
    `${s.fromBottom}px from the bottom, last: "${s.lastText.slice(-30)}"`,
  );

  // --- searching and clearing keeps the place ------------------------------
  await openChannel(cdp, general.name);
  await cdp.evaluate("document.getElementById('chat-log').scrollTop = 400; return true;");
  await sleep(150);
  const beforeSearch = await logState(cdp);
  await set('chat-search', 'message 5');
  await sleep(800);
  await set('chat-search', '');
  await sleep(800);
  s = await logState(cdp);
  check(
    'clearing a search comes back to where the search was started from',
    Math.abs(s.top - beforeSearch.top) <= 3,
    `scrollTop ${beforeSearch.top} -> ${s.top}`,
  );

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
