// #channel in a message: a link to the channel, and the list that completes it as it is typed.
//
//   node client/test/channel-links-ui.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const HARMONY_PORT = 18195;
const FAKE_MTX_PORT = 20095;
const DEBUG_PORT = 9495;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-links-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-links-profile-'));
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
  const page = await attach(await findPage(DEBUG_PORT));
  await sleep(1200);
  await page.evaluate(`${setInput('server-url', BASE)} return true;`);
  await sleep(1500);
  for (const [id, value] of [['username', 'pedro'], ['account-password', 'hunter22'], ['account-confirm', 'hunter22'], ['owner-key', ownerKey]]) {
    await page.evaluate(`${setInput(id, value)} return true;`);
  }
  await page.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(page, "document.querySelector('.view[data-active]')?.id === 'view-channels'");

  const json = async (path, token, body) => (await fetch(`${BASE}${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}),
  })).json();
  const boss = (await (await fetch(`${BASE}/api/accounts/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname: 'pedro', password: 'hunter22' }) })).json()).token;
  const notes = (await json('/api/channels', boss, { kind: 'text', name: 'Release Notes' })).channel;
  await json('/api/channels', boss, { kind: 'forum', name: 'questions' });
  await json('/api/channels', boss, { kind: 'voice', name: 'lounge' });
  const general = (await json('/api/channels', boss)).channels.find((c) => c.name === 'general');
  await sleep(1200);

  const q = (sel) => page.evaluate(`return !!document.querySelector(${JSON.stringify(sel)});`);
  const text = (sel) => page.evaluate(`return document.querySelector(${JSON.stringify(sel)})?.textContent ?? null;`);
  const shot = async (name) => {
    if (!process.env.LINK_SHOTS) return;
    mkdirSync(process.env.LINK_SHOTS, { recursive: true });
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.LINK_SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
  };
  const rowOf = (name) => `[...document.querySelectorAll('#channel-items li.channel-row')].find((r) => r.querySelector('.channel-name')?.textContent === ${JSON.stringify(name)})`;
  const openChannel = async (name) => {
    await page.evaluate(`${rowOf(name)}.click(); return true;`);
    await sleep(900);
  };
  /** Types into the composer the way a person does: the box's value, then the events. */
  const typeInto = (value) => page.evaluate(`const i = document.getElementById('chat-input'); i.focus(); i.value = ${JSON.stringify(value)};
    i.setSelectionRange(i.value.length, i.value.length); i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  const key = async (k, code, vk) => {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
  };
  const items = () => page.evaluate("const pop = document.getElementById('mention-pop'); return pop.hidden ? null : [...pop.querySelectorAll('li')].map((li) => li.textContent.trim());");

  await openChannel('general');

  // ---- the list that completes it
  await typeInto('see #rel');
  await sleep(200);
  const some = await items();
  check('typing # and the start of a name offers the channel', some?.length === 1 && /Release Notes/.test(some[0]), JSON.stringify(some));
  check('saying what to type when it is not the name itself', /#release-notes/.test(some?.[0] ?? ''), JSON.stringify(some));
  await shot('1-completing');
  await key('Enter', 'Enter', 13);
  await sleep(200);
  check('Enter takes it, as the name it is written by, and the box is not sent', (await page.evaluate("return document.getElementById('chat-input').value")) === 'see #release-notes ', await page.evaluate("return document.getElementById('chat-input').value"));
  check('and the list closes', (await items()) === null);

  await typeInto('#');
  await sleep(200);
  const all = await items();
  check('a # alone lists the channels that can be pointed to, text and forum, and not a voice channel',
    all && all.some((x) => /general/.test(x)) && all.some((x) => /questions/.test(x)) && all.some((x) => /Release Notes/.test(x)) && !all.some((x) => /lounge/.test(x)), JSON.stringify(all));
  await typeInto('#zzz');
  await sleep(200);
  check('a name that is no channel closes the list', (await items()) === null);
  await typeInto('mail me@host#rel');
  await sleep(200);
  check('a # inside a word does not open it', (await items()) === null);
  await typeInto('and @ped');
  await sleep(200);
  check('the list for an @ is still there', (await items())?.some((x) => /pedro/.test(x)) === true);
  await typeInto('');

  // ---- what is sent, and drawn
  const say = (body) => json(`/api/channels/${general.id}/messages`, boss, { body });
  await say('look at #release-notes, then #questions. Not #nothing or #lounge, nor https://example.com/#general');
  await say('back in #general (and # heading words)');
  await waitFor(page, "[...document.querySelectorAll('#chat-log .chat-msg')].some((m) => m.textContent.includes('back in'))", { label: 'the messages' });
  const links = await page.evaluate("return [...document.querySelectorAll('#chat-log .channel-link')].map((l) => l.textContent)");
  check('a channel named in a message is a link, with its name as it is written there', JSON.stringify(links) === '["#Release Notes","#questions","#general"]', JSON.stringify(links));
  check('a word that is no channel, a voice channel, and a link\'s own # are left as text',
    await page.evaluate("const t = document.querySelector('#chat-log').textContent; return t.includes('#nothing') && t.includes('#lounge') && t.includes('https://example.com/#general');"));
  await shot('2-links');

  // ---- pressing them
  await page.evaluate("document.querySelector('#chat-log .channel-link').click(); return true;");
  await waitFor(page, "document.getElementById('chat-name').textContent === '#Release Notes'", { label: 'the channel opening' });
  check('pressing a link opens the channel', (await text('#chat-name')) === '#Release Notes');
  await json(`/api/channels/${notes.id}/messages`, boss, { body: 'over here: #general and #questions' });
  await waitFor(page, "[...document.querySelectorAll('#chat-log .chat-msg')].some((m) => m.textContent.includes('over here'))", { label: 'the message in notes' });
  await page.evaluate("[...document.querySelectorAll('#chat-log .channel-link')].find((l) => l.textContent === '#questions').click(); return true;");
  await waitFor(page, "!document.getElementById('forum-active').hidden", { label: 'the forum opening' });
  check('a forum is opened as a forum', await page.evaluate("return !document.getElementById('forum-active').hidden && document.getElementById('forum-name').textContent === 'questions'"));
  await page.evaluate(`${rowOf('Release Notes')}.click(); return true;`);
  await sleep(700);
  await page.evaluate("[...document.querySelectorAll('#chat-log .channel-link')].find((l) => l.textContent === '#general').click(); return true;");
  await waitFor(page, "document.getElementById('chat-name').textContent === '#general'", { label: 'back to general' });
  check('and back to where it was written', (await text('#chat-name')) === '#general');

  // ---- a channel that goes: its link is a word again; one that comes: a word is a link
  await json(`/api/channels/${notes.id}`, boss, { name: 'Changelog' });
  await sleep(1200);
  const after = await page.evaluate("return [...document.querySelectorAll('#chat-log .channel-link')].map((l) => l.textContent)");
  check('renamed, the old name is only a word and the message is drawn again', JSON.stringify(after) === '["#questions","#general"]', JSON.stringify(after));
  await say('and now #changelog');
  await waitFor(page, "[...document.querySelectorAll('#chat-log .chat-msg')].some((m) => m.textContent.includes('and now'))", { label: 'the new message' });
  check('the new name is a link', await page.evaluate("return [...document.querySelectorAll('#chat-log .channel-link')].some((l) => l.textContent === '#Changelog')"));
}

run()
  .catch((err) => {
    console.error(err);
    console.error(serverLog.split('\n').slice(-12).join('\n'));
    process.exitCode = 1;
  })
  .finally(() => {
    const failed = summary();
    setTimeout(() => process.exit(process.exitCode ?? (failed ? 1 : 0)), 200);
  });
