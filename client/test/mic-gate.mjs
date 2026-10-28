// The microphone's noise gate, in a real Chromium, with the page's main thread
// held up on purpose.
//
// The gate used to be a 25 ms timer on the main thread. A main thread that is
// busy -- a camera effect segmenting every frame -- runs a timer late, and the
// gate then stays open or shut when it should not be. It now decides inside the
// audio thread, and the proof is the case that broke the timer: the sound drops
// below the threshold while the page is blocked, and the gate must close anyway.
//
// The signal is made and timed on the audio thread (a gain scheduled on the
// audio clock), so blocking the page cannot move it. What comes out of the chain
// is measured with an analyser in a second audio context.
//
//   node client/test/mic-gate.mjs

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attach, findPage, launchApp, reporter, sleep } from './cdp.mjs';

const PORT = 9563;
const { check, summary } = reporter();
const procs = [];
process.on('exit', () => procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } }));
process.on('SIGINT', () => process.exit(130));

const SETUP = `
  const { createMicChain } = await import('./gain.js');
  window.__createMicChain = createMicChain;
  const make = async (options) => {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator(); osc.frequency.value = 220;
    const level = ctx.createGain(); level.gain.value = 0;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(level); level.connect(dest); osc.start();
    const chain = await createMicChain(dest.stream, options);
    const out = new AudioContext();
    const analyser = out.createAnalyser(); analyser.fftSize = 2048;
    out.createMediaStreamSource(new MediaStream([chain.track])).connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    return {
      chain, ctx, level,
      // Amplitude A is an RMS of A / sqrt 2. Set on the audio clock.
      amplitude(a) { level.gain.setValueAtTime(a, ctx.currentTime); },
      amplitudeAt(a, seconds) { level.gain.setValueAtTime(a, ctx.currentTime + seconds); },
      rms() { analyser.getFloatTimeDomainData(buffer); let s = 0; for (const x of buffer) s += x * x; return Math.sqrt(s / buffer.length); },
    };
  };
  window.__make = make;
  return true;`;

const wait = (ms) => sleep(ms);

async function run() {
  const app = launchApp({
    port: PORT,
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-gate-profile-')),
    extraArgs: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  procs.push(app);
  const page = await attach(await findPage(PORT));
  await sleep(2500);
  await page.evaluate(SETUP);

  await page.evaluate(`window.__m = await window.__make({ gain: 1, threshold: 0 }); window.__m.amplitude(0.1); return true;`);
  await wait(700);
  const kind = await page.evaluate('return window.__m.chain.kind');
  check('the gate runs on the audio thread', kind === 'worklet', kind);

  // --- no gate: sound goes straight through -----------------------------------------------------------------------
  let out = await page.evaluate('return window.__m.rms()');
  check('with the gate off, the sound arrives as it was', Math.abs(out - 0.0707) < 0.015, out.toFixed(4));

  await page.evaluate('window.__m.chain.setGain(2); return true;');
  await wait(500);
  out = await page.evaluate('return window.__m.rms()');
  check('and the input volume applies: twice the gain, twice the sound', Math.abs(out - 0.1414) < 0.03, out.toFixed(4));
  await page.evaluate('window.__m.chain.setGain(1); return true;');

  // --- a gate: loud passes, quiet is shut out ----------------------------------------------------------------------
  await page.evaluate('window.__m.chain.setThreshold(0.05); return true;');
  await wait(600);
  out = await page.evaluate('return window.__m.rms()');
  let state = await page.evaluate('return { open: window.__m.chain.open, level: window.__m.chain.level }');
  check('above the threshold the gate is open and the sound passes', state.open && Math.abs(out - 0.0707) < 0.015, `${out.toFixed(4)} ${JSON.stringify(state)}`);
  check('and the level it reports is what the microphone hears', Math.abs(state.level - 0.0707) < 0.02, state.level.toFixed(4));

  await page.evaluate('window.__m.amplitude(0.02); return true;');
  await wait(1000);
  out = await page.evaluate('return window.__m.rms()');
  state = await page.evaluate('return { open: window.__m.chain.open, level: window.__m.chain.level }');
  check('below it the gate closes and the sound is gone', !state.open && out < 0.002, `${out.toFixed(5)} ${JSON.stringify(state)}`);

  // --- the case the timer lost: it must close while the page is blocked ------------------------------------------------
  await page.evaluate('window.__m.amplitude(0.1); return true;');
  await wait(700);
  const blocked = await page.evaluate(`
    // 100 ms from now, on the audio clock, the sound drops below the threshold...
    window.__m.amplitudeAt(0.02, 0.1);
    // ...and the page does nothing at all for a second and a half.
    const end = performance.now() + 1500;
    while (performance.now() < end) { /* the camera effect, being slow */ }
    return window.__m.rms();`);
  check('the sound drops while the page is blocked, and the gate closes anyway', blocked < 0.002, blocked.toFixed(5));

  // --- and opens again -----------------------------------------------------------------------------------------------------
  await page.evaluate('window.__m.amplitude(0.1); return true;');
  await wait(700);
  out = await page.evaluate('return window.__m.rms()');
  check('a loud sound opens it again', out > 0.05, out.toFixed(4));

  await page.evaluate('window.__m.amplitude(0.02); window.__m.chain.setThreshold(0); return true;');
  await wait(700);
  out = await page.evaluate('return window.__m.rms()');
  check('threshold 0 takes the gate away', Math.abs(out - 0.0141) < 0.006, out.toFixed(4));

  await page.evaluate('window.__m.chain.close(); return true;');

  // --- an engine that will not run the worklet: the timer takes over --------------------------------------------------
  // On a fresh page: the gate's code is loaded once per audio context, and the
  // checks above have already done it.
  await page.evaluate('location.reload(); return true;');
  await sleep(3500);
  await page.evaluate("AudioWorklet.prototype.addModule = () => Promise.reject(new Error('refused')); return true;");
  await page.evaluate(SETUP);
  const fallback = await page.evaluate(`
    const m = await window.__make({ gain: 1, threshold: 0 });
    m.amplitude(0.1);
    await new Promise((r) => setTimeout(r, 700));
    return { kind: m.chain.kind, rms: m.rms(), track: Boolean(m.chain.track) };`);
  check('if the worklet will not load, a timer-driven gate still carries the microphone',
    fallback.kind === 'polled' && fallback.track && Math.abs(fallback.rms - 0.0707) < 0.015, JSON.stringify(fallback));

  // For comparison, the very same stall against the timer: the page cannot run
  // it while blocked, so the gate is still open when the sound is already below
  // the threshold. This is what was reaching people's ears, and it is also what
  // shows the check above can fail.
  const stalled = await page.evaluate(`
    const m = await window.__make({ gain: 1, threshold: 0.05 });
    m.amplitude(0.1);
    await new Promise((r) => setTimeout(r, 700));
    m.amplitudeAt(0.02, 0.1);
    const end = performance.now() + 1500;
    while (performance.now() < end) { /* the camera effect, being slow */ }
    return m.rms();`);
  check('(for comparison) the timer-driven gate stays open through the same stall', stalled > 0.005, stalled.toFixed(5));
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
