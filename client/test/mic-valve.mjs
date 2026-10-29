// The noise gate as a valve on the published track, in a real Chromium.
//
// With the volume at 100% the microphone goes out untouched, and the gate only
// decides when the real track is switched on and off (see createMicValve). Two
// things have to hold: the valve must go on hearing while the real track is
// switched off -- or a closed gate could never reopen -- and an engine that
// will not run the worklet must say so, so that the caller can put the gate in
// the chain instead of having no gate at all.
//
//   node client/test/mic-valve.mjs

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attach, findPage, launchApp, reporter, sleep } from './cdp.mjs';

const PORT = 9564;
const { check, summary } = reporter();
const procs = [];
process.on('exit', () => procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } }));
process.on('SIGINT', () => process.exit(130));

const SETUP = `
  const { createMicValve } = await import('./gain.js');
  window.__createMicValve = createMicValve;
  window.__make = async (threshold) => {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator(); osc.frequency.value = 220;
    const level = ctx.createGain(); level.gain.value = 0;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(level); level.connect(dest); osc.start();
    // The track that is sent, and the clone that is listened to.
    const sent = dest.stream.getAudioTracks()[0];
    const tap = sent.clone(); tap.enabled = true;
    const changes = [];
    const valve = await createMicValve(new MediaStream([tap]), {
      threshold,
      onChange: (open) => { sent.enabled = open; changes.push(open); },
    });
    return { valve, sent, tap, changes, amplitude: (a) => level.gain.setValueAtTime(a, ctx.currentTime) };
  };
  return true;`;

async function run() {
  const app = launchApp({
    port: PORT,
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-valve-profile-')),
    extraArgs: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  procs.push(app);
  const page = await attach(await findPage(PORT));
  await sleep(2500);
  await page.evaluate(SETUP);

  await page.evaluate('window.__m = await window.__make(0.05); return true;');
  let state = await page.evaluate('return { open: window.__m.valve.open, enabled: window.__m.sent.enabled }');
  check('a gate that is set starts shut', state.open === false, JSON.stringify(state));

  await page.evaluate('window.__m.amplitude(0.1); return true;');
  await sleep(700);
  state = await page.evaluate('return { open: window.__m.valve.open, enabled: window.__m.sent.enabled, level: window.__m.valve.level }');
  check('a loud sound opens it, and the track that is sent is switched on',
    state.open && state.enabled && Math.abs(state.level - 0.0707) < 0.02, JSON.stringify(state));

  await page.evaluate('window.__m.amplitude(0.02); return true;');
  await sleep(1000);
  state = await page.evaluate('return { open: window.__m.valve.open, enabled: window.__m.sent.enabled, level: window.__m.valve.level }');
  check('a quiet one shuts it, and the track is switched off', !state.open && !state.enabled, JSON.stringify(state));
  check('and the valve still hears the room while the track is off', Math.abs(state.level - 0.0141) < 0.008, state.level.toFixed(4));

  await page.evaluate('window.__m.amplitude(0.1); return true;');
  await sleep(700);
  state = await page.evaluate('return { open: window.__m.valve.open, enabled: window.__m.sent.enabled }');
  check('so that speech after a silence opens it again', state.open && state.enabled, JSON.stringify(state));

  // --- the threshold is live ---------------------------------------------------------------------------------------
  await page.evaluate('window.__m.valve.setThreshold(0.2); return true;');
  await sleep(900);
  state = await page.evaluate('return { open: window.__m.valve.open, enabled: window.__m.sent.enabled }');
  check('raising the threshold above the sound shuts it', !state.open && !state.enabled, JSON.stringify(state));

  await page.evaluate('window.__m.valve.setThreshold(0); return true;');
  await sleep(700);
  state = await page.evaluate('return { open: window.__m.valve.open, enabled: window.__m.sent.enabled }');
  check('and threshold 0 takes the gate away', state.open && state.enabled, JSON.stringify(state));

  const changes = await page.evaluate('return window.__m.changes');
  check('every change of state was reported, once', changes.length >= 4 && changes.every((c, i) => i === 0 || c !== changes[i - 1]), JSON.stringify(changes));

  await page.evaluate('window.__m.valve.close(); window.__m.tap.stop(); return true;');

  // --- a worklet that will not load: the valve says so ---------------------------------------------------------------
  await page.evaluate('location.reload(); return true;');
  await sleep(3500);
  await page.evaluate("AudioWorklet.prototype.addModule = () => Promise.reject(new Error('refused')); return true;");
  await page.evaluate(SETUP);
  const refused = await page.evaluate(`
    try { await window.__make(0.05); return 'resolved'; } catch (err) { return String(err?.message ?? err); }`);
  check('if the worklet will not load the valve refuses, and the caller can use the chain', refused === 'refused', refused);
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
