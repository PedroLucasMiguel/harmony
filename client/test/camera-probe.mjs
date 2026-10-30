// Telling a camera that gives only black from one that gives a picture.
//
//   node client/test/camera-probe.mjs

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attach, findPage, launchApp, reporter, sleep } from './cdp.mjs';

const PORT = 9560;
const { check, summary } = reporter();
const procs = [];
process.on('exit', () => procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } }));
process.on('SIGINT', () => process.exit(130));

const SETUP = `
  const { probeBlack, isBlackFrame } = await import('./camera-probe.js');
  window.__probe = probeBlack;
  window.__isBlack = isBlackFrame;
  // A stream that draws what it is told, every frame.
  window.__source = (paint) => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const g = canvas.getContext('2d');
    const tick = () => { paint(g, canvas); requestAnimationFrame(tick); };
    tick();
    return canvas.captureStream(30);
  };
  return true;`;

async function run() {
  const app = launchApp({
    port: PORT,
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-probe-profile-')),
    extraArgs: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  procs.push(app);
  const page = await attach(await findPage(PORT));
  await sleep(2500);
  await page.evaluate(SETUP);

  const frame = (...pixels) => page.evaluate(`return window.__isBlack(new Uint8ClampedArray(${JSON.stringify(pixels.flat())}))`);
  check('pixels that are all black are black', await frame([0, 0, 0, 255], [0, 0, 0, 255]) === true);
  check('a bright picture is not', await frame([200, 180, 160, 255], [10, 10, 10, 255]) === false);
  check('a dark room with a little noise is not', await frame([30, 28, 26, 255], [2, 1, 1, 255], [0, 0, 0, 255], [6, 6, 6, 255]) === false);
  check('almost black with no noise at all is', await frame([2, 2, 2, 255], [1, 1, 1, 255], [0, 0, 0, 255], [3, 3, 3, 255]) === true);

  const black = await page.evaluate(`
    const stream = window.__source((g, c) => { g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height); });
    const t0 = performance.now(); const result = await window.__probe(stream, { ms: 1500 });
    return { result, ms: Math.round(performance.now() - t0) };`);
  check('a stream of black frames is black, after looking for the time it was given', black.result === true && black.ms >= 1400, JSON.stringify(black));

  const lively = await page.evaluate(`
    let n = 0;
    const stream = window.__source((g, c) => { n += 1; g.fillStyle = 'hsl(' + (n * 7 % 360) + ' 70% 50%)'; g.fillRect(0, 0, c.width, c.height); });
    const t0 = performance.now(); const result = await window.__probe(stream, { ms: 2500 });
    return { result, ms: Math.round(performance.now() - t0) };`);
  check('a stream with a picture is not, and is known at once', lively.result === false && lively.ms < 1200, JSON.stringify(lively));

  const late = await page.evaluate(`
    const started = performance.now();
    const stream = window.__source((g, c) => {
      // Black for the first second, as a camera that is slow to wake.
      g.fillStyle = performance.now() - started < 1000 ? '#000' : '#4a90d9'; g.fillRect(0, 0, c.width, c.height);
    });
    return await window.__probe(stream, { ms: 2500 });`);
  check('one that is black only at first is not black', late === false);

  const noisy = await page.evaluate(`
    const stream = window.__source((g, c) => {
      const d = g.createImageData(c.width, c.height);
      for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 40; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
      g.putImageData(d, 0, 0);
    });
    return await window.__probe(stream, { ms: 1500 });`);
  check('a dark picture with noise in it is not', noisy === false);

  const gone = await page.evaluate(`
    const stream = window.__source((g, c) => { g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height); });
    setTimeout(() => stream.getTracks().forEach((t) => t.stop()), 500);
    return await window.__probe(stream, { ms: 2000 });`);
  check('a camera that has been let go of is not a black one', gone === false);
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
