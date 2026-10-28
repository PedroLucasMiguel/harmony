// Languages: the module, the strings, and the selector in the real app.
//
//   node client/test/i18n.mjs
//
// Three layers, because each catches something the others cannot:
//   1. The source: every key the code or the markup asks for exists in English,
//      and every language file is complete and has its {placeholders} intact.
//      (A missing key shows as the key itself on screen, and only when somebody
//      reaches that screen.)
//   2. The module, with its inputs given: what "pt-PT" resolves to, plurals,
//      filling in {names}, falling back to English.
//   3. The app: a Portuguese system opens in Portuguese, the picker switches
//      language without a restart -- static text and the text JavaScript draws
//      -- and the choice survives a relaunch, beating the system's language.
//
// MediaMTX is stubbed, as in channels-ui.mjs: nothing here touches media.

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

process.emitWarning = () => {};

const here = dirname(fileURLToPath(import.meta.url));
const renderer = resolve(here, '..', 'src', 'renderer');
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');
const { check, summary } = reporter();

// --- 1. the source ---------------------------------------------------------------------------
const { LANGUAGES } = await import(pathToFileURL(join(renderer, 'locales', 'index.js')).href);
const tables = {};
for (const { code } of LANGUAGES) tables[code] = (await import(pathToFileURL(join(renderer, 'locales', `${code}.js`)).href)).default;
const english = tables.en;

const sources = [...readdirSync(renderer), ...readdirSync(join(renderer, 'web')).map((f) => `web/${f}`)]
  // i18n.js itself only mentions keys as examples in its own documentation.
  .filter((f) => f.endsWith('.js') && f !== 'i18n.js');
const asked = new Map();
for (const file of sources) {
  const text = readFileSync(join(renderer, file), 'utf8');
  for (const m of text.matchAll(/\bt\(\s*'([\w.]+)'/g)) asked.set(m[1], file);
}
for (const m of readFileSync(join(renderer, 'index.html'), 'utf8').matchAll(/data-i18n(?:-[\w-]+)?="([\w.]+)"/g)) asked.set(m[1], 'index.html');
// Built from a variable, so not findable above: roles.<role>, devices.<kind>, picker.none_<kind>, comp.* markup, main.*.
const missingInEnglish = [...asked].filter(([key]) => !(key in english));
check('every key the code and the markup ask for is in English', missingInEnglish.length === 0,
  missingInEnglish.slice(0, 5).map(([k, f]) => `${k} (${f})`).join(', ') || `${asked.size} keys`);

const names = (value) => [...new Set((typeof value === 'object' ? Object.values(value) : [value])
  .flatMap((s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1])))].sort().join(',');
for (const { code, name } of LANGUAGES) {
  if (code === 'en') continue;
  const table = tables[code];
  const missing = Object.keys(english).filter((k) => !(k in table));
  const extra = Object.keys(table).filter((k) => !(k in english));
  const badNames = Object.keys(table).filter((k) => k in english && names(table[k]) !== names(english[k]));
  check(`${name} has every string`, missing.length === 0, missing.slice(0, 4).join(', ') || `${Object.keys(table).length} keys`);
  check(`${name} has nothing English does not`, extra.length === 0, extra.slice(0, 4).join(', '));
  check(`${name} keeps every {placeholder}`, badNames.length === 0, badNames.slice(0, 4).join(', '));
  const same = Object.keys(table).filter((k) => typeof table[k] === 'string' && table[k] === english[k] && /[a-z]{4,}/i.test(english[k]) && !/^[\W\d]*$/.test(english[k]));
  check(`${name} translated more than ${Math.round((1 - same.length / Object.keys(table).length) * 100)}% (the rest are names and symbols)`, same.length < Object.keys(table).length * 0.12,
    `${same.length} identical to English: ${same.slice(0, 6).join(', ')}`);
}

// --- 2. the module ---------------------------------------------------------------------------
// It reads document and localStorage only when switching, so give it enough of both.
globalThis.document = { documentElement: {}, querySelectorAll: () => [] };
globalThis.localStorage = { getItem: () => null, setItem() {} };
const i18n = await import(pathToFileURL(join(renderer, 'i18n.js')).href);

