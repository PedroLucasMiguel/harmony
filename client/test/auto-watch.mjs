// "Open streams automatically": on, a share somebody starts opens by itself; off, it is held back as a closed
// square until it is clicked, and only once per share. Cameras are not held back.
//
//   node client/test/auto-watch.mjs

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attach, findPage, launchApp, reporter, sleep } from './cdp.mjs';

const PORT = 9560;
const { check, summary } = reporter();
const app = launchApp({
  port: PORT,
  userDataDir: mkdtempSync(join(tmpdir(), 'harmony-autowatch-')),
  extraArgs: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
process.on('exit', () => { try { app.kill(); } catch { /* gone */ } });

async function run() {
  const page = await attach(await findPage(PORT));
  await sleep(2000);

  const start = await page.evaluate(`
    const s = await harmony.settings.get();
    const box = document.getElementById('auto-watch-streams');
    return { setting: (s.data ?? s).autoWatchStreams, checked: box.checked, session: window.__harmonyVoice().autoWatchShares };`);
  check('it starts on, in the settings, the switch and the session',
    start.setting === true && start.checked === true && start.session === true, JSON.stringify(start));

  const toggled = await page.evaluate(`
    const box = document.getElementById('auto-watch-streams');
    box.click();
    await new Promise((r) => setTimeout(r, 300));
    const s = await harmony.settings.get();
    const off = { setting: (s.data ?? s).autoWatchStreams, session: window.__harmonyVoice().autoWatchShares };
    box.click();
    await new Promise((r) => setTimeout(r, 300));
    const s2 = await harmony.settings.get();
    return { off, back: { setting: (s2.data ?? s2).autoWatchStreams, session: window.__harmonyVoice().autoWatchShares } };`);
  check('the switch is kept and reaches the session, both ways',
    toggled.off.setting === false && toggled.off.session === false && toggled.back.setting === true && toggled.back.session === true,
    JSON.stringify(toggled));

  const held = await page.evaluate(`
    const { VoiceSession } = await import('./voice.js');
    const roster = (shares) => [{ mid: 1, userId: 1 }, { mid: 5, userId: 50, publishing: shares ? ['v', 's', 'c'] : ['v', 'c'] }];
    const tiles = (v) => v.closedTiles.map((t) => t.key + (t.unopened ? '*' : ''));

    const off = new VoiceSession();
    off.mid = 1;
    off.autoWatchShares = false;
    const first = await off.syncVideo(roster(true));
    const afterFirst = tiles(off);
    const again = await off.syncVideo(roster(true));
    // Opening it by hand: it is not held back a second time.
    off.reopenVideo('5:s');
    await off.syncVideo(roster(true));
    const afterOpen = tiles(off);
    // It ends, and starts again.
    await off.syncVideo(roster(false));
    await off.syncVideo(roster(true));
    const afterRestart = tiles(off);

    const on = new VoiceSession();
    on.mid = 1;
    await on.syncVideo(roster(true));
    return { changed: first.changed, afterFirst, againChanged: again.changed, afterOpen, afterRestart, on: tiles(on) };`);
  check('off: a new share is a closed square, not yet opened, and the screen is told to draw it',
    JSON.stringify(held.afterFirst) === '["5:s*"]' && held.changed === true, JSON.stringify(held));
  check('and a camera from the same person is not held back', !held.afterFirst.some((k) => k.startsWith('5:c')), JSON.stringify(held.afterFirst));
  check('and it is not held back again on the next roster push', held.againChanged === false && JSON.stringify(held.afterFirst) === '["5:s*"]', JSON.stringify(held));
  check('opened by hand it stays open, through the pushes after', held.afterOpen.length === 0, JSON.stringify(held.afterOpen));
  check('a share that ends and starts again is held back again', JSON.stringify(held.afterRestart) === '["5:s*"]', JSON.stringify(held.afterRestart));
  check('on: nothing is held back', held.on.length === 0, JSON.stringify(held.on));
}

run().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  const failed = summary();
  setTimeout(() => process.exit(process.exitCode ?? (failed ? 1 : 0)), 200);
});
