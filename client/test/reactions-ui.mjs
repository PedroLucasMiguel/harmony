// Who reacted, in the real app: the card that opens when the pointer rests on a reaction, the "N others" link and the
// window that lists everybody an emoji at a time. A plain click is still the reaction itself.
//
//   node client/test/reactions-ui.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const HARMONY_PORT = 18184;
const FAKE_MTX_PORT = 20084;
const DEBUG_PORT = 9484;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-react-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-react-profile-'));
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

const setInput = (id, value) => `{ const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
  i.dispatchEvent(new Event('input', {bubbles:true})); i.dispatchEvent(new Event('change', {bubbles:true})); }`;


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

  const people = {};
  for (const name of ['ana', 'bob', 'carol', 'dave', 'eve']) {
    people[name] = (await (await fetch(`${BASE}/api/accounts/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname: name, password: 'hunter22' }) })).json()).token;
  }
  const as = (token) => ({ Authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  const general = (await (await fetch(`${BASE}/api/channels`, { headers: as(people.ana) })).json()).channels.find((c) => c.kind === 'text');
  const message = (await (await fetch(`${BASE}/api/channels/${general.id}/messages`, { method: 'POST', headers: as(people.ana), body: JSON.stringify({ body: 'react to me' }) })).json()).message;
  const react = (who, emoji) => fetch(`${BASE}/api/messages/${message.id}/react`, { method: 'POST', headers: as(people[who]), body: JSON.stringify({ emoji }) });
  for (const who of ['ana', 'bob', 'carol', 'dave', 'eve']) await react(who, '\u2705');
  for (const who of ['ana', 'bob']) await react(who, '\u{1F44D}');

  await cdp.evaluate(`[...document.querySelectorAll('#channel-items li.channel-row')].find((r) => r.textContent.includes('general')).click(); return true;`);
  await waitFor(cdp, "document.querySelectorAll('#chat-log .reaction').length === 2", { label: 'the two reactions' });

  const q = (sel) => cdp.evaluate(`return !!document.querySelector(${JSON.stringify(sel)});`);
  const text = (sel) => cdp.evaluate(`return document.querySelector(${JSON.stringify(sel)})?.textContent ?? null;`);
  const count = (sel) => cdp.evaluate(`return document.querySelectorAll(${JSON.stringify(sel)}).length;`);
  const chip = (n) => `document.querySelectorAll('#chat-log .reaction')[${n}]`;
  const hover = (n) => cdp.evaluate(`${chip(n)}.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' })); return true;`);
  const leave = (n) => cdp.evaluate(`${chip(n)}.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' })); return true;`);
  const shot = async (name) => {
    if (!process.env.REACT_SHOTS) return;
    mkdirSync(process.env.REACT_SHOTS, { recursive: true });
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.REACT_SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
  };

  // ---- the card
  check('the reactions are the checkmark (5) and the thumb (2)', (await cdp.evaluate(`return [...document.querySelectorAll('#chat-log .reaction .count')].map((n) => n.textContent).join();`)) === '5,2');
  await hover(0);
  await waitFor(cdp, "!!document.querySelector('[data-testid=\"reactions-card\"]')", { label: 'the card', timeoutMs: 5000 });
  const card = await text('[data-testid="reactions-card"]');
  check('resting on a reaction opens a card that says who reacted', /reacted by/.test(card) && /ana/.test(card) && /bob/.test(card) && /carol/.test(card), card);
  check('naming three and counting the rest as a link', /2 others/.test(await text('.reactions-card .reactions-others')) && !/dave/.test(card));
  check('the card sits above the reaction, inside the window', await cdp.evaluate(`const c = document.querySelector('.reactions-card').getBoundingClientRect(); const r = ${chip(0)}.getBoundingClientRect();
    return c.bottom <= r.top + 1 && c.left >= 0 && c.right <= innerWidth;`));
  await shot('1-card');
  await leave(0);
  await sleep(400);
  check('and goes when the pointer leaves', !(await q('[data-testid="reactions-card"]')));

  // ---- the window, from the link
  await hover(0);
  await waitFor(cdp, "!!document.querySelector('[data-testid=\"reactions-card\"]')", { label: 'the card again', timeoutMs: 5000 });
  await cdp.evaluate("document.querySelector('.reactions-card .reactions-others').click(); return true;");
  await waitFor(cdp, "!!document.querySelector('[data-testid=\"reactions-dialog\"]')", { label: 'the window' });
  check('the link opens the window, on that emoji, with everybody who chose it', (await count('[data-testid="reactions-people"] .reactions-person')) === 5 && (await count('.reactions-tab')) === 2);
  check('the card is put away when the window opens', !(await q('[data-testid="reactions-card"]')));
  const names = await cdp.evaluate(`return [...document.querySelectorAll('[data-testid="reactions-people"] .reactions-person strong')].map((n) => n.textContent).sort();`);
  check('the people are named', JSON.stringify(names) === JSON.stringify(['ana', 'bob', 'carol', 'dave', 'eve']), JSON.stringify(names));
  await shot('2-window');
  await cdp.evaluate("document.querySelectorAll('.reactions-tab')[1].click(); return true;");
  check('another emoji lists its own people', (await count('[data-testid="reactions-people"] .reactions-person')) === 2 && (await cdp.evaluate("return document.querySelectorAll('.reactions-tab')[1].getAttribute('aria-selected')")) === 'true');
  await cdp.evaluate("document.querySelector('[data-testid=\"reactions-dialog\"] .reactions-head button').click(); return true;");
  await sleep(300);
  check('the X closes it', !(await q('[data-testid="reactions-dialog"]')));

  // ---- a reaction with nobody left out still has a way in
  await hover(1);
  await waitFor(cdp, "!!document.querySelector('[data-testid=\"reactions-card\"]')", { label: 'the second card', timeoutMs: 5000 });
  check('with two people there is no "others", and the window is one click away', !(await cdp.evaluate("return /others/.test(document.querySelector('.reactions-card .reactions-line').textContent)")) && (await q('.reactions-card .reactions-all')));
  await cdp.evaluate("document.querySelector('.reactions-card .reactions-all').click(); return true;");
  await waitFor(cdp, "!!document.querySelector('[data-testid=\"reactions-dialog\"]')", { label: 'the window from "see all"' });
  check('and it opens on the emoji it was asked from', (await cdp.evaluate("return document.querySelector('.reactions-tab[aria-selected=\"true\"] .reactions-count').textContent")) === '2');
  await cdp.evaluate("document.querySelector('[data-testid=\"reactions-dialog\"]').close(); return true;");
  await sleep(300);

  // ---- a click is still the reaction; a shift-click is the window
  const before = await cdp.evaluate(`return ${chip(0)}.querySelector('.count').textContent;`);
  await cdp.evaluate(`${chip(0)}.click(); return true;`);
  await waitFor(cdp, `${chip(0)}.querySelector('.count').textContent !== '${before}'`, { label: 'my reaction counted' });
  check('a plain click still puts your own reaction on', (await cdp.evaluate(`return ${chip(0)}.querySelector('.count').textContent;`)) === '6' && (await cdp.evaluate(`return ${chip(0)}.hasAttribute('data-mine');`)));
  check('without opening anything', !(await q('[data-testid="reactions-dialog"]')));
  await cdp.evaluate(`${chip(0)}.dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true, cancelable: true })); return true;`);
  await waitFor(cdp, "!!document.querySelector('[data-testid=\"reactions-dialog\"]')", { label: 'shift-click window' });
  check('a shift-click opens the window and leaves the reaction alone', (await count('[data-testid="reactions-people"] .reactions-person')) === 6 && (await cdp.evaluate(`return ${chip(0)}.querySelector('.count').textContent;`)) === '6');
  await cdp.evaluate("document.querySelector('[data-testid=\"reactions-dialog\"]').close(); return true;");

  // ---- on a phone
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  await cdp.evaluate(`${chip(0)}.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true })); return true;`);
  await sleep(700);
  check('a long press on a touch screen opens the window', await q('[data-testid="reactions-dialog"]'));
  const box = await cdp.evaluate(`const r = document.querySelector('[data-testid="reactions-dialog"]').getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right), w: innerWidth };`);
  check('which fits the screen', box.l >= 0 && box.r <= box.w, JSON.stringify(box));
  await cdp.send('Emulation.clearDeviceMetricsOverride');
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
