// Dragging a channel or a group in the sidebar: a preview of where it will land, drawn while the drag is still on.
// Real drags (Input.setInterceptDrags), as channel-groups.mjs does them, stopped before the drop.
//
//   node client/test/channel-drop-preview.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const serverEntry = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'src', 'index.js');
const { check, summary } = reporter();

const PORT = 18191, MTX = 20091, DBG = 9482, BASE = `http://127.0.0.1:${PORT}`;
const procs = []; let log = '', ownerKey = null, token = null;
process.on('exit', () => procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } }));
http.createServer((_q, r) => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end('{"itemCount":0,"pageCount":0,"items":[]}'); }).listen(MTX, '127.0.0.1');
const server = spawn(process.execPath, [serverEntry], {
  env: { ...process.env, HARMONY_PORT: String(PORT), HARMONY_HOST: '127.0.0.1', HARMONY_DATA_DIR: mkdtempSync(join(tmpdir(), 'gdp-')),
    HARMONY_MEDIAMTX_API: `http://127.0.0.1:${MTX}`, HARMONY_SIGNALING_URL: 'http://127.0.0.1:8889', HARMONY_POLL_INTERVAL_MS: '500' }, stdio: ['ignore', 'pipe', 'pipe'] });
procs.push(server);
await new Promise((ok) => server.stdout.on('data', (b) => { log += b; const m = /^\s*│\s+([A-Za-z0-9_-]{20,})\s+│$/m.exec(log); if (m) ownerKey = m[1]; if (log.includes('control server on')) ok(); }));
const api = async (path, body) => { const r = await fetch(BASE + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(path + ' ' + JSON.stringify(j)); return j; };
token = (await api('/api/accounts/register', { nickname: 'tester', password: 'hunter22', ownerKey })).token;
const g = {}; for (const n of ['Alpha', 'Beta']) g[n] = (await api('/api/channels/groups', { name: n })).group.id;
const ch = {}; for (const n of ['a1', 'a2', 'b1']) ch[n] = (await api('/api/channels', { kind: 'text', name: n })).channel.id;
await api('/api/channels/arrange', { groups: [g.Alpha, g.Beta], channels: [{ id: ch.a1, groupId: g.Alpha }, { id: ch.a2, groupId: g.Alpha }, { id: ch.b1, groupId: g.Beta }] });

const app = launchApp({ port: DBG, userDataDir: mkdtempSync(join(tmpdir(), 'gdp-p-')) }); procs.push(app);
const cdp = await attach(await findPage(DBG)); await sleep(1200);
const set = (id, v) => cdp.evaluate(`const i=document.getElementById(${JSON.stringify(id)}); i.value=${JSON.stringify(v)}; i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new Event('change',{bubbles:true})); return true;`);
await set('server-url', BASE); await sleep(1500); await set('username', 'tester'); await set('account-password', 'hunter22');
await cdp.evaluate("document.getElementById('continue').click(); return true;");
await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'channels' }); await sleep(900);

const pt = (selector, text, frac = 0.5) => cdp.evaluate(`
  const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => (e.querySelector('.group-name, .channel-name')?.textContent ?? '') === ${JSON.stringify(text)});
  if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * ${frac} };`);
const G = (n, f) => pt('#channel-items li.channel-group', n, f);
const C = (n, f) => pt('#channel-items li.channel-row', n, f);
const emptySpace = () => cdp.evaluate(`const r = document.getElementById('channel-items').getBoundingClientRect(); const last=[...document.querySelectorAll('#channel-items > li')].at(-1).getBoundingClientRect(); return { x: r.left + r.width/2, y: Math.min(r.bottom - 4, last.bottom + 24) };`);

