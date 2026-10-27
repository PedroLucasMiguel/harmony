// The camera background, end to end: what somebody ELSE receives.
//
// Pedro's camera is a photo of a person. He turns the background effect on in
// Settings, starts his camera in a voice room, and Ana -- a second real client
// on the other end of a real MediaMTX -- samples pixels from the video she
// actually receives. So this proves the thing that matters: that what leaves
// the machine is the processed picture, and that changing the setting live does
// not interrupt the stream.
//
//   CAMERA_BACKGROUND_PHOTO=/path/to/a-portrait.jpg \
//   MEDIAMTX_BIN=/path/to/mediamtx node client/test/camera-background.mjs
//
// The photo is not in the repository: it needs to be a real photograph of one
// person, head and shoulders, in front of something that is plainly not a
// person, and nothing here is allowed to ship a stranger's face. Without it the
// test says so and exits.
//
// Windows are left to Chromium's real devices: the microphone and camera are
// replaced inside each page (a tone, and the photo), because
// --use-fake-device-for-media-stream would also fake the screen capture and
// --use-fake-ui-for-media-stream breaks it -- see scripts/record-demo.mjs.

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const serverEntry = resolve(repoRoot, 'server', 'src', 'index.js');

const PHOTO = process.env.CAMERA_BACKGROUND_PHOTO;
const MEDIAMTX_BIN = process.env.MEDIAMTX_BIN ?? join(homedir(), 'mediamtx', 'mediamtx');

if (!PHOTO || !existsSync(PHOTO)) {
  console.log('Set CAMERA_BACKGROUND_PHOTO to a portrait photo to run this test. See the top of the file.');
  process.exit(0);
}
if (!existsSync(MEDIAMTX_BIN)) {
  console.log(`No MediaMTX at ${MEDIAMTX_BIN}. Set MEDIAMTX_BIN.`);
  process.exit(0);
}

const HARMONY_PORT = 18170;
const MTX_API_PORT = 9997 - 20;
const MTX_WEBRTC_PORT = 8889 - 20;
const MTX_ICE_PORT = 8189 - 20;
const PORT_PEDRO = 9471;
const PORT_ANA = 9472;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-bg-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'harmony-bg-mtx-'));
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

/** A microphone that hums and a camera that shows `photo`, in place of hardware. */
const STUBS = (photoBase64) => `
  const md = navigator.mediaDevices;
  md.enumerateDevices = async () => [
    { kind: 'audioinput', deviceId: 'default', label: 'Microphone', groupId: 'g1' },
    { kind: 'videoinput', deviceId: 'camera', label: 'Camera', groupId: 'g2' },
  ].map((d) => ({ ...d, toJSON: () => d }));
  const photo = await new Promise((resolve, reject) => {
    const i = new Image(); i.onload = () => resolve(i); i.onerror = reject;
    i.src = 'data:image/jpeg;base64,${photoBase64}';
  });
  const feed = document.createElement('canvas'); feed.width = 640; feed.height = 360;
  const g = feed.getContext('2d');
  const draw = () => {
    const s = Math.max(640 / photo.width, 360 / photo.height);
    g.drawImage(photo, (640 - photo.width * s) / 2, -photo.height * s * 0.05, photo.width * s, photo.height * s);
  };
  draw(); setInterval(draw, 40);
  md.getUserMedia = async (c = {}) => {
    const tracks = [];
    if (c.audio) {
      const ctx = new AudioContext(); const out = ctx.createMediaStreamDestination();
      const tone = ctx.createOscillator(); tone.frequency.value = 196;
      const gain = ctx.createGain(); gain.gain.value = 0.05;
      tone.connect(gain); gain.connect(out); tone.start();
      tracks.push(...out.stream.getAudioTracks());
    }
    if (c.video) tracks.push(...feed.captureStream(25).getVideoTracks());
    return new MediaStream(tracks);
  };
  return true;`;

const setInput = (id, value) => `{
  const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
  i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
}`;

