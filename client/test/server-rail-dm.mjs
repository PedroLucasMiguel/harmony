// Private messages across servers: one list, and a conversation that opens
// without leaving the server on screen.
//
// Pedro is signed in to two servers. Server A is open; server B is behind it.
// Ana writes to him on B. His private-messages bubble must count it, the list
// must show it tagged with its server, opening it must not move him off A, and
// his answer must reach Ana on B.
//
//   node client/test/server-rail-dm.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const PORT_A = 18180;
const PORT_B = 18181;
const MTX_A = 20060;
const MTX_B = 20061;
const DEBUG_PEDRO = 9440;
const DEBUG_ANA = 9441;
const BASE_A = `http://127.0.0.1:${PORT_A}`;
const BASE_B = `http://127.0.0.1:${PORT_B}`;

const { check, summary } = reporter();
const procs = [];
const closers = [];
process.on('exit', () => {
  procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } });
  closers.forEach((c) => { try { c(); } catch { /* gone */ } });
});
process.on('SIGINT', () => process.exit(130));

function startServer(port, mtxPort) {
  const fake = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ itemCount: 0, pageCount: 0, items: [] }));
  });
  closers.push(() => fake.close());
  return new Promise((done, fail) => {
    fake.listen(mtxPort, '127.0.0.1', () => {
      const p = spawn(process.execPath, [serverEntry], {
        env: {
          ...process.env,
          HARMONY_PORT: String(port),
          HARMONY_HOST: '127.0.0.1',
          HARMONY_DATA_DIR: mkdtempSync(join(tmpdir(), 'harmony-rdm-')),
          HARMONY_MEDIAMTX_API: `http://127.0.0.1:${mtxPort}`,
          HARMONY_SIGNALING_URL: 'http://127.0.0.1:8889',
          HARMONY_POLL_INTERVAL_MS: '500',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      procs.push(p);
      const timer = setTimeout(() => fail(new Error(`server ${port} did not start`)), 15_000);
      let log = '';
      let ownerKey = null;
      p.stdout.on('data', (b) => {
        log += b.toString();
        const match = /^\s*│\s+([A-Za-z0-9_-]{20,})\s+│$/m.exec(log);
        if (match) ownerKey = match[1];
        if (log.includes('control server on')) { clearTimeout(timer); done(() => ownerKey); }
      });
    });
  });
}

const api = async (base, path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const setInput = (id, value) => `{
  const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
  i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
}`;

async function signIn(page, base, nickname) {
  await page.evaluate(`${setInput('server-url', base)} return true;`);
  await sleep(1500);
  await page.evaluate(`${setInput('username', nickname)} ${setInput('account-password', 'hunter22')}
    document.getElementById('continue').click(); return true;`);
  await waitFor(page, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: `${nickname} signing in to ${base}` });
  await sleep(800);
}

const homeBadge = (page) => page.evaluate("return document.querySelector('#server-rail .rail-home .rail-badge')?.textContent ?? null");
const viewId = (page) => page.evaluate("return document.querySelector('.view[data-active]')?.id");

/** Dismiss the recovery-key dialog, if the first message made one. */
const dismissKey = (page) => page.evaluate(`
  const d = document.querySelector('dialog.dm-keys');
  if (d?.open) [...d.querySelectorAll('button')].find((b) => /saved|guardei|guard/i.test(b.textContent))?.click();
  return true;`);

async function run() {
  console.log('Starting two servers and two clients…\n');
  const [keyA, keyB] = await Promise.all([startServer(PORT_A, MTX_A), startServer(PORT_B, MTX_B)]);
  await api(BASE_A, '/api/accounts/register', { method: 'POST', body: { nickname: 'pedro', password: 'hunter22', ownerKey: keyA() } });
  await api(BASE_B, '/api/accounts/register', { method: 'POST', body: { nickname: 'pedro', password: 'hunter22', ownerKey: keyB() } });
  await api(BASE_B, '/api/accounts/register', { method: 'POST', body: { nickname: 'ana', password: 'hunter22' } });

  // Pedro: A, then B (both saved), then back on A with B behind it.
  const pedroApp = launchApp({ port: DEBUG_PEDRO, userDataDir: mkdtempSync(join(tmpdir(), 'harmony-rdm-pedro-')) });
  procs.push(pedroApp);
  const pedro = await attach(await findPage(DEBUG_PEDRO));
  await sleep(2000);
  await signIn(pedro, BASE_A, 'pedro');
  await pedro.evaluate("document.querySelector('#server-rail .rail-add').click(); return true;");
  await waitFor(pedro, "document.querySelector('.view[data-active]')?.id === 'view-connect'", { label: 'the connect screen' });
  await signIn(pedro, BASE_B, 'pedro');
  await pedro.evaluate(`document.querySelector('#server-rail .rail-item[data-server*="${PORT_A}"]').click(); return true;`);
  await waitFor(pedro, `document.querySelector('#server-rail .rail-item[data-server*="${PORT_A}"]')?.getAttribute('aria-current') === 'true' && document.querySelector('.view[data-active]')?.id === 'view-channels'`,
    { label: 'back on A', timeoutMs: 20_000 });
  // Long enough for his key on B to be made and published.
  await sleep(4000);

  // Ana: on B, writes to Pedro.
  const anaApp = launchApp({ port: DEBUG_ANA, userDataDir: mkdtempSync(join(tmpdir(), 'harmony-rdm-ana-')) });
  procs.push(anaApp);
  const ana = await attach(await findPage(DEBUG_ANA));
  await sleep(2000);
  await signIn(ana, BASE_B, 'ana');
  await ana.evaluate("if (document.getElementById('member-list').hidden) document.getElementById('channels-members').click(); return true;");
  await waitFor(ana, "[...document.querySelectorAll('.member-row')].some((r) => /pedro/i.test(r.textContent))", { label: 'Pedro in the member list' });
  await ana.evaluate(`
    const row = [...document.querySelectorAll('.member-row')].find((r) => /pedro/i.test(r.textContent));
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 })); return true;`);
  await ana.evaluate("[...document.querySelectorAll('#member-menu-body button')].find((b) => b.textContent === 'Send a private message').click(); return true;");
  await waitFor(ana, "!document.getElementById('dm-active').hidden", { label: 'Ana\'s conversation' });
  await dismissKey(ana);
  await sleep(500);
  await ana.evaluate(`const i = document.getElementById('dm-input'); i.value = 'hello from B'; i.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('dm-send').click(); return true;`);
  await waitFor(ana, "document.querySelector('#dm-log .chat-msg .text')?.textContent.includes('hello from B')", { label: 'her message' });

  // Pedro, on A, hears of it.
  await waitFor(pedro, "document.querySelector('#server-rail .rail-home .rail-badge')?.textContent === '1'", { label: 'the unread count on the rail', timeoutMs: 20_000 });
  check('a message on the server behind the open one counts on the private-messages bubble', (await homeBadge(pedro)) === '1');
  check('while he is still on server A', (await viewId(pedro)) === 'view-channels');

  // The list.
  await pedro.evaluate("document.querySelector('#server-rail .rail-home').click(); return true;");
  await waitFor(pedro, "document.querySelector('.view[data-active]')?.id === 'view-dms' && document.querySelectorAll('#dm-list .dm-row').length === 1", { label: 'the list', timeoutMs: 20_000 });
  const row = await pedro.evaluate("const r = document.querySelector('#dm-list .dm-row'); return { text: r.textContent, unread: r.hasAttribute('data-unread'), server: r.dataset.server }");
  check('the list has the conversation, with what she wrote, unread', /ana/i.test(row.text) && row.text.includes('hello from B') && row.unread, JSON.stringify(row));
  check('and it says which server it is on', row.server.includes(String(PORT_B)), JSON.stringify(row));

  // Opening it.
  await pedro.evaluate("document.querySelector('#dm-list .dm-row').click(); return true;");
  await waitFor(pedro, "document.querySelector('#dm-log .chat-msg .text')?.textContent.includes('hello from B')", { label: 'the message in his conversation', timeoutMs: 20_000 });
  check('opening it shows the message, readable', true);
  // A look at it, for whoever is changing the page: SCREENSHOT=/path/dm.png
  if (process.env.SCREENSHOT) {
    const shot = await pedro.send('Page.captureScreenshot', { format: 'png' });
    (await import('node:fs')).writeFileSync(process.env.SCREENSHOT, Buffer.from(shot.data, 'base64'));
  }
  const who = await pedro.evaluate("return document.getElementById('dm-name').textContent");
  check('named for Ana, from server B\'s people', /ana/i.test(who), who);
  await waitFor(pedro, "!document.querySelector('#server-rail .rail-home .rail-badge')", { label: 'the count going', timeoutMs: 15_000 });
  check('and reading it clears the count', true);

  // His answer reaches her.
  await pedro.evaluate(`const i = document.getElementById('dm-input'); i.value = 'hi ana, from A'; i.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('dm-send').click(); return true;`);
  await waitFor(ana, "document.getElementById('dm-log').textContent.includes('hi ana, from A')", { label: 'his answer on her screen', timeoutMs: 20_000 });
  check('his answer reaches Ana on server B, live', true);

  // A long message in the list is cut with an ellipsis; it does not widen the column.
  await pedro.evaluate(`const i = document.getElementById('dm-input'); i.value = ${JSON.stringify('x'.repeat(10) + ' una frase larga que no cabe en la lista de conversaciones, ni en dos líneas ni en tres, de verdad')}; i.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('dm-send').click(); return true;`);
  await waitFor(pedro, "document.querySelector('#dm-list .dm-row-text')?.textContent.includes('una frase larga')", { label: 'the long message in the list' });
  const fit = await pedro.evaluate(`const ul = document.getElementById('dm-list'); const list = document.querySelector('.dms-list').getBoundingClientRect(); const row = document.querySelector('#dm-list .dm-row').getBoundingClientRect();
    const text = document.querySelector('#dm-list .dm-row-text'); return { listWidth: Math.round(list.width), rowRight: Math.round(row.right), listRight: Math.round(list.right), scrolls: ul.scrollWidth > ul.clientWidth, cut: text.scrollWidth > text.clientWidth };`);
  check('a long message is cut in the list, not widening it', fit.listWidth === 320 && fit.rowRight <= fit.listRight && !fit.scrolls && fit.cut, JSON.stringify(fit));

  // Back, still on A.
  await pedro.evaluate("document.querySelector('#server-rail .rail-home').click(); return true;");
  await waitFor(pedro, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'leaving the list' });
  const current = await pedro.evaluate(`return document.querySelector('#server-rail .rail-item[data-server*="${PORT_A}"]').getAttribute('aria-current')`);
  check('opening and answering it never moved him off server A', current === 'true', String(current));

  // --- the list of conversations can be dragged wider ------------------------------------------------------------------
  await pedro.evaluate("document.querySelector('#server-rail .rail-home').click(); return true;");
  await waitFor(pedro, "document.querySelector('.view[data-active]')?.id === 'view-dms'", { label: 'the page again' });
  const listWidth = () => pedro.evaluate("return Math.round(document.querySelector('.dms-list').getBoundingClientRect().width)");
  const before = await listWidth();
  const handle = await pedro.evaluate("const r = document.querySelector('.dms-list .col-resizer').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }");
  await pedro.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: handle.x, y: handle.y, button: 'left', buttons: 1, clickCount: 1 });
  for (let step = 1; step <= 8; step += 1) {
    await pedro.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x + step * 15, y: handle.y, button: 'left', buttons: 1 });
  }
  await pedro.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x + 120, y: handle.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(500);
  const wider = await listWidth();
  check('dragging the edge of the list makes it wider', wider >= before + 100, `${before} -> ${wider}`);
  const saved = await pedro.evaluate("const r = await harmony.settings.get(); return (r.data ?? r).dmListWidth");
  check('and the width is remembered', Math.abs(saved - wider) <= 2, String(saved));
  await pedro.evaluate("document.querySelector('.dms-list .col-resizer').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true;");
  await sleep(500);
  check('double-clicking the edge puts it back to the usual width', Math.abs((await listWidth()) - before) <= 2, String(await listWidth()));
  await pedro.evaluate("document.querySelector('#server-rail .rail-home').click(); return true;");
  await waitFor(pedro, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'leaving the list' });

  // --- a narrow screen: a slim rail, and the list or the conversation, one at a time -----------------------------
  await pedro.setViewport(400, 800);
  await sleep(500);
  const rail = await pedro.evaluate("const r = document.getElementById('server-rail'); return { shown: !r.hidden && r.offsetWidth > 0, width: r.offsetWidth }");
  check('on a phone the rail stays, slimmer', rail.shown && rail.width <= 56, JSON.stringify(rail));
  await pedro.evaluate("document.querySelector('#server-rail .rail-home').click(); return true;");
  await waitFor(pedro, "document.querySelector('.view[data-active]')?.id === 'view-dms'", { label: 'the page on a phone' });
  const shown = () => pedro.evaluate(`return { list: document.querySelector('.dms-list').offsetWidth > 0, pane: document.querySelector('.dms-pane').offsetWidth > 0 }`);
  // The conversation is still the one that was open: the pane shows, the list does not.
  let both = await shown();
  check('with a conversation open, a phone shows only the conversation', both.pane && !both.list, JSON.stringify(both));
  await pedro.evaluate("document.getElementById('dm-close').click(); return true;");
  await sleep(300);
  both = await shown();
  check('and closing it brings the list back', both.list && !both.pane, JSON.stringify(both));
  await pedro.clearViewport();
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    const failed = summary();
    setTimeout(() => process.exit(process.exitCode ?? (failed ? 1 : 0)), 300);
  });
