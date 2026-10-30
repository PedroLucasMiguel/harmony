// Private conversations: copying the recovery key, pasting and dropping a file into the box; and
// selecting and copying text, and links, out of the chat.
//
//   node client/test/dm-copy-paste.mjs

import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const serverEntry = resolve(repoRoot, 'server', 'src', 'index.js');

const HARMONY_PORT = 18430;
const FAKE_MTX_PORT = 20430;
const PORT_OWNER = 9751;
const PORT_BOB = 9752;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-dm-copy-'));
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
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-dm-copy-profile-')),
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


async function run() {
  console.log('Starting the server and two clients…\n');
  await startFakeMediaMtx();
  await startServer();
  await register('alice', { ownerKey });
  await register('bob');
  const alice = await signIn(PORT_OWNER, 'alice');
  const bob = await signIn(PORT_BOB, 'bob');
  for (const [name, page] of [['alice', alice], ['bob', bob]]) {
    await page.send('Runtime.enable');
    page.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
      console.log(`  [${name} exception]`, (d.exception?.description ?? d.text).split('\n').slice(0, 3).join(' / ').slice(0, 300));
    });
  }
  await sleep(2500);

  // --- the recovery key's Copy button ------------------------------------------------------------------------------------
  await until(alice, "document.querySelector('#server-rail .rail-home') && !document.querySelector('#server-rail .rail-home').disabled", { label: 'the DM bubble' });
  await alice.evaluate("document.querySelector('#server-rail .rail-home').click(); return true;");
  await until(alice, "document.querySelector('.view[data-active]')?.id === 'view-dms' && document.getElementById('dm-panel').offsetParent !== null", { label: 'the list' });
  await alice.evaluate("[...document.querySelectorAll('#dm-panel-actions button')].find((b) => /recovery key/i.test(b.textContent))?.click(); return true;");
  await until(alice, "document.querySelector('dialog.dm-keys')?.open", { label: 'the recovery key' });
  const key = await alice.evaluate("return document.querySelector('dialog.dm-keys [data-testid=recovery-key]').textContent");
  await alice.evaluate("window.__copied = null; return true;");
  // A real click, which is what a person does: it carries the user gesture the clipboard wants.
  const at = await alice.evaluate(`{
    const b = [...document.querySelectorAll('dialog.dm-keys button')].find((x) => x.dataset.icon === 'copy');
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: b.textContent };
  }`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await alice.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  }
  await sleep(600);
  const after = await alice.evaluate("return document.querySelector('dialog.dm-keys button[data-icon=copy]').textContent");
  check('Copy says it copied', after !== at.label, `${at.label} -> ${after}`);
  // Paste it somewhere with the keyboard, which is how it would be used.
  await alice.evaluate(`{
    document.querySelector('dialog.dm-keys').close();
    const i = document.createElement('input'); i.id = 'probe'; document.body.append(i); i.focus(); return true;
  }`);
  await alice.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', commands: ['paste'] });
  await sleep(300);
  const pasted = await alice.evaluate("return document.getElementById('probe').value");
  check('and the key really is on the clipboard', pasted === key, `${JSON.stringify(pasted)} vs ${key}`);

  // --- pasting a picture into a conversation ---------------------------------------------------------------------------------
  await alice.evaluate("document.getElementById('probe').remove(); document.querySelector('#server-rail .rail-home').click(); return true;");
  await until(alice, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'back on the server' });
  await until(alice, "document.querySelector('.member-row[data-user-id]')", { label: 'the member list' }).catch(async () => {
    await alice.evaluate("if (document.getElementById('member-list').hidden) document.getElementById('channels-members').click(); return true;");
  });
  await alice.evaluate("if (document.getElementById('member-list').hidden) document.getElementById('channels-members').click(); return true;");
  await until(alice, "[...document.querySelectorAll('.member-row')].some((r) => /bob/i.test(r.textContent))", { label: 'Bob in the list' });
  const bobId = await alice.evaluate("return [...document.querySelectorAll('.member-row')].find((r) => /bob/i.test(r.textContent)).dataset.userId");
  await alice.evaluate(`document.querySelector('.member-row[data-user-id="${bobId}"]').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 200 })); return true;`);
  await alice.evaluate("[...document.querySelectorAll('#member-menu-body button')].find((b) => b.textContent === 'Send a private message').click(); return true;");
  await until(alice, "!document.getElementById('dm-active').hidden && !document.getElementById('dm-input').disabled", { label: 'the conversation' });

  // A 1x1 PNG, pasted the way a screenshot arrives: a nameless image on the clipboard.
  const paste = (name, type, bytes) => `{
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(${JSON.stringify(bytes)})], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
    const event = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    const input = document.getElementById('dm-input'); input.focus();
    input.dispatchEvent(event);
    return event.defaultPrevented;
  }`;
  const png = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
  const taken = await alice.evaluate(`return ${paste('image.png', 'image/png', png).replace(/^\{/, '(() => {').replace(/\}$/, '})()')}`);
  await sleep(300);
  const chip = await alice.evaluate("return { shown: !document.getElementById('dm-pending').hidden, name: document.getElementById('dm-pending-name').textContent }");
  check('pasting a picture into the conversation attaches it, with a dated name', taken && chip.shown && /^pasted-\d{8}T\d{6}\.png/.test(chip.name), JSON.stringify(chip));
  await alice.evaluate("document.getElementById('dm-pending-clear').click(); return true;");
  const named = await alice.evaluate(`return ${paste('notes.txt', 'text/plain', [104, 105]).replace(/^\{/, '(() => {').replace(/\}$/, '})()')}`);
  await sleep(300);
  const kept = await alice.evaluate("return document.getElementById('dm-pending-name').textContent");
  check('a file that has a name keeps it', named && /^notes\.txt/.test(kept), kept);
  await alice.evaluate("document.getElementById('dm-pending-clear').click(); return true;");

  // --- what comes back into the conversation: a card for a file, a player for a video ---------------------------------
  const sendPasted = async (name, type, bytes) => {
    const before = await alice.evaluate("return document.querySelectorAll('#dm-log .attachment').length");
    await alice.evaluate(`return (() => ${paste(name, type, bytes)})()`);
    await until(alice, "!document.getElementById('dm-pending').hidden", { label: `${name} attached` });
    await alice.evaluate("document.getElementById('dm-send').click(); return true;");
    await until(alice, `document.querySelectorAll('#dm-log .attachment').length > ${before}`, { label: `${name} in the conversation` });
  };
  await sendPasted('notes.zip', 'application/zip', Array.from({ length: 3000 }, (_, i) => i % 251));
  const card = await alice.evaluate(`
    const c = document.querySelector('#dm-log .attachment-card');
    return c && { icon: c.querySelector('.attachment-icon')?.dataset.icon, name: c.querySelector('.attachment-name')?.textContent,
      size: c.querySelector('.attachment-size')?.textContent, save: Boolean(c.querySelector('.msg-tool')),
      linked: c.querySelector('.attachment-name')?.getAttribute('role') === 'button' };`);
  check('a file in a private conversation is a card as well', card?.icon === 'file-zip' && card.name === 'notes.zip' && /KB/.test(card.size) && card.save && card.linked, JSON.stringify(card));

  const log = [...Buffer.from(Array.from({ length: 40 }, (_, i) => `entry ${i + 1}: <i>plain</i>`).join('\n'))];
  await sendPasted('server.log', 'text/plain', log);
  await sleep(800);
  const shown = await alice.evaluate(`
    const c = document.querySelector('#dm-log .attachment-textfile');
    c?.scrollIntoView({ block: 'center' });
    await new Promise((ok) => setTimeout(ok, 800));
    return c && { shown: !c.querySelector('.textfile-body').hidden, lines: c.querySelector('.textfile-lines').textContent.split('\\n').length,
      left: c.querySelector('.textfile-left').textContent, markup: c.querySelector('.textfile-lines').children.length };`);
  check('a text file in a private conversation shows its first lines too', shown?.shown && shown.lines === 10 && /30 lines left/.test(shown.left) && shown.markup === 0, JSON.stringify(shown));

  let webm = null;
  try {
    const path = join(tmpdir(), `dm-clip-${process.pid}.webm`);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15', '-t', '3', '-c:v', 'libvpx', path]);
    webm = [...readFileSync(path)];
    rmSync(path, { force: true });
  } catch { /* no ffmpeg: the video is only checked where it can be made */ }
  if (webm) {
    await sendPasted('screen.webm', 'video/webm', webm);
    const played = await alice.evaluate(`
      const v = await new Promise((ok) => { const t0 = Date.now(); const tick = () => { const e = document.querySelector('#dm-log video'); (e || Date.now() - t0 > 8000) ? ok(e) : setTimeout(tick, 100); }; tick(); });
      if (!v) return { error: 'no video drawn' };
      const until = (fn, ms) => new Promise((ok) => { const t0 = performance.now(); const tick = () => (fn() || performance.now() - t0 > ms ? ok() : setTimeout(tick, 50)); tick(); });
      await until(() => v.readyState >= 1 || v.error, 6000);
      if (v.error) return { error: 'media error ' + v.error.code };
      v.muted = true;
      try { await v.play(); } catch (err) { return { error: err.message }; }
      await until(() => v.currentTime > 0.3, 5000);
      const t = v.currentTime; v.pause(); return { advanced: t, duration: v.duration };`);
    check('a video in a private conversation plays', !played.error && played.advanced > 0.3, JSON.stringify(played));
  }

  await alice.evaluate("const i = document.getElementById('dm-input'); i.value = 'hello'; return true;");
  const plain = await alice.evaluate(`{
    const dt = new DataTransfer(); dt.setData('text/plain', 'just words');
    const event = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    document.getElementById('dm-input').dispatchEvent(event);
    return event.defaultPrevented;
  }`);
  check('pasting only text is left to the box', plain === false, String(plain));

  // --- dropping a file on a conversation ----------------------------------------------------------------------------------------
  const drag = (type, name = 'dropped.txt') => `{
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([104, 105])], ${JSON.stringify(name)}, { type: 'text/plain' }));
    const event = new DragEvent(${JSON.stringify(type)}, { dataTransfer: dt, bubbles: true, cancelable: true });
    document.getElementById('dm-title-anchor')?.remove();
    (document.getElementById('dm-log')).dispatchEvent(event);
    return event.defaultPrevented ? event.dataTransfer.dropEffect : 'ignored';
  }`;
  const effect = await alice.evaluate(`return (() => ${drag('dragover')})()`);
  const cover = await alice.evaluate("return { dm: !document.getElementById('dm-drop').hidden, chat: !document.getElementById('chat-drop').hidden, title: document.getElementById('dm-drop-title').textContent }");
  check('dragging a file over a conversation offers to take it', effect !== 'ignored' && cover.dm && !cover.chat && /bob/i.test(cover.title), JSON.stringify({ effect, cover }));
  await alice.evaluate(`return (() => ${drag('drop')})()`);
  await sleep(500);
  const dropped = await alice.evaluate("return { cover: !document.getElementById('dm-drop').hidden, shown: !document.getElementById('dm-pending').hidden, name: document.getElementById('dm-pending-name').textContent }");
  check('dropping it attaches the file and takes the cover away', !dropped.cover && dropped.shown && /^dropped\.txt/.test(dropped.name), JSON.stringify(dropped));
  await alice.evaluate("document.getElementById('dm-pending-clear').click(); return true;");

  // --- copying out of the chat -------------------------------------------------------------------------------------------------
  // The first conversation shows the recovery key again: put it away, it is not what this is about.
  await alice.evaluate("document.querySelectorAll('dialog[open]').forEach((d) => d.close()); return true;");
  // The channels are on their own page now: back to it from the private messages.
  await alice.evaluate("if (document.querySelector('.view[data-active]')?.id === 'view-dms') document.querySelector('#server-rail .rail-home').click(); return true;");
  await until(alice, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'back on the server' });
  const text = (await rest('alice', '/api/channels')).body.channels.find((c) => c.kind === 'text');
  await rest('bob', `/api/channels/${text.id}/messages`, { body: 'read https://example.com/some/page and **this** too' });
  await alice.evaluate(`[...document.querySelectorAll('#channel-items .channel-row')].find((r) => r.textContent.includes(${JSON.stringify(text.name)})).click(); return true;`);
  await until(alice, "[...document.querySelectorAll('#chat-log .chat-msg .text')].some((t) => t.textContent.includes('this too'))", { label: 'the message' });
  const selectable = await alice.evaluate("return getComputedStyle(document.querySelector('#chat-log .chat-msg .text')).userSelect");
  check('the words of a message can be selected', selectable === 'text', selectable);

  const menu = () => alice.evaluate("return [...document.querySelectorAll('#row-menu-body button')].map((b) => b.textContent)");
  // A real click: the clipboard wants the user gesture a person's click carries.
  const clickItem = async (label) => {
    const at = await alice.evaluate(`{
      const b = [...document.querySelectorAll('#row-menu-body button')].find((x) => x.textContent === ${JSON.stringify(label)});
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await alice.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
    }
    await sleep(300);
  };
  const pasteIntoProbe = async () => {
    await alice.evaluate("document.getElementById('probe')?.remove(); const i = document.createElement('input'); i.id = 'probe'; document.body.append(i); i.focus(); return true;");
    await alice.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', commands: ['paste'] });
    await sleep(300);
    return alice.evaluate("return document.getElementById('probe').value");
  };
  const rightClick = (selector) => alice.evaluate(`{
    const row = [...document.querySelectorAll('#chat-log .chat-msg')].find((r) => r.textContent.includes('this too'));
    const target = row.querySelector(${JSON.stringify(selector)});
    const r = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 4, clientY: r.top + 4 }));
    return true;
  }`);

  // the whole message, as it was written (not as it is drawn)
  await rightClick('.text');
  const plainMenu = await menu();
  check('right-clicking a message offers to copy it', plainMenu.includes('Copy message text') && !plainMenu.includes('Copy link address'), JSON.stringify(plainMenu));
  await clickItem('Copy message text');
  const copiedWhole = await pasteIntoProbe();
  check('and copies it exactly as written, markdown and all', copiedWhole === 'read https://example.com/some/page and **this** too', JSON.stringify(copiedWhole));

  // a selection
  await alice.evaluate(`{
    const t = [...document.querySelectorAll('#chat-log .chat-msg .text')].find((x) => x.textContent.includes('this too'));
    const walker = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
    let first = null; let last = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) { first ??= n; last = n; }
    const range = document.createRange(); range.setStart(first, 0); range.setEnd(last, last.length);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); return true;
  }`);
  await rightClick('.text');
  const withSelection = await menu();
  check('with something selected, it offers to copy the selection', withSelection[0] === 'Copy', JSON.stringify(withSelection));
  await clickItem('Copy');
  check('and copies what is selected', (await pasteIntoProbe()).startsWith('read https://example.com/some/page and this too'), '');
  await alice.evaluate('getSelection().removeAllRanges(); return true;');

  // a link
  await rightClick('.text a');
  const linkMenu = await menu();
  check('right-clicking a link offers to open it and to copy its address', linkMenu.includes('Open link') && linkMenu.includes('Copy link address'), JSON.stringify(linkMenu));
  await clickItem('Copy link address');
  check('and copies the address', await pasteIntoProbe() === 'https://example.com/some/page', '');
}

try {
  await run();
} catch (err) {
  console.log('  FAIL ', err.stack);
  process.exitCode = 1;
}
summary();
cleanup();
process.exit(process.exitCode ?? 0);
