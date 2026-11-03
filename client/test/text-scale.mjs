// The size of the type, apart from the size of the interface: the settings slider, what it scales and what it keeps.
//
//   node client/test/text-scale.mjs
//
// What each check is here for:
//   - the settings and the server dialogs scroll, and their Done button is on the screen. Their pages sat
//     in a flex column that could not shrink, so on a phone the pages were taller than the dialog, the
//     dialog clipped them and nothing past the first screen could be reached;
//   - a swipe that closes a drawer finishes when it starts on a person or a channel. Closing the member
//     drawer rebuilt its rows under the finger, the touch went to a row that was no longer in the page,
//     and the drawer was left stuck part way;
//   - the call controls take a row of the dock, not a fifth of the screen.
//
//   node client/test/mobile-layout.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const HARMONY_PORT = 18174;
const FAKE_MTX_PORT = 20074;
const DEBUG_PORT = 9474;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-sinfo-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-sinfo-profile-'));
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
  for (const [id, value] of [['username', 'Pedro Lucas'], ['account-password', 'hunter22'],
    ['account-confirm', 'hunter22'], ['owner-key', ownerKey]]) {
    await cdp.evaluate(`${setInput(id, value)} return true;`);
  }
  await cdp.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'");



  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  const measure = () => cdp.evaluate(`
    const px = (e, p) => parseFloat(getComputedStyle(e)[p]);
    const channel = document.querySelector('#channel-items li') ?? document.querySelector('.channel-list-head');
    return {
      html: px(document.documentElement, 'fontSize'), body: px(document.body, 'fontSize'),
      scaleVar: getComputedStyle(document.documentElement).getPropertyValue('--text-scale').trim(),
      who: px(document.getElementById('channels-who'), 'fontSize'),
      avatar: document.getElementById('channels-avatar').getBoundingClientRect().width,
      list: document.querySelector('.channel-list').getBoundingClientRect().width,
      zoom: window.devicePixelRatio,
      pill: document.getElementById('text-scale-value').textContent,
    };`);
  const base = await measure();

  await cdp.evaluate("document.getElementById('voice-config').click(); return true;");
  await sleep(500);
  await cdp.evaluate("document.querySelector('.settings-tab[data-tab=\"appearance\"]').click(); return true;");
  await sleep(400);
  check('Appearance has a text size beside the interface size, at 100%',
    await cdp.evaluate("return Boolean(document.getElementById('text-scale')) && document.getElementById('text-scale').value === '100' && Boolean(document.getElementById('ui-scale'))"), '');
  await cdp.evaluate(`${setInput('text-scale', '150')} return true;`);
  await sleep(500);
  const big = await measure();
  check('at 150% the root size, the body and the names are one and a half times as big',
    Math.abs(big.html / base.html - 1.5) < 0.02 && Math.abs(big.body / base.body - 1.5) < 0.02 && Math.abs(big.who / base.who - 1.5) < 0.05, JSON.stringify({ base, big }));
  check('what is measured in rem grows with it: the channel list is wider', big.list > base.list, JSON.stringify({ base: base.list, big: big.list }));
  check('and the interface size (the window\'s own zoom) is not touched', big.zoom === base.zoom, JSON.stringify({ base: base.zoom, big: big.zoom }));
  check('and the slider says what it is', big.pill === '150%', big.pill);
  const kept = await cdp.evaluate("const s = await harmony.settings.get(); const d = s.data ?? s; return { text: d.textScale, ui: d.uiScale, local: localStorage.getItem('harmony.textScale') };");
  check('it is kept, apart from the interface size, and in the page for the next start', kept.text === 150 && kept.local === '150' && kept.ui !== 150, JSON.stringify(kept));

  await cdp.evaluate("document.getElementById('text-scale-down').click(); return true;");
  await sleep(300);
  check('the buttons step it by 5', (await measure()).pill === '145%', '');
  await cdp.evaluate("document.getElementById('text-scale-reset').click(); return true;");
  await sleep(400);
  const back = await measure();
  check('Reset puts it back to 100%', back.pill === '100%' && Math.abs(back.html - base.html) < 0.01 && Math.abs(back.who - base.who) < 0.01, JSON.stringify(back));
  await cdp.evaluate(`${setInput('text-scale', '999')} return true;`);
  await sleep(300);
  check('and it is held to 200%', (await measure()).pill === '200%', '');
}

run().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  const failed = summary();
  setTimeout(() => process.exit(process.exitCode ?? (failed ? 1 : 0)), 200);
});
