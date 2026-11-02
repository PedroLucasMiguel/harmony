// Who may pin: admins, and people with the permission -- and nobody else sees the controls.
//
//   - a member with no role has no pin on any message and no way to unpin in the list of pins
//   - given a role that holds the permission, the controls appear at once, without signing in again, and work
//   - and when the role is taken away they go again
//
// MediaMTX is stubbed, as in channels-ui.mjs: nothing here touches media.
//
//   node client/test/pin-permission.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const HARMONY_PORT = 18160;
const FAKE_MTX_PORT = 20040;
const DEBUG_PORT = 9441;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-pinperm-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-pinperm-profile-'));
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

  const owner = await api('/api/accounts/register', { nickname: 'boss', password: 'hunter22', ownerKey });
  const ownerToken = owner.token;
  const ana = await api('/api/accounts/register', { nickname: 'ana', password: 'hunter22' });
  const anaId = ana.user.id;
  token = ownerToken;
  const general = (await api('/api/channels')).channels.find((c) => c.kind === 'text');
  const mine = (await post(general.id, 'pin me if you may')).message;
  const already = (await post(general.id, 'already pinned by the boss')).message;
  await api(`/api/messages/${already.id}/pin`, { pinned: true });

  const app = launchApp({ port: DEBUG_PORT, userDataDir });
  procs.push(app);
  const cdp = await attach(await findPage(DEBUG_PORT));
  await sleep(1200);
  const set = (id, value) => cdp.evaluate(`
    const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
    i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  await set('server-url', BASE);
  await sleep(1500);
  await set('username', 'ana');
  await set('account-password', 'hunter22');
  await cdp.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'the channels view' });
  await sleep(500);
  await cdp.evaluate(`[...document.querySelectorAll('#channel-items li.channel-row')]
    .find((r) => r.querySelector('.channel-name')?.textContent === ${JSON.stringify(general.name)}).click(); return true;`);
  await waitFor(cdp, "document.querySelectorAll('#chat-log .chat-msg').length >= 2", { label: 'the messages' });
  await sleep(400);

  const controls = () => cdp.evaluate(`
    return {
      pinTools: document.querySelectorAll('#chat-log .chat-msg .msg-tool[data-icon="push-pin"]').length,
      inList: (() => {
        const pop = document.getElementById('pins-pop');
        return { open: !pop.hidden, cards: pop.querySelectorAll('.pin-card').length, unpins: pop.querySelectorAll('.pin-tool-icon').length, jumps: pop.querySelectorAll('.pin-tool:not(.pin-tool-icon)').length };
      })(),
    };`);
  const openList = async () => {
    await cdp.evaluate("const pop = document.getElementById('pins-pop'); if (pop.hidden) document.getElementById('chat-pins').click(); return true;");
    await sleep(300);
  };
  const closeList = async () => {
    await cdp.evaluate("const pop = document.getElementById('pins-pop'); if (!pop.hidden) document.getElementById('chat-pins').click(); return true;");
    await sleep(150);
  };

  // --- a member with no role -----------------------------------------------------------------------------------------------
  let c = await controls();
  check('a member with no role has no pin on any message', c.pinTools === 0, JSON.stringify(c));
  check('and still sees what is pinned, in the strip', await cdp.evaluate("return /already pinned/.test(document.getElementById('chat-pinned').textContent)"), '');
  await openList();
  c = await controls();
  check('the list of pins is theirs to read and jump from, with no way to unpin', c.inList.open && c.inList.cards === 1 && c.inList.jumps === 1 && c.inList.unpins === 0, JSON.stringify(c));
  await closeList();

  // --- a role that holds the permission ----------------------------------------------------------------------------------------
  const curator = (await api('/api/roles', { name: 'Curator', permissions: ['messages.pin'] })).role;
  await api(`/api/accounts/${anaId}/roles`, { roles: [curator.id] });
  await waitFor(cdp, "document.querySelectorAll('#chat-log .chat-msg .msg-tool[data-icon=\"push-pin\"]').length > 0", { label: 'the pin, once the role arrives' });
  c = await controls();
  check('given the role, the pin is on the messages at once, without signing in again', c.pinTools >= 2, JSON.stringify(c));
  await openList();
  c = await controls();
  check('and the list has Unpin', c.inList.unpins === 1, JSON.stringify(c));
  await closeList();

  // and it works: pin the message, see it pinned
  await cdp.evaluate(`[...document.querySelectorAll('#chat-log .chat-msg')].find((r) => /pin me if you may/.test(r.textContent))
    .querySelector('.msg-tool[data-icon="push-pin"]').click(); return true;`);
  await waitFor(cdp, "/2/.test(document.querySelector('#chat-pinned .pinned-more')?.textContent ?? '')", { label: 'two pinned' });
  check('pinning works for them: two are pinned now, the one pinned last in the strip', await cdp.evaluate("return /pin me if you may/.test(document.querySelector('#chat-pinned .pinned-line').textContent)"), '');
  await openList();
  await cdp.evaluate("document.querySelectorAll('#pins-list .pin-card')[0].querySelector('.pin-tool-icon').click(); return true;");
  await waitFor(cdp, "document.querySelector('#chat-pinned .pinned-more') === null", { label: 'one let go' });
  check('and so does unpinning, from the list', await cdp.evaluate("return /already pinned/.test(document.querySelector('#chat-pinned .pinned-line').textContent)"), '');
  await closeList();

  // --- and taken away --------------------------------------------------------------------------------------------------------------
  await api(`/api/accounts/${anaId}/roles`, { roles: [] });
  await waitFor(cdp, "document.querySelectorAll('#chat-log .chat-msg .msg-tool[data-icon=\"push-pin\"]').length === 0", { label: 'the pin going' });
  await openList();
  c = await controls();
  check('the role taken away, the pin goes from the messages and Unpin from the list', c.pinTools === 0 && c.inList.unpins === 0, JSON.stringify(c));
  await closeList();

  // and the server says no to the request anyway, whatever the page shows
  const refused = await cdp.evaluate(`
    const { harmony } = await import('./bridge.js');
    try { await harmony.api.pinMessage(${JSON.stringify(BASE)}, ${mine.id}, true); return { ok: true }; } catch (err) { return { ok: false, message: err.message }; }`);
  check('the server refuses the request itself, so a page that is not the app\'s changes nothing', refused.ok === false && /allowed|pin/i.test(refused.message ?? ''), JSON.stringify(refused));

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
