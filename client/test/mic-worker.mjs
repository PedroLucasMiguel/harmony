// Volume and the noise gate applied to the frames of the track, in a worker.
//
// What this has to get right: the gate and the volume do their jobs, they do
// not leave a click where the gate opens and closes (a track that is switched
// on and off does -- measured here against the same signal left alone), muting
// the source still silences it, and an engine that cannot run the worker says
// so instead of publishing a track nothing comes out of.
//
//   node client/test/mic-worker.mjs

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attach, findPage, launchApp, reporter, sleep } from './cdp.mjs';

const PORT = 9579;
const { check, summary } = reporter();
const procs = [];
process.on('exit', () => procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } }));
process.on('SIGINT', () => process.exit(130));

const SETUP = `
  const { workerMicChain, createMicValve } = await import('./gain.js');
  window.__gain = { workerMicChain, createMicValve };
  const ctx = new AudioContext({ sampleRate: 48000 });
  // A voice-like source whose loudness the test sets.
  const voice = ctx.createGain(); voice.gain.value = 0;
  for (let h = 1; h <= 6; h += 1) {
    const o = ctx.createOscillator(); o.frequency.value = 140 * h;
    const g = ctx.createGain(); g.gain.value = 1 / h; o.connect(g); g.connect(voice); o.start();
  }
  const dest = ctx.createMediaStreamDestination(); voice.connect(dest);
  window.__voice = voice; window.__ctx = ctx;
  window.__source = dest.stream.getAudioTracks()[0];
  window.__input = () => new MediaStream([window.__source.clone()]);

  // Peak and click energy (what is above 3 kHz: the voice has none) of what a track delivers in a while.
  window.__listen = async (track, ms) => {
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    const end = performance.now() + ms; const chunks = [];
    while (performance.now() < end) {
      const { value, done } = await reader.read(); if (done) break;
      const f = new Float32Array(value.numberOfFrames); value.copyTo(f, { planeIndex: 0, format: 'f32-planar' });
      chunks.push(f); value.close();
    }
    reader.cancel();
    const x = new Float32Array(chunks.reduce((n, c) => n + c.length, 0)); let p = 0;
    for (const c of chunks) { x.set(c, p); p += c.length; }
    let peak = 0, hi = 0, all = 0;
    for (let i = 3; i < x.length; i += 1) {
      peak = Math.max(peak, Math.abs(x[i]));
      const d3 = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3];
      hi += d3 * d3; all += x[i] * x[i];
    }
    return { peak, clicks: hi / (all || 1), samples: x.length };
  };
  // Syllables that straddle a threshold, the way speech does.
  window.__speak = (amps) => {
    const t0 = ctx.currentTime + 0.2;
    voice.gain.cancelScheduledValues(0); voice.gain.setValueAtTime(0, ctx.currentTime);
    amps.forEach((a, i) => {
      const t = t0 + i * 0.55;
      voice.gain.setValueAtTime(0, t); voice.gain.linearRampToValueAtTime(a, t + 0.03);
      voice.gain.setValueAtTime(a, t + 0.17); voice.gain.linearRampToValueAtTime(0, t + 0.25);
    });
    return amps.length * 0.55 + 0.6;
  };
  return true;`;

