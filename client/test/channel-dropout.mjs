// Taking a channel out of a group by dragging it.
//
//
//   node client/test/channel-dropout.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const serverEntry = resolve(repoRoot, 'server', 'src', 'index.js');

const HARMONY_PORT = 18380;
const FAKE_MTX_PORT = 20380;
const PORT_OWNER = 9701;
const PORT_BOB = 9702;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-dropout-'));
const { check, summary } = reporter();
const procs = [];
let fakeMtx = null;
let serverLog = '';
let ownerKey = null;

function cleanup() {
  for (const p of procs) {
    try { p.kill(); } catch { /* already gone */ }
  }
  try { fakeMtx?.close(); } catch { /* already closed */ }
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

function startFakeMediaMtx() {
  return new Promise((done) => {
    fakeMtx = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ itemCount: 0, pageCount: 0, items: [] }));
    });
    fakeMtx.listen(FAKE_MTX_PORT, '127.0.0.1', done);
  });
}

function startServer() {
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        HARMONY_PORT: String(HARMONY_PORT),
        HARMONY_HOST: '127.0.0.1',
        HARMONY_DATA_DIR: dataDir,
        HARMONY_MEDIAMTX_API: `http://127.0.0.1:${FAKE_MTX_PORT}`,
        HARMONY_SIGNALING_URL: 'http://media.test:8889',
        HARMONY_POLL_INTERVAL_MS: '400',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    procs.push(p);
    const timer = setTimeout(() => fail(new Error('server did not start')), 15_000);
    p.stdout.on('data', (b) => {
      serverLog += b.toString();
      const match = /^\s*│\s+([A-Za-z0-9_-]{20,})\s+│$/m.exec(serverLog);
      if (match) ownerKey = match[1];
      if (serverLog.includes('control server on')) {
        clearTimeout(timer);
        done();
      }
    });
    p.stderr.on('data', (b) => (serverLog += b.toString()));
  });
}