async function signInAndJoin(port, nickname, stubs) {
  const app = launchApp({
    port,
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-bg-profile-')),
    extraArgs: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  procs.push(app);
  const page = await attach(await findPage(port));
  await sleep(1500);
  await page.evaluate(stubs);
  await page.evaluate(`${setInput('server-url', BASE)} return true;`);
  await sleep(1500);
  await page.evaluate(`${setInput('username', nickname)} ${setInput('account-password', 'hunter22')}
    document.getElementById('continue').click(); return true;`);
  await waitFor(page, "document.querySelector('.view[data-active]')?.id === 'view-channels'", {
    label: `${nickname} signing in`,
  });
  await sleep(600);
  await page.evaluate(`
    [...document.querySelectorAll('#channel-items li.channel-row')]
      .find((li) => li.querySelector('.channel-name')?.textContent === 'voice').click();
    return true;`);
  await waitFor(page, "!document.getElementById('voice-active').hidden && document.querySelectorAll('#voice-roster li').length >= 1", {
    label: `${nickname} joining the room`, timeoutMs: 40_000,
  }).catch(async (err) => {
    // What the app itself said is usually the whole explanation.
    const said = await page.evaluate(`return [...document.querySelectorAll('.error, #channels-error')]
      .filter((n) => !n.hidden && n.textContent.trim()).map((n) => n.textContent.trim()).join(' | ');`).catch(() => '');
    console.error(`[${nickname} said] ${said || '(nothing)'}`);
    throw err;
  });
  return page;
}

/** The average colour of the top-left corner of the camera video Ana receives, 0-255. */
const corner = (ana) => ana.evaluate(`
  const v = document.querySelector('#channel-video [data-key$=":c"] video');
  if (!v || !v.videoWidth) return null;
  const c = document.createElement('canvas'); c.width = 32; c.height = 32;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(v, 0, 0, v.videoWidth * 0.12, v.videoHeight * 0.12, 0, 0, 32, 32);
  const d = x.getImageData(0, 0, 32, 32).data; let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  const n = d.length / 4;
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];`);

const near = (got, want, tolerance = 45) =>
  Array.isArray(got) && got.every((value, i) => Math.abs(value - want[i]) <= tolerance);

const framesOf = (ana) => ana.evaluate(`
  const v = document.querySelector('#channel-video [data-key$=":c"] video');
  return v ? Math.round(v.currentTime * 100) : 0;`);

async function run() {
  console.log('Starting MediaMTX, the server and two clients…\n');
  await startMediaMtx();
  await startServer();
  await register('pedro', { ownerKey });
  await register('ana');

  const photo = readFileSync(PHOTO).toString('base64');
  const ana = await signInAndJoin(PORT_ANA, 'ana', `${STUBS(photo)}`);
  const pedro = await signInAndJoin(PORT_PEDRO, 'pedro', `${STUBS(photo)}`);
  // What the page itself complains about, which is where a frame that throws shows up.
  await pedro.send('Runtime.enable');
  pedro.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
    console.log('  [pedro exception]', (d.exception?.description ?? d.text).split('\n').slice(0, 3).join(' / ').slice(0, 300));
  });
  pedro.on('Runtime.consoleAPICalled', ({ type, args }) => {
    if (type === 'warning' || type === 'error') {
      console.log(`  [pedro ${type}]`, args.map((a) => a.value ?? a.description).join(' ').slice(0, 220));
    }
  });

  const settings = (action) => pedro.evaluate(`
    const dialog = document.getElementById('devices');
    if (!dialog.open) document.getElementById('voice-config').click();
    document.querySelector('.settings-tab[data-tab="voice"]').click();
    ${action}
    return true;`);
  const mode = (name) => settings(`document.querySelector('#bg-mode [data-value="${name}"]').click();`);
  const done = () => pedro.evaluate("document.getElementById('devices').close(); return true;");

  // --- the controls are there -------------------------------------------------
  await settings('');
  await sleep(1200);
  const group = await pedro.evaluate(`
    return { shown: !document.getElementById('bg-group').hidden,
      modes: [...document.querySelectorAll('#bg-mode button')].map((b) => b.dataset.value) };`);
  check('Settings offers the camera background', group.shown === true, group.modes.join(', '));
  check('with none, blur, colour, gradient and image',
    group.modes.join() === 'off,blur,color,gradient,image');

  // --- a solid colour, before the camera starts --------------------------------
  await mode('color');
  await pedro.evaluate(`${setInput('bg-color', '#1f6feb')} return true;`);
  await done();
  await pedro.evaluate("document.getElementById('voice-cam').click(); return true;");
  await waitFor(ana, "document.querySelector('#channel-video [data-key$=\":c\"] video')?.videoWidth > 0", {
    label: "Ana receiving Pedro's camera", timeoutMs: 40_000,
  });
  await sleep(2500);
  let c = await corner(ana);
  check('with a colour chosen, Ana receives that colour behind him', near(c, [31, 111, 235]), `corner ${c}`);

  // --- changed live, with the camera running ------------------------------------
  const before = await framesOf(ana);
  await mode('gradient');
  await pedro.evaluate(`${setInput('bg-from', '#ff0000')} ${setInput('bg-to', '#ff0000')} return true;`);
  await sleep(2500);
  c = await corner(ana);
  const own = await pedro.evaluate(`
    const p = document.getElementById('bg-preview'); const x = p.getContext('2d', { willReadFrequently: true });
    const d = x.getImageData(2, 2, 4, 4).data; return { wrapHidden: document.getElementById('bg-preview-wrap').hidden,
      px: [d[0], d[1], d[2]], mode: document.querySelector('#bg-mode [aria-checked="true"]')?.dataset.value,
      from: document.getElementById('bg-from').value, to: document.getElementById('bg-to').value };`);
  check('switching to a gradient changes what Ana sees, live', near(c, [255, 0, 0], 70), `corner ${c}`);
  check('and the stream carried on rather than restarting', (await framesOf(ana)) > before);

  await mode('blur');
  await sleep(2500);
  c = await corner(ana);
  check('blur gives a soft version of the real room, not a flat colour',
    Array.isArray(c) && !near(c, [255, 0, 0], 70) && !near(c, [31, 111, 235], 40), `corner ${c}`);

  // --- a picture, chosen the way a person chooses one -----------------------------
  // The file input is filled exactly as the browser's file dialog would fill it,
  // so this goes through the same handler: stored, named, applied, live.
  await settings(`
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 36;
    const x = canvas.getContext('2d'); x.fillStyle = '#00cc44'; x.fillRect(0, 0, 64, 36);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const input = document.getElementById('bg-file');
    const files = new DataTransfer(); files.items.add(new File([blob], 'green.png', { type: 'image/png' }));
    input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));`);
  await sleep(3500);
  const named = await pedro.evaluate("return document.getElementById('bg-image-name').textContent");
  check('choosing a picture shows its name', named === 'green.png', named);
  c = await corner(ana);
  check('and Ana receives that picture behind him', near(c, [0, 204, 68], 60), `corner ${c}`);

  // --- an animated GIF: red, then blue, on a loop ------------------------------------
  // Four frames, a quarter of a second each. Watching the corner for a couple
  // of seconds has to see BOTH colours, or it is a still of the first frame.
  const GIF = 'R0lGODlhQAAkAPcfMQAAACQAAEgAAGwAAJAAALQAANgAAPwAAAAkACQkAEgkAGwkAJAkALQkANgkAPwkAABIACRIAEhIAGxIAJBIALRIANhIAPxIAABsACRsAEhsAGxsAJBsALRsANhsAPxsAACQACSQAEiQAGyQAJCQALSQANiQAPyQAAC0ACS0AEi0AGy0AJC0ALS0ANi0APy0AADYACTYAEjYAGzYAJDYALTYANjYAPzYAAD8ACT8AEj8AGz8AJD8ALT8ANj8APz8AAAAVSQAVUgAVWwAVZAAVbQAVdgAVfwAVQAkVSQkVUgkVWwkVZAkVbQkVdgkVfwkVQBIVSRIVUhIVWxIVZBIVbRIVdhIVfxIVQBsVSRsVUhsVWxsVZBsVbRsVdhsVfxsVQCQVSSQVUiQVWyQVZCQVbSQVdiQVfyQVQC0VSS0VUi0VWy0VZC0VbS0Vdi0Vfy0VQDYVSTYVUjYVWzYVZDYVbTYVdjYVfzYVQD8VST8VUj8VWz8VZD8VbT8Vdj8Vfz8VQAAqiQAqkgAqmwAqpAAqrQAqtgAqvwAqgAkqiQkqkgkqmwkqpAkqrQkqtgkqvwkqgBIqiRIqkhIqmxIqpBIqrRIqthIqvxIqgBsqiRsqkhsqmxsqpBsqrRsqthsqvxsqgCQqiSQqkiQqmyQqpCQqrSQqtiQqvyQqgC0qiS0qki0qmy0qpC0qrS0qti0qvy0qgDYqiTYqkjYqmzYqpDYqrTYqtjYqvzYqgD8qiT8qkj8qmz8qpD8qrT8qtj8qvz8qgAA/yQA/0gA/2wA/5AA/7QA/9gA//wA/wAk/yQk/0gk/2wk/5Ak/7Qk/9gk//wk/wBI/yRI/0hI/2xI/5BI/7RI/9hI//xI/wBs/yRs/0hs/2xs/5Bs/7Rs/9hs//xs/wCQ/ySQ/0iQ/2yQ/5CQ/7SQ/9iQ//yQ/wC0/yS0/0i0/2y0/5C0/7S0/9i0//y0/wDY/yTY/0jY/2zY/5DY/7TY/9jY//zY/wD8/yT8/0j8/2z8/5D8/7T8/9j8//z8/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQEGQAfACwAAAAAQAAkAAAIlQAPCBxIsKDBgwgTKlzIsKHDhxAjSpwo0MBBiwYxFtRIkONAjxUvUhxJsqTJkyhTPgR5gKVLkRlhblRJs6bNmzgZvozJc2bPjjJzCh1KtCjFnT6TAv35MajRp1Cj0kS6VGlTpiGxSt3KtetEqletZhXb0qnXs2i7gh1btW1Yt2zTyp2r1mxZrWvvkqXLty/KvIDt5g0IACH5BAUZAAAALD8AIwABAAEAAAgEAAEEBAAh+QQFGQAAACwAAAAAQAAkAAAIlgABARtIEJjAggMPIlRYkCFBhwkRRpRIsaLFixgzatzIsaPHjyBDUoRocKRJiSRTnhTJsqXLlzBjvlSJcmVDmw9xytzJs6fPnxxpLtRZsqbRoUCTKl3KdKPQm0ehIp0qtanVq1iZPs0ZlStVr1Wzih1LVuPWiV/RhlULtqzbt3DTFpV7du5au3Hz6k1aty/RunsDC44ZEAAh+QQFGQAAACw/ACMAAQABAAAIBAABBAQAOw==';
  await settings(`
    const bytes = Uint8Array.from(atob(${JSON.stringify(GIF)}), (ch) => ch.charCodeAt(0));
    const input = document.getElementById('bg-file');
    const files = new DataTransfer(); files.items.add(new File([bytes], 'loop.gif', { type: 'image/gif' }));
    input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));`);
  await sleep(2500);
  let sawRed = false;
  let sawBlue = false;
  for (let i = 0; i < 14; i += 1) {
    const sample = await corner(ana);
    if (Array.isArray(sample)) {
      if (sample[0] > 170 && sample[2] < 100) sawRed = true;
      if (sample[2] > 170 && sample[0] < 100) sawBlue = true;
    }
    await sleep(250);
  }
  check('a GIF background animates for the people watching', sawRed && sawBlue, `red ${sawRed}, blue ${sawBlue}`);

  // --- off again ------------------------------------------------------------------
  await mode('off');
  await sleep(2500);
  c = await corner(ana);
  check('turning it off sends the real camera again, still live',
    Array.isArray(c) && !near(c, [255, 0, 0], 70) && !near(c, [31, 111, 235], 40), `corner ${c}`);
  await done();
  const after = await framesOf(ana);
  await sleep(1500);
  check('and the video is still moving', (await framesOf(ana)) > after);
}

run()
  .catch((err) => {
    console.error(err);
    console.error(serverLog.split('\n').slice(-8).join('\n'));
    if (mtxLog) console.error(`--- mediamtx ---\n${mtxLog.slice(-1200)}`);
    process.exitCode = 1;
  })
  .finally(() => {
    const failed = summary();
    setTimeout(() => process.exit(process.exitCode ?? (failed ? 1 : 0)), 300);
  });
