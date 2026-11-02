// The phone layout, on a touchscreen: a real client against a real control server, with a phone's screen
// and finger (Chrome's device emulation and touch events), not a narrow window and a mouse.
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

const HARMONY_PORT = 18170;
const FAKE_MTX_PORT = 20070;
const DEBUG_PORT = 9470;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-mobile-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-mobile-profile-'));
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

  // A few more people, so that the lists have rows to put a finger on.
  for (const name of ['alice', 'bob', 'dave']) {
    await fetch(`${BASE}/api/accounts/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nickname: name, password: 'hunter22' }),
    });
  }

  // The phone: 390 x 844, a touchscreen, the interface at 100% as the Android app has it.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.evaluate("await harmony.settings.set({ uiScale: 100 }); return true;");
  await sleep(800);

  /** A finger down at the first point, through the rest, up at the last. */
  const swipe = async (points, stepMs = 16) => {
    const at = ([x, y]) => [{ x, y, id: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(points[0]) });
    for (const p of points.slice(1)) {
      await sleep(stepMs);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(p) });
    }
    await sleep(stepMs);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(500);
  };
  const line = (x0, x1, y) => Array.from({ length: 8 }, (_, i) => [Math.round(x0 + ((x1 - x0) * i) / 7), y + (i > 0 ? 1 : 0)]);

  const drawerState = () => cdp.evaluate(`
    const list = document.querySelector('.channel-list'); const members = document.querySelector('.member-list');
    return {
      drawer: document.querySelector('.channels-layout').dataset.drawer || '',
      stuck: Boolean(list.style.transform || members.style.transform),
    };`);
  const openDrawer = async (which) => {
    await cdp.evaluate(`
      document.querySelector('.channels-layout').dataset.drawer = '';
      await new Promise((r) => setTimeout(r, 450));
      document.getElementById(${JSON.stringify(which === 'members' ? 'channels-members' : 'channels-menu')}).click();
      await new Promise((r) => setTimeout(r, 650));
      return true;`);
  };
  const rowCentre = (selector, text) => cdp.evaluate(`
    const row = [...document.querySelectorAll(${JSON.stringify(selector)})].find((r) => r.textContent.includes(${JSON.stringify(text)}));
    const b = row.getBoundingClientRect();
    return [Math.round(b.x + 60), Math.round(b.y + b.height / 2)];`);

  // --- the swipes ---------------------------------------------------------------------------------------------------------------------
  await openDrawer('members');
  const [mx, my] = await rowCentre('#member-items .member-row', 'alice');
  await swipe(line(mx, 380, my));
  let state = await drawerState();
  check('a swipe that starts on a person closes the member drawer, and leaves nothing half open',
    state.drawer === '' && state.stuck === false, JSON.stringify(state));

  await openDrawer('members');
  await cdp.evaluate('setTimeout(() => document.getElementById(\'member-items\').replaceChildren(), 70); return true;');
  await swipe(line(mx, 380, my), 30);
  state = await drawerState();
  check('and still does when that person\'s row is taken out of the page under the finger',
    state.drawer === '' && state.stuck === false, JSON.stringify(state));

  await cdp.evaluate('document.getElementById(\'channels-members\').click(); return true;');
  await sleep(300);
  await openDrawer('channels');
  const [cx, cy] = await rowCentre('#channel-items li.channel-row', 'general');
  await swipe(line(260, 20, cy));
  state = await drawerState();
  check('a swipe that starts on a channel closes the channel drawer',
    state.drawer === '' && state.stuck === false, JSON.stringify(state));
  void cx;

  await openDrawer('members');
  await swipe(line(150, 380, 700));
  state = await drawerState();
  check('and one that starts on empty space still does', state.drawer === '' && state.stuck === false, JSON.stringify(state));

  // --- the dialogs ----------------------------------------------------------------------------------------------------------------------
  const dialogLayout = (id, opener) => cdp.evaluate(`
    document.getElementById(${JSON.stringify(opener)}).click();
    await new Promise((r) => setTimeout(r, 800));
    const d = document.getElementById(${JSON.stringify(id)});
    const pages = d.querySelector('.settings-pages');
    const footer = d.querySelector('.settings-footer');
    return {
      open: d.open,
      pagesTall: pages.scrollHeight, pagesShown: pages.clientHeight,
      doneBottom: Math.round(footer.getBoundingClientRect().bottom), screen: innerHeight,
    };`);
  const scrolls = async (id) => {
    const before = await cdp.evaluate(`return document.getElementById(${JSON.stringify(id)}).querySelector('.settings-pages').scrollTop;`);
    await swipe(line(200, 200, 600).map(([x, y], i) => [x, y - i * 55]));
    const after = await cdp.evaluate(`return document.getElementById(${JSON.stringify(id)}).querySelector('.settings-pages').scrollTop;`);
    return after > before;
  };

  const settings = await dialogLayout('devices', 'voice-config');
  check('the settings: the pages are shorter than their content, so they scroll, and Done is on the screen',
    settings.open && settings.pagesTall > settings.pagesShown && settings.doneBottom <= settings.screen, JSON.stringify(settings));
  check('and a finger scrolls them', await scrolls('devices'));
  await cdp.evaluate('document.getElementById(\'devices\').close(); return true;');

  const server = await dialogLayout('server-dialog', 'server-settings');
  check('the server settings: the same, with Done on the screen', server.open && server.doneBottom <= server.screen, JSON.stringify(server));
  await cdp.evaluate('document.getElementById(\'server-dialog\').close(); return true;');

  // --- the app is the screen --------------------------------------------------------------------------------------------------------
  // A pinch used to enlarge the whole app, and it could then be dragged around in both directions.
  await cdp.send('Input.synthesizePinchGesture', { x: 195, y: 400, scaleFactor: 2.2, relativeSpeed: 400, gestureSourceType: 'touch' });
  await sleep(400);
  for (let i = 0; i < 2; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 500, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(60);
  }
  await sleep(400);
  const zoom = await cdp.evaluate('return { scale: visualViewport.scale, x: visualViewport.pageLeft, y: visualViewport.pageTop };');
  check('a pinch or a double tap does not enlarge the app', zoom.scale === 1 && zoom.x === 0 && zoom.y === 0, JSON.stringify(zoom));
  await cdp.evaluate('window.scrollTo(120, 200); return true;');
  await sleep(200);
  const slid = await cdp.evaluate('return [scrollX, scrollY, document.scrollingElement.scrollLeft];');
  check('and the page is put back if something does move it', slid.every((n) => n === 0), JSON.stringify(slid));

  // --- the call controls ------------------------------------------------------------------------------------------------------------------
  const dock = await cdp.evaluate(`
    const panel = document.getElementById('voice-panel');
    panel.hidden = false;
    await new Promise((r) => setTimeout(r, 300));
    const rect = (e) => e.getBoundingClientRect();
    return {
      dock: Math.round(rect(document.getElementById('mobile-dock')).height),
      panel: Math.round(rect(panel).height),
      buttons: [...panel.querySelectorAll('button')].filter((b) => rect(b).width > 0).map((b) => Math.round(rect(b).height)),
    };`);
  check('the call and the strip under it together are under an eighth of the screen',
    dock.dock <= 105 && dock.panel <= 56 && Math.max(...dock.buttons) <= 40, JSON.stringify(dock));
}

run().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  const failed = summary();
  setTimeout(() => process.exit(process.exitCode ?? (failed ? 1 : 0)), 200);
});
