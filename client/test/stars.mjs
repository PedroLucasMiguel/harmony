// Starred messages in a text channel: yours alone, kept on this computer.
//
//   - anybody can star a message (no permission), and the row shows it
//   - the star in the header lists them, with a box that searches them (accents and case aside)
//   - a card goes to its message, even in another channel; the Jump button too
//   - a starred message stays when it is deleted, and says so when jumped to
//   - it is kept in the settings, for this account on this server, and let go from the log or from the list
//   - the header's search box, pin and star sit on one line
//

// MediaMTX is stubbed, as in channels-ui.mjs: nothing here touches media.
//
//   node client/test/stars.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const HARMONY_PORT = 18170;
const FAKE_MTX_PORT = 20050;
const DEBUG_PORT = 9451;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-stars-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-stars-profile-'));
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
  const ana = await api('/api/accounts/register', { nickname: 'ana', password: 'hunter22' });
  const bob = await api('/api/accounts/register', { nickname: 'bob', password: 'hunter22' });
  token = owner.token;
  const general = (await api('/api/channels')).channels.find((c) => c.kind === 'text');
  const random = (await api('/api/channels', { kind: 'text', name: 'random' })).channel;
  const as = async (who, channelId, text) => {
    const keep = token; token = who;
    try { return (await post(channelId, text)).message; } finally { token = keep; }
  };
  const first = await as(ana.token, general.id, 'the plan for the café, with **bold** words');
  await as(bob.token, general.id, 'something else entirely');
  const doomed = await as(bob.token, general.id, 'this one will be deleted soon');
  const elsewhere = await as(ana.token, random.id, 'a recipe that lives in random');
  for (let i = 1; i <= 40; i += 1) await as(bob.token, random.id, `random filler ${i}`);
  await as(ana.token, general.id, 'the last message in general');

  const app = launchApp({ port: DEBUG_PORT, userDataDir });
  procs.push(app);
  const cdp = await attach(await findPage(DEBUG_PORT));
  await sleep(1200);
  const set = (id, value) => cdp.evaluate(`
    const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
    i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  await set('server-url', BASE);
  await sleep(1500);
  // A plain member: no role, no permission.
  await set('username', 'bob');
  await set('account-password', 'hunter22');
  await cdp.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'the channels view' });
  await sleep(500);
  await openChannel(cdp, general.name);

  const rowOf = (text) => `[...document.querySelectorAll('#chat-log .chat-msg')].find((r) => r.textContent.includes(${JSON.stringify(text)}))`;
  const panel = () => cdp.evaluate(`
    const pop = document.getElementById('stars-pop');
    return {
      open: !pop.hidden,
      cards: [...pop.querySelectorAll('.pin-card')].map((c) => c.textContent),
      count: document.getElementById('stars-count').textContent,
      empty: pop.querySelector('.pins-empty')?.textContent ?? '',
      html: pop.querySelector('.pin-card .pin-body')?.innerHTML ?? '',
    };`);
  const clickStar = (text) => cdp.evaluate(`
    const row = ${rowOf(text)}; const tool = row.querySelector('.star-tool'); tool.click(); return true;`);
  const keptNow = () => cdp.evaluate('const r = await window.harmony.settings.get(); const s = r.data ?? r; return { stars: s.stars ?? null };').then((r) => r.stars ?? {});
  const openStars = async () => {
    await cdp.evaluate("const pop = document.getElementById('stars-pop'); if (pop.hidden) document.getElementById('chat-stars').click(); return true;");
    await sleep(300);
  };
  const closeStars = async () => {
    await cdp.evaluate("const pop = document.getElementById('stars-pop'); if (!pop.hidden) document.getElementById('chat-stars').click(); return true;");
    await sleep(150);
  };
  const searchStars = async (text) => {
    await cdp.evaluate(`const i = document.getElementById('stars-search'); i.value = ${JSON.stringify(text)};
      i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
    await sleep(150);
  };

  // --- the header ------------------------------------------------------------------------------------------------------------------
  const header = await cdp.evaluate(`
    const mid = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return Math.round((r.top + r.bottom) / 2); };
    const h2 = document.getElementById('chat-name').getBoundingClientRect();
    return { search: mid('search-box'), pin: mid('chat-pins'), star: mid('chat-stars'), name: Math.round((h2.top + h2.bottom) / 2),
      order: ['search-box', 'chat-pins', 'chat-stars'].map((id) => Math.round(document.getElementById(id).getBoundingClientRect().left)) };`);
  check('the search box, the pin and the star are centred on one line', header.search === header.pin && header.pin === header.star && Math.abs(header.name - header.search) <= 1, JSON.stringify(header));
  check('the star is the next one after the pin', header.order[1] < header.order[2], JSON.stringify(header));
  const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })).data;
  (await import('node:fs')).writeFileSync(process.env.STARS_SHOT_DIR ? `${process.env.STARS_SHOT_DIR}/stars-header.png` : join(tmpdir(), 'stars-header.png'), Buffer.from(shot, 'base64'));

  // --- an empty list --------------------------------------------------------------------------------------------------------------
  await openStars();
  let p = await panel();
  check('with nothing starred the panel says how to', p.open && p.cards.length === 0 && /No starred messages yet/.test(p.empty), JSON.stringify(p));
  await closeStars();

  // --- starring --------------------------------------------------------------------------------------------------------------------
  const tools = await cdp.evaluate(`return document.querySelectorAll('#chat-log .chat-msg .star-tool').length`);
  check('a member with no role has the star on every message', tools >= 4, String(tools));
  await clickStar('the plan for the café');
  await clickStar('this one will be deleted soon');
  await sleep(300);
  const marked = await cdp.evaluate(`
    const a = ${rowOf('the plan for the café')}; const b = ${rowOf('something else entirely')};
    return { a: a.hasAttribute('data-starred'), b: b.hasAttribute('data-starred'),
      label: a.querySelector('.star-tool').title, on: a.querySelector('.star-tool').hasAttribute('data-on') };`);
  check('the row shows its star, and the button offers to remove it', marked.a && !marked.b && marked.on && marked.label === 'Remove the star', JSON.stringify(marked));

  const kept = await keptNow();
  const scopes = Object.keys(kept);
  check('it is kept in the settings, for this account on this server', scopes.length === 1 && scopes[0].endsWith(`#${bob.user.id}`) && kept[scopes[0]].length === 2, JSON.stringify(scopes));
  check('as a copy of the message', kept[scopes[0]].some((e) => e.kind === 'channel' && e.message.body.startsWith('the plan for the café')), '');

  // --- the list ---------------------------------------------------------------------------------------------------------------------
  await openStars();
  p = await panel();
  check('the star lists them, the one starred last first', p.open && p.cards.length === 2 && /deleted soon/.test(p.cards[0]) && /the plan/.test(p.cards[1]), JSON.stringify(p.cards));
  check('each says where it was written', p.cards.every((c) => /#general/.test(c)), JSON.stringify(p.cards));
  check('and says how many', /2 starred messages/.test(p.count), p.count);
  if (process.env.STARS_SHOT_DIR) {
    const open = (await cdp.send('Page.captureScreenshot', { format: 'png' })).data;
    (await import('node:fs')).writeFileSync(`${process.env.STARS_SHOT_DIR}/stars-open.png`, Buffer.from(open, 'base64'));
  }
  check('and is drawn as the log draws it: the markdown is bold', /<strong>bold<\/strong>/.test(await cdp.evaluate("return document.getElementById('stars-pop').innerHTML")), '');

  // --- searching them --------------------------------------------------------------------------------------------------------------
  await searchStars('cafe');
  p = await panel();
  check('searching ignores accents: "cafe" finds the café', p.cards.length === 1 && /café/.test(p.cards[0]), JSON.stringify(p.cards));
  check('and says how many of how many', /1 of 2/.test(p.count), p.count);
  await searchStars('PLAN bold');
  check('words are any order and any case, every one needed', (await panel()).cards.length === 1, '');
  await searchStars('bob');
  p = await panel();
  check('it looks at who wrote it, too', p.cards.length === 1 && /deleted soon/.test(p.cards[0]), JSON.stringify(p.cards));
  await searchStars('nothing like this');
  p = await panel();
  check('with no match it says so', p.cards.length === 0 && /No starred message has those words/.test(p.empty), JSON.stringify(p));
  await searchStars('');
  check('emptied, it is the whole list again', (await panel()).cards.length === 2, '');

  // --- going to one ---------------------------------------------------------------------------------------------------------------
  await cdp.evaluate(`const c = [...document.querySelectorAll('#stars-pop .pin-card')].find((x) => x.textContent.includes('the plan for the café')); c.querySelector('.pin-body').click(); return true;`);
  await sleep(900);
  const landed = await cdp.evaluate(`const r = ${rowOf('the plan for the café')}; return { jumped: r.hasAttribute('data-jumped'), closed: document.getElementById('stars-pop').hidden };`);
  check('clicking the message goes to it, and the panel goes away', landed.jumped && landed.closed, JSON.stringify(landed));

  // a message in another channel: to that channel, and far up in it
  await openChannel(cdp, general.name);
  await clickStar('the last message in general');
  await sleep(200);
  await openChannel(cdp, random.name);
  // starred from the list's own row? the one in random is starred by id through the server's message list
  await cdp.evaluate(`const row = [...document.querySelectorAll('#chat-log .chat-msg')].find((r) => r.textContent.includes('a recipe that lives in random'));
    if (row) { row.querySelector('.star-tool').click(); } return true;`);
  await sleep(300);
  if (!await cdp.evaluate(`return Boolean(${rowOf('a recipe that lives in random')})`)) {
    // It is above the page that loaded: load older until it is there.
    await cdp.evaluate(`for (let i = 0; i < 5; i += 1) { document.querySelector('.load-older, .older-messages')?.click(); await new Promise((r) => setTimeout(r, 400)); } return true;`);
  }
  await openChannel(cdp, general.name);
  await openStars();
  await searchStars('recipe');
  p = await panel();
  const hasRandom = p.cards.length === 1 && /#random/.test(p.cards[0]);
  if (hasRandom) {
    await cdp.evaluate(`document.querySelector('#stars-pop .pin-card .pin-tool:not(.pin-tool-icon)').click(); return true;`);
    await waitFor(cdp, "document.getElementById('chat-name').textContent === '#random'", { label: 'the other channel' });
    await sleep(1200);
    const there = await cdp.evaluate(`const r = ${rowOf('a recipe that lives in random')}; return Boolean(r) && r.hasAttribute('data-jumped');`);
    check('the Jump button goes to a message in another channel', there, '');
  } else {
    check('a message starred in another channel is in the list', false, JSON.stringify(p));
  }

  // --- deleted --------------------------------------------------------------------------------------------------------------------
  await openChannel(cdp, general.name);
  token = owner.token;
  await api(`/api/messages/${doomed.id}/delete`, {});
  await sleep(600);
  await openStars();
  await searchStars('deleted soon');
  p = await panel();
  check('a starred message that was deleted is still in the list: it is a copy', p.cards.length === 1 && /deleted soon/.test(p.cards[0]), JSON.stringify(p));
  await cdp.evaluate(`document.querySelector('#stars-pop .pin-card .pin-body').click(); return true;`);
  await sleep(800);
  check('and going to it says it is gone', /no longer/.test(await cdp.evaluate("return document.getElementById('chat-note').textContent")), '');

  // --- letting one go -------------------------------------------------------------------------------------------------------------
  await openStars();
  await searchStars('');
  const before = (await panel()).cards.length;
  await cdp.evaluate(`document.querySelector('#stars-pop .pin-card .pin-tool-icon').click(); return true;`);
  await sleep(300);
  const after = await panel();
  check('the X in the list lets one go, and the list is drawn again', after.cards.length === before - 1, `${before} -> ${after.cards.length}`);
  await closeStars();
  await clickStar('the plan for the café');
  await sleep(300);
  const gone = await cdp.evaluate(`const a = ${rowOf('the plan for the café')}; return { starred: a.hasAttribute('data-starred'), label: a.querySelector('.star-tool').title };`);
  check('starring again from the log toggles it off, on the row and the button', !gone.starred && gone.label === 'Star this message', JSON.stringify(gone));
  const left = await keptNow();
  check('and what is kept is what is starred', Object.values(left).flat().every((e) => !/the plan for the café/.test(e.message?.body ?? '')), JSON.stringify(left).slice(0, 200));

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
