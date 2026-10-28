// Settings > Profile, driven through the real client against a real server.
//
//   node client/test/profile-tab.mjs
//
// Every check also reads the account back from the SERVER, because the page
// saying "Saved." proves nothing about what everybody else is going to see.
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

const HARMONY_PORT = 18200;
const FAKE_MTX_PORT = 20100;
const DEBUG_PORT = 9491;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-profile-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-profile-profile-'));
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
const me = async () => (await api('/api/accounts/me')).user;

async function run() {
  await startFakeMediaMtx();
  await startServer();
  token = (await api('/api/accounts/register', { nickname: 'tester', password: 'hunter22', ownerKey })).token;

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

  const text = (id) => cdp.evaluate(`return document.getElementById(${JSON.stringify(id)}).textContent`);
  const value = (id) => cdp.evaluate(`return document.getElementById(${JSON.stringify(id)}).value`);
  const click = (id) => cdp.evaluate(`document.getElementById(${JSON.stringify(id)}).click(); return true;`);

  // --- the tab ------------------------------------------------------------------------------
  await click('voice-config');
  const tabs = await cdp.evaluate("return [...document.querySelectorAll('.settings-tab')].map((t) => t.dataset.tab)");
  check('Settings has a Profile tab, first in the menu', tabs[0] === 'profile', tabs.join(', '));
  await cdp.evaluate("document.querySelector('.settings-tab[data-tab=\"profile\"]').click(); return true;");
  const shown = await cdp.evaluate(`
    const page = document.querySelector('.settings-page[data-page="profile"]');
    return { visible: !page.hidden, others: [...document.querySelectorAll('.settings-page')].filter((p) => p !== page && !p.hidden).length };`);
  check('opening it shows its page and nothing else', shown.visible && shown.others === 0, JSON.stringify(shown));
  check('it shows the username and role', (await text('profile-nickname')) === 'tester' && (await text('profile-role')) === 'owner',
    `${await text('profile-nickname')} / ${await text('profile-role')}`);
  check('the name field starts empty, with the username as its hint',
    (await value('profile-name')) === '' && (await cdp.evaluate("return document.getElementById('profile-name').placeholder")) === 'tester');
  check('Save has nothing to do yet, and neither has "Remove picture"',
    (await cdp.evaluate("return document.getElementById('profile-name-save').disabled")) === true
    && (await cdp.evaluate("return document.getElementById('profile-remove').disabled")) === true);
  const initials = await text('profile-avatar');
  check('with no picture, the initials are drawn', initials === 'TE', initials);

  // --- display name ---------------------------------------------------------------------------------
  await set('profile-name', 'Ana María');
  check('typing a new name enables Save', (await cdp.evaluate("return document.getElementById('profile-name-save').disabled")) === false);
  await click('profile-name-save');
  await sleep(700);
  check('the server has the new display name', (await me()).displayName === 'Ana María', (await me()).displayName);
  check('the bar shows it at once', (await text('channels-who')) === 'Ana María', await text('channels-who'));
  check('and the page says so', (await text('profile-name-note')) === 'Saved.', await text('profile-name-note'));
  check('the initials follow the name', (await text('profile-avatar')) === 'AN', await text('profile-avatar'));
  check('"Use my username" is available now',
    (await cdp.evaluate("return document.getElementById('profile-name-reset').disabled")) === false);

  // Enter saves the name and must not close the dialog it sits in.
  await set('profile-name', 'Pedro');
  await cdp.evaluate(`
    const i = document.getElementById('profile-name');
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;`);
  await sleep(700);
  check('Enter in the field saves it', (await me()).displayName === 'Pedro', (await me()).displayName);
  check('and keeps Settings open', (await cdp.evaluate("return document.getElementById('devices').open")) === true);

  await click('profile-name-reset');
  await sleep(700);
  const reset = await me();
  check('"Use my username" puts the username back, on the server', !reset.customName && (reset.displayName || reset.nickname) === 'tester',
    JSON.stringify({ displayName: reset.displayName, customName: reset.customName }));
  check('and empties the field', (await value('profile-name')) === '');

  // --- picture -----------------------------------------------------------------------------------------
  const pick = () => cdp.evaluate(`
    const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 200;
    const x = canvas.getContext('2d'); x.fillStyle = '#e0457b'; x.fillRect(0, 0, 300, 200);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const input = document.getElementById('avatar-file');
    const files = new DataTransfer(); files.items.add(new File([blob], 'me.png', { type: 'image/png' }));
    input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;`);
  // "Change picture" opens the file chooser by clicking the hidden input.
  const opens = await cdp.evaluate(`
    let clicked = false;
    const input = document.getElementById('avatar-file');
    input.addEventListener('click', (e) => { clicked = true; e.preventDefault(); }, { once: true });
    document.getElementById('profile-choose').click();
    return clicked;`);
  check('"Change picture" opens the file chooser', opens === true);
  await pick();
  await waitFor(cdp, "!!document.querySelector('#profile-avatar img')", { label: 'the picture on the page' });
  const after = await me();
  check('the server has a picture for the account', /^[0-9a-f]{64}$/.test(after.avatarHash ?? ''), String(after.avatarHash).slice(0, 12));
  check('the page draws it, and the bar does too',
    (await cdp.evaluate("return !!document.querySelector('#channels-avatar img')")) === true);
  check('"Remove picture" is available now',
    (await cdp.evaluate("return document.getElementById('profile-remove').disabled")) === false);

  await click('profile-remove');
  await sleep(900);
  check('removing it clears it on the server', (await me()).avatarHash == null, String((await me()).avatarHash));
  check('and the initials come back', (await text('profile-avatar')) === 'TE', await text('profile-avatar'));
  check('and the bar loses it too', (await cdp.evaluate("return !!document.querySelector('#channels-avatar img')")) === false);

  // --- the bar's own shortcuts still work -------------------------------------------------------------------
  await cdp.evaluate("document.getElementById('devices').close(); return true;");
  await click('self-name');
  await waitFor(cdp, "document.getElementById('ask').open", { label: 'the name dialog' });
  const dialogTitle = await text('ask-title');
  check('the name in the bar still opens its own dialog', dialogTitle === 'Your display name', dialogTitle);

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
