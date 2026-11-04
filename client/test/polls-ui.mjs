// A poll in a text channel, in the real app against a real server.
//
//   - the dialog: what it asks for, that it will not send without a question and two options, that writing in
//     the last option makes another, the switches and the end time
//   - the card in the log: the options, who voted, the count, a click to vote and to take it back
//   - what somebody else does arrives without a refresh (a vote, a poll that hides its voters, one that closes)
//   - the list of who voted
//
//   node client/test/polls-ui.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const HARMONY_PORT = 18181;
const FAKE_MTX_PORT = 20081;
const DEBUG_PORT = 9481;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-polls-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-polls-profile-'));
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

  const reg = await (await fetch(`${BASE}/api/accounts/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname: 'ana', password: 'hunter22' }),
  })).json();
  const ana = { Authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' };
  const chans = await (await fetch(`${BASE}/api/channels`, { headers: ana })).json();
  const general = chans.channels.find((c) => c.kind === 'text');
  const anaPost = async (poll) => (await (await fetch(`${BASE}/api/channels/${general.id}/messages`, {
    method: 'POST', headers: ana, body: JSON.stringify({ poll }),
  })).json()).message;
  const anaVote = (id, options) => fetch(`${BASE}/api/messages/${id}/vote`, { method: 'POST', headers: ana, body: JSON.stringify({ options }) });

  await cdp.evaluate(`[...document.querySelectorAll('#channel-items li.channel-row')].find((r) => r.textContent.includes('general')).click(); return true;`);
  await sleep(1200);

  const q = (sel) => cdp.evaluate(`return !!document.querySelector(${JSON.stringify(sel)});`);
  const text = (sel) => cdp.evaluate(`return document.querySelector(${JSON.stringify(sel)})?.textContent ?? null;`);
  const count = (sel) => cdp.evaluate(`return document.querySelectorAll(${JSON.stringify(sel)}).length;`);
  const type = (sel, value, nth = 0) => cdp.evaluate(`const i = document.querySelectorAll(${JSON.stringify(sel)})[${nth}];
    i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  const click = (sel, nth = 0) => cdp.evaluate(`document.querySelectorAll(${JSON.stringify(sel)})[${nth}].click(); return true;`);
  const D = '[data-testid="poll-dialog"]';
  // POLL_SHOTS=dir keeps a picture of the dialog and of the cards, to look at.
  const shot = async (name) => {
    if (!process.env.POLL_SHOTS) return;
    mkdirSync(process.env.POLL_SHOTS, { recursive: true });
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.POLL_SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
  };

  // ---- the dialog
  check('the composer has a poll button', await q('#chat-poll'));
  await click('#chat-poll');
  await waitFor(cdp, `!!document.querySelector('${D}')`, { label: 'the poll dialog' });
  check('the dialog opens with two empty options', (await count(`${D} [data-testid="poll-option"]`)) === 2);
  check('and cannot be sent while it has no question', await cdp.evaluate(`return document.querySelector('[data-testid="poll-send"]').disabled;`));

  await type(`${D} [data-testid="poll-title"]`, 'Where do we eat?');
  check('a question alone is not enough', await cdp.evaluate(`return document.querySelector('[data-testid="poll-send"]').disabled;`));
  await type(`${D} [data-testid="poll-option"]`, 'Pizza', 0);
  check('one option is not enough', await cdp.evaluate(`return document.querySelector('[data-testid="poll-send"]').disabled;`));
  await type(`${D} [data-testid="poll-option"]`, 'Sushi', 1);
  check('writing in the last option makes another', (await count(`${D} [data-testid="poll-option"]`)) === 3);
  check('and a question with two options can be sent', !(await cdp.evaluate(`return document.querySelector('[data-testid="poll-send"]').disabled;`)));
  await type(`${D} [data-testid="poll-option"]`, 'Tacos', 2);
  check('and again, with the third', (await count(`${D} [data-testid="poll-option"]`)) === 4);
  check('an option that is not the empty one at the end can be removed', await cdp.evaluate(`return getComputedStyle(document.querySelector('${D} .poll-option-drop')).visibility !== 'hidden';`));
  await cdp.evaluate(`document.querySelectorAll('${D} .poll-option-drop')[2].click(); return true;`);
  check('removing one takes it out', (await count(`${D} [data-testid="poll-option"]`)) === 3);
  await type(`${D} [data-testid="poll-description"]`, 'Friday night');
  await type(`${D} [data-testid="poll-footer"]`, 'majority wins');
  await click(`${D} [data-testid="poll-multiple"]`);
  await click(`${D} [data-testid="poll-timed"]`);
  check('the end time shows when asked for, a day ahead', await cdp.evaluate(`const i = document.querySelector('[data-testid="poll-ends"]');
    const t = new Date(i.value).getTime() - Date.now(); return !i.hidden && t > 23 * 3600e3 && t < 25 * 3600e3;`));
  await type(`${D} [data-testid="poll-ends"]`, '2001-01-01T00:00');
  check('an end that has passed cannot be sent', await cdp.evaluate(`return document.querySelector('[data-testid="poll-send"]').disabled;`));
  await type(`${D} [data-testid="poll-ends"]`, await cdp.evaluate(`const d = new Date(Date.now() + 2 * 86400e3); d.setSeconds(0, 0);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);`));
  await shot('dialog');
  await click('[data-testid="poll-send"]');
  await waitFor(cdp, `!document.querySelector('${D}') && !!document.querySelector('#chat-log [data-testid="poll-card"]')`, { label: 'the card in the log' });

  // ---- the card
  const card = '#chat-log [data-testid="poll-card"]';
  check('the card shows the question, description and footer', /Where do we eat\?/.test(await text(`${card} .poll-title`))
    && (await text(`${card} .poll-desc`)) === 'Friday night' && (await text(`${card} .poll-footer`)) === 'majority wins');
  check('with its options, without the empty one', (await count(`${card} .poll-option`)) === 2);
  check('saying that more than one can be chosen', /one or more/i.test(await text(`${card} .poll-sub`)));
  check('and when it ends', /day/.test(await text(`${card} .poll-ends`) ?? ''));
  check('and no votes yet, with the list one click away', (await text(`${card} .poll-total`)) === '0 votes' && await q(`${card} .poll-view`));
  check('the message is not offered for editing', !(await cdp.evaluate(`return !!document.querySelector('#chat-log .chat-msg[data-poll] .msg-tool[data-icon="pencil-simple"]');`)));

  await click(`${card} .poll-choice`, 0);
  await waitFor(cdp, `document.querySelector('${card} .poll-check[data-on]')`, { label: 'the vote shown' });
  check('a click votes: the option is ticked and counted', (await text(`${card} .poll-option .poll-count`)) === '1' && (await text(`${card} .poll-total`)) === '1 vote');
  check('with your face beside it', (await count(`${card} .poll-faces .avatar`)) === 1);
  await click(`${card} .poll-choice`, 1);
  await waitFor(cdp, `document.querySelectorAll('${card} .poll-check[data-on]').length === 2`, { label: 'two ticked' });
  check('a poll of several takes the second as well', (await text(`${card} .poll-total`)) === '1 vote');
  await click(`${card} .poll-choice`, 0);
  await waitFor(cdp, `document.querySelectorAll('${card} .poll-check[data-on]').length === 1`, { label: 'one taken back' });
  check('and a click on a ticked option takes it back', true);

  // ---- somebody else votes
  const id = Number(await cdp.evaluate(`return document.querySelector('#chat-log .chat-msg[data-poll]').dataset.id;`));
  await anaVote(id, [1]);
  await waitFor(cdp, `document.querySelector('${card} .poll-total')?.textContent === '2 votes'`, { label: 'ana\'s vote arriving' });
  check('somebody else\'s vote arrives without a refresh', (await count(`${card} .poll-faces .avatar`)) === 2);
  await click(`${card} .poll-view`);
  await waitFor(cdp, `!!document.querySelector('[data-testid="poll-votes"]')`, { label: 'the voters dialog' });
  const voters = await cdp.evaluate(`return [...document.querySelectorAll('[data-testid="poll-votes"] .poll-voter')].map((n) => n.textContent.trim());`);
  check('the list says who chose what', voters.length === 2 && voters.some((v) => /pedro/.test(v)) && voters.some((v) => /ana/.test(v)), JSON.stringify(voters));
  await cdp.evaluate(`document.querySelector('[data-testid="poll-votes"] .ask-buttons button').click(); return true;`);

  // ---- a poll that hides its voters, from somebody else
  const hidden = await anaPost({ title: 'Secret ballot', options: ['yes', 'no'], anonymous: true });
  await waitFor(cdp, `!!document.querySelector('.chat-msg[data-id="${hidden.id}"] .poll-card')`, { label: 'the second poll' });
  const hiddenCard = `.chat-msg[data-id="${hidden.id}"] .poll-card`;
  check('says that it is anonymous', /Anonymous/.test(await text(`${hiddenCard} .poll-sub`)));
  await click(`${hiddenCard} .poll-choice`, 0);
  await anaVote(hidden.id, [0]);
  await waitFor(cdp, `document.querySelector('${hiddenCard} .poll-total')?.textContent === '2 votes'`, { label: 'both votes' });
  check('counts the votes and shows nobody\'s face', (await count(`${hiddenCard} .poll-faces`)) === 0 && (await text(`${hiddenCard} .poll-option .poll-count`)) === '2');
  await click(`${hiddenCard} .poll-view`);
  await waitFor(cdp, `!!document.querySelector('[data-testid="poll-votes"]')`, { label: 'voters dialog of the hidden poll' });
  check('and the list says they are hidden and has no names', /hidden/i.test(await text('[data-testid="poll-votes"] .poll-hidden')) && (await count('[data-testid="poll-votes"] .poll-voter')) === 0);
  await cdp.evaluate(`document.querySelector('[data-testid="poll-votes"] .ask-buttons button').click(); return true;`);

  await shot('cards');

  // ---- one that closes while it is on the screen
  const timed = await anaPost({ title: 'Quick one', options: ['a', 'b'], endsAt: Date.now() + 2500 });
  await waitFor(cdp, `!!document.querySelector('.chat-msg[data-id="${timed.id}"] .poll-card')`, { label: 'the timed poll' });
  const timedCard = `.chat-msg[data-id="${timed.id}"] .poll-card`;
  check('a poll with an end says how long is left', /left/.test(await text(`${timedCard} .poll-ends`)));
  check('and can be voted on until then', !(await cdp.evaluate(`return document.querySelector('${timedCard} .poll-choice').disabled;`)));
  await waitFor(cdp, `document.querySelector('${timedCard}')?.hasAttribute('data-closed')`, { label: 'the poll closing', timeoutMs: 15_000 });
  check('at its end it is closed on the screen, with no one scrolling', (await text(`${timedCard} .poll-ends`)) === 'Poll closed' && /Final/.test(await text(`${timedCard} .poll-sub`)));
  check('and its options no longer take a click', await cdp.evaluate(`return [...document.querySelectorAll('${timedCard} .poll-choice')].every((b) => b.disabled);`));

  await shot('closed');

  // ---- what happens on a phone
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  const fits = await cdp.evaluate(`const c = document.querySelector('${card}'); const r = c.getBoundingClientRect();
    return { right: Math.round(r.right), win: innerWidth, scroll: document.documentElement.scrollWidth };`);
  check('on a phone the card fits the screen', fits.right <= fits.win && fits.scroll <= fits.win, JSON.stringify(fits));
  await click('#chat-poll');
  await waitFor(cdp, `!!document.querySelector('${D}')`, { label: 'the dialog on a phone' });
  const box = await cdp.evaluate(`const r = document.querySelector('${D}').getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), win: innerWidth };`);
  check('and so does the dialog', box.left >= 0 && box.right <= box.win, JSON.stringify(box));
  await click(`${D} .ask-buttons button`, 0);
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