check('a system in pt-PT, which is not offered, gets pt-BR', i18n.resolveLanguage('auto', ['pt-PT']) === 'pt-BR');
check('es-MX gets Spanish', i18n.resolveLanguage('auto', ['es-MX', 'en']) === 'es');
check('the first language the system lists that is offered wins', i18n.resolveLanguage('auto', ['fr-FR', 'es', 'pt-BR']) === 'es');
check('a language that is not offered falls back to English', i18n.resolveLanguage('auto', ['ja', 'fr']) === 'en');
check('a chosen language beats the system\'s', i18n.resolveLanguage('pt-BR', ['es']) === 'pt-BR');
check('a chosen language is matched without regard to case', i18n.resolveLanguage('PT-br', []) === 'pt-BR');
check('a code that is not in the list is English', i18n.resolveLanguage('xx', ['es']) === 'en');
check('{names} are filled in', i18n.t('connect.not_answering', { host: 'srv' }).includes('srv'));
check('a name that is not given is left as written', i18n.t('connect.not_answering', {}).includes('{host}'));
check('English picks the singular', i18n.t('channels.mentions', { count: 1 }) === '1 message mentions you', i18n.t('channels.mentions', { count: 1 }));
check('and the plural', i18n.t('channels.mentions', { count: 3 }) === '3 messages mention you', i18n.t('channels.mentions', { count: 3 }));
check('a key nobody wrote shows as itself rather than as nothing', i18n.t('nobody.wrote.this') === 'nobody.wrote.this');
await i18n.setLanguage('es');
check('Spanish is loaded on request', i18n.currentLanguage() === 'es' && i18n.t('app.cancel') !== 'Cancel', i18n.t('app.cancel'));
check('and Spanish plurals are picked', i18n.t('channels.mentions', { count: 1 }) !== i18n.t('channels.mentions', { count: 3 }));
await i18n.setLanguage('en');

// --- 3. the app ---------------------------------------------------------------------------------
const HARMONY_PORT = 18260;
const FAKE_MTX_PORT = 20160;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;
const procs = [];
let fakeMtx = null;
let serverLog = '';
let ownerKey = null;
process.on('exit', () => {
  for (const p of procs) { try { p.kill(); } catch { /* gone */ } }
  try { fakeMtx?.close(); } catch { /* closed */ }
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
      ...process.env, HARMONY_PORT: String(HARMONY_PORT), HARMONY_HOST: '127.0.0.1',
      HARMONY_DATA_DIR: mkdtempSync(join(tmpdir(), 'harmony-i18n-')),
      HARMONY_MEDIAMTX_API: `http://127.0.0.1:${FAKE_MTX_PORT}`, HARMONY_SIGNALING_URL: 'http://127.0.0.1:8889',
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
    if (serverLog.includes('control server on')) { clearTimeout(timer); done(); }
  });
  p.stderr.on('data', (b) => (serverLog += b.toString()));
});

