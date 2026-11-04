// A person's status on a server: online, idle, do not disturb, invisible. Chosen from the dot on your picture, kept per
// server (the other one never meets it), shown on the member list, silent for mentions in do not disturb (and the
// markers still put up), idle after five minutes of the app being left alone, and nowhere in the private messages.
//
//   node client/test/status-ui.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const PORT_A = 18193;
const PORT_B = 18194;
const MTX_A = 20093;
const MTX_B = 20094;
const DEBUG = 9493;

const { check, summary } = reporter();
const procs = [];
const closers = [];
process.on('exit', () => {
  procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } });
  closers.forEach((c) => { try { c(); } catch { /* gone */ } });
});

function startServer(name, port, mtxPort) {
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
          HARMONY_DATA_DIR: mkdtempSync(join(tmpdir(), `harmony-status-${name}-`)),
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
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

/** A person on the other side, over the real socket: sees what a member's client sees, and says what theirs says. */
function person(base, token) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
  const inbox = [];
  ws.addEventListener('message', (event) => inbox.push(JSON.parse(event.data)));
  const ready = new Promise((done) => ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'hello', token, rid: 'hello' }));
    done();
  }));
  const request = async (payload) => {
    await ready;
    const rid = Math.random().toString(36).slice(2);
    ws.send(JSON.stringify({ ...payload, rid }));
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const reply = inbox.find((m) => m.rid === rid);
      if (reply) return reply;
      await sleep(20);
    }
    throw new Error('no reply');
  };
  const lastPresence = () => inbox.filter((m) => m.type === 'presence').at(-1);
  return { ws, inbox, request, lastPresence, ready };
}

const setInput = (id, value) => `{
  const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
  i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
}`;

async function signIn(page, base, nickname) {
  await page.evaluate(`${setInput('server-url', base)} return true;`);
  await sleep(1500);
  await page.evaluate(`${setInput('username', nickname)} ${setInput('account-password', 'hunter22')}
    document.getElementById('continue').click(); return true;`);
  await waitFor(page, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: `signing in to ${base}` });
  await sleep(800);
}

