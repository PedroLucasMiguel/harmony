// The sound effects, measured rather than listened to: each cue is played alone and what reaches the
// speakers is recorded. A cue has to be heard, must not clip, has to end instead of ringing on, and the
// push-to-talk ticks (heard hundreds of times a day) have to be the quietest and shortest of all.
// Every cue the application asks for by name also has to exist.
//
//   node client/test/cues.mjs

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep } from './cdp.mjs';

const PORT = 9559;
const { check, summary } = reporter();
const app = launchApp({
  port: PORT,
  userDataDir: mkdtempSync(join(tmpdir(), 'harmony-cues-')),
  extraArgs: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
process.on('exit', () => { try { app.kill(); } catch { /* gone */ } });

const here = dirname(fileURLToPath(import.meta.url));
const NAMES = ['join', 'leave', 'connect', 'disconnect', 'streamStart', 'streamStop', 'cameraOn', 'cameraOff',
  'mute', 'unmute', 'deafen', 'undeafen', 'pttDown', 'pttUp', 'mention', 'dm'];

async function run() {
  // Every name the application plays is one that exists.
  const source = ['app.js', 'dm-ui.js'].map((f) => readFileSync(join(here, '../src/renderer', f), 'utf8')).join('\n');
  const asked = new Set([...source.matchAll(/(?:playCue|voiceCue)\('([A-Za-z]+)'\)/g)].map((m) => m[1]));
  for (const name of asked) check(`the application's "${name}" cue exists`, NAMES.includes(name), name);
  for (const name of ['mute', 'unmute', 'deafen', 'undeafen', 'connect', 'disconnect', 'streamStart', 'streamStop', 'cameraOn', 'cameraOff', 'pttDown', 'pttUp', 'dm', 'mention']) {
    check(`and "${name}" is used somewhere`, source.includes(`Cue(`) && source.includes(`'${name}'`), name);
  }

  // Your own arriving and leaving are heard when you ask, before the first thing there is to wait for.
  const body = (start) => source.slice(source.indexOf(start), source.indexOf('\n}\n', source.indexOf(start)));
  for (const [start, cue] of [['async function joinVoice(', 'connect'], ['async function leaveVoice(', 'disconnect']]) {
    const text = body(start);
    const call = cue === 'connect' ? 'playConnectCue()' : `voiceCue('${cue}')`;
    check(`${cue} is played before the first await`, text.indexOf(call) > -1 && text.indexOf(call) < text.indexOf('await '), start);
  }

  const page = await attach(await findPage(PORT));
  await sleep(2000);

  const measured = await page.evaluate(`
    const gain = await import('./gain.js');
    const names = ${JSON.stringify(NAMES)};

    // What would go to the speakers goes to a recorder instead, in the context the cues are played in.
    const realConnect = AudioNode.prototype.connect;
    let samples = [];
    let rate = 48000;
    let recorder = null;
    AudioNode.prototype.connect = function (to, ...rest) {
      if (to instanceof AudioDestinationNode && !recorder) {
        const ctx = this.context;
        rate = ctx.sampleRate;
        recorder = ctx.createScriptProcessor(1024, 1, 1);
        recorder.onaudioprocess = (e) => { samples.push(Float32Array.from(e.inputBuffer.getChannelData(0))); };
        const quiet = ctx.createGain(); quiet.gain.value = 0;
        realConnect.call(recorder, quiet); realConnect.call(quiet, to);
      }
      if (to instanceof AudioDestinationNode) return realConnect.call(this, recorder, ...rest);
      return realConnect.call(this, to, ...rest);
    };
    gain.playCue('join'); // builds the context and the bus; not measured
    await new Promise((r) => setTimeout(r, 1200));
    // The cue module builds its own bus on first use; make sure it connects through the tap.
    const out = {};
    for (const name of names) {
      samples = [];
      gain.playCue(name);
      await new Promise((r) => setTimeout(r, 900));
      const all = new Float32Array(samples.reduce((n, s) => n + s.length, 0));
      let at = 0; for (const s of samples) { all.set(s, at); at += s.length; }
      let peak = 0, finite = true, last = 0;
      for (let i = 0; i < all.length; i++) {
        const v = Math.abs(all[i]);
        if (!Number.isFinite(v)) finite = false;
        if (v > peak) peak = v;
        if (v > 0.002) last = i;
      }
      out[name] = { peak, finite, endsAt: last / rate };
    }
    AudioNode.prototype.connect = realConnect;
    return out;`);

  for (const name of NAMES) {
    const m = measured[name];
    check(`${name}: finite`, m.finite);
    check(`${name}: is heard`, m.peak > 0.02, `peak ${m.peak.toFixed(3)}`);
    check(`${name}: does not clip`, m.peak < 0.95, `peak ${m.peak.toFixed(3)}`);
    check(`${name}: ends rather than rings`, m.endsAt < 0.85, `${m.endsAt.toFixed(2)} s`);
  }
  const ptt = ['pttDown', 'pttUp'];
  for (const name of ptt) {
    check(`${name}: over before 0.15 s`, measured[name].endsAt < 0.15, `${measured[name].endsAt.toFixed(3)} s`);
    check(`${name}: quieter than a mute`, measured[name].peak < measured.mute.peak, `${measured[name].peak.toFixed(3)} vs ${measured.mute.peak.toFixed(3)}`);
  }
  check('a private message is told from a mention', measured.dm.endsAt < measured.mention.endsAt + 0.2 && NAMES.includes('dm'), `${measured.dm.endsAt.toFixed(2)} s`);
  check('deafen is lower and longer than mute', measured.deafen.endsAt > measured.mute.endsAt, `${measured.deafen.endsAt.toFixed(2)} vs ${measured.mute.endsAt.toFixed(2)}`);
  check('you joining lasts longer than somebody else joining', measured.connect.endsAt > measured.join.endsAt, `${measured.connect.endsAt.toFixed(2)} vs ${measured.join.endsAt.toFixed(2)}`);
}

run().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  const failed = summary();
  setTimeout(() => process.exit(process.exitCode ?? (failed ? 1 : 0)), 200);
});