const tokens = {};
async function register(nickname, extra = {}) {
  const res = await fetch(`${BASE}/api/accounts/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, password: 'hunter22', ...extra }),
  });
  if (!res.ok) throw new Error(`register ${nickname}: ${res.status}`);
  const body = await res.json();
  tokens[nickname] = body.token;
  return body.user;
}
const rest = async (as, path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[as]}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

const STUBS = `
  const md = navigator.mediaDevices;
  md.enumerateDevices = async () => [];
  md.getUserMedia = async () => { throw new DOMException('no device', 'NotFoundError'); };
  return true;`;

const setInput = (id, value) => `{
  const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
  i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
}`;

async function signIn(port, nickname) {
  const app = launchApp({
    port,
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-dropout-profile-')),
    extraArgs: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  procs.push(app);
  const page = await attach(await findPage(port));
  await sleep(1500);
  await page.evaluate(STUBS);
  await page.evaluate(`${setInput('server-url', BASE)} return true;`);
  await sleep(4000);
  await page.evaluate(`${setInput('username', nickname)} ${setInput('account-password', 'hunter22')}
    document.getElementById('continue').click(); return true;`);
  await waitFor(page, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: `${nickname} signing in`, timeoutMs: 60_000 });
  await sleep(1500);
  return page;
}

async function until(page, expression, { timeoutMs = 10_000, label = expression } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await page.evaluate(`return (${expression})`).catch(() => undefined);
    if (last) return last;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

/** ROLES_SHOTS=/some/dir saves a picture of each page, for looking at rather than asserting. */
async function shot(page, name) {
  const dir = process.env.ROLES_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(dir, `${name}.png`), Buffer.from(data, 'base64'));
}

const click = (page, selector) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); return true;`);
const tab = (page, name) => click(page, `#server-dialog .settings-tab[data-tab="${name}"]`);
/** Click the checkbox whose label contains this text, inside a container. */
const tick = (page, container, label) => page.evaluate(`{
  const row = [...document.querySelectorAll(${JSON.stringify(`${container} label.check`)})]
    .find((l) => l.textContent.includes(${JSON.stringify(label)}));
  row.querySelector('input').click();
  return true;
}`);
const nameColor = (page, selector) => page.evaluate(`{
  const n = document.querySelector(${JSON.stringify(selector)});
  return n ? getComputedStyle(n).color : null;
}`);





/** Fire the sequence a real drag does, with a real DataTransfer, on the elements named. */
const drag = (page, fromSel, toSel, { drop = true } = {}) => page.evaluate(`{
  const from = document.querySelector(${JSON.stringify(fromSel)});
  const dt = new DataTransfer();
  from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  ${toSel ? `
  const to = document.querySelector(${JSON.stringify(toSel)});
  to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  ${drop ? "to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));" : ''}` : ''}
  return true;
}`);
const rowOf = (name) => `#channel-items .channel-row[data-id="${name}"]`;

async function run() {
  await startFakeMediaMtx();
  await startServer();
  await register('chief', { ownerKey });
  const g = (await rest('chief', '/api/channels/groups', { name: 'Games' })).body.group;
  const a = (await rest('chief', '/api/channels', { kind: 'text', name: 'alpha', groupId: g.id })).body.channel;
  const b = (await rest('chief', '/api/channels', { kind: 'text', name: 'bravo', groupId: g.id })).body.channel;
  const owner = await signIn(PORT_OWNER, 'chief');
  await sleep(500);
  const state = async () => (await rest('chief', '/api/channels')).body;
  const hidden = () => owner.evaluate("return document.getElementById('channel-dropout').hidden");

  check('the way out is not on screen until a drag starts', await hidden(), '');

  // an ungrouped channel has nothing to come out of
  await drag(owner, rowOf((await state()).channels.find((c) => c.name === 'general').id));
  check('dragging a channel that is in no group does not offer it', await hidden(), '');
  await owner.evaluate("document.dispatchEvent(new DragEvent('dragend', { bubbles: true })); return true;");

  // a grouped one does
  await drag(owner, rowOf(a.id));
  check('dragging a channel out of a group shows a strip saying where to drop it', !(await hidden()) && (await owner.evaluate("return document.getElementById('channel-dropout').textContent")).includes('take it out'), '');
  await shot(owner, 'dropout');
  await owner.evaluate(`{
    const to = document.getElementById('channel-dropout'); const dt = new DataTransfer();
    to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return true;
  }`);
  check('which lights up under the pointer', await owner.evaluate("return document.getElementById('channel-dropout').hasAttribute('data-over')"), '');
  await owner.evaluate(`{
    const to = document.getElementById('channel-dropout'); const dt = new DataTransfer();
    to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    return true;
  }`);
  await until(owner, `[...document.querySelectorAll('#channel-items .channel-row')].length >= 4`, { label: 'the list' });
  await sleep(800);
  const after = await state();
  const alpha = after.channels.find((c) => c.id === a.id);
  const bravo = after.channels.find((c) => c.id === b.id);
  const group = after.groups.find((x) => x.id === g.id);
  check('dropping there takes it out of the group', alpha.groupId === null, JSON.stringify(alpha));
  check('and leaves the others in it', bravo.groupId === g.id, JSON.stringify(bravo));
  check('it lands just below the group it came out of, ungrouped', alpha.position > bravo.position && alpha.position > group.position, `alpha ${alpha.position}, group ${group.position}, bravo ${bravo.position}`);
  check('and the strip goes away again', await hidden(), '');
  const order = await owner.evaluate("return [...document.querySelectorAll('#channel-items > li')].map((li) => li.textContent.trim().split(/\\s+/)[0].toLowerCase())");
  check('the sidebar shows alpha outside the group', order.indexOf('alpha') > order.indexOf('bravo'), JSON.stringify(order));

  // the strip is hidden by a drop anywhere, too (the row may be redrawn before its dragend)
  await drag(owner, rowOf(b.id));
  await owner.evaluate("document.body.dispatchEvent(new DragEvent('drop', { bubbles: true })); return true;");
  check('and by a drop anywhere else, with no dragend needed', await hidden(), '');

  // --- into a group ------------------------------------------------------------------------------------------------
  const over = (target, fraction) => owner.evaluate(`{
    const to = document.querySelector(${JSON.stringify(target)});
    const box = to.getBoundingClientRect();
    const dt = window.__dt;
    to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: box.left + 20, clientY: box.top + box.height * ${fraction} }));
    const marks = (attr) => [...document.querySelectorAll('#channel-items [' + attr + ']')].map((n) => n.className.split(' ')[0] + ':' + (n.dataset.id ?? n.dataset.groupId));
    const heading = document.querySelector('#channel-items li.channel-group');
    return { into: marks('data-drop-into'), inGroup: marks('data-drop-in-group'), before: marks('data-drop-before'), label: heading.dataset.dropLabel ?? null };
  }`);
  const begin = (id) => owner.evaluate(`{
    window.__dt = new DataTransfer();
    document.querySelector('#channel-items .channel-row[data-id="${id}"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: window.__dt }));
    return true;
  }`);
  const heading = '#channel-items li.channel-group';
  const now = await state();
  const gid = now.groups.find((x) => x.name === 'Games').id;
  await begin(a.id);
  const onName = await over(heading, 0.6);
  await shot(owner, 'into-group');
  check('right on top of a group\'s name, the group is the target: heading outlined and named', onName.into.length === 1 && onName.label === 'Move into Games' && onName.before.length === 0, JSON.stringify(onName));
  check('and the whole group is tinted with it, its channels too', onName.inGroup.includes(`channel-group:${gid}`) && onName.inGroup.includes(`channel-row:${b.id}`), JSON.stringify(onName));
  const onEdge = await over(heading, 0.1);
  check('only the very top edge of the heading means "above the group"', onEdge.before.length === 1 && onEdge.into.length === 0 && onEdge.inGroup.length === 0, JSON.stringify(onEdge));
  const onRow = await over(`#channel-items .channel-row[data-id="${b.id}"]`, 0.5);
  check('over a channel inside the group, it is marked where it lands, and the group is lit as what it joins',
    onRow.before.includes(`channel-row:${b.id}`) && onRow.inGroup.includes(`channel-group:${gid}`) && onRow.into.length === 0, JSON.stringify(onRow));
  const onLoose = await over(`#channel-items .channel-row[data-id="${(await state()).channels.find((c) => c.name === 'general').id}"]`, 0.5);
  check('over a channel outside any group, no group is lit', onLoose.inGroup.length === 0 && onLoose.into.length === 0, JSON.stringify(onLoose));

  await over(heading, 0.6);
  await owner.evaluate(`{
    const to = document.querySelector('#channel-items li.channel-group');
    to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt, clientY: to.getBoundingClientRect().top + to.getBoundingClientRect().height * 0.6 }));
    return true;
  }`);
  await sleep(900);
  check('dropping there puts the channel in the group', (await state()).channels.find((c) => c.id === a.id).groupId === gid, '');
  check('and every mark is cleared', await owner.evaluate("return document.querySelectorAll('#channel-items [data-drop-in-group], #channel-items [data-drop-into], #channel-items [data-drop-before]').length === 0"), '');
}
try { await run(); } catch (e) { console.log('  FAIL ', e.message); process.exitCode = 1; }
summary(); cleanup(); process.exit(process.exitCode ?? 0);
