// Mentioning a role, and rewriting your last message in the composer with Up: two real app windows.
//
//   node client/test/composer-ui.mjs

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

const HARMONY_PORT = 18420;
const FAKE_MTX_PORT = 20420;
const PORT_OWNER = 9741;
const PORT_BOB = 9742;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-composer-ui-'));
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
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-composer-ui-profile-')),
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


const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;

const keydown = (key) => `{
  const i = document.getElementById('chat-input');
  i.focus();
  i.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
  return true;
}`;

async function run() {
  console.log('Starting the server and two clients…\n');
  await startFakeMediaMtx();
  await startServer();
  await register('chief', { ownerKey });
  const bob = await register('bob');
  await register('carol');

  const owls = (await rest('chief', '/api/roles', { name: 'Night Owls', color: '#8844ff' })).body.role;
  const idle = (await rest('chief', '/api/roles', { name: 'Idle Folk', color: '#44aa88' })).body.role;
  await rest('chief', `/api/accounts/${bob.id}/roles`, { roles: [owls.id] });
  const text = (await rest('bob', '/api/channels')).body.channels.find((c) => c.kind === 'text');

  const owner = await signIn(PORT_OWNER, 'chief');
  const bobPage = await signIn(PORT_BOB, 'bob');
  for (const [name, page] of [['owner', owner], ['bob', bobPage]]) {
    await page.send('Runtime.enable');
    page.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
      console.log(`  [${name} exception]`, (d.exception?.description ?? d.text).split('\n').slice(0, 3).join(' / ').slice(0, 300));
    });
  }
  await owner.evaluate(`[...document.querySelectorAll('#channel-items .channel-row')].find((r) => r.textContent.includes(${JSON.stringify(text.name)})).click(); return true;`);
  await until(owner, "!document.getElementById('chat-input').disabled", { label: 'the chat open' });

  // --- mentioning a role ---------------------------------------------------------------------------------------------
  await owner.evaluate(`${setInput('chat-input', '@night')} return true;`);
  await until(owner, "!document.getElementById('mention-pop').hidden", { label: 'the suggestion list' });
  const list = await owner.evaluate(`return [...document.querySelectorAll('#mention-items li')].map((li) => ({ nick: li.dataset.nickname, text: li.textContent }))`);
  check('typing @ and part of a role\'s name suggests the role, with how many it would notify',
    list.length === 1 && list[0].nick === 'night-owls' && /Night Owls/.test(list[0].text) && /1 member/.test(list[0].text), JSON.stringify(list));
  await owner.evaluate(`${setInput('chat-input', '@')} return true;`);
  await sleep(200);
  const everything = await owner.evaluate("return [...document.querySelectorAll('#mention-items li')].map((li) => li.dataset.nickname)");
  check('a bare @ lists the people, then the roles (top of the hierarchy first), then everyone',
    JSON.stringify(everything) === JSON.stringify(['bob', 'carol', 'chief', 'night-owls', 'idle-folk', 'everyone']), JSON.stringify(everything));

  await owner.evaluate(`${setInput('chat-input', 'wake up @night')} return true;`);
  await until(owner, "!document.getElementById('mention-pop').hidden", { label: 'the list again' });
  await owner.evaluate(keydown('Enter'));
  const filled = await owner.evaluate("return document.getElementById('chat-input').value");
  check('Enter takes it, writing the role\'s handle', filled === 'wake up @night-owls ', JSON.stringify(filled));
  await owner.evaluate(keydown('Enter'));
  await until(owner, "[...document.querySelectorAll('#chat-log .mention[data-role]')].length === 1", { label: 'the mention drawn' });
  const drawn = await owner.evaluate(`{
    const m = document.querySelector('#chat-log .mention[data-role]');
    return { text: m.textContent, me: m.hasAttribute('data-me'), color: getComputedStyle(m).color };
  }`);
  check('it is drawn as @ and the role\'s name, in the role\'s colour', drawn.text === '@Night Owls' && drawn.color === rgb('#8844ff'), JSON.stringify(drawn));
  check('and not as one of the ones addressed to the person who wrote it', drawn.me === false, JSON.stringify(drawn));
  const sent = (await rest('chief', `/api/channels/${text.id}/messages`)).body.messages.at(-1);
  check('the server worked out who it is for', JSON.stringify(sent.mentionRoles) === JSON.stringify([owls.id]), JSON.stringify(sent));

  // Bob holds the role and is not looking at the channel: it rings there.
  await until(bobPage, `document.querySelector('#channel-items .channel-row[data-mention]')`, { label: 'the mention mark on Bob\'s channel list' });
  check('somebody holding the role is told, on the channel they are not looking at',
    await bobPage.evaluate("return document.querySelector('#channel-items .channel-row[data-mention]').dataset.mention") === '1', '');
  await shot(owner, 'role-mention');

  // A role Bob does not hold does not ring him.
  await owner.evaluate(`${setInput('chat-input', '@idle-folk are you there')} return true;`);
  await owner.evaluate(keydown('Enter'));
  await until(owner, "document.querySelectorAll('#chat-log .mention[data-role]').length === 2", { label: 'the second mention' });
  await sleep(1200);
  check('and one he does not hold does not ring him again', await bobPage.evaluate("return document.querySelector('#channel-items .channel-row[data-mention]').dataset.mention") === '1', '');

  // A role that was never made is plain text.
  await owner.evaluate(`${setInput('chat-input', 'mail me at @nobody-at-all')} return true;`);
  await owner.evaluate(keydown('Enter'));
  await until(owner, "[...document.querySelectorAll('#chat-log .chat-msg')].some((r) => r.textContent.includes('nobody-at-all'))", { label: 'the plain one' });
  check('an @ that names nothing is left as text', await owner.evaluate("return document.querySelectorAll('#chat-log .mention[data-role]').length") === 2, '');

  // --- rewriting the last message with Up ------------------------------------------------------------------------------
  // Bob speaks last, to show that Up finds the last of YOUR messages.
  await rest('bob', `/api/channels/${text.id}/messages`, { body: 'bob has the last word' });
  await until(owner, "[...document.querySelectorAll('#chat-log .chat-msg')].some((r) => r.textContent.includes('bob has the last word'))", { label: 'Bob\'s message' });

  await owner.evaluate(`${setInput('chat-input', 'half a thought')} return true;`);
  await owner.evaluate(keydown('ArrowUp'));
  check('Up with something already typed does nothing to it',
    await owner.evaluate("return document.getElementById('chat-input').value") === 'half a thought'
    && await owner.evaluate("return document.getElementById('chat-editing').hidden"), '');
  await owner.evaluate(`${setInput('chat-input', '')} return true;`);

  await owner.evaluate(keydown('ArrowUp'));
  const editing = await owner.evaluate(`{
    const form = document.getElementById('chat-form');
    return {
      value: document.getElementById('chat-input').value,
      bar: !document.getElementById('chat-editing').hidden,
      barText: document.getElementById('chat-editing').textContent.trim(),
      marked: form.hasAttribute('data-editing'),
      row: document.querySelector('#chat-log .chat-msg[data-editing]')?.textContent ?? null,
      focused: document.activeElement === document.getElementById('chat-input'),
      sendTitle: document.getElementById('chat-send').title,
    };
  }`);
  check('Up in an empty box puts your last message in it, and says it is being edited',
    editing.value === 'mail me at @nobody-at-all' && editing.bar && /Editing/.test(editing.barText) && editing.marked, JSON.stringify(editing));
  check('the message in the log is marked, the box has focus, and the button says Save',
    /nobody-at-all/.test(editing.row ?? '') && editing.focused && /save/i.test(editing.sendTitle), JSON.stringify(editing));
  await shot(owner, 'editing');

  await owner.evaluate(keydown('Escape'));
  const left = await owner.evaluate(`return ({ value: document.getElementById('chat-input').value, hidden: document.getElementById('chat-editing').hidden,
    marked: document.getElementById('chat-form').hasAttribute('data-editing'), rows: document.querySelectorAll('#chat-log .chat-msg[data-editing]').length })`);
  check('Escape lets go: the box is empty again and nothing changed',
    left.value === '' && left.hidden && !left.marked && left.rows === 0, JSON.stringify(left));
  check('nothing was sent or changed on the server',
    (await rest('chief', `/api/channels/${text.id}/messages`)).body.messages.some((m) => m.body === 'mail me at @nobody-at-all' && !m.editedAt), '');

  await owner.evaluate(keydown('ArrowUp'));
  await owner.evaluate(`${setInput('chat-input', 'mail me at the office')} return true;`);
  await owner.evaluate(keydown('Enter'));
  await until(owner, "[...document.querySelectorAll('#chat-log .chat-msg')].some((r) => r.textContent.includes('the office'))", { label: 'the edit arriving' });
  const afterSave = await owner.evaluate(`return ({ value: document.getElementById('chat-input').value, hidden: document.getElementById('chat-editing').hidden,
    marked: document.getElementById('chat-form').hasAttribute('data-editing'),
    count: [...document.querySelectorAll('#chat-log .chat-msg')].filter((r) => r.textContent.includes('mail me')).length })`);
  const serverSide = (await rest('chief', `/api/channels/${text.id}/messages`)).body.messages;
  check('Enter saves it: the same message, changed, and the composer is back to normal',
    serverSide.filter((m) => m.body === 'mail me at the office').length === 1 && !serverSide.some((m) => m.body.includes('nobody-at-all'))
    && afterSave.count === 1 && afterSave.value === '' && afterSave.hidden && !afterSave.marked, JSON.stringify(afterSave));
  check('and the server marks it edited', Boolean(serverSide.find((m) => m.body === 'mail me at the office')?.editedAt), '');

  // Saving what is already there changes nothing, and the Edit button on a row does the same as Up.
  await owner.evaluate(`{
    const mine = [...document.querySelectorAll('#chat-log .chat-msg')].find((r) => r.textContent.includes('the office'));
    mine.querySelector('.msg-tool[data-icon="pencil-simple"]').click(); return true;
  }`);
  check('the Edit button on a message opens it in the composer, too',
    await owner.evaluate("return document.getElementById('chat-input').value") === 'mail me at the office'
    && await owner.evaluate("return !document.getElementById('chat-editing').hidden"), '');
  await owner.evaluate(keydown('Enter'));
  await until(owner, "document.getElementById('chat-editing').hidden", { label: 'leaving the edit' });
  check('saving it unchanged ends the edit without a new version',
    (await rest('chief', `/api/channels/${text.id}/messages`)).body.messages.filter((m) => m.body === 'mail me at the office').length === 1, '');

  // A draft survives the detour.
  await owner.evaluate(`${setInput('chat-input', 'my draft')} document.querySelector('#chat-log .msg-tool[data-icon="pencil-simple"]').click(); return true;`);
  await owner.evaluate(keydown('Escape'));
  const draft = await owner.evaluate("return { value: document.getElementById('chat-input').value, hidden: document.getElementById('chat-editing').hidden }");
  check('a half-typed message comes back when the edit is cancelled', draft.value === 'my draft' && draft.hidden, JSON.stringify(draft));
  await owner.evaluate(`${setInput('chat-input', '')} return true;`);

  // Somebody else's message is not yours to edit: with none of your own loaded, Up does nothing.
  await bobPage.evaluate(`[...document.querySelectorAll('#channel-items .channel-row')].find((r) => r.textContent.includes(${JSON.stringify(text.name)})).click(); return true;`);
  await until(bobPage, "!document.getElementById('chat-input').disabled && document.querySelectorAll('#chat-log .chat-msg').length > 0", { label: 'Bob reading' });
  await bobPage.evaluate(keydown('ArrowUp'));
  check('Up edits only your own: Bob\'s last message, not the last one in the channel',
    await bobPage.evaluate("return document.getElementById('chat-input').value") === 'bob has the last word', '');
  await bobPage.evaluate(keydown('Escape'));

  // Switching channel leaves the edit.
  await owner.evaluate(keydown('ArrowUp'));
  const other = (await rest('chief', '/api/channels')).body.channels.filter((c) => c.kind === 'text' && c.id !== text.id)[0]
    ?? (await rest('chief', '/api/channels', { name: 'elsewhere', kind: 'text' })).body.channel;
  await owner.evaluate(`[...document.querySelectorAll('#channel-items .channel-row')].find((r) => r.textContent.includes(${JSON.stringify(other.name)})).click(); return true;`);
  await sleep(800);
  const moved = await owner.evaluate("return { value: document.getElementById('chat-input').value, hidden: document.getElementById('chat-editing').hidden }");
  check('going to another channel drops the edit and leaves the box empty', moved.hidden && moved.value === '', JSON.stringify(moved));
}

try {
  await run();
} catch (err) {
  console.log('  FAIL ', err.stack);
  process.exitCode = 1;
} finally {
  summary();
  process.exit(process.exitCode ?? 0);
}