await cdp.send('Input.setInterceptDrags', { enabled: true });
let data = null; cdp.on('Input.dragIntercepted', (p) => { data = p.data; });
const mouse = (type, x, y, extra = {}) => cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: 1, clickCount: 1, ...extra });
const drag = (type, x, y) => cdp.send('Input.dispatchDragEvent', { type, x, y, data, modifiers: 0 });
/** Starts a drag on `from` and holds it over `over`, without dropping. */
async function hold(from, over) {
  data = null;
  await mouse('mouseMoved', from.x, from.y, { buttons: 0 }); await mouse('mousePressed', from.x, from.y);
  for (let i = 1; i <= 6 && !data; i++) { await mouse('mouseMoved', from.x + i * 4, from.y + i * 4); await sleep(30); }
  if (!data) throw new Error('the drag never started');
  await drag('dragEnter', over.x, over.y); await drag('dragOver', over.x, over.y); await sleep(60); await drag('dragOver', over.x, over.y + 0.5);
  await sleep(120);
}
/** Gives the drag up (nothing moves), as the browser ends it: a cancel, then the dragend on what was dragged. */
async function letGo(at) {
  await drag('dragCancel', at.x, at.y).catch(() => {});
  await cdp.evaluate("document.querySelector('#channel-items [data-dragging]')?.dispatchEvent(new DragEvent('dragend', { bubbles: true })); return true;");
  await mouse('mouseReleased', at.x, at.y);
  await sleep(300);
}
/** The preview, and the row it should be beside, read from the page. */
const preview = (rowSelector) => cdp.evaluate(`
  const list = document.getElementById('channel-items'); const p = list.querySelector('.channel-drop-preview');
  if (!p) return null;
  const pr = p.getBoundingClientRect(); const lr = list.getBoundingClientRect();
  const row = ${JSON.stringify(rowSelector)} ? list.querySelector(${JSON.stringify(rowSelector)}) : null; const rr = row?.getBoundingClientRect();
  return { top: pr.top, left: pr.left, width: pr.width, tag: p.querySelector('.drop-tag-name').textContent, kind: p.dataset.kind,
    visible: pr.top >= lr.top - 2 && pr.top <= lr.bottom + 2, rowTop: rr?.top ?? null, rowBottom: rr?.bottom ?? null, rowLeft: rr?.left ?? null };`);
const gone = () => cdp.evaluate("return !document.querySelector('#channel-items .channel-drop-preview');");

check('nothing is previewed when nothing is being dragged', await gone());

// A channel over another channel: a line just above it, at its level, naming what is moving.
await hold(await C('a2'), await C('b1'));
if (process.env.SHOT) {
  const r = await cdp.evaluate("const r = document.querySelector('.channel-list').getBoundingClientRect(); return { x: r.x - 70, y: r.y, w: r.width + 70, h: 420 };");
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.SHOT, Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 } })).data, 'base64'));
}
let p = await preview('li.channel-row[data-id="' + ch.b1 + '"]');
check('a channel over another: a line goes above it, naming the channel', p && p.tag === 'a2' && p.kind === 'channel' && Math.abs(p.top - p.rowTop) <= 5, JSON.stringify(p));
check('and it is at that row\'s level (inside the group: set in, as its channels are)', p && Math.abs(p.left - p.rowLeft) <= 1 && Math.abs(p.width - (p.width)) < 1, JSON.stringify(p));
const beforeGroup = await cdp.evaluate(`return document.querySelector('#channel-items li.channel-group').getBoundingClientRect().left;`);
check('which is further in than a group\'s heading', p && p.left > beforeGroup + 8, `${p?.left} vs ${beforeGroup}`);
await letGo(await C('b1'));
check('the line is gone once it is let go', await gone());

// Onto a heading's lower part: the end of the group, set in.
await hold(await C('a1'), await G('Beta', 0.8));
p = await preview('li.channel-row[data-id="' + ch.b1 + '"]');
check('onto a group\'s heading: a line under its last channel, at their level', p && Math.abs(p.top - p.rowBottom) <= 5 && Math.abs(p.left - p.rowLeft) <= 1 && p.tag === 'a1', JSON.stringify(p));
await letGo(await G('Beta', 0.8));

// Onto a heading's top edge: above the group, at the heading's own level.
await hold(await C('a1'), await G('Beta', 0.1));
p = await preview('li.channel-group[data-group-id="' + g.Beta + '"]');
check('onto the top of a heading: a line above the group, at the heading\'s level', p && Math.abs(p.top - p.rowTop) <= 5 && Math.abs(p.left - p.rowLeft) <= 1, JSON.stringify(p));
await letGo(await G('Beta', 0.1));

// A group over a channel: the same, naming the group.
await hold(await G('Beta'), await C('a1'));
p = await preview(null);
check('a group being dragged is previewed too, by its name', p && p.tag === 'Beta' && p.kind === 'group', JSON.stringify(p));
await letGo(await C('a1'));

// The empty space: the end of the list.
await hold(await C('b1'), await emptySpace());
p = await preview(null);
const lastBottom = await cdp.evaluate(`const rows=[...document.querySelectorAll('#channel-items > li')]; return rows.at(-1).getBoundingClientRect().bottom;`);
check('over the empty space: a line at the end of the list', p && Math.abs(p.top - lastBottom) <= 5 && p.tag === 'b1', JSON.stringify({ p, lastBottom }));
await drag('drop', (await emptySpace()).x, (await emptySpace()).y);
await mouse('mouseReleased', (await emptySpace()).x, (await emptySpace()).y);
await sleep(1000);
check('and gone again after a real drop', await gone());

app.kill();
const failed = summary();
process.exit(failed ? 1 : 0);
