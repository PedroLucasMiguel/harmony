// The Security page of Settings and "forgot password", as a person sees them:
// a real app window against a real server.
//
// Ana changes her password, writes three questions, signs out, and gets back in
// by answering them -- typed with other capitals, accents and spaces than she
// wrote them with. Bob never wrote any, and is told so.
//
//   MEDIAMTX_BIN=/path/to/mediamtx node client/test/security-ui.mjs

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const serverEntry = resolve(repoRoot, 'server', 'src', 'index.js');

const MEDIAMTX_BIN = process.env.MEDIAMTX_BIN ?? join(homedir(), 'mediamtx', 'mediamtx');
if (!existsSync(MEDIAMTX_BIN)) {
  console.log(`No MediaMTX at ${MEDIAMTX_BIN}. Set MEDIAMTX_BIN.`);
  process.exit(0);
}

const HARMONY_PORT = 18301;
const MTX_API_PORT = 9997 - 141;
const MTX_WEBRTC_PORT = 8889 - 141;
const MTX_ICE_PORT = 8189 - 141;
const PORT_ALICE = 9561;
const PORT_BOB = 9562;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-sec-'));
const { check, summary } = reporter();
const procs = [];
let mtxLog = '';
let serverLog = '';
let ownerKey = null;

process.on('exit', () => {
  for (const p of procs) {
    try { p.kill(); } catch { /* already gone */ }
  }
});
process.on('SIGINT', () => process.exit(130));