async function run() {
  const [a, b] = await Promise.all([startServer('a', PORT_A, MTX_A), startServer('b', PORT_B, MTX_B)]);
  const reg = async (srv, nickname, extra = {}) => (await api(srv.base, '/api/accounts/register', { method: 'POST', body: { nickname, password: 'hunter22', ...extra } })).body;
  const pedroA = await reg(a, 'pedro', { ownerKey: a.ownerKey() });
  const pedroB = await reg(b, 'pedro', { ownerKey: b.ownerKey() });
  const anaA = await reg(a, 'ana');
  const anaB = await reg(b, 'ana');
  const generalOf = async (srv, token) => (await api(srv.base, '/api/channels', { token })).body.channels.find((c) => c.kind === 'text').id;
  const generalA = await generalOf(a, pedroA.token);
  const generalB = await generalOf(b, pedroB.token);
  const sayA = (text) => api(a.base, `/api/channels/${generalA}/messages`, { method: 'POST', body: { body: text }, token: anaA.token });
  const sayB = (text) => api(b.base, `/api/channels/${generalB}/messages`, { method: 'POST', body: { body: text }, token: anaB.token });
  const mine = async (srv, token) => (await api(srv.base, '/api/channels', { token })).body.status;

  const anaOnA = person(a.base, anaA.token);
  const anaOnB = person(b.base, anaB.token);
  await Promise.all([anaOnA.ready, anaOnB.ready]);

  const app = launchApp({ port: DEBUG, userDataDir: mkdtempSync(join(tmpdir(), 'harmony-status-profile-')) });
  procs.push(app);
  const page = await attach(await findPage(DEBUG));
  await sleep(2000);
  await signIn(page, a.base, 'pedro');
  await page.evaluate("document.querySelector('#server-rail .rail-add').click(); return true;");
  await waitFor(page, "document.querySelector('.view[data-active]')?.id === 'view-connect'", { label: 'the connect screen' });
  await signIn(page, b.base, 'pedro');

  const shot = async (name) => {
    if (!process.env.STATUS_SHOTS) return;
    mkdirSync(process.env.STATUS_SHOTS, { recursive: true });
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.STATUS_SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
  };
  const q = (sel) => page.evaluate(`return !!document.querySelector(${JSON.stringify(sel)});`);
  const text = (sel) => page.evaluate(`return document.querySelector(${JSON.stringify(sel)})?.textContent ?? null;`);
  const dot = () => page.evaluate("return document.getElementById('status-button').dataset.status");
  const open = async (port) => {
    await page.evaluate(`document.querySelector('#server-rail .rail-item[data-server*="${port}"]').click(); return true;`);
    await waitFor(page, `document.querySelector('#server-rail .rail-item[data-server*="${port}"]')?.getAttribute('aria-current') === 'true'`, { label: `opening ${port}`, timeoutMs: 20_000 });
    await sleep(1200);
  };
  const choose = async (status) => {
    await page.evaluate("document.getElementById('status-button').click(); return true;");
    await waitFor(page, "!document.getElementById('row-menu').hidden", { label: 'the status menu' });
    await page.evaluate(`document.querySelector('#row-menu .menu-item[data-status="${status}"]').click(); return true;`);
    await sleep(500);
  };
  const memberDot = (name) => page.evaluate(`const row = [...document.querySelectorAll('#member-items .member-row')].find((r) => r.querySelector('.member-name')?.textContent === ${JSON.stringify(name)});
    return row ? { off: row.hasAttribute('data-off'), dot: row.querySelector('.presence-dot')?.dataset.status ?? null } : null;`);
  const showMembers = async () => {
    if (await page.evaluate("return document.getElementById('member-list').hidden")) await page.evaluate("document.getElementById('channels-members').click(); return true;");
    await sleep(500);
  };
  const sounds = () => page.evaluate('return window.__osc ?? 0');

  // ---- the dot on your picture, and the menu behind it (server B is open)
  check('your picture has a dot, online, and the strip says so', (await dot()) === 'online' && (await text('#self-status')) === 'Online');
  await page.evaluate("document.getElementById('status-button').click(); return true;");
  await waitFor(page, "!document.getElementById('row-menu').hidden", { label: 'the status menu' });
  const items = await page.evaluate("return [...document.querySelectorAll('#row-menu .menu-item')].map((b) => ({ status: b.dataset.status, label: b.textContent, current: b.getAttribute('aria-current') === 'true' }))");
  check('the menu offers online, idle, do not disturb and invisible, with the current one marked',
    JSON.stringify(items.map((i) => i.status)) === '["online","idle","dnd","invisible"]' && items[0].current && !items[1].current
    && items.map((i) => i.label).join() === 'Online,Idle,Do not disturb,Invisible', JSON.stringify(items));
  await shot('1-menu');
  await page.evaluate("document.querySelector('#row-menu .menu-item[data-status=\"dnd\"]').click(); return true;");
  await sleep(600);
  check('choosing do not disturb changes the dot and the strip', (await dot()) === 'dnd' && (await text('#self-status')) === 'Do not disturb');
  check('and the server has it', (await mine(b, pedroB.token)) === 'dnd');
  check('and everybody else is told', (await anaOnB.lastPresence()).statuses[pedroB.user.id] === 'dnd');

  // ---- per server: the other one does not meet it
  check('server A, which was not touched, still has pedro online', (await mine(a, pedroA.token)) === 'online');
  await open(PORT_A);
  check('opening A shows A\'s own status, online, not B\'s', (await dot()) === 'online' && (await text('#self-status')) === 'Online');
  await choose('idle');
  check('on A, idle: the dot says so', (await dot()) === 'idle' && (await mine(a, pedroA.token)) === 'idle');
  await open(PORT_B);
  check('back on B it is still do not disturb, not A\'s idle', (await dot()) === 'dnd');
  await open(PORT_A);
  check('and A is still idle', (await dot()) === 'idle');
  await choose('online');

  // ---- the member list, per server
  await showMembers();
  await waitFor(page, "[...document.querySelectorAll('#member-items .member-row .member-name')].some((n) => n.textContent === 'ana')", { label: 'ana on the list', timeoutMs: 15_000 });
  check('ana is on the list with a green dot', (await memberDot('ana'))?.dot === 'online' && !(await memberDot('ana')).off, JSON.stringify(await memberDot('ana')));
  await anaOnA.request({ type: 'presence:set', status: 'dnd' });
  await anaOnB.request({ type: 'presence:set', status: 'idle' });
  await waitFor(page, "[...document.querySelectorAll('#member-items .member-row')].find((r) => r.querySelector('.member-name')?.textContent === 'ana')?.querySelector('.presence-dot')?.dataset.status === 'dnd'", { label: 'ana do not disturb on A' });
  check('ana is red on A, where she is not to be disturbed', (await memberDot('ana')).dot === 'dnd');
  await shot('2-members');
  await open(PORT_B);
  await showMembers();
  await waitFor(page, "[...document.querySelectorAll('#member-items .member-row')].find((r) => r.querySelector('.member-name')?.textContent === 'ana')?.querySelector('.presence-dot')?.dataset.status === 'idle'", { label: 'ana idle on B', timeoutMs: 15_000 });
  check('and yellow on B, where she is idle: the same person, a different status on each', (await memberDot('ana')).dot === 'idle');
  await anaOnA.request({ type: 'presence:set', status: 'invisible' });
  await open(PORT_A);
  await showMembers();
  await sleep(600);
  const hidden = await memberDot('ana');
  check('invisible on A: she is in the offline half, with no dot', hidden?.off === true && hidden.dot === null, JSON.stringify(hidden));
  await anaOnA.request({ type: 'presence:set', status: 'online' });

  // ---- do not disturb: no sound, markers still there (A is open, pedro online)
  await page.evaluate(`const make = AudioContext.prototype.createOscillator; window.__osc = 0;
    AudioContext.prototype.createOscillator = function () { window.__osc += 1; return make.apply(this, arguments); }; return true;`);
  // No channel is open, so nothing they are looking at takes the mention in.
  await sayA('@pedro are you there?');
  await waitFor(page, "[...document.querySelectorAll('#channel-items li.channel-row')].some((r) => r.dataset.mention)", { label: 'the mention marker on A' });
  const heard = await sounds();
  check('online, a mention makes its sound, and its marker', heard > 0, String(heard));
  await choose('dnd');
  const before = await sounds();
  await sayA('@pedro again?');
  await waitFor(page, "[...document.querySelectorAll('#channel-items li.channel-row')].some((r) => r.dataset.mention === '2')", { label: 'the second mention counted' });
  await sleep(500);
  check('in do not disturb the second one is counted and marked, and makes no sound', (await sounds()) === before, `${before} -> ${await sounds()}`);
  await shot('3-dnd');
  // B is pedro's DND server and behind A now: its bubble counts, quietly.
  const beforeB = await sounds();
  await sayB('@pedro, over here');
  await waitFor(page, `document.querySelector('#server-rail .rail-item[data-server*="${PORT_B}"] .rail-badge')?.textContent === '1'`, { label: 'the bubble of B counting', timeoutMs: 15_000 });
  check('a mention on B, in do not disturb there, is on its bubble and silent', (await sounds()) === beforeB);
  await choose('online');

  // ---- idle: five minutes of the app being left alone
  await page.evaluate(`window.__realNow = Date.now.bind(Date); window.__shift = 6 * 60 * 1000; Date.now = () => window.__realNow() + window.__shift; return true;`);
  await waitFor(page, 'true', {});
  const idleSeen = async () => { await sleep(100); return anaOnA.lastPresence()?.statuses?.[pedroA.user.id]; };
  const until = Date.now() + 12_000;
  while (Date.now() < until && (await idleSeen()) !== 'idle') await sleep(500);
  check('left alone for more than five minutes, everybody sees pedro idle on A', anaOnA.lastPresence().statuses[pedroA.user.id] === 'idle');
  check('and the dot on their own picture says idle', (await dot()) === 'idle');
  check('B, where they are in do not disturb, is not turned idle by it', (await mine(b, pedroB.token)) === 'dnd' || anaOnB.lastPresence().statuses[pedroB.user.id] !== 'idle');
  await shot('4-idle');
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 400, y: 300 });
  const until2 = Date.now() + 8000;
  while (Date.now() < until2 && anaOnA.lastPresence().statuses[pedroA.user.id] === 'idle') await sleep(200);
  check('touching the app makes them online again at once', anaOnA.lastPresence().statuses[pedroA.user.id] === undefined && (await dot()) === 'online');
  await page.evaluate("Date.now = window.__realNow; return true;");

  // ---- the private messages say nothing of it
  await page.evaluate("document.querySelector('#server-rail .rail-home').click(); return true;");
  await sleep(800);
  check('the private messages have no status anywhere', !(await q('#view-dms .presence-dot, #view-dms .status-button')));
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
