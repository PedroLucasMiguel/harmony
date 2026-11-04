// The title bar, in the real app: the frameless window with its own slim bar -- back and forward through the places
// opened, the server named at the middle, the palette's colours -- and the page starting under it.
//
//   node client/test/titlebar-ui.mjs

process.env.HARMONY_TEST_TITLEBAR = '1';

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const HARMONY_PORT = 18186;
const FAKE_MTX_PORT = 20086;
const DEBUG_PORT = 9486;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-tbar-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-tbar-profile-'));
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
  await sleep(1500);

  const rect = (sel) => cdp.evaluate(`const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), b: Math.round(r.bottom), r: Math.round(r.right) };`);
  const text = (sel) => cdp.evaluate(`return document.querySelector(${JSON.stringify(sel)})?.textContent ?? null;`);
  const visible = (sel) => cdp.evaluate(`const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.hidden && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none';`);
  const css = (sel, prop) => cdp.evaluate(`return getComputedStyle(document.querySelector(${JSON.stringify(sel)})).getPropertyValue(${JSON.stringify(prop)});`);
  const shot = async (name) => {
    if (!process.env.TBAR_SHOTS) return;
    mkdirSync(process.env.TBAR_SHOTS, { recursive: true });
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.TBAR_SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
  };

  // ---- before signing in
  const platform = await cdp.evaluate('return harmony.platform;');
  check('the page was told the window has no frame of its own', await cdp.evaluate("return document.documentElement.hasAttribute('data-titlebar') && harmony.titleBar === true;"));
  const bar = await rect('#titlebar');
  const win = await cdp.evaluate('return { w: innerWidth, h: innerHeight };');
  check('a slim bar runs across the top of the window', bar.y === 0 && bar.x === 0 && bar.w === win.w && bar.h === 32, JSON.stringify(bar));
  check('it is a place to drag the window by, and its buttons are not', (await css('#titlebar', '-webkit-app-region')) === 'drag' && (await css('#nav-back', '-webkit-app-region')) === 'no-drag');
  check('before there is a server it says the app\'s name, with no picture', (await text('#titlebar-name')) === 'Harmony' && !(await visible('#titlebar-icon')));
  check('back and forward have nowhere to go yet', await cdp.evaluate("return document.getElementById('nav-back').disabled && document.getElementById('nav-forward').disabled;"));
  const top = await rect('#app-shell');
  check('the page starts under the bar, not behind it', top.y >= 32, JSON.stringify(top));
  if (platform === 'darwin') {
    check('on a Mac the left is left clear for the traffic lights', (await cdp.evaluate("return parseFloat(getComputedStyle(document.getElementById('titlebar')).paddingLeft);")) >= 78);
  } else {
    check('the right is left clear for the system\'s window buttons', (await cdp.evaluate("return parseFloat(getComputedStyle(document.getElementById('titlebar')).paddingRight);")) >= 130);
  }

  // ---- the bar's colours are the palette's
  const bg = (theme) => cdp.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)};
    const v = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(); const probe = document.createElement('i'); probe.style.color = v; document.body.append(probe);
    const want = getComputedStyle(probe).color; probe.remove(); return { want, got: getComputedStyle(document.getElementById('titlebar')).backgroundColor };`);
  const dark = await bg('onyx');
  const light = await bg('daylight');
  check('the bar is drawn in the theme\'s background', dark.want === dark.got && light.want === light.got && dark.got !== light.got, JSON.stringify({ dark, light }));
  check('and its text follows the theme too (dark text on the light one)', await cdp.evaluate("const c = getComputedStyle(document.getElementById('titlebar')).color; return /^rgb\\((\\d+)/.exec(c) && Number(/^rgb\\((\\d+)/.exec(c)[1]) < 100;"));
  await cdp.evaluate("document.documentElement.dataset.theme = 'midnight'; return true;");
  const told = await cdp.evaluate("return (await harmony.setTitleBar({ color: '#101010', symbolColor: '#ffffff' })).data;");
  check('the colours can be given to the system\'s window buttons (where there are such)', platform === 'darwin' ? told === false : told === true, String(told));

  // ---- signed in
  await cdp.evaluate(`${setInput('server-url', BASE)} return true;`);
  await sleep(1500);
  for (const [id, value] of [['username', 'pedro'], ['account-password', 'hunter22'], ['account-confirm', 'hunter22'], ['owner-key', ownerKey]]) {
    await cdp.evaluate(`${setInput(id, value)} return true;`);
  }
  await cdp.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'");
  await sleep(800);
  check('signed in, it names the server, with its picture, at the middle of the window', (await text('#titlebar-name')) === 'Harmony' && (await visible('#titlebar-icon')));
  const title = await rect('.titlebar-title');
  check('which is centred on the window', Math.abs((title.x + title.w / 2) - win.w / 2) <= 2, JSON.stringify({ title, win }));
  await cdp.send('Runtime.evaluate', { expression: '1' });
  const json = async (path, token, body) => (await fetch(`${BASE}${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}),
  })).json();
  const boss = (await (await fetch(`${BASE}/api/accounts/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname: 'pedro', password: 'hunter22' }) })).json()).token;
  const forum = (await json('/api/channels', boss, { kind: 'forum', name: 'questions' })).channel;
  const post = (await json(`/api/channels/${forum.id}/messages`, boss, { title: 'A post', body: 'words' })).message;
  await sleep(1500);
  await shot('1-signed-in');

  // ---- back and forward
  const row = (name) => `[...document.querySelectorAll('#channel-items li.channel-row')].find((r) => r.textContent.includes('${name}'))`;
  const where = () => cdp.evaluate(`return { forum: !document.getElementById('forum-active').hidden, chat: !document.getElementById('chat-active').hidden, name: document.getElementById(document.getElementById('chat-active').hidden ? 'forum-name' : 'chat-name').textContent };`);
  const buttons = () => cdp.evaluate("return [document.getElementById('nav-back').disabled, document.getElementById('nav-forward').disabled];");
  await cdp.evaluate(`${row('general')}.click(); return true;`);
  await sleep(900);
  check('the first place opened leaves nowhere to go back to', JSON.stringify(await buttons()) === '[true,true]');
  await cdp.evaluate(`${row('questions')}.click(); return true;`);
  await waitFor(cdp, "!document.getElementById('forum-active').hidden", { label: 'the forum' });
  check('a second place makes back available', JSON.stringify(await buttons()) === '[false,true]');
  await cdp.evaluate(`document.querySelector('#forum-posts .forum-post').click(); return true;`);
  await waitFor(cdp, "!document.getElementById('chat-active').hidden && document.querySelector('#chat-log .post-title')", { label: 'the post' });
  await cdp.evaluate("document.getElementById('nav-back').click(); return true;");
  await sleep(700);
  let at = await where();
  check('back from a post goes to its forum\'s list', at.forum && !at.chat && at.name === 'questions', JSON.stringify(at));
  await cdp.evaluate("document.getElementById('nav-back').click(); return true;");
  await sleep(900);
  at = await where();
  check('and back again to the channel before it', at.chat && at.name === '#general', JSON.stringify(at));
  check('at the start, back is off and forward is on', JSON.stringify(await buttons()) === '[true,false]');
  await cdp.evaluate("document.getElementById('nav-forward').click(); return true;");
  await sleep(700);
  await cdp.evaluate("document.getElementById('nav-forward').click(); return true;");
  await waitFor(cdp, "!document.getElementById('chat-active').hidden && document.querySelector('#chat-log .post-title')", { label: 'forward to the post' });
  at = await where();
  check('forward comes back to the post', at.chat && at.name === 'A post', JSON.stringify(at));
  check('and at the end forward is off', JSON.stringify(await buttons()) === '[false,true]');
  // the keyboard: Command-[ on a Mac, Alt+Left elsewhere
  await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', ${platform === 'darwin' ? "{ key: '[', metaKey: true }" : "{ key: 'ArrowLeft', altKey: true }"}));  return true;`);
  await sleep(700);
  at = await where();
  check('the keyboard goes back too', at.forum && !at.chat, JSON.stringify(at));
  await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', ${platform === 'darwin' ? "{ key: ']', metaKey: true }" : "{ key: 'ArrowRight', altKey: true }"})); return true;`);
  await waitFor(cdp, "!document.getElementById('chat-active').hidden && document.querySelector('#chat-log .post-title')", { label: 'forward by key' });
  check('and forward', true);
  // going somewhere new from the middle drops what was ahead
  await cdp.evaluate("document.getElementById('nav-back').click(); return true;");
  await sleep(600);
  await cdp.evaluate(`${row('general')}.click(); return true;`);
  await sleep(800);
  check('somewhere new after going back drops what was ahead', JSON.stringify(await buttons()) === '[false,true]');
  void post;
  await shot('2-navigated');

  // ---- About
  const about = await rect('#about-open');
  const barNow = await rect('#titlebar');
  check('a button at the end of the bar opens About, clear of the system\'s window buttons', about && about.r <= barNow.r - (platform === 'darwin' ? 8 : 130) + 4 && about.y >= 0 && about.b <= 32, JSON.stringify({ about, barNow }));
  await cdp.evaluate("document.getElementById('about-open').click(); return true;");
  await waitFor(cdp, "document.getElementById('about').open", { label: 'the about window' });
  const wanted = await cdp.evaluate('return harmony.version().then((v) => v.data ?? v);');
  check('it shows the logo, the name and the version of the app', (await visible('#about .about-logo')) && (await text('#about-title')) === 'Harmony' && (await text('#about-version')) === wanted && /^\d+\.\d+\.\d+/.test(wanted), String(wanted));
  const credits = await text('#about');
  check('who made it, the credits and what it is built on', /Pedro Lucas Miguel/.test(credits) && /Ciranda/.test(credits) && /Brunovncs/.test(credits) && /MediaMTX/.test(credits) && /Electron/.test(credits));
  check('with links that open in the browser', await cdp.evaluate("const links = [...document.querySelectorAll('#about a[href]')]; return links.length >= 8 && links.every((a) => a.target === '_blank' && a.rel.includes('noopener') && a.href.startsWith('https://'));"));
  await shot('about');
  check('it fits the window', await cdp.evaluate("const r = document.getElementById('about').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;"));
  await cdp.evaluate("document.getElementById('about-close').click(); return true;");
  await sleep(300);
  check('Close puts it away', !(await cdp.evaluate("return document.getElementById('about').open;")));
  await cdp.evaluate("document.getElementById('about-open').click(); return true;");
  await sleep(200);
  await cdp.evaluate("document.getElementById('about').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); document.getElementById('about').close(); return true;");
  await sleep(200);

  // ---- the rest of the page is clear of the bar
  const view = await rect('#view-channels');
  const head = await rect('#server-head');
  check('the server\'s head and the channels start under the bar', view.y >= 32 && head.y >= 32, JSON.stringify({ view, head }));

  // ---- a narrow window: the drawer is under the bar too
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 560, height: 700, deviceScaleFactor: 1, mobile: false });
  await sleep(700);
  await cdp.evaluate("document.getElementById('channels-menu')?.click(); return true;");
  await sleep(600);
  const drawer = await rect('.channel-list');
  check('on a narrow window the channel drawer opens under the bar', drawer.y >= 32, JSON.stringify(drawer));
  check('and the bar still has its buttons and the server\'s name', (await visible('#nav-back')) && (await visible('#titlebar-name')));
  await shot('3-narrow');
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
