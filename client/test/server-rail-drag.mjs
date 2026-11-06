// Rearranging the servers on the rail with the mouse, as a person does it: press on a bubble, drag, let go.
//
//   node client/test/server-rail-drag.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const serverEntry = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'src', 'index.js');
const { check, summary } = reporter();

const PORT = 18192, MTX = 20092, DBG = 9483, BASE = `http://127.0.0.1:${PORT}`;
const procs = []; let log = '', ownerKey = null, token = null;
process.on('exit', () => procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } }));
http.createServer((_q, r) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end('{"itemCount":0,"pageCount":0,"items":[]}'); }).listen(MTX, '127.0.0.1');
const server = spawn(process.execPath, [serverEntry], {
  env: { ...process.env, HARMONY_PORT: String(PORT), HARMONY_HOST: '127.0.0.1', HARMONY_DATA_DIR: mkdtempSync(join(tmpdir(), 'srd-')),
    HARMONY_MEDIAMTX_API: `http://127.0.0.1:${MTX}`, HARMONY_SIGNALING_URL: 'http://127.0.0.1:8889', HARMONY_POLL_INTERVAL_MS: '500' }, stdio: ['ignore', 'pipe', 'pipe'] });
procs.push(server);
await new Promise((ok) => server.stdout.on('data', (b) => { log += b; const m = /^\s*│\s+([A-Za-z0-9_-]{20,})\s+│$/m.exec(log); if (m) ownerKey = m[1]; if (log.includes('control server on')) ok(); }));
const api = async (path, body) => { const r = await fetch(BASE + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(path + ' ' + JSON.stringify(j)); return j; };
token = (await api('/api/accounts/register', { nickname: 'tester', password: 'hunter22', ownerKey })).token;

const app = launchApp({ port: DBG, userDataDir: mkdtempSync(join(tmpdir(), 'srd-p-')) }); procs.push(app);
const cdp = await attach(await findPage(DBG)); await sleep(1200);
const set = (id, v) => cdp.evaluate(`const i=document.getElementById(${JSON.stringify(id)}); i.value=${JSON.stringify(v)}; i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true})); return true;`);
await set('server-url', BASE); await sleep(1500); await set('username', 'tester'); await set('account-password', 'hunter22');
await cdp.evaluate("document.getElementById('continue').click(); return true;");
await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'channels' }); await sleep(900);
// Two more saved servers that nobody answers at: bubbles all the same.
await cdp.evaluate(`const s = await harmony.settings.get(); const list = (s.data ?? s).servers;
  await harmony.settings.set({ servers: [...list, { url: 'http://127.0.0.1:18993', name: 'Second', username: '', password: '', sessionToken: '' }, { url: 'http://127.0.0.1:18994', name: 'Third', username: '', password: '', sessionToken: '' }] });
  location.reload(); return true;`);
await sleep(3500);
await waitFor(cdp, "document.querySelectorAll('#server-rail .rail-item[data-server]').length === 3", { label: 'three servers on the rail' });
const order = () => cdp.evaluate("return [...document.querySelectorAll('#server-rail .rail-item[data-server]')].map((b) => b.dataset.server.replace(/.*:/, ''))");
const centre = (port) => cdp.evaluate(`const b = document.querySelector('#server-rail .rail-item[data-server$=":${port}"]'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, bottom: r.bottom };`);
const saved = () => cdp.evaluate("const s = await harmony.settings.get(); return (s.data ?? s).servers.map((p) => p.url.replace(/.*:/, ''));");

const m = (type, x, y, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: 1, clickCount: 1, ...extra });
async function mouseDrag(from, to, { hold = false } = {}) {
  await m('mouseMoved', from.x, from.y, { buttons: 0 });
  await m('mousePressed', from.x, from.y);
  const steps = 12;
  for (let i = 1; i <= steps; i += 1) { await m('mouseMoved', from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps); await sleep(25); }
  await sleep(150);
  if (hold) return;
  await m('mouseReleased', to.x, to.y);
  await sleep(500);
}
const first = String(PORT), second = '18993', third = '18994';
check('the rail starts in the order saved', JSON.stringify(await order()) === JSON.stringify([first, second, third]), JSON.stringify(await order()));
// Third, dragged onto the lower half of the first: it goes after the first.
let a = await centre(first); let t = await centre(third);
await mouseDrag(t, { x: a.x, y: a.bottom - 6 });
check('dragging the last server onto the lower half of the first puts it second', JSON.stringify(await order()) === JSON.stringify([first, third, second]), JSON.stringify(await order()));
check('and the new order is what is saved', JSON.stringify(await saved()) === JSON.stringify([first, third, second]), JSON.stringify(await saved()));
a = await centre(first); t = await centre(second);
await mouseDrag(t, { x: a.x, y: a.top + 6 });
check('dragging one onto the upper half of the first puts it first', JSON.stringify(await order()) === JSON.stringify([second, first, third]), JSON.stringify(await order()));
check('a drag that is let go where it started changes nothing', await (async () => { const c = await centre(first); await mouseDrag(c, { x: c.x, y: c.y }); return JSON.stringify(await order()) === JSON.stringify([second, first, third]); })());
check('and a plain click on a bubble still only clicks it (no reorder, no drag left over)', await cdp.evaluate("return !document.querySelector('#server-rail [data-dragging], #server-rail [data-drop]');"));

