// Profile customisation, end to end: a name font, a banner and a join sound.
//
// Pedro changes them in Settings > Profile; Ana, a second real client in a
// voice room on a real server and MediaMTX, looks at what SHE sees: Pedro's
// name drawn in his font, his banner behind him in the member list and in the
// voice channel (dimmed, fading out to the left, a GIF kept as a GIF), and --
// the part that has to be heard to be believed, so it is measured -- the join
// sound she plays when he arrives: his own recording instead of the tone, cut
// at ten seconds, and the tone again when she turns that off.
//
//   MEDIAMTX_BIN=/path/to/mediamtx node client/test/profile-style.mjs

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

const HARMONY_PORT = 18200;
const MTX_API_PORT = 9997 - 50;
const MTX_WEBRTC_PORT = 8889 - 50;
const MTX_ICE_PORT = 8189 - 50;
const PORT_PEDRO = 9493;
const PORT_ANA = 9494;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-ps-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'harmony-ps-mtx-'));
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

/** A microphone that hums; the camera is not used. Every oscillator and buffer
 *  the page starts is noted, so a join tone and a join recording can be told apart. */
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
      const tone = ctx.createOscillator(); tone.frequency.value = 196;
      const gain = ctx.createGain(); gain.gain.value = 0.05;
      tone.connect(gain); gain.connect(out); tone.start();
      tracks.push(...out.stream.getAudioTracks());
    }
    if (c.video) {
      const feed = document.createElement('canvas'); feed.width = 640; feed.height = 360;
      const g = feed.getContext('2d'); let n = 0;
      setInterval(() => { n += 1; g.fillStyle = '#243055'; g.fillRect(0, 0, 640, 360); g.fillStyle = '#7aa2ff'; g.fillRect((n * 9) % 600, 0, 40, 360); }, 100);
      tracks.push(feed.captureStream(10).getVideoTracks()[0]);
    }
    return new MediaStream(tracks);
  };
  window.__heard = { tones: 0, buffers: [] };
  const oscStart = OscillatorNode.prototype.start;
  OscillatorNode.prototype.start = function (...a) {
    // The hum above is created before anybody listens; cues are 'sine' with a
    // settle ramp, which is all this needs to count them.
    if (this.frequency.value !== 196) window.__heard.tones += 1;
    return oscStart.apply(this, a);
  };
  const bufStart = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...a) {
    window.__heard.buffers.push({ seconds: this.buffer?.duration ?? 0, rate: this.buffer?.sampleRate ?? 0, length: a[2] ?? null });
    return bufStart.apply(this, a);
  };
  return true;`;

const setInput = (id, value) => `{
  const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
  i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
}`;

async function signIn(port, nickname) {
  const app = launchApp({
    port,
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-ps-profile-')),
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
  await waitFor(page, "document.querySelector('.view[data-active]')?.id === 'view-channels'", {
    label: `${nickname} signing in`,
  });
  await sleep(600);
  return page;
}

const joinVoice = async (page, label) => {
  await page.evaluate(`
    [...document.querySelectorAll('#channel-items li.channel-row')]
      .find((li) => li.querySelector('.channel-name')?.textContent === 'voice').click();
    return true;`);
  await waitFor(page, "!document.getElementById('voice-active').hidden && document.querySelectorAll('#voice-roster li').length >= 1", {
    label, timeoutMs: 40_000,
  });
};

/** Hand a file to a hidden <input type=file>, as picking one in the dialog would. */
const pickFile = (page, inputId, makeFile) => page.evaluate(`
  const file = await (async () => { ${makeFile} })();
  const input = document.getElementById(${JSON.stringify(inputId)});
  const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;`);

/** PS_SHOT=/some/dir keeps a picture of what each client sees. */
async function shot(page, name) {
  if (!process.env.PS_SHOT) return;
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(process.env.PS_SHOT, `${name}.png`), Buffer.from(data, 'base64'));
}

const makeWav = (seconds, hz = 440) => `
  const rate = 22050; const n = Math.round(${seconds} * rate);
  const bytes = new Uint8Array(44 + n * 4); const v = new DataView(bytes.buffer);
  const w = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    const s = Math.sin(i / rate * ${hz} * 6.283) * 12000;
    v.setInt16(44 + i * 4, s, true); v.setInt16(46 + i * 4, s, true);
  }
  return new File([bytes], 'ding.wav', { type: 'audio/wav' });`;

async function run() {
  console.log('Starting MediaMTX, the server and two clients…\n');
  await startMediaMtx();
  await startServer();
  await register('pedro', { ownerKey });
  await register('ana');

  const ana = await signIn(PORT_ANA, 'ana');
  const pedro = await signIn(PORT_PEDRO, 'pedro');
  for (const [who, page] of [['ana', ana], ['pedro', pedro]]) {
    await page.send('Runtime.enable');
    page.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
      console.log(`  [${who} exception]`, (d.exception?.description ?? d.text).split('\n').slice(0, 3).join(' / ').slice(0, 300));
    });
  }
  await joinVoice(ana, 'Ana joining the room');

  const open = () => pedro.evaluate(`
    const dialog = document.getElementById('devices');
    if (!dialog.open) document.getElementById('voice-config').click();
    document.querySelector('.settings-tab[data-tab="profile"]').click();
    return true;`);
  const rowOf = (page, where) => page.evaluate(`
    const name = [...document.querySelectorAll(${JSON.stringify(where)})]
      .find((r) => r.textContent.includes('pedro') || r.textContent.includes('Pedro'));
    if (!name) return null;
    const img = name.querySelector(':scope > img.profile-banner');
    const label = name.querySelector('.member-name');
    const style = img ? getComputedStyle(img) : null;
    return {
      font: label?.dataset.nameFont ?? null,
      family: label ? getComputedStyle(label).fontFamily : '',
      banner: img ? { src: img.getAttribute('src'), loaded: img.complete && img.naturalWidth > 0,
        filter: style.filter, opacity: Number(style.opacity), mask: style.maskImage || style.webkitMaskImage } : null,
      has: name.classList.contains('has-banner'),
    };`);

  // --- the choices ---------------------------------------------------------------------
  await open();
  await sleep(800);
  const choices = await pedro.evaluate("return [...document.querySelectorAll('#profile-font-grid .font-choice')].map((b) => b.title)");
  check('the font list offers Default and ten fonts', choices.length === 11 && choices[0] === 'Default', choices.join());
  check('with nothing picked, Default is the one checked',
    await pedro.evaluate("return document.querySelector('#profile-font-grid .font-choice[aria-checked=\"true\"]')?.title") === 'Default');
  check('the sound starts as the usual tone',
    (await pedro.evaluate("return document.getElementById('profile-sound-state').textContent")) === 'The usual tone');
  check('and there is no banner to remove',
    await pedro.evaluate("return document.getElementById('profile-banner-remove').disabled"));
  check('members\' join sounds are on by default',
    await pedro.evaluate("return document.getElementById('custom-join-sounds').checked"));

  // --- the font -----------------------------------------------------------------------------
  await pedro.evaluate(`[...document.querySelectorAll('#profile-font-grid .font-choice')].find((b) => b.title === 'Pacifico').click(); return true;`);
  await sleep(1500);
  let own = await pedro.evaluate("return document.getElementById('channels-who').dataset.nameFont ?? null");
  check('Pedro\'s own bar uses the font', own === 'pacifico', String(own));
  let seen = await rowOf(ana, '#member-items .member-row');
  check('Ana sees Pedro in the member list in that font', seen?.font === 'pacifico', JSON.stringify(seen));
  check('and it is really Pacifico, loaded from the app', /Pacifico/.test(seen?.family ?? '')
    && await ana.evaluate("await document.fonts.load('16px Pacifico'); return document.fonts.check('16px Pacifico')"), seen?.family);
  const chosen = await pedro.evaluate("return document.querySelector('#profile-font-grid .font-choice[aria-checked=\"true\"]')?.title");
  check('the choice is the one marked in Settings', chosen === 'Pacifico', String(chosen));

  // --- the banner ----------------------------------------------------------------------------------
  const GIF = "const b = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0)); return new File([b], 'b.gif', { type: 'image/gif' });";
  await pickFile(pedro, 'profile-banner-file', GIF);
  await sleep(2000);
  seen = await rowOf(ana, '#member-items .member-row');
  check('Ana sees a banner behind Pedro in the member list', seen?.has && seen.banner?.loaded, JSON.stringify(seen?.banner));
  check('the banner is dimmed', /brightness\(0\.5\)/.test(seen?.banner?.filter ?? '') && seen.banner.opacity < 1, JSON.stringify(seen?.banner));
  check('and fades out toward the left', /linear-gradient\(to right, rgba?\(0, 0, 0, 0\)/.test(seen?.banner?.mask ?? ''), seen?.banner?.mask);

  // --- dimming: Pedro moves the slider, and Ana's list follows while he does ---------------------------------------
  const moveDim = (value) => pedro.evaluate(`const s = document.getElementById('profile-banner-dim'); s.focus(); s.value = '${value}';
    s.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  const dimOf = (r) => Number(/brightness\(([\d.]+)\)/.exec(r?.banner?.filter ?? '')?.[1]);
  await open();
  check('the slider starts at the default', await pedro.evaluate("return document.getElementById('profile-banner-dim').value") === '50');
  await moveDim(10);
  const dimVar = await pedro.evaluate("return document.getElementById('profile-banner-preview').style.getPropertyValue('--banner-dim')");
  check('his own preview follows the slider at once', dimVar === '10', dimVar);
  await sleep(700);
  seen = await rowOf(ana, '#member-items .member-row');
  check('Ana\'s list follows without a reload: lighter', Math.abs(dimOf(seen) - 0.9) < 0.01, JSON.stringify(seen?.banner));
  // A quick drag: only where the hand stops counts, and nothing jumps back.
  for (const v of [30, 70, 90, 60, 30]) { await moveDim(v); await sleep(30); }
  await sleep(900);
  seen = await rowOf(ana, '#member-items .member-row');
  check('after a quick drag Ana has the value the hand stopped on', Math.abs(dimOf(seen) - 0.7) < 0.01, JSON.stringify(seen?.banner));
  check('and so does his slider', await pedro.evaluate("return document.getElementById('profile-banner-dim').value") === '30');
  await pedro.evaluate("document.getElementById('profile-banner-dim').blur(); document.getElementById('profile-banner-dim-reset').click(); return true;");
  await sleep(900);
  seen = await rowOf(ana, '#member-items .member-row');
  check('back to the default puts it back for Ana', Math.abs(dimOf(seen) - 0.5) < 0.01 && await pedro.evaluate("return document.getElementById('profile-banner-dim').value") === '50', JSON.stringify(seen?.banner));
  const sent = await pedro.evaluate(`
    const me = (await harmony.api.roster(${JSON.stringify(BASE)})); const u = (me.data ?? me).users.find((x) => x.nickname === 'pedro');
    const res = await fetch('harmony://app/media/' + u.bannerHash); const buf = new Uint8Array(await res.arrayBuffer());
    return { type: res.headers.get('content-type'), head: String.fromCharCode(...buf.slice(0, 3)) };`);
  check('a GIF is sent as a GIF, so it keeps moving', sent.type === 'image/gif' && sent.head === 'GIF', JSON.stringify(sent));

  const STILL = `
    const c = document.createElement('canvas'); c.width = 1800; c.height = 600;
    const g = c.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 1800, 600);
    g.fillStyle = '#fc3'; g.fillRect(900, 0, 900, 600);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    return new File([blob], 'wide.png', { type: 'image/png' });`;
  await pickFile(pedro, 'profile-banner-file', STILL);
  await sleep(2000);
  const shrunk = await pedro.evaluate(`
    const r = await harmony.api.roster(${JSON.stringify(BASE)}); const u = (r.data ?? r).users.find((x) => x.nickname === 'pedro');
    const res = await fetch('harmony://app/media/' + u.bannerHash); const bmp = await createImageBitmap(await res.blob());
    return { type: res.headers.get('content-type'), w: bmp.width, h: bmp.height };`);
  check('a big still picture is shrunk to 960 wide before it is sent',
    shrunk.type === 'image/jpeg' && shrunk.w === 960 && shrunk.h === 320, JSON.stringify(shrunk));
  const preview = await pedro.evaluate("const r = document.getElementById('profile-banner-preview'); return r.classList.contains('has-banner') && !!r.querySelector('img.profile-banner')");
  check('and the preview in Settings shows it', preview);
  await shot(pedro, 'settings');
  await pedro.evaluate("document.getElementById('profile-font-grid').scrollIntoView({ block: 'center' }); return true;");
  await sleep(300);
  await shot(pedro, 'fonts');

  // --- the banner, in a voice channel --------------------------------------------------------------------------
  await pedro.evaluate("document.getElementById('devices').close(); return true;");
  await joinVoice(pedro, 'Pedro joining the room');
  await sleep(1500);
  const inChannel = await rowOf(ana, '.channel-member');
  check('Ana sees the banner behind Pedro in the channel list too', inChannel?.has && inChannel.banner?.loaded, JSON.stringify(inChannel));
  check('with his font', inChannel?.font === 'pacifico', String(inChannel?.font));
  const inPane = await rowOf(ana, '#voice-roster li');
  check('and in the voice pane', inPane?.has && inPane.banner?.loaded && inPane.font === 'pacifico', JSON.stringify(inPane));
  await shot(ana, 'ana');

  // --- clearing -----------------------------------------------------------------------------------------------------------
  await open();
  await pedro.evaluate("document.getElementById('profile-banner-remove').click(); return true;");
  await pedro.evaluate(`[...document.querySelectorAll('#profile-font-grid .font-choice')].find((b) => b.title === 'Default').click(); return true;`);
  await sleep(1500);
  seen = await rowOf(ana, '#member-items .member-row');
  check('removing the banner and the font puts the plain row back', seen && !seen.has && !seen.banner && seen.font === null, JSON.stringify(seen));

  // --- a closed stream wears the streamer's picture ---------------------------------------------------------------------
  await pedro.evaluate(`
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const g = c.getContext('2d'); g.fillStyle = '#e0457b'; g.fillRect(0, 0, 64, 64);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const file = new File([blob], 'me.png', { type: 'image/png' });
    const input = document.getElementById('avatar-file');
    const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;`);
  await sleep(1500);
  await pedro.evaluate("document.getElementById('voice-cam').click(); return true;");
  await waitFor(ana, "document.querySelector('#channel-video .channel-tile[data-key$=\":c\"] video')?.videoWidth > 0", {
    label: "Ana receiving Pedro's camera", timeoutMs: 40_000,
  });
  await ana.evaluate("document.querySelector('#channel-video .channel-tile[data-key$=\":c\"] .tile-btn[data-role=\"close\"]').click(); return true;");
  await sleep(1000);
  const ghost = await ana.evaluate(`
    const g = document.querySelector('#channel-video .ghost-tile');
    const img = g?.querySelector(':scope > img.ghost-bg');
    return g ? { text: g.textContent, img: !!img, loaded: !!img && img.complete && img.naturalWidth > 0,
      filter: img ? getComputedStyle(img).filter : '' } : null;`);
  check('Ana closes his camera and a square is left behind', !!ghost && /pedro/i.test(ghost.text), JSON.stringify(ghost));
  check('his picture is the square\'s background', ghost?.img && ghost.loaded, JSON.stringify(ghost));
  check('dimmed, so the name on it stays readable', /brightness\(0\.45\)/.test(ghost?.filter ?? ''), ghost?.filter);
  await shot(ana, 'ghost');
  await pedro.evaluate("document.getElementById('voice-cam').click(); return true;");
  await sleep(800);

  // --- the join sound --------------------------------------------------------------------------------------------------------------
  await pickFile(pedro, 'profile-sound-file', makeWav(12));
  await sleep(2500);
  const note = await pedro.evaluate("return document.getElementById('profile-sound-note').textContent");
  check('a 12 second sound is cut, and Pedro is told', /10 seconds/.test(note) && /cut/.test(note), note);
  const stored = await pedro.evaluate(`
    const r = await harmony.api.roster(${JSON.stringify(BASE)}); const u = (r.data ?? r).users.find((x) => x.nickname === 'pedro');
    const res = await fetch('harmony://app/media/' + u.joinSoundHash); const buf = new DataView(await res.arrayBuffer());
    const rate = buf.getUint32(28, true); const bytes = buf.getUint32(40, true);
    return { type: res.headers.get('content-type'), seconds: bytes / rate, size: buf.byteLength };`);
  check('what the server holds is a WAV of ten seconds', stored.type === 'audio/wav' && Math.abs(stored.seconds - 10) < 0.05, JSON.stringify(stored));
  check('small enough to be cheap for everybody (under 700 KB)', stored.size < 700 * 1024, String(stored.size));

  // Then a short one, which is the one the room listens to.
  await pickFile(pedro, 'profile-sound-file', makeWav(3, 660));
  await sleep(2500);
  check('a 3 second sound is kept whole, and says so',
    /3\.0 seconds/.test(await pedro.evaluate("return document.getElementById('profile-sound-note').textContent")));
  check('Settings now says it is his own sound',
    (await pedro.evaluate("return document.getElementById('profile-sound-state').textContent")) === 'Your own sound');
  await pedro.evaluate("document.getElementById('devices').close(); return true;");

  // Pedro leaves, and joins again with a sound of his own.
  const heard = () => ana.evaluate('return JSON.parse(JSON.stringify(window.__heard))');
  await pedro.evaluate("document.getElementById('voice-leave').click(); return true;");
  await waitFor(pedro, "document.getElementById('voice-active').hidden", { label: 'Pedro leaving' });
  await sleep(1500);
  let before = await heard();
  await joinVoice(pedro, 'Pedro rejoining');
  await sleep(2500);
  let after = await heard();
  const played = after.buffers.slice(before.buffers.length);
  check('Ana plays his recording when he joins', played.some((b) => Math.abs(b.seconds - 3) < 0.1), JSON.stringify(played));
  check('and not the usual join tone on top of it', after.tones === before.tones, `${before.tones} -> ${after.tones}`);

  // Switched off, she hears the tone for everybody.
  await ana.evaluate(`
    document.getElementById('voice-config').click();
    document.querySelector('.settings-tab[data-tab="sounds"]').click();
    const t = document.getElementById('custom-join-sounds'); t.checked = false; t.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('devices').close(); return true;`);
  await sleep(500);
  await pedro.evaluate("document.getElementById('voice-leave').click(); return true;");
  await waitFor(pedro, "document.getElementById('voice-active').hidden", { label: 'Pedro leaving again' });
  await sleep(1500);
  before = await heard();
  await joinVoice(pedro, 'Pedro rejoining again');
  await sleep(2500);
  after = await heard();
  check('with the switch off Ana hears the usual tone', after.tones > before.tones, `${before.tones} -> ${after.tones}`);
  check('and not his recording', !after.buffers.slice(before.buffers.length).some((b) => Math.abs(b.seconds - 3) < 0.1));

  // Removing it goes back to the tone, switch or no switch.
  await open();
  await pedro.evaluate("document.getElementById('profile-sound-remove').click(); return true;");
  await sleep(1200);
  check('removing it puts the usual tone back in Settings',
    (await pedro.evaluate("return document.getElementById('profile-sound-state').textContent")) === 'The usual tone');
  const gone = await pedro.evaluate(`
    const r = await harmony.api.roster(${JSON.stringify(BASE)}); return (r.data ?? r).users.find((x) => x.nickname === 'pedro').joinSoundHash`);
  check('and the server forgets it', gone === null, String(gone));
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