async function startMediaMtx() {
  const dir = mkdtempSync(join(tmpdir(), 'harmony-sec-mtx-'));
  const config = join(dir, 'mediamtx.yml');
  copyFileSync(join(repoRoot, 'server', 'mediamtx.yml'), config);
  const p = spawn(MEDIAMTX_BIN, [config], {
    env: {
      ...process.env,
      MTX_AUTHHTTPADDRESS: `${BASE}/mediamtx/auth`,
      MTX_WEBRTCADDRESS: `:${MTX_WEBRTC_PORT}`,
      MTX_APIADDRESS: `127.0.0.1:${MTX_API_PORT}`,
      MTX_WEBRTCLOCALUDPADDRESS: `:${MTX_ICE_PORT}`,
      MTX_WEBRTCLOCALTCPADDRESS: `:${MTX_ICE_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(p);
  p.stdout.on('data', (b) => (mtxLog += b.toString()));
  p.stderr.on('data', (b) => (mtxLog += b.toString()));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (new RegExp(`\\[WebRTC\\].*:${MTX_WEBRTC_PORT}`).test(mtxLog)) return;
    await sleep(200);
  }
  throw new Error('MediaMTX did not start');
}

function startServer() {
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        HARMONY_PORT: String(HARMONY_PORT),
        HARMONY_HOST: '127.0.0.1',
        HARMONY_DATA_DIR: dataDir,
        HARMONY_MEDIAMTX_API: `http://127.0.0.1:${MTX_API_PORT}`,
        HARMONY_SIGNALING_URL: `http://127.0.0.1:${MTX_WEBRTC_PORT}`,
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

const register = async (nickname, extra = {}) => {
  const res = await fetch(`${BASE}/api/accounts/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, password: 'hunter22', ...extra }),
  });
  if (!res.ok) throw new Error(`register ${nickname}: ${res.status}`);
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
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-sec-profile-')),
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

/** Wait for a condition evaluated in the page, polled, returning what it returned. */
async function until(page, expression, { timeoutMs = 20_000, label = expression } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await page.evaluate(`return (${expression})`).catch(() => undefined);
    if (last) return last;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

/** DM_SHOTS=/some/dir saves a picture of each step, for looking at rather than asserting. */
async function shot(page, name) {
  const dir = process.env.DM_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(dir, `${name}.png`), Buffer.from(data, 'base64'));
}

const text = (id) => `document.getElementById('${id}')?.textContent ?? ''`;


const fill = (id, value) => `{ const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); }`;

/** The app's one-question dialog: what it says, and then answer it. */
const askShows = (page, label) => until(page, "document.getElementById('ask').open && document.getElementById('ask-title').textContent", { label });
const askText = (page) => page.evaluate("return { title: document.getElementById('ask-title').textContent, text: document.getElementById('ask-text').textContent, fields: [...document.querySelectorAll('#ask-fields input')].map((i) => i.name) }");
async function answerAsk(page, values = {}) {
  for (const [name, value] of Object.entries(values)) {
    await page.evaluate(`{ const i = document.querySelector('#ask-fields input[name=${JSON.stringify(name)}]'); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); }`);
  }
  await page.evaluate("document.getElementById('ask-ok').click(); return true;");
  await sleep(500);
}
const askClosed = (page) => until(page, "!document.getElementById('ask').open", { label: 'the dialog closing' });

async function run() {
  console.log('Starting MediaMTX, the server and a client…\n');
  await startMediaMtx();
  await startServer();
  await register('ana', { ownerKey });
  await register('bob');
  const ana = await signIn(PORT_ALICE, 'ana');
  await ana.send('Runtime.enable');
  ana.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
    console.log('  [exception]', (d.exception?.description ?? d.text).split('\n').slice(0, 3).join(' / ').slice(0, 300));
  });

  const openSecurity = async () => {
    await ana.evaluate("document.getElementById('voice-config').click(); return true;");
    await until(ana, "document.getElementById('devices').open");
    await ana.evaluate("document.querySelector('.settings-tab[data-tab=security]').click(); return true;");
    await until(ana, "!document.querySelector('.settings-page[data-page=security]').hidden", { label: 'the Security page' });
    await sleep(500);
  };
  await openSecurity();
  const tab = await ana.evaluate("return document.querySelector('.settings-tab[data-tab=security]').textContent.trim()");
  check('Settings has a Security tab', /security/i.test(tab), tab);
  check('with no recovery set up it says so', /not set up/i.test(await ana.evaluate('return ' + text('sec-rec-status'))), await ana.evaluate('return ' + text('sec-rec-status')));

  // --- changing the password ---------------------------------------------------------------------------------------------
  await ana.evaluate(`${fill('sec-current', 'wrong-one')} ${fill('sec-new', 'second-pass')} ${fill('sec-confirm', 'second-pass')}
    document.getElementById('sec-change').click(); return true;`);
  await until(ana, "document.getElementById('sec-change-note').textContent", { label: 'an answer' });
  check('a wrong current password is refused', /wrong/i.test(await ana.evaluate('return ' + text('sec-change-note'))), await ana.evaluate('return ' + text('sec-change-note')));
  await ana.evaluate(`${fill('sec-current', 'hunter22')} ${fill('sec-new', 'second-pass')} ${fill('sec-confirm', 'different')}
    document.getElementById('sec-change').click(); return true;`);
  await sleep(400);
  check('two new passwords that differ are refused before asking the server', /not the same/i.test(await ana.evaluate('return ' + text('sec-change-note'))), await ana.evaluate('return ' + text('sec-change-note')));
  await ana.evaluate(`${fill('sec-current', 'hunter22')} ${fill('sec-new', 'second-pass')} ${fill('sec-confirm', 'second-pass')}
    document.getElementById('sec-change').click(); return true;`);
  await until(ana, "/changed/i.test(document.getElementById('sec-change-note').textContent)", { label: 'the password changing' });
  check('the right one changes it', true, '');
  const stillIn = await ana.evaluate("return window.harmony.api.me(document.getElementById('server-url').value).then((r) => r.ok === true)");
  check('and this window stays signed in, on the new session', stillIn, String(stillIn));
  check('the boxes are emptied', (await ana.evaluate("return document.getElementById('sec-current').value + document.getElementById('sec-new').value")) === '', '');
  const login = await fetch(`${BASE}/api/accounts/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: 'ana', password: 'second-pass' }) });
  check('the server takes the new password', login.status === 200, String(login.status));

  // --- the three questions ----------------------------------------------------------------------------------------------------
  const fillQuestions = (qs, as, current) => ana.evaluate(`
    ${qs.map((q, i) => fill(`sec-q${i + 1}`, q)).join('\n')}
    ${as.map((a, i) => fill(`sec-a${i + 1}`, a)).join('\n')}
    ${fill('sec-rec-current', current)}
    document.getElementById('sec-rec-save').click(); return true;`);
  const QS = ['What city were you born in?', 'What was your first pet called?', 'Which street did you grow up on?'];
  await fillQuestions(QS, ['São Paulo', 'Rex', 'Rua das Flores'], '');
  await sleep(500);
  check('saving needs the current password', /current password/i.test(await ana.evaluate('return ' + text('sec-rec-note'))), await ana.evaluate('return ' + text('sec-rec-note')));
  await fillQuestions([QS[0], QS[0], QS[2]], ['São Paulo', 'Rex', 'Rua das Flores'], 'second-pass');
  await until(ana, "document.getElementById('sec-rec-note').textContent", { label: 'an answer' });
  check('the same question twice is refused, in words', /different/i.test(await ana.evaluate('return ' + text('sec-rec-note'))), await ana.evaluate('return ' + text('sec-rec-note')));
  await fillQuestions(QS, ['São Paulo', 'Rex', 'Rua das Flores'], 'second-pass');
  await until(ana, "/saved/i.test(document.getElementById('sec-rec-note').textContent)", { label: 'the questions saving' });
  const after = await ana.evaluate("return { status: document.getElementById('sec-rec-status').textContent, q: [1,2,3].map((n) => document.getElementById('sec-q' + n).value), a: [1,2,3].map((n) => document.getElementById('sec-a' + n).value), remove: !document.getElementById('sec-rec-clear').hidden }");
  check('saved: it says recovery is set up', /is set up/i.test(after.status), after.status);
  check('the questions stay on the page and the answers do not', after.q.join('|') === QS.join('|') && after.a.every((v) => v === ''), JSON.stringify(after));
  check('and there is now a way to remove it', after.remove, '');
  await shot(ana, 'security-page');
  await ana.evaluate("document.getElementById('devices').close(); return true;");

  // --- signing out and forgetting ----------------------------------------------------------------------------------------------------
  await ana.evaluate("document.getElementById('channels-signout').click(); return true;");
  await until(ana, "document.querySelector('.view[data-active]')?.id === 'view-connect'", { label: 'the sign-in screen' });
  await sleep(1200);
  const link = await ana.evaluate("const b = document.getElementById('forgot-password'); const r = b.getBoundingClientRect(); return { shown: !b.closest('#forgot-row').hidden && r.width > 0, text: b.textContent }");
  check('the sign-in screen offers "forgot password"', link.shown && /forgot/i.test(link.text), JSON.stringify(link));
  await shot(ana, 'sign-in');

  await ana.evaluate(`${fill('username', 'ana')} document.getElementById('forgot-password').click(); return true;`);
  await askShows(ana, 'which account');
  let dialog = await askText(ana);
  check('it asks which account, with what was typed already in', dialog.fields.includes('nickname'), JSON.stringify(dialog));
  await answerAsk(ana, { nickname: 'ana' });
  await until(ana, "/Question 1 of 3/.test(document.getElementById('ask-title').textContent)", { label: 'the first question' });
  dialog = await askText(ana);
  check('then the first question, on its own', dialog.text === QS[0] && dialog.fields.join() === 'answer', JSON.stringify(dialog));
  await answerAsk(ana, { answer: 'sao paulo' });
  await until(ana, "/Question 2 of 3/.test(document.getElementById('ask-title').textContent)", { label: 'the second question' });
  dialog = await askText(ana);
  check('then the second', dialog.text === QS[1], JSON.stringify(dialog));
  await answerAsk(ana, { answer: 'REX!' });
  await until(ana, "/Question 3 of 3/.test(document.getElementById('ask-title').textContent)", { label: 'the third question' });
  await answerAsk(ana, { answer: 'Wrong street' });
  await until(ana, "/wrong/i.test(document.getElementById('ask-text').textContent)", { label: 'the refusal' });
  dialog = await askText(ana);
  check('a wrong answer is refused without saying which', /one or more answers are wrong/i.test(dialog.text) && !/street|city|pet/i.test(dialog.text), JSON.stringify(dialog));
  await shot(ana, 'wrong-answers');
  await answerAsk(ana, {});
  await until(ana, "/Question 1 of 3/.test(document.getElementById('ask-title').textContent)", { label: 'starting again' });
  check('and it starts again from the first question', true, '');
  await answerAsk(ana, { answer: '  SÃO   paulo ' });
  await until(ana, "/Question 2 of 3/.test(document.getElementById('ask-title').textContent)", { label: 'the second question again' });
  await answerAsk(ana, { answer: 'rex' });
  await until(ana, "/Question 3 of 3/.test(document.getElementById('ask-title').textContent)", { label: 'the third question again' });
  await answerAsk(ana, { answer: 'rua  das FLÔRES' });
  await until(ana, "document.querySelector('#ask-fields input[name=password]')", { label: 'the new password' });
  dialog = await askText(ana);
  check('answered with other capitals, accents and spaces, it is right: a new password is asked for', dialog.fields.join() === 'password,confirm', JSON.stringify(dialog));
  await shot(ana, 'new-password');
  await answerAsk(ana, { password: 'abc', confirm: 'abc' });
  await until(ana, "/at least 6/i.test(document.getElementById('ask-text').textContent)", { label: 'the short password refused' });
  check('a short password is refused and asked for again', true, '');
  await answerAsk(ana, { password: 'recovered-pass', confirm: 'recovered-pass' });
  await until(ana, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'being signed in', timeoutMs: 40_000 });
  check('with a new password chosen, she is signed in', true, '');
  const old = await fetch(`${BASE}/api/accounts/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: 'ana', password: 'second-pass' }) });
  const fresh = await fetch(`${BASE}/api/accounts/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: 'ana', password: 'recovered-pass' }) });
  check('the new password works and the old one does not', fresh.status === 200 && old.status === 401, `${fresh.status} ${old.status}`);

  // --- an account that never wrote any -----------------------------------------------------------------------------------------------------
  await ana.evaluate("document.getElementById('channels-signout').click(); return true;");
  await until(ana, "document.querySelector('.view[data-active]')?.id === 'view-connect'", { label: 'the sign-in screen again' });
  await sleep(1200);
  await ana.evaluate(`${fill('username', 'bob')} document.getElementById('forgot-password').click(); return true;`);
  await askShows(ana, 'which account');
  await answerAsk(ana, { nickname: 'bob' });
  await until(ana, "/not possible/i.test(document.getElementById('ask-text').textContent)", { label: 'the message' });
  dialog = await askText(ana);
  check('an account with no questions is told it cannot be recovered', /not possible to recover the password for "bob"/i.test(dialog.text), JSON.stringify(dialog));
  await shot(ana, 'no-recovery');
  await answerAsk(ana, {});
  await askClosed(ana);
  check('and nothing else is asked', true, '');
}

run()
  .catch((err) => {
    console.error(err);
    console.error(serverLog.split('\n').slice(-10).join('\n'));
    process.exitCode = 1;
  })
  .finally(() => {
    const failed = summary();
    setTimeout(() => process.exit(process.exitCode ?? (failed ? 1 : 0)), 200);
  });
