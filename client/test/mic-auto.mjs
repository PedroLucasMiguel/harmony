// The automatic gain control and the automatic sensitivity, in the microphone's worker, on a voice-like
// signal whose loudness the test sets -- and the switches in the settings that turn them on.
//
//   node client/test/mic-auto.mjs

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attach, findPage, launchApp, reporter, sleep } from './cdp.mjs';

const PORT = 9593;
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
  // The room: noise at a level the test sets, always there, mixed with the voice.
  const noise = ctx.createBufferSource();
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  { const d = buffer.getChannelData(0); for (let i = 0; i < d.length; i += 1) d[i] = Math.random() * 2 - 1; }
  noise.buffer = buffer; noise.loop = true;
  const room = ctx.createGain(); room.gain.value = 0;
  noise.connect(room); room.connect(dest); noise.start();
  window.__room = room;
  return true;`;


const syllables = (a, n) => JSON.stringify(Array(n).fill(a));

async function run() {
  const app = launchApp({
    port: PORT,
    userDataDir: mkdtempSync(join(tmpdir(), 'harmony-auto-profile-')),
    extraArgs: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  procs.push(app);
  const page = await attach(await findPage(PORT));
  await sleep(2500);
  await page.evaluate(SETUP);

  // --- the switches --------------------------------------------------------------------------------------------------------------------
  const ui = await page.evaluate(`return {
    gain: document.getElementById('mic-auto-gain')?.checked,
    auto: document.getElementById('mic-auto-sensitivity')?.checked,
    hasGain: Boolean(document.getElementById('mic-auto-gain')),
    hasAuto: Boolean(document.getElementById('mic-auto-sensitivity')),
    settings: await window.harmony.settings.get().then((s) => { const d = s.data ?? s; return { gain: d.micAutoGain, auto: d.micAutoSensitivity }; }),
  }`);
  check('both are in the settings, and both are off by default', ui.hasGain && ui.hasAuto && ui.gain === false && ui.auto === false
    && ui.settings.gain === false && ui.settings.auto === false, JSON.stringify(ui));

  // --- the gain control ------------------------------------------------------------------------------------------------------------------
  // A quiet voice, 24 syllables with a pause between each, through a chain without and a chain with it.
  const peakOf = (options, amp, seconds) => page.evaluate(`
    window.__room.gain.value = 0;
    const chain = await window.__gain.workerMicChain(window.__input(), ${JSON.stringify(options)});
    const length = window.__speak(${syllables(amp, 24)});
    // Listen to the last few seconds only: it has had the time to settle by then.
    await new Promise((r) => setTimeout(r, (length - ${seconds}) * 1000));
    const out = await window.__listen(chain.track, ${seconds} * 1000);
    const gain = chain.agcGain; chain.close(); return { ...out, gain };`);
  const quietOff = await peakOf({ gain: 1 }, 0.01, 3);
  const quietOn = await peakOf({ gain: 1, agc: true }, 0.01, 3);
  check('a quiet voice comes out several times louder with the gain control on',
    quietOn.peak > quietOff.peak * 4, `${quietOff.peak.toFixed(3)} -> ${quietOn.peak.toFixed(3)} (gain ${quietOn.gain.toFixed(1)})`);
  check('and never over full scale', quietOn.peak <= 1, quietOn.peak.toFixed(3));
  check('the chain says what gain it is applying', quietOn.gain > 4 && quietOff.gain === 1, `${quietOn.gain} / ${quietOff.gain}`);

  const loudOff = await peakOf({ gain: 1 }, 0.3, 3);
  const loudOn = await peakOf({ gain: 1, agc: true }, 0.3, 3);
  check('a loud voice is brought down', loudOn.peak < loudOff.peak * 0.7, `${loudOff.peak.toFixed(3)} -> ${loudOn.peak.toFixed(3)}`);

  // It is for the voice at the top of the input volume too: the case of the people it is for.
  const topOff = await peakOf({ gain: 3.5 }, 0.002, 3);
  const topOn = await peakOf({ gain: 3.5, agc: true }, 0.002, 3);
  check('a microphone too quiet even at 350% is brought up', topOn.peak > topOff.peak * 3 && topOn.peak > 0.2, `${topOff.peak.toFixed(3)} -> ${topOn.peak.toFixed(3)}`);

  // Live: switched on and off while the sound runs.
  const live = await page.evaluate(`
    window.__room.gain.value = 0;
    const chain = await window.__gain.workerMicChain(window.__input(), { gain: 1 });
    const length = window.__speak(${syllables(0.01, 30)});
    await new Promise((r) => setTimeout(r, 1000));
    const before = await window.__listen(chain.track, 1500);
    chain.setAgc(true);
    await new Promise((r) => setTimeout(r, 9000));
    const on = await window.__listen(chain.track, 2500);
    chain.setAgc(false);
    await new Promise((r) => setTimeout(r, 600));
    const off = await window.__listen(chain.track, 2000);
    chain.close(); return { before: before.peak, on: on.peak, off: off.peak };`);
  check('it is switched on while the call goes on, and off again', live.on > live.before * 4 && live.off < live.on / 3, JSON.stringify(live));

  // --- the automatic sensitivity ---------------------------------------------------------------------------------------------------------
  // A room at an RMS of about 0.0035 (noise of 0.006 over 1) and a voice at about 0.06.
  const found = await page.evaluate(`
    window.__room.gain.value = 0.006;
    const chain = await window.__gain.workerMicChain(window.__input(), { gain: 1, auto: true });
    const length = window.__speak(${syllables(0.04, 20)});
    await new Promise((r) => setTimeout(r, 8000));
    const threshold = chain.threshold;
    // During a syllable the gate is open and the sound is through; once it is over it is shut and the room is not heard.
    const speaking = await window.__listen(chain.track, 1000);
    await new Promise((r) => setTimeout(r, (length - 9) * 1000 + 1500));
    window.__voice.gain.cancelScheduledValues(0); window.__voice.gain.value = 0;
    await new Promise((r) => setTimeout(r, 1200));
    const room = await window.__listen(chain.track, 800);
    chain.close(); return { threshold, speaking: speaking.peak, room: room.peak };`);
  check('it finds a threshold above the room and below the voice', found.threshold > 0.0035 * 1.4 && found.threshold < 0.06 * 0.4, String(found.threshold));
  check('the voice gets through it', found.speaking > 0.04, found.speaking.toFixed(3));
  check('and the room does not', found.room < 0.001, found.room.toFixed(5));

  // The same quiet voice a fixed threshold would cut, and the one that is found does not.
  const quiet = await page.evaluate(`
    window.__room.gain.value = 0.0008;
    const chain = await window.__gain.workerMicChain(window.__input(), { gain: 1, auto: true });
    const length = window.__speak(${syllables(0.003, 20)});
    await new Promise((r) => setTimeout(r, 7000));
    const threshold = chain.threshold;
    const out = await window.__listen(chain.track, 1400);
    chain.close(); return { threshold, peak: out.peak };`);
  check('a quiet voice in a quiet room is not cut', quiet.threshold < 0.003 * 0.7 && quiet.peak > 0.003, JSON.stringify(quiet));

  const manual = await page.evaluate(`
    window.__room.gain.value = 0.006;
    const chain = await window.__gain.workerMicChain(window.__input(), { gain: 1, threshold: 0.02 });
    await new Promise((r) => setTimeout(r, 1200));
    const set = chain.threshold; chain.setAuto(true);
    window.__speak(${syllables(0.04, 20)});
    await new Promise((r) => setTimeout(r, 7000));
    const found = chain.threshold; chain.close(); return { set, found };`);
  check('switched on live, the threshold stops being the one that was set', manual.set === 0.02 && manual.found !== 0.02 && manual.found < 0.02, JSON.stringify(manual));

  // --- with both, and the browser's own gain control -------------------------------------------------------------------------------------
  const both = await page.evaluate(`
    window.__room.gain.value = 0.003;
    const chain = await window.__gain.workerMicChain(window.__input(), { gain: 1, auto: true, agc: true });
    const length = window.__speak(${syllables(0.01, 28)});
    await new Promise((r) => setTimeout(r, (length - 4) * 1000));
    const speech = await window.__listen(chain.track, 3000);
    chain.close(); return speech.peak;`);
  check('together, a quiet voice in a room still comes out loud', both > 0.1 && both <= 1, both.toFixed(3));
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
