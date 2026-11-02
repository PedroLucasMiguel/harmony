// Searching and starred messages on a phone: a real client, a phone's screen and a finger (Chrome's device emulation).
//
//   - focusing the search box gives it the row (the name and the buttons make way) and a way back
//   - the dropdown of filters is on the screen, as wide as it, with rows big enough to press
//   - Enter puts the keyboard away and shows the answers, over the whole screen, with what was asked at the top
//   - what was asked is pressed to change it; an answer is pressed to go to it
//   - the star's panel is a whole screen, with a close button and the search over what is starred
//
//   node client/test/search-mobile.mjs

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
const DEBUG_PORT = 9500;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-smob-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-smob-profile-'));
const { check, summary } = reporter();
const procs = [];
let fakeMtx = null;
let serverLog = '';
let ownerKey = null;

process.on('exit', () => {
  for (const p of procs) { try { p.kill(); } catch { /* gone */ } }
  try { fakeMtx?.close(); } catch { /* closed */ }
});

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
      if (serverLog.includes('control server on')) { clearTimeout(timer); done(p); }
    });
    p.stderr.on('data', (b) => (serverLog += b.toString()));
  });
}

const setInput = (id, value) =>
  `{ const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)}; `
  + 'i.dispatchEvent(new Event(\'input\', {bubbles:true})); i.dispatchEvent(new Event(\'change\', {bubbles:true})); }';



