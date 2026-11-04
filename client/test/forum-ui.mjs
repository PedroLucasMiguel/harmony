// A forum channel in the real app, against a real server: the list of posts, starting one (with pictures), opening one
// beside the list, answering in it, what others do arriving live, the search of the list and of a post, pinning and
// starring inside a post, dropping a file, and the phone's one-at-a-time layout.
//
//   node client/test/forum-ui.mjs

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

const HARMONY_PORT = 18183;
const FAKE_MTX_PORT = 20083;
const DEBUG_PORT = 9483;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-forum-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-forum-profile-'));
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


/** A real PNG, a gradient, `w` x `h`: so that what is seen in the screenshot is a picture. */
function gradientPng(w, h) {
  const crc = (buf) => {
    let c;
    let crcv = 0xffffffff;
    for (let n = 0; n < buf.length; n += 1) {
      c = (crcv ^ buf[n]) & 0xff;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcv = (crcv >>> 8) ^ c;
    }
    return (crcv ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x += 1) {
      raw[row + 1 + x * 3] = Math.round(40 + 180 * (x / w));
      raw[row + 2 + x * 3] = Math.round(90 + 120 * (y / h));
      raw[row + 3 + x * 3] = 200 - Math.round(120 * (x / w));
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}


async function run() {
  await startFakeMediaMtx();
  await startHarmonyServer();
  const app = launchApp({ port: DEBUG_PORT, userDataDir });
  procs.push(app);
  const cdp = await attach(await findPage(DEBUG_PORT));
  await sleep(1200);
  await cdp.evaluate(`${setInput('server-url', BASE)} return true;`);
  await sleep(1500);
  for (const [id, value] of [['username', 'pedro'], ['account-password', 'hunter22'], ['account-confirm', 'hunter22'], ['owner-key', ownerKey]]) {
    await cdp.evaluate(`${setInput(id, value)} return true;`);
  }
  await cdp.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'");

  const json = async (path, token, body) => (await fetch(`${BASE}${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}),
  })).json();
  const boss = (await (await fetch(`${BASE}/api/accounts/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname: 'pedro', password: 'hunter22' }) })).json()).token;
  const ana = (await (await fetch(`${BASE}/api/accounts/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname: 'ana', password: 'hunter22' }) })).json()).token;
  const forum = (await json('/api/channels', boss, { kind: 'forum', name: 'questions' })).channel;
  await sleep(1500);

  const q = (sel) => cdp.evaluate(`return !!document.querySelector(${JSON.stringify(sel)});`);
  const text = (sel) => cdp.evaluate(`return document.querySelector(${JSON.stringify(sel)})?.textContent ?? null;`);
  const count = (sel) => cdp.evaluate(`return document.querySelectorAll(${JSON.stringify(sel)}).length;`);
  const visible = (sel) => cdp.evaluate(`const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.hidden && e.getClientRects().length > 0;`);
  const type = (sel, value) => cdp.evaluate(`const i = document.querySelector(${JSON.stringify(sel)}); i.focus(); i.value = ${JSON.stringify(value)};
    i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  const click = (sel, nth = 0) => cdp.evaluate(`document.querySelectorAll(${JSON.stringify(sel)})[${nth}].click(); return true;`);
  const shot = async (name) => {
    if (!process.env.FORUM_SHOTS) return;
    mkdirSync(process.env.FORUM_SHOTS, { recursive: true });
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.FORUM_SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
  };
  const png = (w, h) => gradientPng(w, h).toString('base64');
  /** Hands the next file picker the files, as if they were chosen in it. */
  const pickFiles = (names) => cdp.evaluate(`window.__input = null; if (!window.__patched) { const click = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () { if (this.type === 'file') { window.__input = this; return; } return click.call(this); }; window.__patched = true; }
    return true;`).then(async () => {
    await cdp.evaluate(`document.querySelector('[data-testid="forum-add-media"]').click(); return true;`);
    await cdp.evaluate(`const input = window.__input; const dt = new DataTransfer();
      for (const name of ${JSON.stringify(names)}) { const bytes = Uint8Array.from(atob(${JSON.stringify(png(240, 160))}), (c) => c.charCodeAt(0)); dt.items.add(new File([bytes], name, { type: 'image/png' })); }
      input.files = dt.files; input.dispatchEvent(new Event('change')); return true;`);
  });
  const dropFiles = (names) => cdp.evaluate(`const dt = new DataTransfer();
    for (const name of ${JSON.stringify(names)}) { const bytes = Uint8Array.from(atob(${JSON.stringify(png(120, 80))}), (c) => c.charCodeAt(0)); dt.items.add(new File([bytes], name, { type: 'image/png' })); }
    document.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return true;`);

  // ---- the channel, and its list
  check('the forum is in the channel list, with its own icon', await cdp.evaluate(`return [...document.querySelectorAll('#channel-items li.channel-row')].some((r) => r.textContent.includes('questions') && r.querySelector('.kind')?.dataset.icon === 'chats-teardrop');`));
  await cdp.evaluate(`[...document.querySelectorAll('#channel-items li.channel-row')].find((r) => r.textContent.includes('questions')).click(); return true;`);
  await waitFor(cdp, "!document.getElementById('forum-active').hidden", { label: 'the forum list' });
  check('clicking it shows its list of posts and not a log', (await visible('#forum-active')) && !(await visible('#chat-active')) && (await text('#forum-name')) === 'questions');
  check('an empty forum says so, and has the search and New Post', /No posts yet/.test(await text('#forum-empty')) && (await visible('#forum-search')) && (await visible('#forum-new')));
  await shot('1-empty');

  // ---- starting a post
  await click('#forum-new');
  await waitFor(cdp, "!!document.querySelector('[data-testid=\"forum-compose\"]')", { label: 'the new post card' });
  check('New Post opens the card: a title, a message, and a tile to add media', (await q('[data-testid="forum-title"]')) && (await q('[data-testid="forum-body"]')) && (await q('[data-testid="forum-add-media"]')));
  check('a post cannot be sent without a title and something to say', await cdp.evaluate(`return document.querySelector('[data-testid="forum-post"]').disabled;`));
  await type('[data-testid="forum-title"]', 'How do I translate this?');
  check('a title alone is not enough', await cdp.evaluate(`return document.querySelector('[data-testid="forum-post"]').disabled;`));
  await type('[data-testid="forum-body"]', 'I keep seeing the by <User> form, is it approved?');
  check('with the words it can be sent', !(await cdp.evaluate(`return document.querySelector('[data-testid="forum-post"]').disabled;`)));
  await pickFiles(['first.png', 'second.png']);
  await waitFor(cdp, "document.querySelectorAll('[data-testid=\"forum-previews\"] .forum-compose-preview').length === 2", { label: 'the previews' });
  check('pictures chosen are previewed, and can be taken out again', (await count('.forum-compose-preview img')) === 2);
  await click('.forum-compose-remove', 1);
  check('taking one out leaves the other', (await count('.forum-compose-preview')) === 1);
  await pickFiles(['third.png']);
  await waitFor(cdp, "document.querySelectorAll('[data-testid=\"forum-previews\"] .forum-compose-preview').length === 2", { label: 'two again' });
  await shot('2-compose');
  await click('[data-testid="forum-post"]');
  await waitFor(cdp, "!document.querySelector('[data-testid=\"forum-compose\"]') && !document.getElementById('chat-active').hidden", { label: 'the post opening', timeoutMs: 20_000 });
  await sleep(1000);

  // ---- the post, open beside the list
  check('the post opens beside the list, which is still there', (await visible('#forum-active')) && (await visible('#chat-active')) && (await count('#forum-posts .forum-post')) === 1);
  check('the pane shows the title, large, and names the post', (await text('#chat-log .post-title')) === 'How do I translate this?' && (await text('#chat-name')) === 'How do I translate this?');
  check('the post is the first message, by its author, marked OP', await cdp.evaluate(`const r = document.querySelector('#chat-log .chat-msg'); return !!r && /pedro/.test(r.textContent) && !!r.querySelector('.op-badge') && /approved/.test(r.textContent);`));
  check('with a line between it and what answers it', await q('#chat-log .post-divider'));
  check('its other picture is a message under it, from the same person', (await count('#chat-log .chat-msg')) === 2 && (await count('#chat-log .chat-msg img')) >= 2);
  check('the list shows it: title, who wrote it, a first line, its picture, and that it is the open one', await cdp.evaluate(`const r = document.querySelector('#forum-posts .forum-post'); return r.hasAttribute('data-active') && /How do I translate/.test(r.textContent) && /pedro/.test(r.textContent) && !!r.querySelector('.forum-post-thumb');`));
  check('the composer asks for a message in the post', /How do I translate this\?/.test(await cdp.evaluate("return document.getElementById('chat-input').placeholder")));
  await shot('3-post');

  // ---- answering
  await type('#chat-input', 'My own answer');
  await cdp.evaluate("document.getElementById('chat-form').requestSubmit(); return true;");
  await waitFor(cdp, "[...document.querySelectorAll('#chat-log .chat-msg')].some((r) => /My own answer/.test(r.textContent))", { label: 'my answer' });
  await waitFor(cdp, "document.querySelector('#forum-posts .forum-post .forum-post-replies')?.textContent === '2'", { label: 'the answer counted' });
  check('an answer is written in the post and counted in the list', true);

  // ---- others, live
  const mine = (await json(`/api/channels/${forum.id}/posts`, boss)).posts[0].message;
  const other = (await json(`/api/channels/${forum.id}/messages`, ana, { title: 'Where is the glossary?', body: 'Looking for the term list' })).message;
  await waitFor(cdp, "document.querySelectorAll('#forum-posts .forum-post').length === 2", { label: 'the second post' });
  check('a post made by somebody else appears in the list, above, while one is open', await cdp.evaluate(`return document.querySelector('#forum-posts .forum-post .forum-post-title').textContent === 'Where is the glossary?';`));
  check('and does not touch the thread that is open', (await text('#chat-log .post-title')) === 'How do I translate this?');
  await json(`/api/channels/${forum.id}/messages`, ana, { threadId: mine.id, body: 'It is approved, check the glossary' });
  await waitFor(cdp, "[...document.querySelectorAll('#chat-log .chat-msg')].some((r) => /It is approved/.test(r.textContent))", { label: 'her answer in the thread' });
  await waitFor(cdp, "[...document.querySelectorAll('#forum-posts .forum-post')].find((r) => /How do I translate/.test(r.textContent))?.querySelector('.forum-post-replies').textContent === '3'", { label: 'three answers' });
  check('an answer from somebody else arrives in the open post and is counted in the list', true);
  await json(`/api/channels/${forum.id}/messages`, ana, { threadId: other.id, body: 'Answer to the other post' });
  await sleep(700);
  check('an answer under another post is only counted, not shown here', !(await cdp.evaluate(`return [...document.querySelectorAll('#chat-log .chat-msg')].some((r) => /Answer to the other post/.test(r.textContent));`)));
  await json(`/api/messages/${mine.id}/react`, ana, { emoji: '\u2705' });
  await waitFor(cdp, "[...document.querySelectorAll('#forum-posts .forum-post')].some((r) => /How do I translate/.test(r.textContent) && r.querySelector('.forum-post-reactions .reaction'))", { label: 'the reaction in the list' });
  check('a reaction to the main post shows on the list', true);
  await shot('4-live');

  // ---- searching the list, and sorting it
  await type('#forum-search', 'glossary');
  await waitFor(cdp, "document.querySelectorAll('#forum-posts .forum-post').length === 2", { label: 'search by words' });
  check('the list is searched in the words and in what is written under a post', (await count('#forum-posts .forum-post')) === 2);
  await type('#forum-search', 'zzzzz-nothing');
  await waitFor(cdp, "document.querySelectorAll('#forum-posts .forum-post').length === 0 && !document.getElementById('forum-empty').hidden", { label: 'no match' });
  check('nothing found says so and offers to create the post with that title', /No post matches/.test(await text('#forum-empty')) && /zzzzz-nothing/.test(await text('#forum-empty button')));
  await type('#forum-search', '');
  await waitFor(cdp, "document.querySelectorAll('#forum-posts .forum-post').length === 2", { label: 'cleared' });
  await click('#forum-sort');
  await click('.forum-sort-option', 1);
  await waitFor(cdp, "document.querySelector('#forum-posts .forum-post .forum-post-title')?.textContent === 'Where is the glossary?'", { label: 'by date posted' });
  await click('#forum-sort');
  await click('.forum-sort-option', 2);
  await waitFor(cdp, "document.querySelector('#forum-posts .forum-post .forum-post-title')?.textContent === 'How do I translate this?'", { label: 'by answers' });
  check('sorted by recent activity, date posted or answers', true);
  await click('#forum-sort');
  await click('.forum-sort-option', 0);

  // ---- inside the post: search, pin, star
  await type('#chat-search', 'glossary');
  await cdp.evaluate(`document.getElementById('chat-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true;`);
  await waitFor(cdp, "!document.getElementById('search-results').hidden", { label: 'results in the post' });
  await sleep(600);
  const found = await cdp.evaluate(`return [...document.querySelectorAll('#sr-body .chat-msg, #sr-body .search-hit, #sr-body li')].map((n) => n.textContent.slice(0, 60));`);
  check('a search in the open post finds only what is in it', found.some((x) => /It is approved/.test(x)) && !found.some((x) => /Looking for the term list/.test(x)), JSON.stringify(found));
  await click('#sr-close');
  const answerRow = `#chat-log .chat-msg:nth-of-type(n)`;
  void answerRow;
  const replyId = await cdp.evaluate(`return [...document.querySelectorAll('#chat-log .chat-msg')].find((r) => /It is approved/.test(r.textContent)).dataset.id;`);
  await cdp.evaluate(`const row = document.querySelector('#chat-log .chat-msg[data-id="${replyId}"]'); row.querySelector('.msg-tool[data-icon="push-pin"]').click(); return true;`);
  await waitFor(cdp, "!document.getElementById('chat-pinned').hidden", { label: 'the pin strip' });
  check('a message of the post can be pinned, and the strip shows it', /approved/.test(await text('#chat-pinned')));
  await cdp.evaluate(`document.querySelector('#chat-log .chat-msg[data-id="${replyId}"] .star-tool').click(); return true;`);
  await waitFor(cdp, `document.querySelector('#chat-log .chat-msg[data-id="${replyId}"]')?.hasAttribute('data-starred')`, { label: 'the star' });
  const mainId = await cdp.evaluate(`return document.querySelector('#chat-log .chat-msg').dataset.id;`);
  await cdp.evaluate(`document.querySelector('#chat-log .chat-msg[data-id="${mainId}"] .star-tool').click(); return true;`);
  await waitFor(cdp, `document.querySelector('#chat-log .chat-msg[data-id="${mainId}"]')?.hasAttribute('data-starred')`, { label: 'the post starred' });
  check('and the post and its messages can be starred', true);
  await click('#chat-stars');
  await waitFor(cdp, "document.querySelectorAll('#stars-list > *').length >= 2", { label: 'the stars panel' });
  check('the star panel says which post a star is in', (await text('#stars-list')).includes('How do I translate this?'));
  await shot('5-stars');
  await cdp.evaluate("document.querySelector('#chat-stars').click(); return true;");

  // ---- drag and drop, in the post
  await dropFiles(['dropped.png']);
  await sleep(500);
  check('a file dropped while a post is open is attached to the answer being written', await cdp.evaluate(`return !document.getElementById('chat-pending').hidden && /dropped/.test(document.getElementById('chat-pending').textContent);`));
  await click('#chat-pending .composer-btn');

  // ---- closing the post, and dropping on the list
  await click('#chat-close-post');
  await sleep(400);
  check('closing the post gives the list the whole stage', (await visible('#forum-active')) && !(await visible('#chat-active')));
  await dropFiles(['listdrop.png']);
  await waitFor(cdp, "!!document.querySelector('[data-testid=\"forum-compose\"]')", { label: 'compose from a drop' });
  check('a file dropped on the list starts a post with it attached', (await count('.forum-compose-preview')) === 1);
  await click('.forum-compose-close');
  check('the card is closed with its X', !(await q('[data-testid="forum-compose"]')));

  // ---- a post that is deleted while it is open
  await click('#forum-posts .forum-post', 1);
  await waitFor(cdp, "!document.getElementById('chat-active').hidden", { label: 'reopened' });
  await json(`/api/messages/${other.id}/delete`, ana, {}).catch(() => {});
  await json(`/api/messages/${mine.id}/delete`, boss, {});
  await sleep(1200);
  const afterDelete = { chat: await visible('#chat-active'), posts: await count('#forum-posts .forum-post'), titles: await cdp.evaluate(`return [...document.querySelectorAll('#forum-posts .forum-post-title')].map((n) => n.textContent);`), err: await text('#channels-error') };
  check('a post deleted while it is open closes, and leaves the list', !afterDelete.chat && afterDelete.posts <= 1, JSON.stringify(afterDelete));

  // ---- phone
  const again = (await json(`/api/channels/${forum.id}/messages`, ana, { title: 'On a phone', body: 'small screen' })).message;
  await sleep(800);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(700);
  await cdp.evaluate("document.getElementById('channels-menu')?.click(); return true;");
  await cdp.evaluate(`[...document.querySelectorAll('#channel-items li.channel-row')].find((r) => r.textContent.includes('questions')).click(); return true;`);
  await sleep(800);
  await cdp.evaluate(`document.querySelector('#forum-posts .forum-post').click(); return true;`);
  await waitFor(cdp, "!document.getElementById('chat-active').hidden", { label: 'the post on a phone' });
  await sleep(500);
  check('on a phone the post covers the list, and its X goes back to it', !(await visible('#forum-active')) && (await visible('#chat-active')) && (await visible('#chat-close-post')));
  await shot('6-phone');
  await click('#chat-close-post');
  await sleep(400);
  check('and the list is back', await visible('#forum-active'));
  void again;
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
