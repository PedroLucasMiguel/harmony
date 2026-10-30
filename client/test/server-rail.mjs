// The rail of servers, driven through the real client against two real servers.
//
// What it proves: after signing in to two servers the rail lists both, one
// click opens the other with the saved session and no form, the open one is
// marked, and a restart opens the last server by itself. MediaMTX is stubbed:
// nothing here publishes or subscribes.
//
//   node client/test/server-rail.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const PORT_A = 18160;
const PORT_B = 18161;
const MTX_A = 20040;
const MTX_B = 20041;
const DEBUG_1 = 9420;
const DEBUG_2 = 9421;

const { check, summary } = reporter();
const procs = [];
const closers = [];
process.on('exit', () => {
  procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } });
  closers.forEach((c) => { try { c(); } catch { /* gone */ } });
});
process.on('SIGINT', () => process.exit(130));

function startServer(name, port, mtxPort) {
  const fake = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ itemCount: 0, pageCount: 0, items: [] }));
  });
  closers.push(() => fake.close());
  return new Promise((done, fail) => {
    fake.listen(mtxPort, '127.0.0.1', () => {
      const dataDir = mkdtempSync(join(tmpdir(), `harmony-rail-${name}-`));
      const p = spawn(process.execPath, [serverEntry], {
        env: {
          ...process.env,
          HARMONY_PORT: String(port),
          HARMONY_HOST: '127.0.0.1',
          HARMONY_DATA_DIR: dataDir,
          HARMONY_MEDIAMTX_API: `http://127.0.0.1:${mtxPort}`,
          HARMONY_SIGNALING_URL: 'http://127.0.0.1:8889',
          HARMONY_POLL_INTERVAL_MS: '500',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      procs.push(p);
      const timer = setTimeout(() => fail(new Error(`server ${name} did not start`)), 15_000);
      let log = '';
      let ownerKey = null;
      p.stdout.on('data', (b) => {
        log += b.toString();
        const match = /^\s*│\s+([A-Za-z0-9_-]{20,})\s+│$/m.exec(log);
        if (match) ownerKey = match[1];
        if (log.includes('control server on')) {
          clearTimeout(timer);
          done({ base: `http://127.0.0.1:${port}`, ownerKey: () => ownerKey });
        }
      });
    });
  });
}

const api = async (base, path, { method = 'GET', body, token } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const setInput = (id, value) => `{
  const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
  i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
}`;

const view = (page) => page.evaluate("return document.querySelector('.view[data-active]')?.id ?? null");
const channelNames = (page) => page.evaluate(
  "return [...document.querySelectorAll('#channel-items li.channel-row .channel-name')].map((n) => n.textContent)",
);
const bubble = (page, port) => page.evaluate(`
  const b = document.querySelector('#server-rail .rail-item[data-server*="${port}"]');
  return { unread: b.hasAttribute('data-unread'), badge: b.querySelector('.rail-badge')?.textContent ?? null, state: b.dataset.state };`);
const rail = (page) => page.evaluate(`
  const nav = document.getElementById('server-rail');
  return {
    hidden: nav.hidden,
    servers: [...nav.querySelectorAll('.rail-item[data-server]')].map((b) => ({
      url: b.dataset.server, current: b.getAttribute('aria-current') === 'true',
    })),
    home: Boolean(nav.querySelector('.rail-home')),
    add: Boolean(nav.querySelector('.rail-add')),
  };`);

async function signIn(page, base, nickname) {
  await page.evaluate(`${setInput('server-url', base)} return true;`);
  await sleep(1500);
  await page.evaluate(`${setInput('username', nickname)} ${setInput('account-password', 'hunter22')}
    document.getElementById('continue').click(); return true;`);
  await waitFor(page, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: `signing in to ${base}` });
  await sleep(800);
}

async function run() {
  console.log('Starting two servers and the client…\n');
  const [a, b] = await Promise.all([startServer('a', PORT_A, MTX_A), startServer('b', PORT_B, MTX_B)]);
  const tokenA = (await api(a.base, '/api/accounts/register', { method: 'POST', body: { nickname: 'pedro', password: 'hunter22', ownerKey: a.ownerKey() } })).body.token;
  const tokenB = (await api(b.base, '/api/accounts/register', { method: 'POST', body: { nickname: 'pedro', password: 'hunter22', ownerKey: b.ownerKey() } })).body.token;
  await api(a.base, '/api/channels', { method: 'POST', body: { kind: 'text', name: 'alpha-room' }, token: tokenA });
  const betaId = (await api(b.base, '/api/channels', { method: 'POST', body: { kind: 'text', name: 'beta-room' }, token: tokenB })).body.channel.id;
  const tokenAna = (await api(b.base, '/api/accounts/register', { method: 'POST', body: { nickname: 'ana', password: 'hunter22' } })).body.token;
  const say = (text) => api(b.base, `/api/channels/${betaId}/messages`, { method: 'POST', body: { body: text }, token: tokenAna });

  const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-rail-profile-'));
  const launch = (port) => {
    const app = launchApp({ port, userDataDir });
    procs.push(app);
    return app;
  };

  // --- nothing saved yet: no rail --------------------------------------------------------------------------------
  const app1 = launch(DEBUG_1);
  let page = await attach(await findPage(DEBUG_1));
  await sleep(2000);
  let state = await rail(page);
  check('with no server saved there is no rail', state.hidden === true, JSON.stringify(state));

  // --- sign in to both, one after the other ---------------------------------------------------------------------
  await signIn(page, a.base, 'pedro');
  state = await rail(page);
  check('once a server is saved the rail is there, with private messages and "+"', !state.hidden && state.home && state.add, JSON.stringify(state));
  const plus = await page.evaluate(`
    const add = document.querySelector('#server-rail .rail-add');
    const icon = add.querySelector('.rail-plus');
    const box = add.getBoundingClientRect(); const mark = icon.getBoundingClientRect();
    const pill = getComputedStyle(add, '::before');
    return { text: add.textContent, dx: (mark.left + mark.width / 2) - (box.left + box.width / 2), dy: (mark.top + mark.height / 2) - (box.top + box.height / 2),
      size: Math.round(mark.width), pillHeight: pill.height, drawn: getComputedStyle(icon).backgroundImage.includes('gradient') };`);
  check('the "+" is a drawn icon exactly in the middle of its circle',
    plus.text === '' && Math.abs(plus.dx) < 0.6 && Math.abs(plus.dy) < 0.6 && plus.size === 20 && plus.drawn, JSON.stringify(plus));
  check('and the circle\'s own mark (which says which server is open) is left alone', plus.pillHeight === '0px', plus.pillHeight);
  check('and it lists that server, open', state.servers.length === 1 && state.servers[0].current, JSON.stringify(state.servers));

  await page.evaluate("document.querySelector('#server-rail .rail-add').click(); return true;");
  await waitFor(page, "document.querySelector('.view[data-active]')?.id === 'view-connect'", { label: 'the "+" opening the connect screen' });
  await signIn(page, b.base, 'pedro');
  state = await rail(page);
  check('two servers on the rail', state.servers.length === 2, JSON.stringify(state.servers));
  check('the one just signed in to is the open one',
    state.servers.filter((s) => s.current).length === 1 && state.servers.find((s) => s.current).url.includes(String(PORT_B)), JSON.stringify(state.servers));
  check('and it keeps its place instead of jumping to the top',
    state.servers[0].url.includes(String(PORT_A)) && state.servers[1].url.includes(String(PORT_B)), JSON.stringify(state.servers));
  check('server B shows its own channels', (await channelNames(page)).includes('beta-room'), JSON.stringify(await channelNames(page)));

  // A look at it, for whoever is changing the rail: SCREENSHOT=/path/rail.png
  if (process.env.SCREENSHOT) {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    (await import('node:fs')).writeFileSync(process.env.SCREENSHOT, Buffer.from(shot.data, 'base64'));
  }

  // --- one click opens the other, with no form -------------------------------------------------------------------
  await page.evaluate(`document.querySelector('#server-rail .rail-item[data-server*="${PORT_A}"]').click(); return true;`);
  await waitFor(page, "(document.querySelector('.view[data-active]')?.id === 'view-channels') && [...document.querySelectorAll('#channel-items .channel-name')].some((n) => n.textContent === 'alpha-room')",
    { label: 'switching to server A', timeoutMs: 20_000 });
  state = await rail(page);
  check('clicking a server opens it with its saved session, no form', await view(page) === 'view-channels');
  check('and it is the open one on the rail', state.servers.find((s) => s.url.includes(String(PORT_A))).current, JSON.stringify(state.servers));
  check('server A shows its own channels, not B\'s', !(await channelNames(page)).includes('beta-room'), JSON.stringify(await channelNames(page)));

  await page.evaluate(`document.querySelector('#server-rail .rail-item[data-server*="${PORT_B}"]').click(); return true;`);
  await waitFor(page, "[...document.querySelectorAll('#channel-items .channel-name')].some((n) => n.textContent === 'beta-room')",
    { label: 'and back to server B', timeoutMs: 20_000 });
  check('and back again', (await rail(page)).servers.find((s) => s.url.includes(String(PORT_B))).current);

  // --- a restart opens the last server by itself -----------------------------------------------------------------
  app1.kill();
  await sleep(1500);
  process.env.HARMONY_TEST_AUTO_SIGNIN = '1';
  launch(DEBUG_2);
  page = await attach(await findPage(DEBUG_2));
  await waitFor(page, "document.querySelector('.view[data-active]')?.id === 'view-channels' && [...document.querySelectorAll('#channel-items .channel-name')].length > 0",
    { label: 'the last server opening by itself', timeoutMs: 30_000 });
  check('a restart opens the last server by itself, without pressing Connect',
    (await channelNames(page)).includes('beta-room'), JSON.stringify(await channelNames(page)));
  state = await rail(page);
  check('with both servers still on the rail', state.servers.length === 2 && state.servers.find((s) => s.url.includes(String(PORT_B))).current, JSON.stringify(state.servers));

  // --- the server behind the open one is kept live ------------------------------------------------------------------
  await page.evaluate(`document.querySelector('#server-rail .rail-item[data-server*="${PORT_A}"]').click(); return true;`);
  await waitFor(page, "[...document.querySelectorAll('#channel-items .channel-name')].some((n) => n.textContent === 'alpha-room')",
    { label: 'moving on to server A', timeoutMs: 20_000 });
  await sleep(1500);
  check('a server that is not open starts without news', (await bubble(page, PORT_B)).unread === false, JSON.stringify(await bubble(page, PORT_B)));

  await say('anybody here?');
  await waitFor(page, `document.querySelector('#server-rail .rail-item[data-server*="${PORT_B}"]')?.hasAttribute('data-unread')`,
    { label: 'news on server B', timeoutMs: 15_000 });
  let seen = await bubble(page, PORT_B);
  check('a message there shows as news on its bubble, without a count', seen.unread && seen.badge === null, JSON.stringify(seen));

  await say('hey @pedro, look');
  await waitFor(page, `document.querySelector('#server-rail .rail-item[data-server*="${PORT_B}"] .rail-badge')?.textContent === '1'`,
    { label: 'a mention on server B', timeoutMs: 15_000 });
  seen = await bubble(page, PORT_B);
  check('a message that names you shows the count', seen.badge === '1', JSON.stringify(seen));

  // --- opening it and reading clears it, and it stays cleared ---------------------------------------------------------
  await page.evaluate(`document.querySelector('#server-rail .rail-item[data-server*="${PORT_B}"]').click(); return true;`);
  await waitFor(page, "[...document.querySelectorAll('#channel-items .channel-name')].some((n) => n.textContent === 'beta-room')",
    { label: 'opening server B', timeoutMs: 20_000 });
  await page.evaluate(`[...document.querySelectorAll('#channel-items li.channel-row')]
    .find((li) => li.querySelector('.channel-name').textContent === 'beta-room').click(); return true;`);
  await waitFor(page, "document.querySelectorAll('#chat-log .chat-msg').length >= 2", { label: 'the channel\'s messages', timeoutMs: 15_000 });
  await sleep(1500);
  await page.evaluate(`document.querySelector('#server-rail .rail-item[data-server*="${PORT_A}"]').click(); return true;`);
  await waitFor(page, "[...document.querySelectorAll('#channel-items .channel-name')].some((n) => n.textContent === 'alpha-room')",
    { label: 'back to server A', timeoutMs: 20_000 });
  await sleep(2000);
  seen = await bubble(page, PORT_B);
  check('after reading the channel there, its bubble is clear', !seen.unread && seen.badge === null, JSON.stringify(seen));

  await say('one more');
  await waitFor(page, `document.querySelector('#server-rail .rail-item[data-server*="${PORT_B}"]')?.hasAttribute('data-unread')`,
    { label: 'news on server B again', timeoutMs: 15_000 });
  check('and news after that shows again', (await bubble(page, PORT_B)).unread);

  // --- order, shortcuts, and the menu on a bubble ----------------------------------------------------------------------
  const order = () => page.evaluate("return [...document.querySelectorAll('#server-rail .rail-item[data-server]')].map((b) => b.dataset.server)");
  check('the rail lists A first', (await order())[0].includes(String(PORT_A)), JSON.stringify(await order()));
  await page.evaluate(`{
    const from = document.querySelector('#server-rail .rail-item[data-server*="${PORT_A}"]');
    const onto = document.querySelector('#server-rail .rail-item[data-server*="${PORT_B}"]');
    const box = onto.getBoundingClientRect();
    const dt = new DataTransfer();
    from.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
    onto.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: box.left + 10, clientY: box.bottom - 4 }));
    onto.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    from.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
    return true;
  }`);
  await waitFor(page, `document.querySelector('#server-rail .rail-item[data-server]').dataset.server.includes('${PORT_B}')`, { label: 'the rail reordered' });
  check('dragging a server onto another puts it after it', (await order())[0].includes(String(PORT_B)), JSON.stringify(await order()));

  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true })); return true;`);
  await waitFor(page, `document.querySelector('#server-rail .rail-item[data-server*="${PORT_B}"]')?.getAttribute('aria-current') === 'true' && [...document.querySelectorAll('#channel-items .channel-name')].some((n) => n.textContent === 'beta-room')`,
    { label: 'Ctrl+1 opening the first server', timeoutMs: 20_000 });
  check('Ctrl+1 opens the first server on the rail', true);

  const menuLabels = () => page.evaluate("return [...document.querySelectorAll('#row-menu-body button')].map((b) => b.textContent)");
  const rightClickBubble = (port) => page.evaluate(`{
    const b = document.querySelector('#server-rail .rail-item[data-server*="${port}"]');
    const r = b.getBoundingClientRect();
    b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.right, clientY: r.top + 10 }));
    return true;
  }`);
  await rightClickBubble(PORT_A);
  let labels = await menuLabels();
  check('right-clicking a server offers to open it, sign out, keep it live, or forget it',
    ['Open', 'Sign out', 'Stop keeping connected in the background', 'Forget this server'].every((l) => labels.includes(l)), JSON.stringify(labels));
  await page.evaluate("[...document.querySelectorAll('#row-menu-body button')].find((b) => /Stop keeping/.test(b.textContent)).click(); return true;");
  await sleep(800);
  await rightClickBubble(PORT_A);
  labels = await menuLabels();
  check('and the choice is remembered: it now offers to keep it connected', labels.includes('Keep connected in the background'), JSON.stringify(labels));
  await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.body.click(); return true;");

  await rightClickBubble(PORT_A);
  await page.evaluate("[...document.querySelectorAll('#row-menu-body button')].find((b) => /Forget this server/.test(b.textContent)).click(); return true;");
  await waitFor(page, "document.getElementById('ask')?.open || document.querySelector('dialog[open]')", { label: 'the question' });
  await page.evaluate("document.getElementById('ask-ok').click(); return true;");
  await waitFor(page, `!document.querySelector('#server-rail .rail-item[data-server*="${PORT_A}"]')`, { label: 'the server going from the rail' });
  check('forgetting a server takes it off the rail, and the open one stays', (await order()).length === 1 && (await view(page)) === 'view-channels', JSON.stringify(await order()));
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    const failed = summary();
    setTimeout(() => process.exit(process.exitCode ?? (failed ? 1 : 0)), 200);
  });
