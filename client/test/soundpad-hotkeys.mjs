// The soundpad's emoji, and a hotkey for every clip on Settings > Hotkeys,
// driven through the real client against a real server.
//
//   node client/test/soundpad-hotkeys.mjs
//
// The emoji go in through the API exactly as the app sends them and come back
// from the SERVER before they are checked on screen: a flag, a skin tone, a
// heart with its variation selector and a joined family were each cut to the
// first code point, or dropped altogether.
// MediaMTX is stubbed, as in channels-ui.mjs: nothing here touches media.

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const HARMONY_PORT = 18240;
const FAKE_MTX_PORT = 20140;
const DEBUG_PORT = 9497;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-hk-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-hk-profile-'));
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
const me = async () => (await api('/api/accounts/me')).user;

async function run() {
  await startFakeMediaMtx();
  await startServer();
  token = (await api('/api/accounts/register', { nickname: 'tester', password: 'hunter22', ownerKey })).token;

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
  await set('username', 'tester');
  await set('account-password', 'hunter22');
  await cdp.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'the channels view' });
  await sleep(800);

  // A tiny valid WAV, uploaded once and used by every clip.
  const wav = Buffer.alloc(44 + 800);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + 800, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34); wav.write('data', 36); wav.writeUInt32LE(800, 40); wav.fill(128, 44);
  const upload = await (await fetch(`${BASE}/api/uploads`, {
    method: 'POST', headers: { 'Content-Type': 'audio/wav', Authorization: `Bearer ${token}` }, body: wav,
  })).json();

  const CLIPS = [
    ['Airhorn', '\u{1F4EF}'],
    ['Heart', '❤️'],
    ['Brazil', '\u{1F1E7}\u{1F1F7}'],
    ['Thumbs', '\u{1F44D}\u{1F3FD}'],
    ['Family', '\u{1F468}‍\u{1F469}‍\u{1F467}'],
    ['Keycap', '1️⃣'],
    ['No emoji', ''],
  ];
  for (const [name, emoji] of CLIPS) await api('/api/soundpad', { name, emoji, hash: upload.hash });

  const stored = (await api('/api/soundpad')).clips;
  for (const [name, emoji] of CLIPS) {
    check(`the server keeps the whole emoji of "${name}"`, (stored.find((c) => c.name === name)?.emoji ?? '') === emoji,
      JSON.stringify(stored.find((c) => c.name === name)?.emoji));
  }
  await api(`/api/soundpad/${stored[0].id}/rename`, { name: 'Airhorn', emoji: '\u{1F468}‍\u{1F469}‍\u{1F467}' });
  check('and so does renaming one', (await api('/api/soundpad')).clips[0].emoji === '\u{1F468}‍\u{1F469}‍\u{1F467}');
  await api(`/api/soundpad/${stored[0].id}/rename`, { name: 'Airhorn', emoji: '\u{1F4EF}' });
  await sleep(1200);

  const text = (id) => cdp.evaluate(`return document.getElementById(${JSON.stringify(id)}).textContent`);
  const click = (id) => cdp.evaluate(`document.getElementById(${JSON.stringify(id)}).click(); return true;`);

  // --- the pad ------------------------------------------------------------------------------------
  // The button is for use in a call and is disabled outside one; a call is not
  // what this test is about, so it is switched on the way a call would.
  await cdp.evaluate("document.getElementById('voice-soundboard').disabled = false; return true;");
  await click('voice-soundboard');
  await sleep(600);
  const pad = await cdp.evaluate(`return [...document.querySelectorAll('.clip-cell')].map((c) => [c.querySelector('.clip-name').textContent, c.querySelector('.clip-emoji')?.textContent ?? ''])`);
  for (const [name, emoji] of CLIPS) {
    check(`the pad draws "${name}" with its emoji`, pad.find(([n]) => n === name)?.[1] === emoji, JSON.stringify(pad.find(([n]) => n === name)));
  }
  await click('voice-soundboard');

  // --- the Hotkeys tab -----------------------------------------------------------------------------
  await click('voice-config');
  await cdp.evaluate("document.querySelector('.settings-tab[data-tab=\"hotkeys\"]').click(); return true;");
  await sleep(400);
  const rows = () => cdp.evaluate(`
    return [...document.querySelectorAll('#hotkey-list .hotkey-row')].map((r) => ({
      name: r.querySelector('.hotkey-name').textContent,
      emoji: r.querySelector('.hotkey-emoji')?.textContent ?? '',
      key: r.querySelector('.hotkey-key').textContent,
      clearShown: !r.querySelector('.hotkey-clear').hidden,
    }))`);
  let list = await rows();
  check('the page still has mute and deafen', list.length >= 2 && /Mute/.test(list[0].name) && /Deafen/.test(list[1].name), list.slice(0, 2).map((r) => r.name).join(' | '));
  check('and a heading for the clips', (await cdp.evaluate("return document.querySelector('#hotkey-list .hotkey-heading')?.textContent")) === 'Soundpad clips');
  check('every clip on the server has a row', CLIPS.every(([name]) => list.some((r) => r.name.endsWith(name))), list.map((r) => r.name).join(' | '));
  check('each with its emoji', CLIPS.every(([name, emoji]) => list.find((r) => r.name.endsWith(name))?.emoji === emoji),
    JSON.stringify(list.filter((r) => r.emoji).map((r) => r.emoji)));
  check('all of them unset to begin with', list.slice(2).every((r) => r.key === 'Not set' && !r.clearShown));

  // Bind one the way a person does: press the button, then the combination.
  const press = () => cdp.evaluate(`
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'F9', key: 'F9', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    return true;`);
  const bind = async (name) => {
    await cdp.evaluate(`
      const row = [...document.querySelectorAll('#hotkey-list .hotkey-row')].find((r) => r.querySelector('.hotkey-name').textContent.endsWith(${JSON.stringify(name)}));
      row.querySelector('.hotkey-key').click(); return true;`);
    await waitFor(cdp, "document.getElementById('hotkey-recorder').open", { label: 'the recorder' });
    await press();
    await waitFor(cdp, "!document.getElementById('hotkey-recorder').open", { label: 'the recorder to close' });
    await sleep(500);
  };
  await bind('Brazil');
  list = await rows();
  const brazil = list.find((r) => r.name.endsWith('Brazil'));
  check('pressing a combination binds it to that clip', /F9/.test(brazil.key) && brazil.clearShown, brazil.key);
  const saved = await cdp.evaluate("const s = await harmony.settings.get(); const d = s.data ?? s; return JSON.stringify(d.clipHotkeys)");
  const brazilId = stored.find((c) => c.name === 'Brazil').id;
  check('it is kept in the settings under that clip', saved.includes(`"${brazilId}"`), saved);

  // One combination does one thing: binding it to another clip moves it.
  await bind('Heart');
  list = await rows();
  check('binding the same keys to another clip moves them',
    /F9/.test(list.find((r) => r.name.endsWith('Heart')).key) && list.find((r) => r.name.endsWith('Brazil')).key === 'Not set');

  // The pad shows what the page set.
  await click('devices-close');
  await cdp.evaluate("document.getElementById('voice-soundboard').disabled = false; return true;");
  await click('voice-soundboard');
  await sleep(500);
  const chip = await cdp.evaluate(`return [...document.querySelectorAll('.clip-cell')].find((c) => c.querySelector('.clip-name').textContent === 'Heart')?.querySelector('.clip-key')?.textContent ?? null`);
  check('and the pad shows the same combination on the clip', /F9/.test(chip ?? ''), String(chip));
  await click('voice-soundboard');

  // Clear.
  await click('voice-config');
  await cdp.evaluate("document.querySelector('.settings-tab[data-tab=\"hotkeys\"]').click(); return true;");
  await cdp.evaluate(`
    const row = [...document.querySelectorAll('#hotkey-list .hotkey-row')].find((r) => r.querySelector('.hotkey-name').textContent.endsWith('Heart'));
    row.querySelector('.hotkey-clear').click(); return true;`);
  await sleep(600);
  list = await rows();
  check('Clear takes the combination off', list.find((r) => r.name.endsWith('Heart')).key === 'Not set');
  const after = await cdp.evaluate("const s = await harmony.settings.get(); const d = s.data ?? s; return JSON.stringify(d.clipHotkeys)");
  check('and out of the settings', !after.includes(`"${stored.find((c) => c.name === 'Heart').id}"`), after);

  // A clip added while Settings is open shows up without reopening it.
  await api('/api/soundpad', { name: 'Late arrival', emoji: '\u{1F389}', hash: upload.hash });
  await waitFor(cdp, "[...document.querySelectorAll('#hotkey-list .hotkey-name')].some((n) => n.textContent.endsWith('Late arrival'))", { label: 'the new clip in the list', timeoutMs: 8000 })
    .then(() => check('a clip added while Settings is open appears in the list', true))
    .catch(() => check('a clip added while Settings is open appears in the list', false, 'it did not'));

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