// ---- what is on screen while it is held
{
  const before = JSON.stringify(await order());
  const from = await centre(first); const to = await centre(second);
  await mouseDrag(from, { x: to.x, y: to.bottom - 6 }, { hold: true });
  const held = await cdp.evaluate(`const g = document.querySelector('.rail-ghost'); const gr = g?.getBoundingClientRect();
    return { ghost: Boolean(g), ghostAt: gr && [gr.left + gr.width / 2, gr.top + gr.height / 2], source: document.querySelector('#server-rail .rail-item[data-dragging]')?.dataset.server ?? null,
      marks: [...document.querySelectorAll('#server-rail [data-drop]')].map((b) => b.dataset.server.replace(/.*:/, '') + ':' + b.dataset.drop), reordering: 'reordering' in document.getElementById('server-rail').dataset };`);
  check('held, a copy of the bubble follows the pointer', held.ghost && Math.abs(held.ghostAt[0] - to.x) < 3 && Math.abs(held.ghostAt[1] - (to.bottom - 6)) < 3, JSON.stringify({ held, to }));
  check('the one being moved is dimmed where it was, and the rail says it is being rearranged', held.source?.endsWith(first) && held.reordering, JSON.stringify(held));
  check('and one bar says where it would land: after the one it is over', JSON.stringify(held.marks) === JSON.stringify([second + ':after']), JSON.stringify(held.marks));
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await m('mouseReleased', to.x, to.bottom - 6);
  await sleep(400);
  check('Escape puts it back: nothing moved, and nothing is left on the screen', JSON.stringify(await order()) === before
    && await cdp.evaluate("return !document.querySelector('.rail-ghost, #server-rail [data-dragging], #server-rail [data-drop]');"), JSON.stringify(await order()));
  check('and the click that ended it did not open a server', (await cdp.evaluate("return document.querySelector('#server-rail .rail-item[aria-current=\"true\"]')?.dataset.server ?? null;"))?.endsWith(first) === true);
}

// ---- the rail drawn again while a bubble is in the hand (it is, on every change on any server)
{
  const result = await cdp.evaluate(`
    const { createServerRail } = await import('./server-rail.js');
    const nav = document.createElement('nav'); nav.id = 'test-rail'; nav.style.cssText = 'position:fixed;left:200px;top:100px;display:flex;flex-direction:column;gap:12px;z-index:50';
    document.body.append(nav);
    const moves = [];
    const rail = createServerRail({ root: nav, t: (k) => k, fillBadge: (n, spec) => { n.textContent = spec.name[0]; }, onSelect: (u) => moves.push(['select', u]), onHome() {}, onAdd() {}, onMove: (...a) => moves.push(['move', ...a]) });
    const view = () => ({ servers: ['A', 'B', 'C'].map((n) => ({ url: 'http://' + n, name: n, logo: null, banner: null, current: false, state: 'up', unread: 0, mentions: 0, inCall: false, voice: false })) });
    rail.render(view());
    window.__rail = { rail, view, moves, nav };
    return true;`);
  const at = (name) => cdp.evaluate(`const b = [...document.querySelectorAll('#test-rail .rail-item[data-server]')].find((x) => x.dataset.server === 'http://${name}'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, bottom: r.bottom };`);
  const a = await at('A'); const c = await at('C');
  await mouseDrag(a, { x: c.x, y: c.y + 10 }, { hold: true });
  const kept = await cdp.evaluate(`const before = [...document.querySelectorAll('#test-rail .rail-item[data-server]')]; window.__rail.rail.render(window.__rail.view()); window.__rail.rail.render(window.__rail.view());
    const after = [...document.querySelectorAll('#test-rail .rail-item[data-server]')];
    return { same: before.length === after.length && before.every((b, i) => b === after[i]), ghost: Boolean(document.querySelector('.rail-ghost')) };`);
  check('a redraw arriving while one is in the hand leaves the bubbles where they are, and the move goes on', kept.same && kept.ghost, JSON.stringify(kept));
  await m('mouseReleased', c.x, c.y + 10);
  await sleep(300);
  const moves = await cdp.evaluate('return window.__rail.moves;');
  check('and letting go asks for the move once: A, after C', JSON.stringify(moves) === JSON.stringify([['move', 'http://A', 'http://C', true]]), JSON.stringify(moves));
  // A plain click is a choice of server; a move is not.
  const b = await at('B');
  await m('mouseMoved', b.x, b.y, { buttons: 0 }); await m('mousePressed', b.x, b.y); await m('mouseReleased', b.x, b.y); await sleep(200);
  check('a plain click on a bubble still chooses that server', JSON.stringify((await cdp.evaluate('return window.__rail.moves;')).slice(1)) === JSON.stringify([['select', 'http://B']]), JSON.stringify(await cdp.evaluate('return window.__rail.moves;')));
  await cdp.evaluate("document.getElementById('test-rail').remove(); return true;");
}

app.kill();
const failed = summary();
process.exit(failed ? 1 : 0);