async function run() {
  await startFakeMediaMtx();
  await startServer();
  const reg = await fetch(`${BASE}/api/accounts/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: 'tester', password: 'hunter22', ownerKey }),
  });
  if (!reg.ok) throw new Error(`register: ${reg.status}`);

  const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-i18n-profile-'));
  const open = async (port, lang) => {
    const app = launchApp({ port, userDataDir, extraArgs: [`--lang=${lang}`] });
    procs.push(app);
    const cdp = await attach(await findPage(port));
    await sleep(1500);
    return { app, cdp };
  };
  const text = (cdp, id) => cdp.evaluate(`return document.getElementById(${JSON.stringify(id)})?.textContent?.replace(/\\s+/g, ' ').trim() ?? null`);
  const set = (cdp, id, value) => cdp.evaluate(`
    const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
    i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
    return true;`);

  // A Portuguese system: the app opens in Portuguese without being told to.
  let { app, cdp } = await open(9501, 'pt-BR');
  const pt = tables['pt-BR'];
  check('a Portuguese system opens in Portuguese', (await cdp.evaluate('return document.documentElement.lang')) === 'pt-BR');
  check('its static text is translated', (await text(cdp, 'ask-cancel')) === pt['ask_cancel.cancel'], await text(cdp, 'ask-cancel'));
  check('and so is what a tooltip says', (await cdp.evaluate("return document.getElementById('avatar-button').title")) === pt['channel_dock.change_your_picture']);

  // The login screen has its own picker: somebody who cannot read the screen
  // cannot get as far as Settings to change the language.
  const login = await cdp.evaluate(`
    const s = document.getElementById('login-language');
    return { shown: s.getClientRects().length > 0, value: s.value, options: [...s.options].map((o) => o.value).join() };`);
  check('the login screen has a language picker, on Automatic', login.shown && login.value === 'auto' && login.options === 'auto,en,pt-BR,es', JSON.stringify(login));
  await set(cdp, 'login-language', 'es');
  await sleep(700);
  check('choosing a language there changes the login screen at once',
    (await text(cdp, 'server-continue')) === tables.es['app.continue'] && (await cdp.evaluate('return document.documentElement.lang')) === 'es', await text(cdp, 'server-continue'));
  check('and saves it', (await cdp.evaluate("const s = await harmony.settings.get(); return (s.data ?? s).language")) === 'es');
  await set(cdp, 'login-language', 'auto');
  await sleep(700);
  check('Automatic goes back to the system\'s language', (await text(cdp, 'server-continue')) === pt['app.continue'] && (await cdp.evaluate('return document.documentElement.lang')) === 'pt-BR');
  if (process.env.I18N_SHOT) {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    (await import('node:fs')).writeFileSync(process.env.I18N_SHOT, Buffer.from(data, 'base64'));
  }

  await set(cdp, 'server-url', BASE);
  await sleep(1500);
  await set(cdp, 'username', 'tester');
  await set(cdp, 'account-password', 'hunter22');
  await cdp.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'the channels view' });
  await sleep(1000);
  check('what JavaScript draws is Portuguese too: the member list heading',
    (await cdp.evaluate("return document.querySelector('.member-head')?.textContent")) === pt['members.online'].replace('{count}', '1'),
    await cdp.evaluate("return document.querySelector('.member-head')?.textContent"));

  // The picker.
  await cdp.evaluate("document.getElementById('voice-config').click(); document.querySelector('.settings-tab[data-tab=\"appearance\"]').click(); return true;");
  await sleep(500);
  const options = await cdp.evaluate("return [...document.getElementById('language-select').options].map((o) => [o.value, o.textContent])");
  check('Settings > Appearance offers Automatic and every language, each in its own name',
    options.map(([v]) => v).join() === 'auto,en,pt-BR,es'
    && options.some(([, n]) => n === 'Português (Brasil)') && options.some(([, n]) => n === 'Español'), JSON.stringify(options));
  check('Automatic says which one it is using', options[0][1].includes('Português'), options[0][1]);
  check('and the picker starts on Automatic', (await cdp.evaluate("return document.getElementById('language-select').value")) === 'auto');

  await set(cdp, 'language-select', 'es');
  await sleep(900);
  const es = tables.es;
  check('choosing Spanish changes the open page at once', (await text(cdp, 'ask-cancel')) === es['ask_cancel.cancel'] && (await cdp.evaluate("return document.documentElement.lang")) === 'es');
  check('and the text JavaScript drew', (await cdp.evaluate("return document.querySelector('.member-head')?.textContent")) === es['members.online'].replace('{count}', '1'),
    await cdp.evaluate("return document.querySelector('.member-head')?.textContent"));
  check('and the tab names', (await cdp.evaluate("return document.querySelector('.settings-tab[data-tab=\"profile\"]').textContent.trim()")) === es['settings.profile']);
  const saved = await cdp.evaluate("const s = await harmony.settings.get(); return (s.data ?? s).language");
  check('the choice is saved', saved === 'es', String(saved));
  // The tray menu and the save dialog are drawn by the main process, which is handed its words.
  const handed = await cdp.evaluate("return await harmony.strings.set({ 'main.quit': 'Salir de Harmony', 'main.bogus': 'ignored' })");
  check('the main process accepts the words it is sent for the tray and dialogs', handed === true || handed?.ok === true, JSON.stringify(handed));
  check('a language file is not loaded again for nothing: the page still works', (await cdp.evaluate("return !!document.getElementById('language-select')")) === true);
  app.kill();
  await sleep(1500);

  // Relaunched on a system that says English: the saved choice wins.
  ({ app, cdp } = await open(9502, 'en-US'));
  check('it is still Spanish after a restart, whatever the system says',
    (await cdp.evaluate('return document.documentElement.lang')) === 'es' && (await text(cdp, 'ask-cancel')) === es['ask_cancel.cancel'], await text(cdp, 'ask-cancel'));
  // Not signed in any more after a relaunch (nobody ticked "remember me"): do it again.
  await sleep(2500);
  await set(cdp, 'server-url', BASE);
  await sleep(1500);
  await set(cdp, 'username', 'tester');
  await set(cdp, 'account-password', 'hunter22');
  await cdp.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'signing back in', timeoutMs: 20000 });
  await cdp.evaluate("document.getElementById('voice-config').click(); document.querySelector('.settings-tab[data-tab=\"appearance\"]').click(); return true;");
  await sleep(400);
  await set(cdp, 'language-select', 'auto');
  await sleep(900);
  check('Automatic on an English system is English', (await text(cdp, 'ask-cancel')) === 'Cancel' && (await cdp.evaluate('return document.documentElement.lang')) === 'en', await text(cdp, 'ask-cancel'));
  app.kill();
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
