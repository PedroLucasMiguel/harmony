// A forum's posts in the real app, for the person who looks after it: pinned posts (the last one pinned on top, the
// rest after it in the order they were made), the mentions of the person (a badge on each post and a filter), and
// what a post's row offers -- to pin it, and to delete it with everything under it.
//
//   node client/test/forum-pins-ui.mjs

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

const HARMONY_PORT = 18185;
const FAKE_MTX_PORT = 20085;
const DEBUG_PORT = 9485;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-fpin-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-fpin-profile-'));
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
  const make = async (title, body) => (await json(`/api/channels/${forum.id}/messages`, ana, { title, body })).message;
  const plain = await make('Plain', 'nothing to see');
  const everyone = await make('For everybody', '@everyone please read');
  const named = await make('For pedro', 'hello @pedro, a question');
  await sleep(1500);

  const text = (sel) => cdp.evaluate(`return document.querySelector(${JSON.stringify(sel)})?.textContent ?? null;`);
  const count = (sel) => cdp.evaluate(`return document.querySelectorAll(${JSON.stringify(sel)}).length;`);
  const q = (sel) => cdp.evaluate(`return !!document.querySelector(${JSON.stringify(sel)});`);
  const titles = () => cdp.evaluate(`return [...document.querySelectorAll('#forum-posts .forum-post-title')].map((n) => n.textContent);`);
  const row = (title) => `[...document.querySelectorAll('#forum-posts .forum-post')].find((r) => r.querySelector('.forum-post-title').textContent === ${JSON.stringify(title)})`;
  const tool = (title, testid) => cdp.evaluate(`${row(title)}.querySelector('[data-testid="${testid}"]').click(); return true;`);
  const shot = async (name) => {
    if (!process.env.PIN_SHOTS) return;
    mkdirSync(process.env.PIN_SHOTS, { recursive: true });
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.PIN_SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
  };

  await cdp.evaluate(`[...document.querySelectorAll('#channel-items li.channel-row')].find((r) => r.textContent.includes('questions')).click(); return true;`);
  await waitFor(cdp, "document.querySelectorAll('#forum-posts .forum-post').length === 3", { label: 'the posts' });

  // ---- the order, mentions
  check('without pins, the newest post is first and the rest follow in the order they were made', JSON.stringify(await titles()) === JSON.stringify(['For pedro', 'For everybody', 'Plain']), JSON.stringify(await titles()));
  check('posts that mention you are lit and say how many messages do', (await cdp.evaluate(`return [...document.querySelectorAll('#forum-posts .forum-post[data-mention] .forum-post-mention')].map((n) => n.textContent).join();`)) === '@1,@1');
  check('and one that does not is left plain', await cdp.evaluate(`return !${row('Plain')}.hasAttribute('data-mention') && !${row('Plain')}.querySelector('.forum-post-mention');`));
  await shot('1-mentions');
  await cdp.evaluate("document.getElementById('forum-mentions').click(); return true;");
  await waitFor(cdp, "document.querySelectorAll('#forum-posts .forum-post').length === 2", { label: 'the mentions filter' });
  check('the Mentions button keeps only the posts that mention you', JSON.stringify(await titles()) === JSON.stringify(['For pedro', 'For everybody']) && (await cdp.evaluate("return document.getElementById('forum-mentions').getAttribute('aria-pressed')")) === 'true');
  await cdp.evaluate("document.getElementById('forum-mentions').click(); return true;");
  await waitFor(cdp, "document.querySelectorAll('#forum-posts .forum-post').length === 3", { label: 'all again' });
  check('and pressing it again brings the rest back', true);

  // ---- live: a new post and an answer that mention you
  const answered = await json(`/api/channels/${forum.id}/messages`, ana, { threadId: plain.id, body: 'psst @pedro, about this' });
  await waitFor(cdp, `${row('Plain')}.hasAttribute('data-mention')`, { label: 'the answer counted' });
  check('an answer that mentions you lights its post, while you look', (await text('#forum-posts .forum-post[data-mention] .forum-post-mention')) !== null && !!answered.message);
  await make('Live one', 'with a @pedro in it');
  await waitFor(cdp, "document.querySelectorAll('#forum-posts .forum-post').length === 4", { label: 'the live post' });
  check('a new post that mentions you arrives with its badge', await cdp.evaluate(`return ${row('Live one')}.hasAttribute('data-mention');`));

  // ---- pinning: the last one pinned on top, the rest below in the order they were made
  check('the owner is offered to pin, and to delete, on every post', (await count('#forum-posts .forum-post [data-testid="forum-pin"]')) === 4 && (await count('#forum-posts .forum-post [data-testid="forum-delete"]')) === 4);
  await tool('Plain', 'forum-pin');
  await waitFor(cdp, "document.querySelector('#forum-posts .forum-post-title')?.textContent === 'Plain'", { label: 'Plain on top' });
  check('a pinned post goes to the top and says so', await cdp.evaluate(`return ${row('Plain')}.hasAttribute('data-post-pinned') && !!${row('Plain')}.querySelector('.forum-post-pin');`));
  await tool('For everybody', 'forum-pin');
  await waitFor(cdp, "document.querySelector('#forum-posts .forum-post-title')?.textContent === 'For everybody'", { label: 'the last pinned on top' });
  check('the one pinned last is on top, the one before under it, and the rest after them', JSON.stringify(await titles()) === JSON.stringify(['For everybody', 'Plain', 'Live one', 'For pedro']), JSON.stringify(await titles()));
  await shot('2-pinned');
  await tool('Plain', 'forum-pin');
  await waitFor(cdp, "JSON.stringify([...document.querySelectorAll('#forum-posts .forum-post-title')].map((n) => n.textContent)) === JSON.stringify(['For everybody', 'Live one', 'For pedro', 'Plain'])", { label: 'Plain unpinned' });
  check('unpinning sends a post back among the rest, where it was made', true);

  // ---- somebody else's pin arrives too
  await json(`/api/messages/${named.id}/post-pin`, boss, { pinned: true });
  await waitFor(cdp, "document.querySelector('#forum-posts .forum-post-title')?.textContent === 'For pedro'", { label: 'a pin from elsewhere' });
  check('a post pinned elsewhere moves to the top at once', true);
  await json(`/api/messages/${named.id}/post-pin`, boss, { pinned: false });
  await waitFor(cdp, "document.querySelector('#forum-posts .forum-post-title')?.textContent === 'For everybody'", { label: 'unpinned elsewhere' });

  // ---- in the post itself: the pin of the post, apart from the pin of a message
  await cdp.evaluate(`${row('Plain')}.click(); return true;`);
  await waitFor(cdp, "!document.getElementById('chat-active').hidden && document.querySelectorAll('#chat-log .chat-msg').length >= 2", { label: 'the post open' });
  const rootTools = await cdp.evaluate(`const r = document.querySelector('#chat-log .chat-msg'); return [...r.querySelectorAll('.msg-tool')].map((b) => b.title);`);
  check('the post, in its thread, offers to pin the post (not a message) and to delete it', rootTools.includes('Pin the post') && rootTools.includes('Delete') , JSON.stringify(rootTools));
  const answerTools = await cdp.evaluate(`const r = document.querySelectorAll('#chat-log .chat-msg')[1]; return [...r.querySelectorAll('.msg-tool')].map((b) => b.title);`);
  check('and an answer offers the pin of a message', answerTools.includes('Pin') && !answerTools.includes('Pin the post'), JSON.stringify(answerTools));
  await cdp.evaluate(`[...document.querySelector('#chat-log .chat-msg').querySelectorAll('.msg-tool')].find((b) => b.title === 'Pin the post').click(); return true;`);
  await waitFor(cdp, "document.querySelector('#forum-posts .forum-post-title')?.textContent === 'Plain'", { label: 'pinned from the thread' });
  check('pinning from the thread pins the post to the top of the list', await cdp.evaluate(`return [...document.querySelector('#chat-log .chat-msg').querySelectorAll('.msg-tool')].some((b) => b.title === 'Unpin the post');`));
  await cdp.evaluate("document.getElementById('chat-close-post').click(); return true;");
  await sleep(300);

  // ---- deleting from the row
  await tool('Live one', 'forum-delete');
  await waitFor(cdp, "document.querySelector('dialog.ask[open]')", { label: 'the confirmation' });
  check('deleting asks first, and says what goes with it', /everything written under it/i.test(await text('dialog.ask[open] h2')));
  await cdp.evaluate("document.querySelector('dialog.ask[open] button[value=\"ok\"], dialog.ask[open] .primary, dialog.ask[open] form button[type=\"submit\"]').click(); return true;");
  await waitFor(cdp, "![...document.querySelectorAll('#forum-posts .forum-post-title')].some((n) => n.textContent === 'Live one')", { label: 'the post gone' });
  check('the post goes from the list', (await count('#forum-posts .forum-post')) === 3);
  const gone = await fetch(`${BASE}/api/channels/${forum.id}/posts`, { headers: { Authorization: `Bearer ${boss}` } });
  check('and from the server', !(await gone.json()).posts.some((p) => p.message.title === 'Live one'));
  void everyone;
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