async function run() {
  const app = launchApp({
    port: PORT,
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-worker-profile-')),
    extraArgs: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  procs.push(app);
  const page = await attach(await findPage(PORT));
  await sleep(2500);
  await page.evaluate(SETUP);

  // --- the gate -------------------------------------------------------------------------------------------------------------------------
  await page.evaluate(`window.__voice.gain.value = 0.1; window.__c = await window.__gain.workerMicChain(window.__input(), { threshold: 0.03 }); return true;`);
  let r = await page.evaluate(`return window.__listen(window.__c.track, 1200)`);
  check('a loud sound goes through a gate that is set', r.peak > 0.15, `peak ${r.peak.toFixed(3)}`);
  check('and the gate reports itself open', await page.evaluate('return window.__c.open'));

  await page.evaluate('window.__voice.gain.value = 0.01; return true;');
  await sleep(900);
  r = await page.evaluate(`return window.__listen(window.__c.track, 600)`);
  check('a sound under the threshold is shut out', r.peak < 0.001, `peak ${r.peak.toFixed(5)}`);
  check('and the gate reports itself shut', !(await page.evaluate('return window.__c.open')));

  // --- what it costs ----------------------------------------------------------------------------------------------------------------
  await sleep(2400);
  const cpu = await page.evaluate('return window.__c.cpu');
  check('the worker says how much of a core it takes, and it is a small share (under 3%)', typeof cpu === 'number' && cpu >= 0 && cpu < 3, String(cpu));

  // --- volume, live -----------------------------------------------------------------------------------------------------------------------
  await page.evaluate('window.__voice.gain.value = 0.1; window.__c.setThreshold(0); return true;');
  await sleep(500);
  const full = await page.evaluate(`return window.__listen(window.__c.track, 500)`);
  await page.evaluate('window.__c.setGain(0.5); return true;');
  await sleep(500);
  const half = await page.evaluate(`return window.__listen(window.__c.track, 500)`);
  check('the volume is applied while it runs', Math.abs(half.peak / full.peak - 0.5) < 0.05, `${full.peak.toFixed(3)} -> ${half.peak.toFixed(3)}`);
  await page.evaluate('window.__c.setGain(2); return true;');
  await sleep(500);
  const boosted = await page.evaluate(`return window.__listen(window.__c.track, 500)`);
  check('and it can be raised past 100%', Math.abs(boosted.peak / full.peak - 2) < 0.1, `${full.peak.toFixed(3)} -> ${boosted.peak.toFixed(3)}`);

  // --- muting the source ---------------------------------------------------------------------------------------------------------------
  await page.evaluate('window.__c.close(); return true;');
  await page.evaluate(`
    window.__src = window.__input();
    window.__c = await window.__gain.workerMicChain(window.__src, { threshold: 0, gain: 1 });
    return true;`);
  await page.evaluate('window.__src.getAudioTracks()[0].enabled = false; return true;');
  await sleep(300);
  r = await page.evaluate(`return window.__listen(window.__c.track, 500)`);
  check('switching the source off silences what comes out', r.peak < 0.001, `peak ${r.peak.toFixed(5)}`);
  await page.evaluate('window.__src.getAudioTracks()[0].enabled = true; return true;');
  await sleep(300);
  r = await page.evaluate(`return window.__listen(window.__c.track, 500)`);
  check('and switching it on brings the sound back', r.peak > 0.1, `peak ${r.peak.toFixed(3)}`);
  await page.evaluate('window.__c.close(); return true;');

  // --- no click where the gate opens and closes -----------------------------------------------------------------------------------------
  const amps = [0.09, 0.05, 0.12, 0.03, 0.07, 0.025, 0.1, 0.04];
  const through = async (make) => page.evaluate(`
    const track = await (${make})();
    const length = window.__speak(${JSON.stringify(amps)});
    const out = await window.__listen(track.track ?? track, length * 1000);
    track.close?.(); return out;`);
  const untouched = await through('async () => window.__source.clone()');
  const worker = await through('() => window.__gain.workerMicChain(window.__input(), { threshold: 0.03 })');
  const valve = await page.evaluate(`
    const sent = window.__source.clone(); const tap = window.__source.clone(); tap.enabled = true; sent.enabled = false;
    const valve = await window.__gain.createMicValve(new MediaStream([tap]), { threshold: 0.03, onChange: (o) => { sent.enabled = o; } });
    const length = window.__speak(${JSON.stringify(amps)});
    const out = await window.__listen(sent, length * 1000);
    valve.close(); tap.stop(); sent.stop(); return out;`);
  check('a gate at work leaves no more click than the microphone left alone',
    worker.clicks < Math.max(untouched.clicks * 20, 1e-6), `${worker.clicks.toExponential(1)} vs ${untouched.clicks.toExponential(1)}`);
  check('where switching the track on and off does (what this replaces)',
    valve.clicks > worker.clicks * 100, `${valve.clicks.toExponential(1)} vs ${worker.clicks.toExponential(1)}`);

  // --- an engine that cannot run it says so ---------------------------------------------------------------------------------------------
  const refused = await page.evaluate(`
    const Real = window.Worker;
    window.Worker = class { constructor() { throw new Error('workers are refused'); } };
    try { await window.__gain.workerMicChain(window.__input(), { threshold: 0.03 }); return 'resolved'; }
    catch (err) { return String(err?.message ?? err); } finally { window.Worker = Real; }`);
  check('a worker that cannot start rejects, so the caller can use something else', refused === 'workers are refused', refused);

  const silent = await page.evaluate(`
    // A worker that starts and says nothing: nothing is coming out, which has to be seen and not published.
    const Real = window.Worker;
    window.Worker = class { constructor() { this.terminate = () => {}; this.postMessage = () => {}; } };
    const t0 = performance.now();
    try { await window.__gain.workerMicChain(window.__input(), { threshold: 0.03 }); return 'resolved'; }
    catch (err) { return { error: String(err?.message ?? err), ms: Math.round(performance.now() - t0) }; } finally { window.Worker = Real; }`);
  check('and so does one that never lets any sound through', silent?.error === 'no sound came out of the gate worker' && silent.ms < 5000, JSON.stringify(silent));
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
