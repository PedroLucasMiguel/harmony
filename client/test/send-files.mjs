// Sending files from a text channel: seen before they go, several at once, and what is said when something goes wrong.
//
//   - a file put in the box (picked, pasted or dropped) is shown first: the picture itself, the icon of its kind
//   - several can wait together; one can be taken out; there is a most that go at once
//   - they are sent one message each, in order, and the words in the box go with the last
//   - the error line goes away by itself, and by a click
//   - a pinned file shows what it is in the strip under the header
//
//   node client/test/send-files.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const HARMONY_PORT = 18190;
const FAKE_MTX_PORT = 20095;
const DEBUG_PORT = 9495;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-files-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-files-profile-'));
const { check, summary } = reporter();
const procs = [];
let fakeMtx = null;
let serverLog = '';
let ownerKey = null;

process.on('exit', () => {
  for (const p of procs) {
    try { p.kill(); } catch { /* already gone */ }
  }
  try { fakeMtx?.close(); } catch { /* already closed */ }
});
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
      if (serverLog.includes('control server on')) {
        clearTimeout(timer);
        done(p);
      }
    });
    p.stderr.on('data', (b) => (serverLog += b.toString()));
  });
}

let token = null;
const api = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
};

const post = (channelId, body) => api(`/api/channels/${channelId}/messages`, { body });

/** Where the log is scrolled, as the renderer sees it. */
const logState = (cdp) => cdp.evaluate(`
  const log = document.getElementById('chat-log');
  const rows = [...log.querySelectorAll('.chat-msg')];
  const last = rows.at(-1);
  return {
    top: Math.round(log.scrollTop),
    fromBottom: Math.round(log.scrollHeight - log.scrollTop - log.clientHeight),
    scrollable: log.scrollHeight > log.clientHeight + 100,
    count: rows.length,
    lastText: last?.textContent ?? '',
    title: document.getElementById('chat-name').textContent,
  };
`);

const openChannel = async (cdp, name) => {
  await cdp.evaluate(`
    const li = [...document.querySelectorAll('#channel-items li.channel-row')]
      .find((row) => row.querySelector('.channel-name')?.textContent === ${JSON.stringify(name)});
    li.click();
    return true;
  `);
  await waitFor(
    cdp,
    `document.getElementById('chat-name').textContent === '#${name}'
      && document.querySelectorAll('#chat-log .chat-msg').length > 0`,
    { label: `#${name} to show its messages` },
  );
  // Let the scroll that follows the render settle.
  await sleep(250);
};

