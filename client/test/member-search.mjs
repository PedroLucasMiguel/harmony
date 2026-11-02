// Finding somebody in the member list.
//
//   - the box under "Members" shows only who has the words, by the name shown and the name signed up with
//   - case and accents do not matter, every word is needed, and the count says how many match
//   - with no match it says so; the X and Escape give the whole list back
//   - the list keeps its filter when it is drawn again (somebody comes online, an account is made)
//
//   node client/test/member-search.mjs

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
const DEBUG_PORT = 9520;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-msearch-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-msearch-profile-'));
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
  const boss = await api('/api/accounts/register', { nickname: 'boss', password: 'hunter22', ownerKey });
  const jose = await api('/api/accounts/register', { nickname: 'jose', password: 'hunter22' });
  for (const name of ['ana', 'bob', 'anabel']) await api('/api/accounts/register', { nickname: name, password: 'hunter22' });
  // Shown as something with an accent: what is looked at is the name shown, as well as the one signed up with.
  token = jose.token;
  await api('/api/accounts/display-name', { displayName: 'Jos\u00e9 Caf\u00e9' });
  token = boss.token;

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
  await set('username', 'boss');
  await set('account-password', 'hunter22');
  await cdp.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'the channels view' });
  await sleep(800);

  const members = () => cdp.evaluate(`
    return { names: [...document.querySelectorAll('#member-items .member-row .member-name')].map((n) => n.textContent),
      heads: [...document.querySelectorAll('#member-items .member-head')].map((h) => h.textContent),
      count: document.getElementById('member-count').textContent, empty: document.querySelector('#member-items .member-empty')?.textContent ?? '',
      clear: !document.getElementById('member-search-clear').hidden };`);
  const search = async (text) => {
    await cdp.evaluate(`const i = document.getElementById('member-search'); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
    await sleep(200);
  };

  let m = await members();
  check('the list has everybody, and a box above it', m.names.length === 5 && await cdp.evaluate("return { f: Boolean(document.getElementById('member-search')) }").then((r) => r.f), JSON.stringify(m));
  const box = await cdp.evaluate("const r = document.getElementById('member-search').getBoundingClientRect(); const l = document.getElementById('member-list').getBoundingClientRect(); return { inside: r.left >= l.left && r.right <= l.right, w: Math.round(r.width) };");
  check('the box fits in the column', box.inside && box.w > 100, JSON.stringify(box));

  await search('ana');
  m = await members();
  check('"ana" leaves the two people who have it: Ana and Anabel', m.names.slice().sort().join() === 'ana,anabel', JSON.stringify(m));
  check('the count says how many match, and the X is there', /2 of 5 match/.test(m.count) && m.clear, JSON.stringify(m));
  check('and an empty "Online" is not drawn above them', !m.heads.some((h) => /^Online/.test(h)), JSON.stringify(m.heads));
  await search('ANA BEL');
  check('case does not matter and every word is needed', (await members()).names.join() === 'anabel', '');
  await search('cafe');
  check('accents do not matter: "cafe" finds Jos\u00e9 Caf\u00e9, by the name shown', (await members()).names.join() === 'Jos\u00e9 Caf\u00e9', JSON.stringify(await members()));
  await search('jose');
  check('and by the name signed up with, which is not the one shown', (await members()).names.join() === 'Jos\u00e9 Caf\u00e9', JSON.stringify(await members()));
  await search('nobody like this');
  m = await members();
  check('with no match it says so, and draws no headings', m.names.length === 0 && /No member has those words/.test(m.empty) && m.heads.length === 0, JSON.stringify(m));

  await cdp.evaluate("document.getElementById('member-search-clear').click(); return true;");
  await sleep(200);
  m = await members();
  check('the X gives the whole list back', m.names.length === 5 && !m.clear && /of 5$/.test(m.count) && m.heads.length >= 2, JSON.stringify(m));
  await search('bob');
  await cdp.evaluate("document.getElementById('member-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return true;");
  await sleep(200);
  check('Escape takes back what was typed', (await members()).names.length === 5 && await cdp.evaluate("return { v: document.getElementById('member-search').value }").then((r) => r.v === ''), '');

  // the list is drawn again when somebody arrives: the words stay
  await search('an');
  const before = (await members()).names.length;
  await api('/api/accounts/register', { nickname: 'anders', password: 'hunter22' });
  await sleep(1500);
  m = await members();
  check('an account made while it is filtered is drawn by the filter, and the box keeps its words', m.names.length === before + 1 && m.names.includes('anders')
    && await cdp.evaluate("return { v: document.getElementById('member-search').value }").then((r) => r.v === 'an'), JSON.stringify(m));
  const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })).data;
  (await import('node:fs')).writeFileSync(`${process.env.SHOT_DIR ?? tmpdir()}/member-search.png`, Buffer.from(shot, 'base64'));

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