async function run() {
  await startFakeMediaMtx();
  await startHarmonyServer();
  const app = launchApp({ port: DEBUG_PORT, userDataDir });
  procs.push(app);
  const cdp = await attach(await findPage(DEBUG_PORT));
  await sleep(1200);
  await cdp.evaluate(`${setInput('server-url', BASE)} return true;`);
  await sleep(1500);
  for (const [id, value] of [['username', 'pedro'], ['account-password', 'hunter22'], ['account-confirm', 'hunter22'], ['owner-key', ownerKey]]) {
    await cdp.evaluate(`${setInput(id, value)} return true;`);
  }
  await cdp.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'");
  const reg = await (await fetch(`${BASE}/api/accounts/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname: 'ana', password: 'hunter22' }) })).json();
  const chans = await (await fetch(`${BASE}/api/channels`, { headers: { Authorization: `Bearer ${reg.token}` } })).json();
  const general = chans.channels.find((c) => c.kind === 'text');
  for (let i = 1; i <= 30; i += 1) {
    await fetch(`${BASE}/api/channels/${general.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${reg.token}` }, body: JSON.stringify({ body: `message number ${i} from ana, with some words to fill the line` }) });
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  // So that focus() is a real focus, as it is on a phone, and :focus-within is what it says.
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await cdp.evaluate("await harmony.settings.set({ uiScale: 100 }); return true;");
  await sleep(800);
  await cdp.evaluate(`[...document.querySelectorAll('#channel-items li.channel-row')].find((r) => r.textContent.includes('general')).click(); return true;`);
  await sleep(1200);

  const rect = (id) => cdp.evaluate(`const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) };`);
  const shown = (selector) => cdp.evaluate(`const e = document.querySelector(${JSON.stringify(selector)}); return { on: Boolean(e) && getComputedStyle(e).display !== 'none' && !e.hidden && e.getBoundingClientRect().width > 0 };`).then((r) => r.on);
  const typeSearch = (text) => cdp.evaluate(`const i = document.getElementById('chat-search'); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  const enter = () => cdp.evaluate("document.getElementById('chat-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true;");
  const focused = () => cdp.evaluate("return { id: document.activeElement?.id ?? '' };").then((r) => r.id);

  // --- the box takes the row -----------------------------------------------------------------------------------------------
  const before = await rect('search-box');
  await cdp.evaluate("document.getElementById('chat-search').focus(); return true;");
  await sleep(500);
  const wide = await rect('search-box');
  check('focused, the box takes the whole row: it was a small pill', before.w < 220 && wide.w > 340, `${before.w} -> ${wide.w}`);
  check('the name and the pin and star make way', !(await shown('#chat-name')) && !(await shown('#chat-pins')) && !(await shown('#chat-stars')), '');
  check('and a back arrow is where the magnifier was', (await shown('#search-box .search-back')) && !(await shown('#search-box .search-box-icon')), '');

  // --- the dropdown -----------------------------------------------------------------------------------------------------------------
  const pop = await cdp.evaluate(`const p = document.getElementById('search-pop'); const r = p.getBoundingClientRect(); const box = document.getElementById('search-box').getBoundingClientRect();
    const rows = [...p.querySelectorAll('.search-row')];
    return { open: !p.hidden, top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), under: r.top >= box.bottom - 1,
      rows: rows.length, smallest: Math.min(...rows.map((x) => Math.round(x.getBoundingClientRect().height))), win: { w: innerWidth, h: innerHeight } };`);
  check('the filters are offered, on the screen, as wide as it and under the box', pop.open && pop.rows >= 5 && pop.under && pop.left === 0 && pop.right === pop.win.w && pop.bottom <= pop.win.h && pop.top < pop.win.h - 200, JSON.stringify(pop));
  check('each row is as tall as a finger needs', pop.smallest >= 44, String(pop.smallest));
  await cdp.evaluate("document.querySelectorAll('#search-pop .search-row')[0].click(); return true;");
  await sleep(400);
  const people = await cdp.evaluate("const p = document.getElementById('search-pop'); const r = p.getBoundingClientRect(); return { rows: p.querySelectorAll('.search-row').length, inside: r.top < innerHeight && r.bottom <= innerHeight };");
  check('choosing from: offers the people, on the screen too', people.rows >= 2 && people.inside, JSON.stringify(people));
  const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })).data;
  (await import('node:fs')).writeFileSync(`${process.env.SHOT_DIR ?? tmpdir()}/search-mobile-people.png`, Buffer.from(shot, 'base64'));

  // --- back ----------------------------------------------------------------------------------------------------------------------
  await cdp.evaluate("document.getElementById('chat-search').value = ''; document.getElementById('chat-search').dispatchEvent(new Event('input', { bubbles: true })); return true;");
  await cdp.evaluate("document.querySelector('#search-box .search-back').click(); return true;");
  await sleep(500);
  check('the back arrow puts the list away and gives the row back', !(await cdp.evaluate("return { o: !document.getElementById('search-pop').hidden }")).o
    && (await shown('#chat-name')) && (await shown('#chat-pins')) && await focused() !== 'chat-search', await focused());

  // --- searching -----------------------------------------------------------------------------------------------------------------
  await typeSearch('number 1');
  await sleep(200);
  await enter();
  await waitFor(cdp, "!document.getElementById('search-results').hidden && document.querySelectorAll('#search-results .search-card').length > 0", { label: 'the answers' });
  await sleep(300);
  const answers = await cdp.evaluate(`const p = document.getElementById('search-results'); const r = p.getBoundingClientRect();
    return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), win: { w: innerWidth, h: innerHeight },
      query: p.querySelector('.search-query')?.textContent ?? '', queryShown: getComputedStyle(p.querySelector('.search-query')).display !== 'none',
      count: document.getElementById('sr-count').textContent, active: document.activeElement?.id ?? '' };`);
  check('Enter shows the answers over the whole screen, and the keyboard is put away',
    answers.left === 0 && answers.right === answers.win.w && answers.top <= 2 && answers.bottom >= answers.win.h - 2 && answers.active !== 'chat-search', JSON.stringify(answers));
  check('they say what was asked, at the top, and how many', answers.queryShown && /number 1/.test(answers.query) && /results/.test(answers.count), JSON.stringify(answers));
  const shot2 = (await cdp.send('Page.captureScreenshot', { format: 'png' })).data;
  (await import('node:fs')).writeFileSync(`${process.env.SHOT_DIR ?? tmpdir()}/search-mobile-results.png`, Buffer.from(shot2, 'base64'));

  await cdp.evaluate("document.querySelector('#search-results .search-query').click(); return true;");
  await sleep(400);
  const edit = await cdp.evaluate("return { open: !document.getElementById('search-results').hidden, active: document.activeElement?.id ?? '', value: document.getElementById('chat-search').value };");
  check('pressing what was asked takes you back to change it, with the words as they were', !edit.open && edit.active === 'chat-search' && edit.value === 'number 1', JSON.stringify(edit));
  await enter();
  await waitFor(cdp, "!document.getElementById('search-results').hidden && document.querySelectorAll('#search-results .search-card').length > 0", { label: 'the answers again' });
  await sleep(300);
  await cdp.evaluate("document.querySelector('#search-results .search-card .pin-body').click(); return true;");
  await sleep(1200);
  const went = await cdp.evaluate("return { closed: document.getElementById('search-results').hidden, flashed: Boolean(document.querySelector('#chat-log .chat-msg[data-jumped]')) };");
  check('pressing an answer goes to the message and puts the answers away', went.closed && went.flashed, JSON.stringify(went));

  // --- starred ---------------------------------------------------------------------------------------------------------------------
  await cdp.evaluate(`const rows = [...document.querySelectorAll('#chat-log .chat-msg')]; for (const r of rows.slice(2, 5)) r.querySelector('.star-tool').click(); return true;`);
  await sleep(300);
  await cdp.evaluate("document.getElementById('chat-stars').click(); return true;");
  await sleep(500);
  const stars = await cdp.evaluate(`const p = document.getElementById('stars-pop'); const r = p.getBoundingClientRect();
    return { open: !p.hidden, top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), win: { w: innerWidth, h: innerHeight },
      cards: p.querySelectorAll('.pin-card').length, close: getComputedStyle(p.querySelector('.pins-close')).display !== 'none' };`);
  check('the star\'s panel is the whole screen, with a close button', stars.open && stars.left === 0 && stars.right === stars.win.w && stars.top <= 2 && stars.bottom >= stars.win.h - 2 && stars.close && stars.cards === 3, JSON.stringify(stars));
  await cdp.evaluate("const i = document.getElementById('stars-search'); i.focus(); i.value = 'number 4'; i.dispatchEvent(new Event('input', { bubbles: true })); return true;");
  await sleep(300);
  check('and searches what is starred', await cdp.evaluate("return { n: document.querySelectorAll('#stars-pop .pin-card').length }").then((r) => r.n === 1), '');
  const shot3 = (await cdp.send('Page.captureScreenshot', { format: 'png' })).data;
  (await import('node:fs')).writeFileSync(`${process.env.SHOT_DIR ?? tmpdir()}/search-mobile-stars.png`, Buffer.from(shot3, 'base64'));
  await cdp.evaluate("document.querySelector('#stars-pop .pins-close').click(); return true;");
  await sleep(300);
  check('the close button puts it away', await cdp.evaluate("return { h: document.getElementById('stars-pop').hidden }").then((r) => r.h), '');
  await cdp.evaluate("document.getElementById('chat-stars').click(); return true;");
  await sleep(300);
  await cdp.evaluate("document.querySelector('#stars-pop .pin-card .pin-body').click(); return true;");
  await sleep(900);
  check('pressing a starred message goes to it and puts the panel away', await cdp.evaluate("return { ok: document.getElementById('stars-pop').hidden && Boolean(document.querySelector('#chat-log .chat-msg[data-jumped]')) }").then((r) => r.ok), '');

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
