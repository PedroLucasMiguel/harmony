// A name is drawn the same size in every font, wherever it is on the page.
//
// fonts.css scales each face (--name-scale) so that its letters come out the size of the ordinary font's. That is a
// font-size on the name, and any rule of the place the name is in that also sets a font-size on it, with more weight
// than the face's own, wins -- and the face is drawn unscaled there (a pixel font twice the size of the rest, beside
// the same name in the chat). This goes through the places a name is shown and, for every name with a face, compares
// its size with and without the face: it must be the face's scale.
//
//   node client/test/name-font-places.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const HARMONY_PORT = 18210;
const FAKE_MTX_PORT = 20110;
const DEBUG_PORT = 9510;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-nfa-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-nfa-profile-'));
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
  const ana = await api('/api/accounts/register', { nickname: 'ana', password: 'hunter22' });
  const bob = await api('/api/accounts/register', { nickname: 'bob', password: 'hunter22' });
  const as = async (who, path, body) => { const keep = token; token = who; try { return await api(path, body); } finally { token = keep; } };
  await as(boss.token, '/api/accounts/name-font', { font: 'press-start' });
  await as(ana.token, '/api/accounts/name-font', { font: 'pacifico' });
  await as(bob.token, '/api/accounts/name-font', { font: 'bebas' });
  token = boss.token;
  const general = (await api('/api/channels')).channels.find((c) => c.kind === 'text');
  const say = async (who, body) => (await as(who, `/api/channels/${general.id}/messages`, { body })).message;
  await say(boss.token, 'a word from the boss');
  const pinned = await say(ana.token, 'a word from ana, pinned');
  await say(bob.token, 'a word from bob');
  await api(`/api/messages/${pinned.id}/pin`, { pinned: true });

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
  await sleep(600);
  await openChannel(cdp, general.name);

  /** Every name with a face that can be seen: its size with the face, and without, and what the face says it should be. */
  const audit = async (place) => {
    const found = await cdp.evaluate(`
      const out = [];
      for (const node of document.querySelectorAll('[data-name-font]')) {
        const box = node.getBoundingClientRect();
        if (!box.width || !box.height) continue;
        const face = node.dataset.nameFont;
        const cs = getComputedStyle(node);
        const withFace = parseFloat(cs.fontSize);
        const scale = parseFloat(cs.getPropertyValue('--name-scale'));
        node.removeAttribute('data-name-font');
        const without = parseFloat(getComputedStyle(node).fontSize);
        node.setAttribute('data-name-font', face);
        const path = (() => { const p = node.parentElement; return node.tagName.toLowerCase() + (node.className ? '.' + String(node.className).trim().split(/\\s+/).join('.') : '') + (node.id ? '#' + node.id : '') + ' < ' + (p ? p.tagName.toLowerCase() + (p.className ? '.' + String(p.className).trim().split(/\\s+/)[0] : '') + (p.id ? '#' + p.id : '') : ''); })();
        out.push({ path, face, ratio: Math.round((withFace / without) * 100) / 100, scale });
      }
      return out;`);
    const bad = found.filter((f) => Math.abs(f.ratio - f.scale) > 0.02);
    const distinct = [...new Map(bad.map((b) => [b.path + b.face, b])).values()];
    check(`${place}: ${found.length} names with a face, each at its face's scale`, found.length > 0 && distinct.length === 0, JSON.stringify(distinct));
    return found.length;
  };

  // --- the channels page -----------------------------------------------------------------------------------------------------------
  await audit('the channels page (you at the bottom, the chat, the members)');
  // search results
  await cdp.evaluate("const i = document.getElementById('chat-search'); i.focus(); i.value = 'word'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true;");
  await waitFor(cdp, "!document.getElementById('search-results').hidden && document.querySelectorAll('#search-results .search-card').length > 0", { label: 'answers' });
  await sleep(300);
  await audit('the search results');
  await cdp.evaluate("document.getElementById('sr-close').click(); document.getElementById('chat-search-clear').click(); return true;");
  // the people offered by from:
  await cdp.evaluate("const i = document.getElementById('chat-search'); i.focus(); i.value = 'from:'; i.dispatchEvent(new Event('input', { bubbles: true })); return true;");
  await sleep(300);
  await audit('the people offered in the search box');
  await cdp.evaluate("document.getElementById('chat-search-clear').click(); document.activeElement.blur(); return true;");
  // pins
  await cdp.evaluate("document.getElementById('chat-pins').click(); return true;");
  await sleep(300);
  await audit('the pinned messages');
  await cdp.evaluate("document.getElementById('chat-pins').click(); return true;");
  // stars
  await cdp.evaluate("for (const r of document.querySelectorAll('#chat-log .chat-msg')) r.querySelector('.star-tool').click(); document.getElementById('chat-stars').click(); return true;");
  await sleep(300);
  await audit('the starred messages');
  await cdp.evaluate("document.getElementById('chat-stars').click(); return true;");
  // a profile card
  await cdp.evaluate("document.querySelector('#member-items .member-row .member-name').click(); return true;");
  await sleep(500);
  await audit('a profile card');
  await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;");
  await sleep(300);

  // --- the phone's layout -----------------------------------------------------------------------------------------------------------
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  await audit('the channels page on a phone');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(300);

  // --- the settings page (your own banner) ----------------------------------------------------------------------------------------
  await cdp.evaluate("document.getElementById('channels-settings')?.click() ?? document.querySelector('[data-open-settings]')?.click(); return true;");
  await sleep(700);
  await audit('the settings page');

  // --- places that are not on screen without a call or a conversation: the same rules, on a name put in them -----------------------
  const probe = (inside, tag, className) => cdp.evaluate(`
    const host = document.querySelector(${JSON.stringify(inside)});
    const node = document.createElement(${JSON.stringify(tag)}); node.className = ${JSON.stringify(className)}; node.textContent = 'anatakehara';
    host.append(node);
    node.dataset.nameFont = 'press-start';
    const cs = getComputedStyle(node);
    const withFace = parseFloat(cs.fontSize); const scale = parseFloat(cs.getPropertyValue('--name-scale'));
    node.removeAttribute('data-name-font');
    const without = parseFloat(getComputedStyle(node).fontSize);
    node.remove();
    return { ratio: Math.round((withFace / without) * 100) / 100, scale };`);
  for (const [place, inside, tag, className] of [
    ['the list of conversations', '#dm-list', 'span', 'dm-row-name'],
    ['the call\'s roster', '#voice-roster', 'span', 'member-name'],
    ['the members list', '#member-items', 'span', 'member-name'],
    ['the conversation\'s header', '#dm-name', 'span', ''],
    ['a message in a conversation', '#dm-log', 'span', 'who'],
    ['the list of who is told', 'body', 'span', 'notified-name'],
    ['your own banner in the settings', 'body', 'span', 'profile-banner-name'],
  ]) {
    const r = await probe(inside, tag, className);
    check(`${place}: a name with a face is at its face's scale`, Math.abs(r.ratio - r.scale) <= 0.02, JSON.stringify(r));
  }

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
