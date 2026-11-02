// Writing in a channel: the box that grows, and what sending does to the log -- on a phone and on a desktop.
//
//   - sending takes you to your message, wherever you were reading
//   - a log that is at its end stays at it while the box grows line by line and goes back to one
//   - one that was being read higher up is left where it was by the typing (only sending moves it)
//   - on a phone the box stops at four lines and scrolls, and the rail is a strip across the top, not a column
//
//   node client/test/chat-send.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const HARMONY_PORT = 18180;
const FAKE_MTX_PORT = 20080;
const DEBUG_PORT = 9480;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-send-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-send-profile-'));
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
  const say = (body) => fetch(`${BASE}/api/channels/${general.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${reg.token}` }, body: JSON.stringify({ body }) });
  for (let i = 1; i <= 40; i += 1) await say(`message number ${i} from ana, with some words to fill the line`);
  await cdp.evaluate("await harmony.settings.set({ uiScale: 100 }); return true;");

  const gap = async () => (await cdp.evaluate("const l = document.getElementById('chat-log'); return { g: Math.round(l.scrollHeight - l.scrollTop - l.clientHeight) };")).g;
  const inputH = async () => (await cdp.evaluate("return { h: document.getElementById('chat-input').offsetHeight };")).h;
  const type = (text) => cdp.evaluate(`const i = document.getElementById('chat-input'); i.value = ${JSON.stringify(text)};
    i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  const send = async () => {
    await cdp.evaluate("document.getElementById('chat-form').requestSubmit(); return true;");
    await sleep(900);
  };
  const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
  const toEnd = async () => {
    await cdp.evaluate("const l = document.getElementById('chat-log'); l.scrollTop = l.scrollHeight; return true;");
    await sleep(300);
  };
  const open = async () => {
    await cdp.evaluate(`[...document.querySelectorAll('#channel-items li.channel-row')].find((r) => r.textContent.includes('general')).click(); return true;`);
    await sleep(1200);
  };

  const scenarios = [
    ['phone', async () => {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }],
    ['desktop', async () => {
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    }],
  ];
  for (const [name, setUp] of scenarios) {
    await setUp();
    await sleep(800);
    await open();
    const label = (text) => `${text} (${name})`;

    if (name === 'phone') {
      const layout = await cdp.evaluate(`
        const rail = document.getElementById('server-rail').getBoundingClientRect();
        const views = document.getElementById('views').getBoundingClientRect();
        return { railTop: Math.round(rail.top), railW: Math.round(rail.width), railH: Math.round(rail.height), viewsLeft: Math.round(views.left), viewsW: Math.round(views.width), win: innerWidth,
          rowOf: [...document.querySelectorAll('#server-rail .rail-item')].every((b) => Math.abs(b.getBoundingClientRect().top - rail.top - (rail.height - b.getBoundingClientRect().height) / 2) < 3) };`);
      check(label('the rail is a strip across the top, as wide as the screen'), layout.railTop === 0 && layout.railW === layout.win && layout.railH <= 56 && layout.rowOf, JSON.stringify(layout));
      check(label('and nothing is taken from the left: the page has the whole width'), layout.viewsLeft === 0 && layout.viewsW === layout.win, JSON.stringify(layout));
    }

    // Being read higher up.
    await cdp.evaluate("const l = document.getElementById('chat-log'); l.scrollTop = 600; return true;");
    await sleep(300);
    const upBefore = await gap();
    await cdp.evaluate("document.getElementById('chat-input').focus(); return true;");
    await type(lines(3));
    await sleep(300);
    const upAfter = await gap();
    check(label('typing while reading higher up does not move the log'), upBefore > 300 && Math.abs(upAfter - upBefore) < 80, `${upBefore} -> ${upAfter}`);
    await type('');
    await sleep(200);

    // At the end: the box grows, and the log stays at the end all the way.
    await toEnd();
    const seen = [];
    for (const n of [2, 3, 4, 6, 9, 12]) {
      await type(lines(n));
      await sleep(250);
      seen.push([n, await gap(), await inputH()]);
    }
    check(label('at the end, growing the box a line at a time keeps the log at the end'), seen.every(([, g]) => g < 5), JSON.stringify(seen));
    if (name === 'phone') {
      check(label('the box stops at four lines and scrolls'), seen.at(-1)[2] <= 112 && seen.at(-1)[2] >= 90, JSON.stringify(seen.at(-1)));
    }
    await send();
    check(label('sending takes you to the message, and the box is one line again'), (await gap()) < 5 && (await inputH()) < 50, `${await gap()} from the end, box ${await inputH()}px`);
    const last = await cdp.evaluate("return document.querySelector('#chat-log .chat-msg:last-child')?.textContent ?? ''");
    check(label('and the message is the last one there'), /line 12/.test(last), last.slice(0, 60));

    // Reading higher up, then sending.
    await cdp.evaluate("const l = document.getElementById('chat-log'); l.scrollTop = 0; return true;");
    await sleep(300);
    check(label('scrolled to the very top'), (await gap()) > 500, String(await gap()));
    await type('one more');
    await send();
    check(label('sending from higher up takes you to it'), (await gap()) < 5, `${await gap()} from the end`);

    // Somebody else's message, at the end: followed as before.
    await say('a reply from ana');
    await sleep(700);
    check(label('a message from somebody else arrives at the end and is followed'), (await gap()) < 5, String(await gap()));
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