async function run() {
  console.log('Starting the control server and the client…\n');
  await startFakeMediaMtx();
  await startHarmonyServer();

  const owner = await api('/api/accounts/register', { nickname: 'boss', password: 'hunter22', ownerKey });
  token = owner.token;
  const general = (await api('/api/channels')).channels.find((c) => c.kind === 'text');
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const upload = async (bytes, contentType) => (await (await fetch(`${BASE}/api/uploads`, {
    method: 'POST', headers: { 'Content-Type': contentType, Authorization: `Bearer ${owner.token}` }, body: bytes,
  })).json()).hash;
  const filePost = async (body, name, bytes, contentType) => {
    const hash = await upload(bytes, contentType);
    const res = await fetch(`${BASE}/api/channels/${general.id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ body, attachmentHash: hash, attachmentName: name }),
    });
    return (await res.json()).message;
  };
  await post(general.id, 'something to start the channel');
  const pic = await filePost('a picture', 'dot.png', PNG, 'image/png');
  const zip = await filePost('', 'backup.zip', Buffer.from('PK\u0003\u0004fake'), 'application/zip');

  const app = launchApp({ port: DEBUG_PORT, userDataDir });
  procs.push(app);
  const cdp = await attach(await findPage(DEBUG_PORT));
  await sleep(1200);
  const set = (id, value) => cdp.evaluate(`
    const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
    i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  await set('server-url', BASE);
  await sleep(1500);
  await set('username', 'boss');
  await set('account-password', 'hunter22');
  await cdp.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'the channels view' });
  await sleep(500);
  await openChannel(cdp, general.name);

  // --- a pinned file shows what it is ---------------------------------------------------------------------------------------------
  await api(`/api/messages/${pic.id}/pin`, { pinned: true });
  await waitFor(cdp, "!document.getElementById('chat-pinned').hidden", { label: 'the strip' });
  await sleep(500);
  const strip = () => cdp.evaluate(`
    const t = document.querySelector('#chat-pinned .pin-thumb');
    const img = t?.querySelector('img');
    return { thumb: Boolean(t), picture: Boolean(img && img.complete && img.naturalWidth > 0), icon: t?.querySelector('[data-icon]')?.dataset.icon ?? null,
      text: document.querySelector('#chat-pinned .pinned-line')?.textContent ?? '' };`);
  let st = await strip();
  check('a pinned picture shows itself in the strip, before its words', st.thumb && st.picture && /a picture/.test(st.text), JSON.stringify(st));
  await api(`/api/messages/${zip.id}/pin`, { pinned: true });
  await sleep(800);
  st = await strip();
  check('a pinned zip shows the icon of a zip', st.thumb && st.icon === 'file-zip' && /backup\.zip/.test(st.text), JSON.stringify(st));
  await cdp.evaluate("document.getElementById('chat-pins').click(); return true;");
  await sleep(300);
  check('and in the list both are drawn, as in the log', await cdp.evaluate("return document.querySelectorAll('#pins-pop .pin-card .attachment').length === 2"), '');
  await cdp.evaluate("document.getElementById('chat-pins').click(); return true;");

  // --- files in the box ------------------------------------------------------------------------------------------------------------
  const putIn = (how, specs) => cdp.evaluate(`
    const files = new DataTransfer();
    for (const [name, type, bytes] of ${JSON.stringify(specs)}) {
      const data = bytes === 'png' ? Uint8Array.from(atob(${JSON.stringify(PNG.toString('base64'))}), (c) => c.charCodeAt(0)) : new Uint8Array(bytes).fill(7);
      files.items.add(new File([data], name, type ? { type } : {}));
    }
    if (${JSON.stringify(how)} === 'paste') {
      document.getElementById('chat-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: files, bubbles: true, cancelable: true }));
    } else {
      const input = document.getElementById('chat-file'); input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return true;`);
  const tray = () => cdp.evaluate(`
    const cards = [...document.querySelectorAll('#chat-pending .pending-card')];
    return { shown: !document.getElementById('chat-pending').hidden, cards: cards.map((c) => ({
      kind: c.dataset.kind, name: c.querySelector('.pending-name').textContent,
      picture: Boolean(c.querySelector('img') && c.querySelector('img').complete && c.querySelector('img').naturalWidth > 0),
      icon: c.querySelector('[data-icon]')?.dataset.icon ?? null })) };`);

  await putIn('picker', [['photo.png', 'image/png', 'png']]);
  await sleep(400);
  let tr = await tray();
  check('a picture put in the box is shown there before it is sent', tr.shown && tr.cards.length === 1 && tr.cards[0].kind === 'image' && tr.cards[0].picture, JSON.stringify(tr));
  await putIn('paste', [['archive.zip', '', 500], ['image.png', 'image/png', 'png']]);
  await sleep(500);
  tr = await tray();
  check('pasting adds to it, and every file has its card', tr.cards.length === 3, JSON.stringify(tr));
  check('a zip with no type is shown with the icon of a zip', tr.cards.some((c) => c.kind === 'file' && c.icon === 'file-zip' && c.name === 'archive.zip'), JSON.stringify(tr));
  check('a pasted screenshot is shown as itself, and given a name', tr.cards.some((c) => c.picture && /^pasted-\d{8}T\d{6}(-\d)?\.png$/.test(c.name)), JSON.stringify(tr));
  const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })).data;
  (await import('node:fs')).writeFileSync(`${process.env.SHOT_DIR ?? tmpdir()}/send-files-tray.png`, Buffer.from(shot, 'base64'));
  await cdp.evaluate("document.querySelectorAll('#chat-pending .pending-remove')[1].click(); return true;");
  await sleep(300);
  tr = await tray();
  check('a card has its own X: the zip is taken out, the other two stay in their order', tr.cards.length === 2 && tr.cards[0].name === 'photo.png' && tr.cards[1].kind === 'image', JSON.stringify(tr));
  await putIn('paste', Array.from({ length: 12 }, (_, i) => [`extra-${i}.bin`, '', 10]));
  await sleep(400);
  tr = await tray();
  check('there is a most that go at once, and it says so', tr.cards.length === 10 && /at most 10/.test(await cdp.evaluate("return document.getElementById('chat-note').textContent")), String(tr.cards.length));

  // --- sending them ----------------------------------------------------------------------------------------------------------------
  await cdp.evaluate("document.querySelectorAll('#chat-pending .pending-remove').forEach((b, i) => { if (i >= 2) b.click(); }); return true;");
  await sleep(100);
  // clicking removes by index at the time: take them out until two are left
  for (let n = (await tray()).cards.length; n > 2; n -= 1) {
    await cdp.evaluate("document.querySelectorAll('#chat-pending .pending-remove')[2].click(); return true;");
    await sleep(50);
  }
  tr = await tray();
  check('two files wait: the photo and the pasted screenshot', tr.cards.length === 2 && tr.cards[0].name === 'photo.png', JSON.stringify(tr));
  const before = (await api(`/api/channels/${general.id}/messages`)).messages.length;
  await cdp.evaluate(`const i = document.getElementById('chat-input'); i.value = 'both of these, for the report'; i.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('chat-form').requestSubmit(); return true;`);
  const deadline = Date.now() + 20000;
  let sent = [];
  while (Date.now() < deadline) {
    sent = (await api(`/api/channels/${general.id}/messages`)).messages.slice(before);
    if (sent.length >= 2) break;
    await sleep(300);
  }
  check('each file is a message of its own, in the order they were put in', sent.length === 2 && sent[0].attachmentName === 'photo.png' && /^pasted-/.test(sent[1].attachmentName ?? ''), JSON.stringify(sent.map((m) => m.attachmentName)));
  check('the words go with the last one only', sent[0]?.body === '' && sent[1]?.body === 'both of these, for the report', JSON.stringify(sent.map((m) => m.body)));
  await sleep(500);
  const after = await cdp.evaluate("return { tray: !document.getElementById('chat-pending').hidden, box: document.getElementById('chat-input').value }");
  check('and the box and the cards are empty again', !after.tray && after.box === '', JSON.stringify(after));
  const rows = await cdp.evaluate("return [...document.querySelectorAll('#chat-log .chat-msg')].slice(-2).map((r) => r.querySelectorAll('.attachment, img').length > 0)");
  check('both are drawn in the log, and the log is at its end', rows.every(Boolean) && await cdp.evaluate("const l = document.getElementById('chat-log'); return { g: l.scrollHeight - l.scrollTop - l.clientHeight }").then((r) => r.g < 5), JSON.stringify(rows));

  // a failure part-way: what did not go comes back
  await putIn('paste', [['one.bin', '', 20], ['two.bin', '', 20], ['three.bin', '', 20]]);
  await sleep(300);
  await cdp.evaluate(`const { harmony: h } = await import('./bridge.js'); window.__posts = 0; const real = h.api.postMessage;
    h.api.postMessage = async (...args) => { window.__posts += 1; if (window.__posts === 2) throw new Error('the server said no'); return real(...args); }; return true;`);
  await cdp.evaluate(`const i = document.getElementById('chat-input'); i.value = 'the words'; i.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('chat-form').requestSubmit(); return true;`);
  await sleep(2500);
  tr = await tray();
  check('when the second of three fails, it and the third come back to the box, with the words',
    tr.cards.map((c) => c.name).join() === 'two.bin,three.bin' && await cdp.evaluate("return document.getElementById('chat-input').value") === 'the words', JSON.stringify(tr));
  await cdp.evaluate("document.querySelectorAll('#chat-pending .pending-remove').forEach(() => {}); return true;");
  for (let n = tr.cards.length; n > 0; n -= 1) {
    await cdp.evaluate("document.querySelector('#chat-pending .pending-remove').click(); return true;");
    await sleep(50);
  }
  await cdp.evaluate("const i = document.getElementById('chat-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true;");

  // --- what is said goes away ------------------------------------------------------------------------------------------------------
  await cdp.evaluate("const e = document.getElementById('channels-error'); e.textContent = 'Could not play \"eba\": Unable to decode audio data'; e.hidden = false; return true;");
  await sleep(600);
  check('an error is shown', await cdp.evaluate("return !document.getElementById('channels-error').hidden"), '');
  await cdp.evaluate("document.getElementById('channels-error').click(); return true;");
  await sleep(200);
  check('a click on it puts it away at once', await cdp.evaluate("return document.getElementById('channels-error').hidden"), '');
  await cdp.evaluate("const e = document.getElementById('channels-error'); e.textContent = 'Could not play again'; e.hidden = false; return true;");
  await sleep(10500);
  check('left alone, it goes by itself', await cdp.evaluate("const e = document.getElementById('channels-error'); return e.hidden && e.textContent === ''"), '');
  await cdp.evaluate("document.getElementById('chat-note').textContent = 'Saved something'; return true;");
  await sleep(10500);
  check('and so does a note under the box', await cdp.evaluate("return document.getElementById('chat-note').textContent === ''"), '');

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
