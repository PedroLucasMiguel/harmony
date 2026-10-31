// The master volume: one gain in front of the speakers, for everything the application plays;
// and the level of each person, which has to outlive the app.
//
// Measured on the graph rather than by ear: whatever is played (a voice sink, a monitor, a cue)
// has to end at the same node, and that node has to follow the setting.
//
//   node client/test/master-volume.mjs

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attach, findPage, launchApp, reporter, sleep } from './cdp.mjs';

const PORT = 9558;
const { check, summary } = reporter();
const app = launchApp({
  port: PORT,
  userDataDir: mkdtempSync(join(tmpdir(), 'harmony-master-')),
  extraArgs: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
process.on('exit', () => { try { app.kill(); } catch { /* gone */ } });

async function run() {
  const page = await attach(await findPage(PORT));
  await sleep(2000);

  const defaults = await page.evaluate('const s = await harmony.settings.get(); return s.data ?? s;');
  check('the setting starts at 100%', defaults.masterVolume === 100, String(defaults.masterVolume));
  check('and nobody has been turned down yet', JSON.stringify(defaults.peerVolumes) === '{}', JSON.stringify(defaults.peerVolumes));

  const graph = await page.evaluate(`
    const gain = await import('./gain.js');
    // Everything that connects to something, from now on: where each sound goes next.
    const edges = [];
    const real = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (to, ...rest) { edges.push({ from: this, to }); return real.call(this, to, ...rest); };

    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest); osc.start();
    edges.length = 0;

    const stream = dest.stream;
    const sink = gain.createSink(stream);
    const monitor = gain.monitorStream(stream, 1);
    gain.playCue('join');
    await new Promise((r) => setTimeout(r, 100));
    AudioNode.prototype.connect = real;

    const speakers = edges.filter((e) => e.to instanceof AudioDestinationNode);
    // The node the sink and the monitor hand their sound to.
    const masters = new Set(edges.filter((e) => e.from instanceof GainNode && e.to instanceof GainNode).map((e) => e.to));
    const results = { direct: speakers.filter((e) => !(e.from instanceof GainNode)).length, masters: masters.size };
    sink.close(); monitor?.close();
    return results;`);
  check('nothing plays straight to the speakers', graph.direct === 0, JSON.stringify(graph));

  const ceiling = await page.evaluate(`
    const gain = await import('./gain.js');
    const ok = [gain.setMasterVolume(0.5), gain.setMasterVolume(9), gain.setMasterVolume(-3), gain.setMasterVolume('x')];
    gain.setMasterVolume(1);
    return ok;`);
  check('the volume is kept between silence and twice the set levels', JSON.stringify(ceiling) === JSON.stringify([0.5, 2, 0, 0]), JSON.stringify(ceiling));

  const follows = await page.evaluate(`
    const gain = await import('./gain.js');
    const ctx = new AudioContext();
    const osc = ctx.createOscillator(); const dest = ctx.createMediaStreamDestination(); osc.connect(dest); osc.start();
    // The first node a sink connects to is the master.
    let master = null;
    const real = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (to, ...rest) { if (!master && to instanceof GainNode && this instanceof GainNode) master = to; return real.call(this, to, ...rest); };
    const sink = gain.createSink(dest.stream);
    AudioNode.prototype.connect = real;
    const at = async (v) => { gain.setMasterVolume(v); await new Promise((r) => setTimeout(r, 300)); return Number(master.gain.value.toFixed(3)); };
    const out = { half: await at(0.5), boost: await at(2), silent: await at(0), whole: await at(1) };
    sink.close();
    return out;`);
  check('the one node in front of the speakers follows it, live', follows.half === 0.5 && follows.boost === 2 && follows.silent === 0 && follows.whole === 1, JSON.stringify(follows));

  // --- a person's level outliving the app -------------------------------------------------------------------------------------------------
  // Turning somebody down used to live only in memory, so every restart (an update included) put everybody back at 100%.
  const kept = await page.evaluate(`
    const voice = window.__harmonyVoice();
    voice.setPeerGain(42, 0.8);
    voice.setPeerMuted(43, true);
    voice.setPeerGain(44, 1);
    await new Promise((r) => setTimeout(r, 900));
    const s = await harmony.settings.get();
    return Object.values((s.data ?? s).peerVolumes ?? {}).map((people) => ({ ...people }))[0] ?? null;`);
  check("a person's volume and mute are written to the settings, under the server they are on",
    Math.abs((kept?.[42]?.gain ?? 0) - 0.8) < 1e-9 && kept?.[43]?.muted === true, JSON.stringify(kept));
  check('and somebody left at 100% and not muted takes no room there', kept && !(44 in kept), JSON.stringify(kept));

  const restored = await page.evaluate(`
    const { VoiceSession } = await import('./voice.js');
    const session = new VoiceSession();
    session.loadPeerPrefs({ 7: { gain: 0.8, muted: false }, 9: { gain: 9, muted: true }, nope: { gain: 0.1 } });
    return { seven: session.peerGain(7), nine: session.peerGain(9), nineMuted: session.peerMuted(9), other: session.peerGain(8) };`);
  check('a session starts from what was kept: the level, the mute, the 350% ceiling, and 100% for everybody else',
    restored.seven === 0.8 && restored.nine === 3.5 && restored.nineMuted === true && restored.other === 1, JSON.stringify(restored));

  // --- and the level of somebody's screen share, which used to be forgotten as soon as the call ended ----------------------------------------
  const streams = await page.evaluate(`
    const voice = window.__harmonyVoice();
    voice.lastRoster = [{ mid: 5, userId: 50 }, { mid: 6, userId: 51 }];
    voice.setTileGain('5:s', 0.4);
    voice.setTileGain('6:s', 1);
    voice.setTileGain('5:c', 0.2);
    await new Promise((r) => setTimeout(r, 900));
    const s = await harmony.settings.get();
    return Object.values((s.data ?? s).streamVolumes ?? {})[0] ?? null;`);
  check("a person's share level is written to the settings, by person and not by slot",
    streams && Math.abs((streams[50] ?? 0) - 0.4) < 1e-9, JSON.stringify(streams));
  check('and a share left at 100%, or a camera, takes no room there', streams && !(51 in streams) && Object.keys(streams).length === 1, JSON.stringify(streams));

  const again = await page.evaluate(`
    const { VoiceSession } = await import('./voice.js');
    const session = new VoiceSession();
    session.loadStreamPrefs({ 50: 0.4, 52: 9, nope: 0.1 });
    // The same person, in a different slot than before.
    session.lastRoster = [{ mid: 9, userId: 50 }, { mid: 10, userId: 52 }, { mid: 11, userId: 53 }];
    return { same: session.tileGain('9:s'), camera: session.tileGain('9:c'), ceiling: session.tileGain('10:s'), other: session.tileGain('11:s') };`);
  check('a share opens at the level kept for its owner, in whatever slot they have now, capped like any other',
    again.same === 0.4 && again.camera === 1 && again.ceiling === 3.5 && again.other === 1, JSON.stringify(again));

  // A change made a moment before the window goes is written at once, not after the wait.
  const hurried = await page.evaluate(`
    const voice = window.__harmonyVoice();
    voice.lastRoster = [{ mid: 7, userId: 60 }];
    voice.setTileGain('7:s', 0.3);
    window.dispatchEvent(new Event('pagehide'));
    await new Promise((r) => setTimeout(r, 150));
    const s = await harmony.settings.get();
    return Object.values((s.data ?? s).streamVolumes ?? {})[0]?.[60] ?? null;`);
  check('and one made as the window goes is written at once', hurried === 0.3, String(hurried));

  await page.evaluate('await harmony.settings.set({ masterVolume: 100, peerVolumes: {}, streamVolumes: {} }); return true;');
}

run().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  const failed = summary();
  setTimeout(() => process.exit(process.exitCode ?? (failed ? 1 : 0)), 200);
});
