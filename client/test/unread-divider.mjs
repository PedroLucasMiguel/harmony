// What is new in a text channel: its name in the sidebar, and the line in the log.
//
//   node client/test/unread-divider.mjs
//
// A name is dim while the channel has nothing new and the channel is not open,
// and bright (and bolder) while it has news or is the one on screen. Entering a
// channel with news shows the last of what was read, then a line, then what is
// new; leaving and coming back finds nothing new and no line.

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const HARMONY_PORT = 18226;
const FAKE_MTX_PORT = 20126;
const DEBUG_PORT = 9501;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-news-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-news-profile-'));
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
const say = (who, channelId, body) => fetch(`${BASE}/api/channels/${channelId}/messages`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${as[who]}` }, body: JSON.stringify({ body }),
});

async function run() {
  await startFakeMediaMtx();
  await startServer();
  for (const name of ['boss', 'ana']) {
    const res = await fetch(`${BASE}/api/accounts/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: name, password: 'hunter22', ...(name === 'boss' ? { ownerKey } : {}) }),
    });
    as[name] = (await res.json()).token;
  }
  token = as.boss;
  const general = (await api('/api/channels')).channels.find((c) => c.kind === 'text');
  const makeChannel = async (name) => (await api('/api/channels', { kind: 'text', name })).channel;
  const busy = await makeChannel('busy');
  const quiet = await makeChannel('quiet');
  const long = await makeChannel('long');

  // History from before boss ever looked: all of it counts as read.
  for (let i = 1; i <= 6; i += 1) await say('ana', busy.id, `old ${i}`);
  await say('ana', long.id, 'long old 1');
  await say('ana', long.id, 'long old 2');

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

  const row = (name) => cdp.evaluate(`
    const li = [...document.querySelectorAll('#channel-items li.channel-row')].find((l) => l.querySelector('.channel-name')?.textContent === ${JSON.stringify(name)});
    if (!li) return null;
    const n = li.querySelector('.channel-name');
    return { read: li.hasAttribute('data-read'), unread: li.hasAttribute('data-unread'), viewing: li.hasAttribute('data-viewing'),
      color: getComputedStyle(n).color, weight: getComputedStyle(n).fontWeight };`);
  const open = (name) => cdp.evaluate(`
    [...document.querySelectorAll('#channel-items li.channel-row')].find((l) => l.querySelector('.channel-name')?.textContent === ${JSON.stringify(name)}).click(); return true;`);
  const log = () => cdp.evaluate(`
    const rows = [...document.getElementById('chat-log').children];
    const at = rows.findIndex((r) => r.classList.contains('new-divider'));
    const text = (r) => r.querySelector?.('.text')?.textContent?.trim() ?? '';
    return { count: rows.filter((r) => r.classList.contains('chat-msg')).length, divider: at,
      above: at > 0 ? text(rows[at - 1]) : null, below: at >= 0 ? text(rows[at + 1]) : null,
      after: at >= 0 ? rows.slice(at + 1).filter((r) => r.classList.contains('chat-msg')).length : null,
      dividerTop: at >= 0 ? Math.round(rows[at].getBoundingClientRect().top - document.getElementById('chat-log').getBoundingClientRect().top) : null,
      label: at >= 0 ? rows[at].textContent : null };`);

  await open('general');
  await waitFor(cdp, "document.getElementById('chat-name').textContent === '#general'", { label: 'general open' });
  await sleep(500);

  const start = { busy: await row('busy'), quiet: await row('quiet'), general: await row('general') };
  check('with nothing new, the channels that are not open are dim, and the one that is open is not',
    start.busy.read && start.quiet.read && !start.general.read && start.general.viewing, JSON.stringify(start));
  check('and dim is a different colour', start.busy.color !== start.general.color, `${start.busy.color} vs ${start.general.color}`);

  const voiceRow = await row('voice');
  check('a voice channel you are not in is dim too', voiceRow.read && voiceRow.color === start.busy.color, JSON.stringify(voiceRow));

  // --- news arrives -----------------------------------------------------------------------------------------------------------
  for (let i = 1; i <= 3; i += 1) await say('ana', busy.id, `new ${i}`);
  await waitFor(cdp, `[...document.querySelectorAll('#channel-items li.channel-row')].some((l) => l.querySelector('.channel-name')?.textContent === 'busy' && l.hasAttribute('data-unread'))`, { label: 'the news in busy' });
  const news = { busy: await row('busy'), quiet: await row('quiet') };
  check('a channel with news is bright and bolder', !news.busy.read && news.busy.unread && news.busy.color === start.general.color && Number(news.busy.weight) >= 700, JSON.stringify(news.busy));
  check('and the others stay dim', news.quiet.read);

  await say('boss', quiet.id, 'my own message');
  await sleep(700);
  check('what you write yourself is not news', (await row('quiet')).read);

  // --- entering it ------------------------------------------------------------------------------------------------------------
  await open('busy');
  await waitFor(cdp, "document.querySelector('#chat-log .new-divider')", { label: 'the line' });
  await sleep(600);
  const entered = await log();
  check('entering shows the last of what was read, then the line, then what is new',
    entered.above === 'old 6' && entered.below === 'new 1' && entered.after === 3 && entered.count === 9, JSON.stringify(entered));
  check('the line says what it is', /new messages/i.test(entered.label ?? ''), entered.label);
  const whileOpen = await row('busy');
  check('the open channel is bright', !whileOpen.read && whileOpen.viewing);

  await sleep(900);
  await open('general');
  await sleep(700);
  const left = await row('busy');
  check('read, and left, it goes dim again', left.read && !left.unread, JSON.stringify(left));

  await open('busy');
  await sleep(800);
  const again = await log();
  check('and coming back finds nothing new and no line', again.divider === -1 && again.count === 9, JSON.stringify(again));

  // --- read somewhere else ----------------------------------------------------------------------------------------------------------
  await open('general');
  await say('ana', quiet.id, 'while you were away');
  await waitFor(cdp, `[...document.querySelectorAll('#channel-items li.channel-row')].some((l) => l.querySelector('.channel-name')?.textContent === 'quiet' && l.hasAttribute('data-unread'))`, { label: 'the news in quiet' });
  await api(`/api/channels/${quiet.id}/read`, {});
  await waitFor(cdp, `[...document.querySelectorAll('#channel-items li.channel-row')].some((l) => l.querySelector('.channel-name')?.textContent === 'quiet' && l.hasAttribute('data-read'))`, { label: 'quiet read elsewhere' });
  check('reading it on another device dims it here', (await row('quiet')).read);

  // --- a lot of news ---------------------------------------------------------------------------------------------------------------
  for (let i = 1; i <= 70; i += 1) await say('ana', long.id, `long new ${i}`);
  await waitFor(cdp, `[...document.querySelectorAll('#channel-items li.channel-row')].some((l) => l.querySelector('.channel-name')?.textContent === 'long' && l.hasAttribute('data-unread'))`, { label: 'the news in long' });
  await open('long');
  await waitFor(cdp, "document.querySelector('#chat-log .new-divider')", { label: 'the line in long' });
  await sleep(900);
  const many = await log();
  check('with more news than a page the history is read back to where the line belongs',
    many.above === 'long old 2' && many.below === 'long new 1' && many.after === 70, JSON.stringify(many));
  check('and the log is at the line, a little of what was read above it', many.dividerTop >= 20 && many.dividerTop <= 160, String(many.dividerTop));

  await cdp.send('Page.enable');
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(userDataDir, 'news.png'), Buffer.from(shot.data, 'base64'));
  console.log('screenshot:', join(userDataDir, 'news.png'));

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
