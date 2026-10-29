// Reordering the sidebar with real drags: groups among ungrouped channels.
//
//   node client/test/channel-groups.mjs
//
// Not synthetic events. Chromium's drag interception (Input.setInterceptDrags)
// lets the page start a genuine HTML5 drag and be handed a genuine drop, so what
// is exercised is the same path a mouse takes: draggable rows, dragover, drop,
// and where over a heading the pointer was.
//
// What it pins: a group can be put above, between and below ungrouped channels;
// dropping a group anywhere that is not a place for it leaves it alone rather
// than sending it to the bottom; a channel can go above a heading or into it;
// and "Move up / Move down" in the menu does what a drag does, for the places
// with no dragging.
//
// MediaMTX is stubbed, as in channels-ui.mjs: nothing here touches media.

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const serverEntry = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'src', 'index.js');
const { check, summary } = reporter();

const PORT = 18190, MTX = 20090, DBG = 9481, BASE = `http://127.0.0.1:${PORT}`;
const procs = []; let log = '', ownerKey = null, token = null;
process.on('exit', () => procs.forEach((p) => { try { p.kill(); } catch {} }));
const fake = http.createServer((_q, r) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end('{"itemCount":0,"pageCount":0,"items":[]}'); }).listen(MTX, '127.0.0.1');
const server = spawn(process.execPath, [serverEntry], {
  env: { ...process.env, HARMONY_PORT: String(PORT), HARMONY_HOST: '127.0.0.1', HARMONY_DATA_DIR: mkdtempSync(join(tmpdir(), 'gd-')),
    HARMONY_MEDIAMTX_API: `http://127.0.0.1:${MTX}`, HARMONY_SIGNALING_URL: 'http://127.0.0.1:8889', HARMONY_POLL_INTERVAL_MS: '500' }, stdio: ['ignore', 'pipe', 'pipe'] });
procs.push(server);
await new Promise((ok) => server.stdout.on('data', (b) => { log += b; const m = /^\s*│\s+([A-Za-z0-9_-]{20,})\s+│$/m.exec(log); if (m) ownerKey = m[1]; if (log.includes('control server on')) ok(); }));
const api = async (path, body) => { const r = await fetch(BASE + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(path + ' ' + JSON.stringify(j)); return j; };
token = (await api('/api/accounts/register', { nickname: 'tester', password: 'hunter22', ownerKey })).token;
const g = {}; for (const n of ['Alpha', 'Beta', 'Gamma']) g[n] = (await api('/api/channels/groups', { name: n })).group.id;
const ch = {}; for (const n of ['a1', 'a2', 'b1', 'b2', 'c1', 'c2']) ch[n] = (await api('/api/channels', { kind: 'text', name: n })).channel.id;
const inGroup = { a1: 'Alpha', a2: 'Alpha', b1: 'Beta', b2: 'Beta', c1: 'Gamma', c2: 'Gamma' };
await api('/api/channels/arrange', { groups: [g.Alpha, g.Beta, g.Gamma], channels: Object.entries(ch).map(([n, id]) => ({ id, groupId: g[inGroup[n]] })) });
const order = async () => { const j = await api('/api/channels'); const gn = Object.fromEntries(Object.entries(g).map(([k, v]) => [v, k]));
  return { groups: j.groups.map((x) => x.name).join(','), channels: j.channels.map((c) => `${c.name}@${c.groupId ? gn[c.groupId] : '-'}`).join(' ') }; };

const app = launchApp({ port: DBG, userDataDir: mkdtempSync(join(tmpdir(), 'gd-p-')) }); procs.push(app);
const cdp = await attach(await findPage(DBG)); await sleep(1200);
const set = (id, v) => cdp.evaluate(`const i=document.getElementById(${JSON.stringify(id)}); i.value=${JSON.stringify(v)}; i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true})); return true;`);
await set('server-url', BASE); await sleep(1500); await set('username', 'tester'); await set('account-password', 'hunter22');
await cdp.evaluate("document.getElementById('continue').click(); return true;");
await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'channels' }); await sleep(800);


const pt = (selector, text, frac = 0.5) => cdp.evaluate(`
  const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const el = els.find((e) => (e.querySelector('.group-name, .channel-name')?.textContent ?? '') === ${JSON.stringify(text)});
  if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * ${frac} };`);
const G = (n, f) => pt('#channel-items li.channel-group', n, f);
const C = (n, f) => pt('#channel-items li.channel-row', n, f);
const end = () => cdp.evaluate(`const r = document.getElementById('channel-items').getBoundingClientRect(); const last=[...document.querySelectorAll('#channel-items > li')].at(-1).getBoundingClientRect(); return { x: r.left + r.width/2, y: Math.min(r.bottom - 4, last.bottom + 20) };`);

// What the sidebar draws, read from the page itself.
const drawn = () => cdp.evaluate(`return [...document.querySelectorAll('#channel-items > li')].filter((li) => !li.classList.contains('channel-members')).map((li) => li.classList.contains('channel-group') ? '[' + li.querySelector('.group-name').textContent + ']' : (li.parentElement && li.querySelector('.channel-name').textContent)).join(' ')`);

