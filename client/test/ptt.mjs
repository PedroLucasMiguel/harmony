// Hotkeys for the camera, and push to talk.
//
// Pedro joins a voice room with a steady tone for a microphone; Ana, in the same
// room, measures what she actually receives from him while he sets push to talk
// up in Settings and holds and lets go of the key with real key events. The
// global key hook is switched off for tests (HARMONY_NO_KEY_HOOK), so this is the
// in-window path, which shares everything but where the key is watched.
//
//   MEDIAMTX_BIN=/path/to/mediamtx node client/test/ptt.mjs

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
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

const HARMONY_PORT = 18240;
const MTX_API_PORT = 9997 - 90;
const MTX_WEBRTC_PORT = 8889 - 90;
const MTX_ICE_PORT = 8189 - 90;
const PORT_PEDRO = 9533;
const PORT_ANA = 9534;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-pt-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'harmony-pt-mtx-'));
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
  md.enumerateDevices = async () => [
    { kind: 'audioinput', deviceId: 'default', label: 'Microphone', groupId: 'g1' },
    { kind: 'videoinput', deviceId: 'camera', label: 'Camera', groupId: 'g2' },
  ].map((d) => ({ ...d, toJSON: () => d }));
  md.getUserMedia = async (c = {}) => {
    const tracks = [];
    if (c.audio) {
      const ctx = new AudioContext(); const out = ctx.createMediaStreamDestination();
      const tone = ctx.createOscillator(); tone.frequency.value = 220;
      const gain = ctx.createGain(); gain.gain.value = 0.05;
      tone.connect(gain); gain.connect(out); tone.start();
      tracks.push(...out.stream.getAudioTracks());
    }
    if (c.video) {
      const feed = document.createElement('canvas'); feed.width = 320; feed.height = 180;
      const g = feed.getContext('2d'); let n = 0;
      setInterval(() => { n += 1; g.fillStyle = '#243055'; g.fillRect(0, 0, 320, 180); g.fillStyle = '#7aa2ff'; g.fillRect((n * 9) % 300, 0, 20, 180); }, 100);
      tracks.push(feed.captureStream(10).getVideoTracks()[0]);
    }
    return new MediaStream(tracks);
  };
  return true;`;

const setInput = (id, value) => `{
  const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
  i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
}`;

async function signIn(port, nickname) {
  const app = launchApp({
    port,
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-pt-profile-')),
    extraArgs: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  procs.push(app);
  const page = await attach(await findPage(port));
  await sleep(1500);
  await page.evaluate(STUBS);
  await page.evaluate(`${setInput('server-url', BASE)} return true;`);
  await sleep(1500);
  await page.evaluate(`${setInput('username', nickname)} ${setInput('account-password', 'hunter22')}
    document.getElementById('continue').click(); return true;`);
  await waitFor(page, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: `${nickname} signing in` });
  await sleep(600);
  return page;
}

const joinVoice = async (page, label) => {
  await page.evaluate(`
    [...document.querySelectorAll('#channel-items li.channel-row')]
      .find((li) => li.querySelector('.channel-name')?.textContent === 'voice').click(); return true;`);
  await waitFor(page, "!document.getElementById('voice-active').hidden && document.querySelectorAll('#voice-roster li').length >= 1", {
    label, timeoutMs: 40_000,
  });
};

/** Real key events, as the keyboard sends them. */
const VK = { KeyV: 86, KeyC: 67, ControlLeft: 17, ShiftLeft: 16, Space: 32 };
const keyOf = (code) => (code.startsWith('Key') ? code.slice(3).toLowerCase() : code === 'Space' ? ' ' : code);
const key = (page, type, code, modifiers = 0) => page.send('Input.dispatchKeyEvent', {
  type: type === 'down' ? 'rawKeyDown' : 'keyUp', code, key: keyOf(code), modifiers, windowsVirtualKeyCode: VK[code],
});
const hold = async (page, code, modifiers = 0) => key(page, 'down', code, modifiers);
const release = async (page, code, modifiers = 0) => key(page, 'up', code, modifiers);

async function run() {
  console.log('Starting MediaMTX, the server and two clients…\n');
  await startMediaMtx();
  await startServer();
  await register('pedro', { ownerKey });
  await register('ana');
  const ana = await signIn(PORT_ANA, 'ana');
  const pedro = await signIn(PORT_PEDRO, 'pedro');
  for (const [name, page] of [['ana', ana], ['pedro', pedro]]) {
    await page.send('Runtime.enable');
    page.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
      console.log(`  [${name} exception]`, (d.exception?.description ?? d.text).split('\n').slice(0, 3).join(' / ').slice(0, 300));
    });
  }
  await joinVoice(ana, 'Ana joining the room');
  await joinVoice(pedro, 'Pedro joining the room');
  await sleep(2500);

  /** What Ana hears of Pedro, averaged over a second and a half. */
  const heard = async (settle = 700) => {
    await sleep(settle);
    return ana.evaluate(`
      let sum = 0, n = 0;
      for (let i = 0; i < 15; i++) {
        const sub = window.__harmony().voice.subs.find((s) => s.tracks > 0);
        if (sub) { sum += sub.level; n += 1; }
        await new Promise((r) => setTimeout(r, 100));
      }
      return n ? sum / n : -1;`);
  };
  const open = (tab) => pedro.evaluate(`
    const d = document.getElementById('devices');
    if (!d.open) document.getElementById('voice-config').click();
    document.querySelector('.settings-tab[data-tab="${tab}"]').click(); return true;`);
  const status = () => pedro.evaluate("return document.getElementById('self-status').textContent");
  const settings = () => pedro.evaluate("const s = await harmony.settings.get(); const d = s.data ?? s; return { on: d.pushToTalk, key: d.pushToTalkKey, cam: d.hotkeys?.camera ?? '' }");
  /** Record a key in the recorder dialog the way a person would. */
  const record = async (code, modifiers = 0) => {
    await sleep(300);
    await hold(pedro, code, modifiers);
    await release(pedro, code, modifiers);
    await sleep(900);
  };

  // --- the camera hotkey -------------------------------------------------------------------------------
  await open('hotkeys');
  const rows = await pedro.evaluate("return [...document.querySelectorAll('#hotkey-list .hotkey-name')].map((n) => n.textContent)");
  check('Hotkeys lists turning the camera on and off', rows.includes('Turn camera on / off'), rows.join(' | '));
  await pedro.evaluate(`[...document.querySelectorAll('#hotkey-list .hotkey-row')]
    .find((r) => r.textContent.includes('Turn camera')).querySelector('.hotkey-key').click(); return true;`);
  await record('KeyC', 2 | 8);
  check('a combination can be set for it (Ctrl + Shift + C)', (await settings()).cam === 'Ctrl+Shift+C', JSON.stringify(await settings()));
  check('and it is registered', await pedro.evaluate(`
    const row = [...document.querySelectorAll('#hotkey-list .hotkey-row')].find((r) => r.textContent.includes('Turn camera'));
    return row.querySelector('.hotkey-key').textContent === 'Ctrl + Shift + C' && !row.querySelector('.hotkey-problem');`));

  // --- off by default ---------------------------------------------------------------------------------------
  await open('voice');
  const initial = await pedro.evaluate(`return {
    on: document.getElementById('ptt-enabled').checked,
    optionsHidden: document.getElementById('ptt-options').hidden }`);
  check('push to talk is off by default', initial.on === false && (await settings()).on === false, JSON.stringify(initial));
  check('and its key row is not shown until it is switched on', initial.optionsHidden);
  const base = await heard();
  check('Ana hears Pedro\'s microphone as usual', base > 0.005, base.toFixed(4));

  // --- on, with no key yet ---------------------------------------------------------------------------------------
  await pedro.evaluate("const i = document.getElementById('ptt-enabled'); i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); return true;");
  await sleep(600);
  check('switching it on shows the key row', await pedro.evaluate("return !document.getElementById('ptt-options').hidden"));
  check('with a note to choose a key', /Choose a key/.test(await pedro.evaluate("return document.getElementById('ptt-scope').textContent")));
  check('with no key chosen the microphone is not silenced', (await heard()) > 0.005);

  // --- a bare key ---------------------------------------------------------------------------------------------------
  await pedro.evaluate("document.getElementById('ptt-key').click(); return true;");
  await record('KeyV');
  check('any key will do, a plain V included', (await settings()).key === 'V', JSON.stringify(await settings()));
  const scope = await pedro.evaluate("return document.getElementById('ptt-scope').textContent");
  check('and the page says it works while Harmony is in front', /in front/.test(scope), scope);
  await pedro.evaluate("document.getElementById('devices').close(); document.activeElement?.blur(); return true;");
  const silent = await heard(1200);
  check('with a key set the microphone is silent until it is held', silent < base * 0.1, `${base.toFixed(4)} -> ${silent.toFixed(4)}`);
  check('and the strip says so', (await status()) === 'Push to talk', await status());

  await hold(pedro, 'KeyV');
  const talking = await heard(500);
  check('holding V opens it', talking > base * 0.6, `${base.toFixed(4)} -> ${talking.toFixed(4)}`);
  check('and the strip says Talking', (await status()) === 'Talking', await status());
  await release(pedro, 'KeyV');
  const closed = await heard(900);
  check('letting go closes it again', closed < base * 0.1, `${base.toFixed(4)} -> ${closed.toFixed(4)}`);
  check('and the strip goes back', (await status()) === 'Push to talk', await status());

  // --- mute still wins ----------------------------------------------------------------------------------------------
  await pedro.evaluate("document.getElementById('voice-mute').click(); return true;");
  await hold(pedro, 'KeyV');
  const mutedHeld = await heard(500);
  await release(pedro, 'KeyV');
  check('muted, holding the key opens nothing', mutedHeld < base * 0.1, `${base.toFixed(4)} -> ${mutedHeld.toFixed(4)}`);
  check('and the strip says Muted', (await status()) === 'Muted', await status());
  await pedro.evaluate("document.getElementById('voice-mute').click(); return true;");
  await sleep(400);

  // --- typing is not talking ------------------------------------------------------------------------------------------------
  await pedro.evaluate("document.getElementById('devices').showModal(); document.querySelector('.settings-tab[data-tab=\"profile\"]').click(); document.getElementById('profile-name').focus(); return true;");
  await hold(pedro, 'KeyV');
  const typing = await heard(500);
  await release(pedro, 'KeyV');
  check('a V typed into a text box does not open the microphone', typing < base * 0.1, `${base.toFixed(4)} -> ${typing.toFixed(4)}`);
  await pedro.evaluate("document.getElementById('devices').close(); document.activeElement?.blur(); return true;");

  // --- a combination ------------------------------------------------------------------------------------------------------------
  await open('voice');
  await pedro.evaluate("document.getElementById('ptt-key').click(); return true;");
  await record('KeyV', 2 | 8);
  check('a combination can be the key (Ctrl + Shift + V)', (await settings()).key === 'Ctrl+Shift+V', JSON.stringify(await settings()));
  await pedro.evaluate("document.getElementById('devices').close(); document.activeElement?.blur(); return true;");
  await hold(pedro, 'KeyV');
  check('the bare key no longer does anything', (await heard(500)) < base * 0.1);
  await release(pedro, 'KeyV');
  await hold(pedro, 'KeyV', 2);
  check('nor does Ctrl + V alone', (await heard(500)) < base * 0.1);
  await release(pedro, 'KeyV', 2);
  await hold(pedro, 'KeyV', 2 | 8);
  const combo = await heard(500);
  check('the whole combination opens it', combo > base * 0.6, `${base.toFixed(4)} -> ${combo.toFixed(4)}`);
  await release(pedro, 'ControlLeft', 8);
  const letGoOfCtrl = await heard(900);
  check('letting go of Ctrl first closes it too', letGoOfCtrl < base * 0.1, `${base.toFixed(4)} -> ${letGoOfCtrl.toFixed(4)}`);
  await release(pedro, 'KeyV', 0);

  // --- a new call starts silent -----------------------------------------------------------------------------------------------------
  await pedro.evaluate("document.getElementById('voice-leave').click(); return true;");
  await waitFor(pedro, "document.getElementById('voice-active').hidden", { label: 'Pedro leaving' });
  await sleep(1000);
  await joinVoice(pedro, 'Pedro rejoining');
  const rejoined = await heard(2000);
  check('a call joined with push to talk on starts silent', rejoined < base * 0.1, `${base.toFixed(4)} -> ${rejoined.toFixed(4)}`);
  await hold(pedro, 'KeyV', 2 | 8);
  check('and opens when the key is held', (await heard(500)) > base * 0.6);
  await release(pedro, 'KeyV', 2 | 8);

  // --- a button of the mouse ---------------------------------------------------------------------------------------------------------
  const click = (button, type) => pedro.send('Input.dispatchMouseEvent', { type, x: 300, y: 300, button, buttons: type === 'mousePressed' ? 8 : 0, clickCount: 1 });
  await open('voice');
  await pedro.evaluate("document.getElementById('ptt-key').click(); return true;");
  await sleep(400);
  await click('back', 'mousePressed');
  await click('back', 'mouseReleased');
  await sleep(900);
  check('the button under the thumb can be the key (Mouse back)', (await settings()).key === 'Mouse4', JSON.stringify(await settings()));
  check('the key shows as a button, not a code', /Mouse back/.test(await pedro.evaluate("return document.getElementById('ptt-key').textContent")), await pedro.evaluate("return document.getElementById('ptt-key').textContent"));
  await pedro.evaluate("document.getElementById('devices').close(); document.activeElement?.blur(); return true;");
  check('with it set the microphone is silent', (await heard(900)) < base * 0.1);
  await click('back', 'mousePressed');
  const mouseOpen = await heard(500);
  check('holding the button opens it', mouseOpen > base * 0.6, `${base.toFixed(4)} -> ${mouseOpen.toFixed(4)}`);
  await click('back', 'mouseReleased');
  const mouseClosed = await heard(900);
  check('and letting go closes it', mouseClosed < base * 0.1, `${base.toFixed(4)} -> ${mouseClosed.toFixed(4)}`);

  // --- keys of the numpad -----------------------------------------------------------------------------------------------------------
  await open('voice');
  await pedro.evaluate("document.getElementById('ptt-key').click(); return true;");
  await record('Numpad7');
  check('a numpad key can be the key (Num 7)', (await settings()).key === 'num7', JSON.stringify(await settings()));
  await pedro.evaluate("document.getElementById('devices').close(); document.activeElement?.blur(); return true;");
  await hold(pedro, 'Numpad7');
  const numpad = await heard(500);
  check('and holding it opens the microphone', numpad > base * 0.6, `${base.toFixed(4)} -> ${numpad.toFixed(4)}`);
  await release(pedro, 'Numpad7');
  await heard(900);
  await open('hotkeys');
  await pedro.evaluate(`[...document.querySelectorAll('#hotkey-list .hotkey-row')]
    .find((r) => r.textContent.includes('Turn camera')).querySelector('.hotkey-key').click(); return true;`);
  await record('NumpadEnter');
  check('the numpad\'s own Enter is a hotkey with no modifier', (await settings()).cam === 'numenter', JSON.stringify(await settings()));
  await pedro.evaluate(`[...document.querySelectorAll('#hotkey-list .hotkey-row')]
    .find((r) => r.textContent.includes('Turn camera')).querySelector('.hotkey-key').click(); return true;`);
  await sleep(400);
  await click('forward', 'mousePressed');
  await click('forward', 'mouseReleased');
  await sleep(900);
  check('and so is a button of the mouse (Mouse forward)', (await settings()).cam === 'Mouse5', JSON.stringify(await settings()));
  await pedro.evaluate("document.getElementById('devices').close(); return true;");
  await open('voice');
  await pedro.evaluate("document.getElementById('ptt-key').click(); return true;");
  await record('KeyV', 2 | 8);
  await pedro.evaluate("document.getElementById('devices').close(); document.activeElement?.blur(); return true;");

  // --- off again ------------------------------------------------------------------------------------------------------------------------
  await open('voice');
  await pedro.evaluate("const i = document.getElementById('ptt-enabled'); i.checked = false; i.dispatchEvent(new Event('change', { bubbles: true })); document.getElementById('devices').close(); return true;");
  const off = await heard(1200);
  check('switched off, the microphone is open again without any key', off > base * 0.6, `${base.toFixed(4)} -> ${off.toFixed(4)}`);
  check('and the chosen key is remembered', (await settings()).key === 'Ctrl+Shift+V', JSON.stringify(await settings()));
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
