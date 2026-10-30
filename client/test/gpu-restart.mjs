// When the GPU process dies, the pictures of streams are put back.
//
//   node client/test/gpu-restart.mjs
//
// The GPU process is killed on purpose (the way a driver hiccup after an update
// would). Chromium starts another by itself, and the app is told, and attaches
// each stream to its <video> again.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const PORT = 9561;
const { check, summary } = reporter();
const procs = [];
process.on('exit', () => procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } }));
process.on('SIGINT', () => process.exit(130));

async function run() {
  const app = launchApp({
    port: PORT,
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-gpu-profile-')),
    extraArgs: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  procs.push(app);
  const target = await findPage(PORT);
  const page = await attach(target);
  await sleep(2500);

  // A picture that changes, on a <video> that shows a stream, as a camera tile does.
  await page.evaluate(`
    window.__told = 0;
    window.harmony.onGpuRestarted(() => { window.__told += 1; });
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const g = canvas.getContext('2d'); let n = 0;
    setInterval(() => { n += 1; g.fillStyle = 'hsl(' + (n * 5 % 360) + ' 70% 50%)'; g.fillRect(0, 0, 320, 180); }, 33);
    const video = document.createElement('video');
    video.id = '__tile'; video.muted = true; video.autoplay = true; video.playsInline = true;
    video.style.cssText = 'position:fixed;left:0;top:0;width:160px;height:90px;z-index:99999';
    video.srcObject = canvas.captureStream(30);
    document.body.append(video);
    await video.play();
    // A downloaded video, which has no stream and must be left alone.
    const plain = document.createElement('video'); plain.id = '__plain'; plain.src = 'data:video/mp4;base64,AAAA'; document.body.append(plain);
    window.__plainSrc = plain.src;
    return true;`);
  await sleep(500);

  const before = await page.evaluate("return document.getElementById('__tile').getVideoPlaybackQuality().totalVideoFrames");
  check('a stream is showing', before > 5, String(before));

  // Kill the GPU process. This needs the browser's own endpoint, not the page's.
  const browserWs = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl;
  const killer = new WebSocket(browserWs);
  await new Promise((r) => killer.addEventListener('open', r, { once: true }));
  const crashed = new Promise((resolve) => {
    killer.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id === 1) resolve(m); });
  });
  killer.send(JSON.stringify({ id: 1, method: 'Browser.crashGpuProcess' }));
  const answer = await crashed;
  check('the GPU process was killed', !answer.error, JSON.stringify(answer));
  killer.close();

  await waitFor(page, 'window.__told >= 1', { timeoutMs: 15_000, label: 'being told the GPU restarted' });
  check('the page is told that the GPU process was restarted', true);

  // The app puts the picture back after a moment (800 ms, and again at 4 s).
  const mark = await page.evaluate("document.getElementById('__tile').__marker = 'same element'; return true");
  await sleep(1500);
  const after = await page.evaluate(`
    const v = document.getElementById('__tile');
    const before = v.getVideoPlaybackQuality().totalVideoFrames; await new Promise((r) => setTimeout(r, 700));
    return { playing: !v.paused, advanced: v.getVideoPlaybackQuality().totalVideoFrames - before, same: v.__marker === 'same element', width: v.videoWidth,
      plainSrc: document.getElementById('__plain').src === window.__plainSrc };`);
  check('the stream is still drawn after it (the element took the stream again, or it never stopped)', after.playing && after.advanced > 5 && after.width === 320, JSON.stringify(after));
  check('and a video that is not a stream was not touched', after.plainSrc === true);
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    const failed = summary();
    setTimeout(() => process.exit(process.exitCode ?? (failed ? 1 : 0)), 200);
  });
