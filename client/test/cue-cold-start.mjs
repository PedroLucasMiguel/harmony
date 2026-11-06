// The sound for joining a room, the first time one is played in a session.
//
// The audio output is not running until something starts it, and the first sound of a session used to be
// scheduled while it was still opening (it broke up). And joining is when the saved speakers are found, which
// restarts the output while that sound is still ringing (it was cut off). Measured at the audio API: when each
// note is scheduled, against what the context is doing, and when the speakers are switched, against the sound.
//
// (Electron lets sound start without a gesture, so the output is normally running from the start; the parked case
// is made by suspending the context, which is what a browser's autoplay policy or the system does to it.)
//
//   node client/test/cue-cold-start.mjs

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attach, findPage, launchApp, reporter, sleep } from './cdp.mjs';

const PORT = 9573;
const { check, summary } = reporter();
const app = launchApp({ port: PORT, userDataDir: mkdtempSync(join(tmpdir(), 'harmony-cold-')), extraArgs: ['--mute-audio'] });
process.on('exit', () => { try { app.kill(); } catch { /* gone */ } });
const page = await attach(await findPage(PORT));
await sleep(2500);

// What happens to the audio API, from here on: every note scheduled, every change of speakers, and the context the
// cues play through (found by the first note).
await page.evaluate(`
  window.__notes = []; window.__sinks = []; window.__ctx = null;
  const start = OscillatorNode.prototype.start;
  OscillatorNode.prototype.start = function (when, ...rest) {
    window.__ctx = this.context;
    window.__notes.push({ state: this.context.state, ahead: when - this.context.currentTime, at: performance.now() });
    return start.call(this, when, ...rest);
  };
  AudioContext.prototype.setSinkId = async function (id) { window.__sinks.push({ id, at: performance.now() }); };
  return true;`);
const status = () => page.evaluate("const g = await import('./gain.js'); return g.cueStatus().context;");
const cue = (name = 'connect') => page.evaluate(`const g = await import('./gain.js'); g.playCue(${JSON.stringify(name)}); return true;`);

// The first thing a person does: a click. It makes sure the output is made and running, long before a sound is wanted.
await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 400, y: 300, button: 'left', clickCount: 1 });
await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 400, y: 300, button: 'left', clickCount: 1 });
await sleep(600);
check('after the first click the output is running, so that the first sound is not what opens it', (await status()) === 'running', await status());

/** What the notes of one cue did: how soon the first one starts, and whether all were placed on a running output. */
const placed = (notes) => ({ n: notes.length, running: notes.every((x) => x.state === 'running'), first: Math.min(...notes.map((x) => x.ahead)) });

// A cue on a running output: placed just ahead, as it always was.
await cue();
await sleep(900);
const warm = await page.evaluate('return window.__notes;');
check('on a running output the notes are placed just ahead', warm.length > 0 && placed(warm).running && placed(warm).first < 0.05, JSON.stringify(placed(warm)));

// A cold one: the output parked, then a sound asked for. The notes wait for it to run, and start a little later.
await page.evaluate('window.__notes.length = 0; await window.__ctx.suspend(); return true;');
check('(the output is parked)', (await status()) === 'suspended', await status());
await cue();
await sleep(1200);
const cold = await page.evaluate('return window.__notes;');
check('a sound asked for while the output is not running is not placed until it is', cold.length > 0 && placed(cold).running, JSON.stringify(placed(cold)));
check('and with room for the device to settle before the first note', cold.length > 0 && placed(cold).first >= 0.07, JSON.stringify(placed(cold)));

// Joining finds the saved speakers while the arriving sound is ringing: the switch waits for it to end.
await sleep(1500);
await page.evaluate('window.__sinks.length = 0; return true;');
await cue();
const t0 = await page.evaluate('return performance.now();');
await page.evaluate("const g = await import('./gain.js'); await g.setOutputDevice('some-other-speakers'); return true;");
const late = await page.evaluate('return window.__sinks;');
check('the speakers are switched once, after the sound that was playing', late.length === 1 && late[0].at - t0 >= 450, JSON.stringify({ late, waited: late[0] ? late[0].at - t0 : null }));

// With nothing playing the switch is at once.
await sleep(1500);
await page.evaluate('window.__sinks.length = 0; return true;');
const t1 = await page.evaluate('return performance.now();');
await page.evaluate("const g = await import('./gain.js'); await g.setOutputDevice('yet-other-speakers'); return true;");
const now = await page.evaluate('return window.__sinks;');
check('and with nothing playing, at once', now.length === 1 && now[0].at - t1 < 100, JSON.stringify({ now, waited: now[0] ? now[0].at - t1 : null }));

const failed = summary();
process.exit(failed ? 1 : 0);