await cdp.send('Input.setInterceptDrags', { enabled: true });
let data = null; cdp.on('Input.dragIntercepted', (p) => { data = p.data; });
async function realDrag(from, to) {
  if (!from || !to) return 'missing element';
  data = null;
  const m = (type, x, y, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: 1, clickCount: 1, ...extra });
  await m('mouseMoved', from.x, from.y, { buttons: 0 }); await m('mousePressed', from.x, from.y);
  for (let i = 1; i <= 6 && !data; i++) { await m('mouseMoved', from.x + i * 4, from.y + i * 4); await sleep(30); }
  if (!data) return 'drag never started';
  const d = (type, x, y) => cdp.send('Input.dispatchDragEvent', { type, x, y, data, modifiers: 0 });
  await d('dragEnter', to.x, to.y); await d('dragOver', to.x, to.y); await sleep(50); await d('dragOver', to.x, to.y + 0.5);
  await d('drop', to.x, to.y);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
  await sleep(1000); return 'ok';
}
const step = async (label, expect, run) => {
  const r = await run(); const got = await drawn();
  check(label, got === expect && (r === 'ok' || r === undefined), got === expect ? got : `${got} (wanted ${expect}; ${r})`);
};


const inGroupOf = async (name) => (await order()).channels.split(' ').find((x) => x.startsWith(name + '@'));
const menu = async (groupName, label) => {
  await cdp.evaluate(`
    const el = [...document.querySelectorAll('#channel-items li.channel-group')].find((e) => e.querySelector('.group-name').textContent === ${JSON.stringify(groupName)});
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 5 }));
    return true;`);
  await sleep(200);
  const labels = await cdp.evaluate("return [...document.querySelectorAll('#row-menu .menu-item')].map((b) => b.textContent)");
  const clicked = await cdp.evaluate(`const b = [...document.querySelectorAll('#row-menu .menu-item')].find((x) => x.textContent === ${JSON.stringify(label)}); if (b) b.click(); return Boolean(b);`);
  await sleep(1000);
  return clicked ? 'ok' : `no "${label}" in [${labels}]`;
};

// ungrouped: general, voice.  groups: Alpha{a1 a2} Beta{b1 b2} Gamma{c1 c2}
await step('a group dropped on an ungrouped channel lands above it',
  '[Alpha] a1 a2 general voice [Beta] b1 b2 [Gamma] c1 c2',
  async () => realDrag(await G('Alpha'), await C('general')));
await step('a group can be put between two ungrouped channels',
  '[Alpha] a1 a2 general [Gamma] c1 c2 voice [Beta] b1 b2',
  async () => realDrag(await G('Gamma'), await C('voice')));
await step('a group dropped on a channel inside another goes above that group',
  '[Beta] b1 b2 [Alpha] a1 a2 general [Gamma] c1 c2 voice',
  async () => realDrag(await G('Beta'), await C('a2')));
await step('a group dropped on its own heading stays where it is',
  '[Beta] b1 b2 [Alpha] a1 a2 general [Gamma] c1 c2 voice',
  async () => realDrag(await G('Beta'), await G('Beta')));
await step('a group dropped on its own channel stays where it is',
  '[Beta] b1 b2 [Alpha] a1 a2 general [Gamma] c1 c2 voice',
  async () => realDrag(await G('Beta'), await C('b1')));
await step('a channel on the upper half of a heading goes above the group, ungrouped',
  'voice [Beta] b1 b2 [Alpha] a1 a2 general [Gamma] c1 c2',
  async () => realDrag(await C('voice'), await G('Beta', 0.2)));
await step('a channel on the lower half of a heading goes into the group',
  'voice [Beta] b1 b2 general [Alpha] a1 a2 [Gamma] c1 c2',
  async () => realDrag(await C('general'), await G('Beta', 0.8)));
await step('a group dropped on the empty space goes last',
  'voice [Alpha] a1 a2 [Gamma] c1 c2 [Beta] b1 b2 general',
  async () => realDrag(await G('Beta'), await end()));
// While a channel from a group is dragged, the strip "drop here to take it out"
// fills the bottom of the list, so this lands on it: just below its own group.
await step('a channel dropped on the way-out strip comes out of its group, just below it',
  'voice [Alpha] a2 a1 [Gamma] c1 c2 [Beta] b1 b2 general',
  async () => realDrag(await C('a1'), await end()));
check('and it is really ungrouped on the server', (await inGroupOf('a1')) === 'a1@-', await inGroupOf('a1'));
await step('"Move up" in a group\'s menu moves it past what is above',
  'voice [Alpha] a2 [Gamma] c1 c2 a1 [Beta] b1 b2 general',
  async () => menu('Gamma', 'Move up'));
await step('"Move down" does the reverse',
  'voice [Alpha] a2 a1 [Gamma] c1 c2 [Beta] b1 b2 general',
  async () => menu('Gamma', 'Move down'));
app.kill();
const failed = summary();
process.exit(failed ? 1 : 0);
