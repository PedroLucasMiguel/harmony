// Fixes made together, checked where they can be checked without a call:
//   - a stream that is fullscreen stays fullscreen when the tiles are placed again (every roster change does);
//   - a soundpad clip can be stopped, including one still being loaded;
//   - the speakers that were chosen are the ones in use from the start, not once the settings are opened;
//   - the soundpad's Stop is an admin's.
//
//   node client/test/session-fixes.mjs

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attach, findPage, launchApp, reporter, sleep } from './cdp.mjs';

const PORT = 9561;
const { check, summary } = reporter();
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-fixes-'));

// A speaker chosen in an earlier run. Device ids belong to a profile, so the first run is in the same one: it
// lists the outputs and saves the second, and the run after it is the one that is looked at.
const FLAGS = ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--use-fake-device-for-media-stream'];
async function chooseOutput() {
  const app = launchApp({ port: PORT, userDataDir, extraArgs: FLAGS });
  try {
    const page = await attach(await findPage(PORT));
    await sleep(2500);
    return await page.evaluate(`
      const outputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput').map((d) => d.deviceId);
      const chosen = outputs.find((id) => id && id !== 'default') ?? null;
      if (chosen) await harmony.settings.set({ voiceOutputId: chosen });
      return chosen;`);
  } finally {
    app.kill();
    await sleep(1500);
  }
}

async function run() {
  const chosen = await chooseOutput();

  const app = launchApp({ port: PORT + 1, userDataDir, extraArgs: FLAGS });
  process.on('exit', () => { try { app.kill(); } catch { /* gone */ } });
  const page = await attach(await findPage(PORT + 1));
  await sleep(3000);

  // --- fullscreen --------------------------------------------------------------------------------------------------
  const full = await page.evaluate(`
    const place = window.__harmonyPlaceChildren;
    const parent = document.createElement('div');
    document.body.append(parent);
    const [a, b, c] = ['a', 'b', 'c'].map((k) => { const f = document.createElement('figure'); f.dataset.key = k; f.textContent = k; return f; });
    place(parent, [a, b, c]);
    b.requestFullscreen().catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
    const before = document.fullscreenElement === b;
    // The same tiles in the same places, as every roster change asks for.
    place(parent, [a, b, c]);
    const same = document.fullscreenElement === b;
    // Another tile arriving before it, and one going: it still has not moved.
    const d = document.createElement('figure'); d.dataset.key = 'd';
    place(parent, [a, d, b]);
    const moved = document.fullscreenElement === b;
    const order = [...parent.children].map((n) => n.dataset.key).join('');
    document.exitFullscreen().catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    parent.remove();
    return { before, same, moved, order };`, { userGesture: true });
  check('a fullscreen stream is still fullscreen after its tiles are placed again, unchanged',
    full.before && full.same, JSON.stringify(full));
  check('and after another tile is put in front of it and one taken out', full.moved && full.order === 'adb', JSON.stringify(full));

  // --- soundpad ----------------------------------------------------------------------------------------------------
  const clip = await page.evaluate(`
    const gain = await import('./gain.js');
    // Two seconds of a tone, as a file: a blob is the page's own, so the policy lets it be fetched.
    const rate = 8000, n = rate * 2;
    const view = new DataView(new ArrayBuffer(44 + n * 2));
    const str = (o, s) => [...s].forEach((ch, i) => view.setUint8(o + i, ch.charCodeAt(0)));
    str(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) view.setInt16(44 + i * 2, Math.round(Math.sin(i / 8) * 8000), true);
    const url = 'clip://one';
    // The page may not fetch a blob (its policy allows its own origin only), so the fetch is the one thing stood in for.
    const bytes = view.buffer;
    window.fetch = async () => new Response(bytes.slice(0));
    try {
      await gain.playSample(url);
    } catch (err) { return { error: String(err.message) }; }
    const playing = gain.cueStatus().playingClips;
    gain.stopSamples();
    const after = gain.cueStatus().playingClips;
    // Stopped while still being fetched: not played once it arrives.
    const late = gain.playSample(url + '#again');
    gain.stopSamples();
    const lateSource = await late.catch(() => 'failed');
    return { playing, after, late: lateSource === null ? 'not played' : String(lateSource) };`);
  if (clip.error) {
    check('a soundpad clip can be played and stopped', false, clip.error);
  } else {
    check('a clip that is playing is stopped, and nothing is left playing', clip.playing >= 1 && clip.after === 0, JSON.stringify(clip));
    check('and one that was still being loaded when the stop came is not played after it', clip.late === 'not played' || clip.late === 'failed', JSON.stringify(clip));
  }

  const stop = await page.evaluate(`
    const b = document.getElementById('soundpad-stop');
    return { exists: Boolean(b), hiddenWithoutAdmin: b?.hidden };`);
  check('the Stop button is in the soundpad, and hidden from somebody who is not an admin', stop.exists && stop.hiddenWithoutAdmin === true, JSON.stringify(stop));

  // --- the speakers ------------------------------------------------------------------------------------------------
  if (chosen) {
    const sink = await page.evaluate(`
      const gain = await import('./gain.js');
      await new Promise((r) => setTimeout(r, 500));
      return gain.cueStatus().sinkId;`);
    check('the speakers chosen in the settings are in use from the start, with the settings never opened', sink === chosen, `${sink} vs ${chosen}`);
  } else {
    console.log('  skip  the speakers: this machine lists no second output to choose');
  }
}

run().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  const failed = summary();
  setTimeout(() => process.exit(process.exitCode ?? (failed ? 1 : 0)), 200);
});
