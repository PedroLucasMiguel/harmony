// Searching the server from a text channel, driven through the real client.
//
//   - the box offers its filters, then what each can be; a chosen value is a chip
//   - Enter searches the whole server, and the answer is a panel over the member list
//   - what was searched is remembered, and can be cleared
//   - a result goes to its message, in its channel, even a long way up
//   - the filters dialog, the sort and the pages
//
// MediaMTX is stubbed, as in channels-ui.mjs: nothing here touches media.
//
//   node client/test/search-ui.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const HARMONY_PORT = 18150;
const FAKE_MTX_PORT = 20030;
const DEBUG_PORT = 9431;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-search-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-search-profile-'));
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

const press = (cdp, key) => cdp.evaluate(`
  const i = document.getElementById('chat-search'); i.focus();
  i.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true })); return true;`);
const type = (cdp, text) => cdp.evaluate(`
  const i = document.getElementById('chat-search'); i.focus(); i.value = ${JSON.stringify(text)};
  i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
const popRows = (cdp) => cdp.evaluate(`return [...document.querySelectorAll('#search-pop .search-row')].map((r) => r.textContent.trim())`);
const chipsOf = (cdp) => cdp.evaluate(`return [...document.querySelectorAll('#search-chips .search-chip')].map((c) => c.textContent.trim())`);
const panel = (cdp) => cdp.evaluate(`
  const p = document.getElementById('search-results');
  const members = document.getElementById('member-list');
  const box = p.getBoundingClientRect(); const m = members.getBoundingClientRect();
  return {
    open: !p.hidden,
    count: document.getElementById('sr-count').textContent,
    cards: [...p.querySelectorAll('.search-card')].map((c) => c.textContent),
    groups: [...p.querySelectorAll('.search-group')].map((g) => g.textContent.trim()),
    pager: !document.getElementById('sr-pager').hidden,
    filtersLabel: document.getElementById('sr-filters').textContent.trim(),
    // over the member list: its right edge reaches the member list's, and it is as tall as the layout
    overMembers: !members.hidden && box.right >= m.right - 2 && box.left <= m.left + 2,
    onScreen: box.width > 250 && box.left >= 0 && box.right <= window.innerWidth + 1,
  };`);

async function run() {
  console.log('Starting the control server and the client…\n');
  await startFakeMediaMtx();
  await startHarmonyServer();

  // --- two people, three channels, a history to search ---------------------
  const registered = await api('/api/accounts/register', { nickname: 'tester', password: 'hunter22', ownerKey });
  token = registered.token;
  const ana = await api('/api/accounts/register', { nickname: 'ana', password: 'hunter22' });
  const anaToken = ana.token;
  const general = (await api('/api/channels')).channels.find((c) => c.kind === 'text');
  const random = (await api('/api/channels', { kind: 'text', name: 'random' })).channel;
  const deep = (await api('/api/channels', { kind: 'text', name: 'deep' })).channel;
  const as = async (who, channelId, body) => {
    const keep = token; token = who;
    try { return (await post(channelId, body)).message; } finally { token = keep; }
  };
  await as(token, general.id, 'hello from the owner');
  const pinnedMessage = await as(anaToken, general.id, 'zebra pinned by ana');
  await as(anaToken, general.id, 'zebra plain by ana');
  await as(anaToken, general.id, 'zebra with a link https://example.com/z');
  await as(token, general.id, 'zebra by the owner');
  const inRandom = await as(anaToken, random.id, 'zebra in random');
  await api(`/api/messages/${pinnedMessage.id}/pin`, { pinned: true });
  // a message at the very top of a long channel, and 130 under it
  const far = await as(anaToken, deep.id, 'zebra at the very top of deep');
  for (let i = 1; i <= 130; i += 1) await as(token, deep.id, `deep filler ${i}`);
  // a channel whose pins hold what a pin can hold: markdown, a link, a file and a picture
  const rich = (await api('/api/channels', { kind: 'text', name: 'rich' })).channel;
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const upload = async (bytes, contentType) => (await (await fetch(`${BASE}/api/uploads`, {
    method: 'POST', headers: { 'Content-Type': contentType, Authorization: `Bearer ${anaToken}` }, body: bytes,
  })).json()).hash;
  const richPost = async (body, attachment) => {
    const res = await fetch(`${BASE}/api/channels/${rich.id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${anaToken}` },
      body: JSON.stringify({ body, ...attachment }),
    });
    const { message } = await res.json();
    await api(`/api/messages/${message.id}/pin`, { pinned: true });
    return message;
  };
  await richPost('some **bold words** and `inline code`\n```\nfenced block\n```');
  await richPost('read https://example.com/docs/page please');
  await richPost('the report', { attachmentHash: await upload(Buffer.from('%PDF-1.4 fake'), 'application/pdf'), attachmentName: 'report.pdf' });
  await richPost('a picture', { attachmentHash: await upload(PNG, 'image/png'), attachmentName: 'dot.png' });
  // enough of a word for pages
  for (let i = 1; i <= 30; i += 1) await as(token, random.id, `giraffe number ${i}`);

  const app = launchApp({ port: DEBUG_PORT, userDataDir });
  procs.push(app);
  const cdp = await attach(await findPage(DEBUG_PORT));
  // The window is not always the one in front when this runs: focus() must be a focus either way.
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await sleep(1200);

  const set = (id, value) => cdp.evaluate(`
    const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
    i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  await set('server-url', BASE);
  await sleep(1500);
  await set('username', 'tester');
  await set('account-password', 'hunter22');
  await cdp.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'the channels view' });
  await sleep(500);
  const openChannel = async (name) => {
    await cdp.evaluate(`[...document.querySelectorAll('#channel-items li.channel-row')]
      .find((row) => row.querySelector('.channel-name')?.textContent === ${JSON.stringify(name)}).click(); return true;`);
    await waitFor(cdp, `document.getElementById('chat-name').textContent === '#${name}' && document.querySelectorAll('#chat-log .chat-msg').length > 0`, { label: `#${name}` });
    await sleep(250);
  };
  await openChannel(general.name);

  // --- the box offers its filters ----------------------------------------------------------------------------------------------
  await cdp.evaluate("document.getElementById('chat-search').focus(); return true;");
  await sleep(200);
  let rows = await popRows(cdp);
  check('focused and empty, the box offers the five filters', rows.length === 5 && /From a specific user/.test(rows[0]) && /in: channel/.test(rows[1])
    && /has: link, embed or file/.test(rows[2]) && /mentions: user/.test(rows[3]) && /More filters/.test(rows[4]), JSON.stringify(rows));
  check('the box says what it searches', (await cdp.evaluate("return document.getElementById('chat-search').placeholder")).startsWith('Search'), '');

  await cdp.evaluate("document.querySelectorAll('#search-pop .search-row')[0].click(); return true;");
  await sleep(200);
  check('choosing "from" puts from: in the box and offers the people', await cdp.evaluate("return document.getElementById('chat-search').value") === 'from:'
    && (await popRows(cdp)).length >= 2, JSON.stringify(await popRows(cdp)));
  await type(cdp, 'from:an');
  await sleep(150);
  rows = await popRows(cdp);
  check('typing narrows them', rows.length === 1 && /ana/.test(rows[0]), JSON.stringify(rows));
  await press(cdp, 'Enter');
  await sleep(200);
  check('Enter takes the first, which becomes a chip, and the box is empty again', (await chipsOf(cdp)).join('|') === 'from:ana'
    && await cdp.evaluate("return document.getElementById('chat-search').value") === '', JSON.stringify(await chipsOf(cdp)));

  // --- searching ----------------------------------------------------------------------------------------------------------------
  await type(cdp, 'zebra');
  await press(cdp, 'Enter');
  await waitFor(cdp, "!document.getElementById('search-results').hidden && document.querySelectorAll('#search-results .search-card').length > 0", { label: 'the results' });
  await sleep(300);
  let p = await panel(cdp);
  check('the answer is every message by Ana with "zebra", in every channel: 5, not only the open one',
    p.count === '5 results' && p.cards.length === 5 && p.cards.every((c) => /ana/.test(c) && /zebra/.test(c)), JSON.stringify(p));
  check('grouped by channel', p.groups.length === 3 && p.groups.some((g) => /general/.test(g)) && p.groups.some((g) => /random/.test(g)) && p.groups.some((g) => /deep/.test(g)), JSON.stringify(p.groups));
  check('and the panel is over the member list, on screen', p.open && p.overMembers && p.onScreen, JSON.stringify(p));
  check('the filters button says how many are on', p.filtersLabel === 'Filters (1)', p.filtersLabel);

  // --- the history ----------------------------------------------------------------------------------------------------------------
  await cdp.evaluate("document.getElementById('chat-search').blur(); return true;");
  await cdp.evaluate("document.getElementById('chat-search-clear').click(); return true;");
  await sleep(200);
  p = await panel(cdp);
  check('the X clears the chips and the words and puts the panel away', !p.open && (await chipsOf(cdp)).length === 0, JSON.stringify(p));
  await cdp.evaluate("document.getElementById('chat-search').focus(); return true;");
  await sleep(200);
  rows = await popRows(cdp);
  check('what was searched is offered again, under the filters', rows.length === 6 && /from:\s*ana/.test(rows[5]) && /zebra/.test(rows[5]), JSON.stringify(rows));
  await cdp.evaluate("document.querySelectorAll('#search-pop .search-history')[0].click(); return true;");
  await waitFor(cdp, "document.querySelectorAll('#search-results .search-card').length > 0", { label: 'the search again' });
  await sleep(300);
  check('choosing it searches again, with its chips and words', (await chipsOf(cdp)).join('|') === 'from:ana'
    && await cdp.evaluate("return document.getElementById('chat-search').value") === 'zebra' && (await panel(cdp)).cards.length === 5, '');

  // --- a result goes to its message, in its channel -------------------------------------------------------------------------
  await cdp.evaluate(`[...document.querySelectorAll('#search-results .search-card')].find((c) => /zebra in random/.test(c.textContent)).click(); return true;`);
  await waitFor(cdp, "document.getElementById('chat-name').textContent === '#random'", { label: 'the other channel' });
  await sleep(900);
  const landed = await cdp.evaluate(`
    const row = document.querySelector('#chat-log .chat-msg[data-id="${inRandom.id}"]');
    const log = document.getElementById('chat-log').getBoundingClientRect(); const box = row?.getBoundingClientRect();
    return { there: Boolean(row), visible: Boolean(box && box.top >= log.top - 1 && box.bottom <= log.bottom + 1) };`);
  check('a result in another channel opens that channel and shows the message', landed.there && landed.visible, JSON.stringify(landed));
  check('and the results stay where they were, for the next one', (await panel(cdp)).open, '');

  await cdp.evaluate(`[...document.querySelectorAll('#search-results .search-card')].find((c) => /very top of deep/.test(c.textContent)).click(); return true;`);
  await waitFor(cdp, "document.getElementById('chat-name').textContent === '#deep'", { label: 'the long channel' });
  await sleep(1500);
  const farLanded = await cdp.evaluate(`
    const row = document.querySelector('#chat-log .chat-msg[data-id="${far.id}"]');
    const log = document.getElementById('chat-log').getBoundingClientRect(); const box = row?.getBoundingClientRect();
    return { there: Boolean(row), visible: Boolean(box && box.top >= log.top - 1 && box.bottom <= log.bottom + 1),
      rows: document.querySelectorAll('#chat-log .chat-msg').length };`);
  check('and a message a hundred and thirty above the newest is reached too', farLanded.there && farLanded.visible, JSON.stringify(farLanded));

  // --- the filters dialog, the sort ------------------------------------------------------------------------------------------
  await cdp.evaluate("document.getElementById('sr-filters').click(); return true;");
  await sleep(300);
  const dialog = await cdp.evaluate(`
    const d = document.querySelector('dialog.search-filters');
    return { open: Boolean(d?.open), sections: [...d.querySelectorAll('h4')].map((h) => h.textContent), clear: d.querySelector('.search-filters-clear').textContent };`);
  check('"Filters" opens every filter in one place: From, In, Has, Mentions, Date, Pinned', dialog.open
    && ['From', 'In', 'Has', 'Mentions', 'Date', 'Pinned'].every((h, i) => dialog.sections[i] === h) && dialog.clear === 'Clear filters (1)', JSON.stringify(dialog));
  await cdp.evaluate(`
    const d = document.querySelector('dialog.search-filters');
    const select = [...d.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.textContent === 'True'));
    select.value = 'true'; select.dispatchEvent(new Event('change', { bubbles: true }));
    d.querySelector('button[type=submit]').click(); return true;`);
  await waitFor(cdp, "document.getElementById('sr-count').textContent === '1 result'", { label: 'only the pinned one' });
  p = await panel(cdp);
  check('Apply: pinned only, with its chip, and the count in the button', (await chipsOf(cdp)).includes('pinned:true') && p.cards.length === 1 && /pinned by ana/.test(p.cards[0]) && p.filtersLabel === 'Filters (2)', JSON.stringify(p));

  // remove the pin chip and the author with Backspace; search the word alone to have enough to page and sort
  await type(cdp, 'giraffe');
  await cdp.evaluate("document.querySelectorAll('#search-chips .search-chip-remove').forEach((b) => b.click()); return true;");
  await press(cdp, 'Enter');
  await waitFor(cdp, "document.getElementById('sr-count').textContent === '30 results'", { label: 'thirty results' });
  p = await panel(cdp);
  check('thirty results are a page of 25 and a pager', p.cards.length === 25 && p.pager, JSON.stringify({ n: p.cards.length, pager: p.pager }));
  const firstPage = p.cards.slice();
  check('newest first by default', /giraffe number 30/.test(firstPage[0]), firstPage[0]);
  await cdp.evaluate("[...document.querySelectorAll('#sr-pager .search-page')].find((b) => b.textContent === '2').click(); return true;");
  await sleep(500);
  p = await panel(cdp);
  check('page 2 is the other five', p.cards.length === 5 && /giraffe number 5/.test(p.cards[0]), JSON.stringify(p.cards));
  await cdp.evaluate("document.getElementById('sr-sort').click(); return true;");
  await cdp.evaluate("[...document.querySelectorAll('#sr-sort-menu .search-menu-item')].find((b) => /Oldest/.test(b.textContent)).click(); return true;");
  await sleep(600);
  p = await panel(cdp);
  check('sorted oldest first, from the first page', /giraffe number 1(?!\d)/.test(p.cards[0]), p.cards[0]);

  // --- typed filters -------------------------------------------------------------------------------------------------------------
  await cdp.evaluate("document.getElementById('chat-search-clear').click(); return true;");
  await type(cdp, 'has:link ');
  await sleep(150);
  check('a filter typed out in full, then a space, becomes a chip', (await chipsOf(cdp)).join('|') === 'has:link', JSON.stringify(await chipsOf(cdp)));
  await type(cdp, 'zebra');
  await press(cdp, 'Enter');
  await waitFor(cdp, "document.getElementById('sr-count').textContent === '1 result'", { label: 'the one link' });
  check('and has:link finds the message with the link', /example\.com/.test((await panel(cdp)).cards[0]), '');

  // --- what a pin holds is drawn, not described --------------------------------------------------------------------------------
  await cdp.evaluate("document.getElementById('chat-search-clear').click(); return true;");
  await openChannel('rich');
  await cdp.evaluate("document.getElementById('chat-pins').click(); return true;");
  await waitFor(cdp, "document.querySelectorAll('#pins-list .pin-card').length === 4", { label: 'the four pins' });
  await sleep(600);
  const pins = await cdp.evaluate(`
    const cards = [...document.querySelectorAll('#pins-list .pin-card')];
    const find = (re) => cards.find((c) => re.test(c.textContent));
    const markdown = find(/bold words/);
    const link = find(/read /);
    const file = find(/the report/);
    const picture = find(/a picture/);
    return {
      boldIsBold: Boolean(markdown?.querySelector('.text strong')) && markdown.querySelector('.text strong').textContent === 'bold words',
      code: Boolean(markdown?.querySelector('code')) && /inline code/.test(markdown.querySelector('code').textContent),
      fenced: Boolean(markdown?.querySelector('pre')) && /fenced block/.test(markdown.querySelector('pre').textContent),
      noAsterisks: !(markdown?.textContent ?? '**').includes('**'),
      linked: Boolean(link?.querySelector('.text a[href^="https://example.com/docs/page"]')),
      file: Boolean(file?.querySelector('.attachment, .attachment-card')) && /report\.pdf/.test(file.textContent),
      picture: Boolean(picture?.querySelector('.text img[src]')),
      jump: cards.every((c) => c.querySelector('.pin-tools .pin-tool')?.textContent === 'Jump'),
      unpin: cards.every((c) => c.querySelector('.pin-tool-icon')),
    };`);
  check('the pinned list draws markdown: bold, inline code and a fenced block', pins.boldIsBold && pins.code && pins.fenced && pins.noAsterisks, JSON.stringify(pins));
  check('a link in a pin is a link', pins.linked, JSON.stringify(pins));
  check('a file in a pin is its card, with its name', pins.file, JSON.stringify(pins));
  check('a picture in a pin is the picture', pins.picture, JSON.stringify(pins));
  check('and each pin has Jump and Unpin', pins.jump && pins.unpin, JSON.stringify(pins));

  // a click on something in the message does that, and does not take you away; the card's own Jump does
  await cdp.evaluate("document.querySelector('#pins-list .pin-card .text a')?.addEventListener('click', (e) => e.preventDefault()); document.querySelector('#pins-list .pin-card .text a')?.click(); return true;");
  await sleep(200);
  check('clicking a link in a pin leaves the list open', await cdp.evaluate("return !document.getElementById('pins-pop').hidden"), '');
  await cdp.evaluate("[...document.querySelectorAll('#pins-list .pin-card')].find((c) => /the report/.test(c.textContent)).querySelector('.pin-tool').click(); return true;");
  await sleep(500);
  check('the Jump button closes it and goes to the message', await cdp.evaluate("return document.getElementById('pins-pop').hidden"), '');

  // the same in the search results
  await type(cdp, 'has:file ');
  await press(cdp, 'Enter');
  await waitFor(cdp, "document.querySelectorAll('#search-results .search-card .attachment, #search-results .search-card .attachment-card').length > 0", { label: 'the file in a result' });
  const results = await cdp.evaluate(`return {
    file: Boolean(document.querySelector('#search-results .search-card .attachment, #search-results .search-card .attachment-card')),
    picture: Boolean(document.querySelector('#search-results .search-card .text img[src]')),
  }`);
  check('a result draws its file and its picture too', results.file && results.picture, JSON.stringify(results));
  await cdp.evaluate("document.getElementById('chat-search-clear').click(); return true;");

  // --- Esc -------------------------------------------------------------------------------------------------------------------------
  await type(cdp, 'zebra');
  await press(cdp, 'Enter');
  await waitFor(cdp, "!document.getElementById('search-results').hidden && document.querySelectorAll('#search-results .search-card').length > 0", { label: 'results to put away' });
  await press(cdp, 'Escape');
  await sleep(150);
  check('Esc puts the results away', !(await panel(cdp)).open, '');
  await cdp.evaluate("document.getElementById('chat-search-clear').click(); document.getElementById('chat-search').focus(); return true;");
  await sleep(200);
  await cdp.evaluate("document.querySelector('#search-pop .search-pop-action').click(); return true;");
  await sleep(300);
  check('the trash clears the history', (await popRows(cdp)).length === 5, JSON.stringify(await popRows(cdp)));

  // --- a filter set, changed or taken off searches by itself --------------------------------------------------------------------------
  await cdp.evaluate("document.getElementById('chat-search-clear').click(); return true;");
  await sleep(300);
  check('nothing is searched to begin with', !(await panel(cdp)).open && (await chipsOf(cdp)).length === 0, '');
  await cdp.evaluate("document.getElementById('chat-search').focus(); return true;");
  await type(cdp, 'from:');
  await sleep(250);
  await cdp.evaluate("document.querySelector('#search-pop .search-row').click(); return true;");
  await waitFor(cdp, "!document.getElementById('search-results').hidden && document.querySelectorAll('#search-results .search-card').length > 0", { label: 'the answers to a filter chosen, with no Enter' });
  await sleep(300);
  p = await panel(cdp);
  const byOne = p.cards.length;
  check('choosing a person from the list searches at once: the answers are theirs, and there was no Enter', p.open && (await chipsOf(cdp)).length === 1 && byOne > 0, JSON.stringify([await chipsOf(cdp), p.count]));
  const groupsBefore = p.groups.length;
  await type(cdp, 'in:');
  await sleep(250);
  await cdp.evaluate("[...document.querySelectorAll('#search-pop .search-row')].find((r) => /random/.test(r.textContent)).click(); return true;");
  await sleep(1200);
  p = await panel(cdp);
  check('a second filter narrows the answers without another Enter: only that channel is left', (await chipsOf(cdp)).length === 2 && p.groups.length === 1 && /random/.test(p.groups[0]) && groupsBefore > 1, JSON.stringify([p.groups, groupsBefore]));
  await cdp.evaluate("document.querySelectorAll('#search-chips .search-chip-remove')[1].click(); return true;");
  await sleep(1200);
  p = await panel(cdp);
  check('taking a filter off searches again with what is left', (await chipsOf(cdp)).length === 1 && p.groups.length > 1, JSON.stringify([p.groups, p.count]));
  await cdp.evaluate("document.querySelectorAll('#search-chips .search-chip-remove')[0].click(); return true;");
  await sleep(600);
  check('and with nothing left to look for the answers go away', !(await panel(cdp)).open && (await chipsOf(cdp)).length === 0, '');
  await type(cdp, 'has:link ');
  await sleep(1200);
  p = await panel(cdp);
  check('a filter typed out whole (followed by a space) searches too', p.open && (await chipsOf(cdp)).join('|') === 'has:link' && p.cards.length > 0 && p.cards.every((c) => /link|https/i.test(c)), JSON.stringify([await chipsOf(cdp), p.cards.length]));
  await cdp.evaluate("document.getElementById('chat-search-clear').click(); return true;");
  await sleep(300);

  // --- a person's own picture is the size of the others' ---------------------------------------------------------------------------
  // A card is not a message row, and the picture's size is set by the row: a face with an image (not just initials) was
  // drawn at the image's own size in the answers, the pins and the stars.
  await type(cdp, 'zebra');
  await press(cdp, 'Enter');
  await waitFor(cdp, "!document.getElementById('search-results').hidden && document.querySelectorAll('#search-results .search-card').length > 0", { label: 'answers to measure a face in' });
  await sleep(300);
  const faces = await cdp.evaluate(`
    const big = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="red"/></svg>');
    const out = {};
    for (const [name, host] of [['search', 'search-card'], ['pin', 'pin-card']]) {
      const card = document.createElement('div'); card.className = host;
      const face = document.createElement('span'); face.className = 'avatar msg-avatar';
      const img = document.createElement('img'); img.src = big; face.append(img); card.append(face);
      (document.getElementById('sr-body')).append(card);
      await new Promise((r) => setTimeout(r, 150));
      const box = face.getBoundingClientRect();
      out[name] = { w: Math.round(box.width), h: Math.round(box.height) };
      card.remove();
    }
    return out;`);
  check('a face with a picture of its own is small in an answer and in a pin, as it is in the log',
    faces.search.w > 0 && faces.search.w <= 48 && faces.search.h <= 48 && faces.pin.w > 0 && faces.pin.w <= 48 && faces.pin.h <= 48, JSON.stringify(faces));

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
