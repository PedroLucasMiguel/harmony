// An @ in a message: the message is lit for the people it reached, and pressing
// the @ opens who it reached -- a person's card for an @name, a list for a role or
// @everyone, and a card straight away when that turns out to be one person.
//
//   node client/test/mention-who.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const HARMONY_PORT = 18224;
const FAKE_MTX_PORT = 20124;
const DEBUG_PORT = 9499;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-who-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-who-profile-'));
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

const startFakeMediaMtx = () => new Promise((done) => {
  fakeMtx = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ itemCount: 0, pageCount: 0, items: [] }));
  });
  fakeMtx.listen(FAKE_MTX_PORT, '127.0.0.1', done);
});

const startServer = () => new Promise((done, fail) => {
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
      done();
    }
  });
  p.stderr.on('data', (b) => (serverLog += b.toString()));
});

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



const as = {};
const ids = {};
const post = (who, body) => fetch(`${BASE}/api/channels/${channelId}/messages`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${as[who]}` }, body: JSON.stringify({ body }),
});
let channelId;

async function run() {
  await startFakeMediaMtx();
  await startServer();
  for (const name of ['boss', 'ana', 'bob', 'cy']) {
    const res = await fetch(`${BASE}/api/accounts/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname: name, password: 'hunter22', ...(name === 'boss' ? { ownerKey } : {}) }),
    });
    const json = await res.json();
    as[name] = json.token;
    ids[name] = json.user.id;
  }
  token = as.boss;
  channelId = (await api('/api/channels')).channels.find((c) => c.kind === 'text').id;
  const role = async (name) => (await api('/api/roles', { name, color: '#3fb984' })).role;
  const dev = await role('Dev');
  const solo = await role('Solo');
  const give = (who, roles) => api(`/api/accounts/${ids[who]}/roles`, { roles });
  await give('ana', [dev.id]);
  await give('bob', [dev.id]);
  await give('cy', [solo.id]);

  await post('boss', 'hello @bob');
  await post('boss', '@dev look at this');
  await post('boss', '@everyone dinner');
  await post('boss', 'just @solo');
  await post('boss', 'hello @ana');
  await post('ana', 'a note to @ana myself');
  await post('ana', '@everyone from me, and @dev');
  await post('ana', 'plain from me');

  const app = launchApp({ port: DEBUG_PORT, userDataDir });
  procs.push(app);
  const cdp = await attach(await findPage(DEBUG_PORT));
  await sleep(1200);
  const set = (id, value) => cdp.evaluate(`
    const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
    return true;`);
  await set('server-url', BASE);
  await sleep(1500);
  await set('username', 'ana');
  await set('account-password', 'hunter22');
  await cdp.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'the channels view' });
  await sleep(600);
  await cdp.evaluate(`
    [...document.querySelectorAll('#channel-items li.channel-row')]
      .find((li) => li.querySelector('.channel-name')?.textContent === 'general').click();
    return true;`);
  await waitFor(cdp, "document.querySelectorAll('.chat-msg').length >= 8", { label: 'the messages' });
  await sleep(500);

  const rows = () => cdp.evaluate(`
    return [...document.querySelectorAll('.chat-msg')].map((m) => ({
      text: m.querySelector('.text')?.textContent ?? '',
      lit: m.hasAttribute('data-mentions-me'),
      chipMe: m.querySelector('.mention')?.hasAttribute('data-me') ?? null,
      chipKind: m.querySelector('.mention')?.dataset.group ?? (m.querySelector('.mention')?.dataset.profileUser ? 'user' : null),
    }));`);
  const all = await rows();
  const row = (text) => all.find((r) => r.text.includes(text));

  check('a message that names you is lit, and so is your name in it', row('hello @ana')?.lit === true && row('hello @ana').chipMe === true, JSON.stringify(row('hello @ana')));
  check('one that names somebody else is not', row('hello @bob')?.lit === false && row('hello @bob').chipMe === false);
  check('a role you hold lights the message and the @', all.find((r) => /look at this/.test(r.text))?.lit === true && all.find((r) => /look at this/.test(r.text))?.chipMe === true, JSON.stringify(all.find((r) => /look at this/.test(r.text))));
  check('so does @everyone', all.find((r) => /dinner/.test(r.text))?.lit === true);
  check('and a role you do not hold does not', all.find((r) => /just/.test(r.text))?.lit === false && all.find((r) => /just/.test(r.text))?.chipMe === false);

  // Your own message is lit when you named yourself, and only then.
  check('a message in which you named yourself is lit', row('a note to')?.lit === true, JSON.stringify(row('a note to')));
  check('and one of yours that says @everyone, or names a role you hold, is lit as well', row('from me, and')?.lit === true, JSON.stringify(row('from me, and')));

  // The time that shows when the pointer is on a line that continues the one above stays clear of its words.
  const gap = await cdp.evaluate(`
    const m = document.querySelector('.chat-msg[data-grouped]:not([data-mentions-me])');
    const gutter = m.querySelector('.when-gutter');
    const r = document.createRange(); r.selectNodeContents(gutter);
    const time = r.getBoundingClientRect(); const text = m.querySelector('.text').getBoundingClientRect();
    const avatarRow = [...document.querySelectorAll('.chat-msg:not([data-grouped])')].find((r) => r.querySelector('.text'));
    return { alignedWithPictureRows: Math.abs(avatarRow.querySelector('.text').getBoundingClientRect().left - text.left) < 3, gap: Math.round((text.left - time.right) * 10) / 10, timeLeft: Math.round(time.left * 10) / 10, rowLeft: Math.round(m.getBoundingClientRect().left * 10) / 10 };`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 600, y: await cdp.evaluate("const r = document.querySelector('.chat-msg[data-grouped]').getBoundingClientRect(); return r.top + r.height / 2;"), button: 'none', buttons: 0 });
  await sleep(400);
  await cdp.send('Page.enable');
  (await import('node:fs')).writeFileSync(join(tmpdir(), 'harmony-gutter.png'), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  check('the time on a grouped line is well clear of the words (at least 13px, and not cut off at the left)', gap.gap >= 13 && gap.timeLeft >= gap.rowLeft - 0.5 && gap.alignedWithPictureRows, JSON.stringify(gap));

  // A line under your own, grouped with it, is as tall as its words: the time in its gutter has no height.
  const heights = await cdp.evaluate(`
    return [...document.querySelectorAll('.chat-msg[data-grouped]')].map((m) => ({
      text: m.querySelector('.text').textContent.slice(0, 12), row: Math.round(m.getBoundingClientRect().height), words: Math.round(m.querySelector('.text').getBoundingClientRect().height) }));`);
  check('a grouped line has no room above or below its words but the row\'s own padding',
    heights.length >= 3 && heights.every((h) => h.row - h.words <= 8), JSON.stringify(heights));

  // Every line of a block has its words on one left edge, a picture or none, lit or not.
  const edges = await cdp.evaluate(`
    const rows = [...document.querySelectorAll('.chat-msg')];
    return { text: [...new Set(rows.map((r) => Math.round(r.querySelector('.text').getBoundingClientRect().left * 10) / 10))] };`);
  check('the words of every line share one left edge', edges.text.length === 1, JSON.stringify(edges));

  // A lit message is lit across the whole row, picture included, from a bar at the left edge...
  const litRows = await cdp.evaluate(`
    const rows = [...document.querySelectorAll('.chat-msg')];
    const lit = rows.filter((r) => r.hasAttribute('data-mentions-me'));
    const shadow = (r) => getComputedStyle(r).boxShadow;
    const first = lit.find((r) => r.querySelector('.msg-avatar'));
    const avatar = first.querySelector('.msg-avatar').getBoundingClientRect();
    const row = first.getBoundingClientRect();
    return { allBars: lit.every((r) => shadow(r) !== 'none'), mainClear: lit.every((r) => getComputedStyle(r.querySelector('.msg-main')).boxShadow === 'none'),
      pictureInside: avatar.left > row.left && avatar.right < row.right,
      edges: [...new Set(lit.map((r) => Math.round(r.getBoundingClientRect().left)))], rights: [...new Set(lit.map((r) => Math.round(r.getBoundingClientRect().right)))] };`);
  check('a lit message is lit across the whole row, picture and all, from a bar at the same left edge to the same right edge',
    litRows.allBars && litRows.mainClear && litRows.pictureInside && litRows.edges.length === 1 && litRows.rights.length === 1, JSON.stringify(litRows));

  // ...and lit messages one under another are one block: the rows touch, square where they meet.
  const block = await cdp.evaluate(`
    const rows = [...document.querySelectorAll('.chat-msg')];
    const pairs = [];
    for (let i = 0; i + 1 < rows.length; i += 1) {
      if (rows[i].hasAttribute('data-mentions-me') && rows[i + 1].hasAttribute('data-mentions-me')) {
        const a = rows[i].getBoundingClientRect(); const b = rows[i + 1].getBoundingClientRect();
        pairs.push({ gap: Math.round((b.top - a.bottom) * 10) / 10, upper: getComputedStyle(rows[i]).borderBottomLeftRadius, lower: getComputedStyle(rows[i + 1]).borderTopLeftRadius });
      }
    }
    return { pairs };`);
  check('lit messages one under another touch, with square corners where they meet',
    block.pairs.length >= 2 && block.pairs.every((p) => Math.abs(p.gap) < 0.5 && p.upper === '0px' && p.lower === '0px'), JSON.stringify(block));

  const litTime = await cdp.evaluate(`
    const m = document.querySelector('.chat-msg[data-grouped][data-mentions-me]');
    const r = document.createRange(); r.selectNodeContents(m.querySelector('.when-gutter'));
    const t = r.getBoundingClientRect(); const text = m.querySelector('.text').getBoundingClientRect();
    return { fromBar: Math.round((t.left - m.getBoundingClientRect().left - 3) * 10) / 10, fromWords: Math.round((text.left - t.right) * 10) / 10 };`);
  check('the time on a lit grouped line has room on both sides: at least 4px from the bar and from the words', litTime.fromBar >= 4 && litTime.fromWords >= 4, JSON.stringify(litTime));
  await cdp.send('Page.enable');
  const lit = await cdp.send('Page.captureScreenshot', { format: 'png' });
  (await import('node:fs')).writeFileSync(join(tmpdir(), 'harmony-lit-grouped.png'), Buffer.from(lit.data, 'base64'));

  const press = (needle) => cdp.evaluate(`
    const row = [...document.querySelectorAll('.chat-msg')].find((m) => m.querySelector('.text')?.textContent.includes(${JSON.stringify(needle)}));
    row.querySelector('.mention').click(); return true;`);
  const pop = () => cdp.evaluate(`
    const p = document.querySelector('.notified-pop');
    return p && { title: p.querySelector('.notified-title').textContent, count: p.querySelector('.notified-count').textContent,
      names: [...p.querySelectorAll('.notified-name')].map((n) => n.textContent) };`);
  const card = () => cdp.evaluate(`
    const c = document.querySelector('.profile-card'); return c && !c.hidden && c.getBoundingClientRect().width > 0 ? c.textContent : null;`);
  const clear = async () => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.evaluate("document.body.click(); return true;");
    await sleep(300);
  };

  // --- an @name is the person ----------------------------------------------------------------------------------------------------
  await press('hello');
  await sleep(500);
  const personCard = await card();
  check('pressing an @name opens that person\'s card, as pressing their name does', /bob/i.test(personCard ?? ''), String(personCard).slice(0, 80));
  check('and not a list', (await pop()) === null);
  await clear();

  // --- a role -------------------------------------------------------------------------------------------------------------------
  await press('look at this');
  await sleep(500);
  const dev1 = await pop();
  check('pressing a role lists the people it reached', dev1 && dev1.names.length === 2 && dev1.names.some((n) => /ana/i.test(n)) && dev1.names.some((n) => /bob/i.test(n)), JSON.stringify(dev1));
  check('with how many', /2/.test(dev1?.count ?? ''), dev1?.count);
  check('not the one who wrote it', !dev1?.names.some((n) => /boss/i.test(n)));
  await cdp.evaluate("document.querySelectorAll('.notified-row')[1].click(); return true;");
  await sleep(500);
  check('and a person in the list opens their card', Boolean(await card()) && (await pop()) === null);
  await clear();

  // --- everyone ----------------------------------------------------------------------------------------------------------------
  await press('dinner');
  await sleep(500);
  const everyone = await pop();
  check('pressing @everyone lists all of them', everyone && everyone.names.length === 3 && /everyone/.test(everyone.title), JSON.stringify(everyone));
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(300);
  check('Escape closes it', (await pop()) === null);

  // --- a role of one person ------------------------------------------------------------------------------------------------------
  await press('just');
  await sleep(500);
  const oneCard = await card();
  check('a role that is one person is that person\'s card', /cy/i.test(oneCard ?? '') && (await pop()) === null, String(oneCard).slice(0, 80));

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
