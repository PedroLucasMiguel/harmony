// A name with a moving colour costs next to nothing: stepped, and stopped while the window is behind another.
//
//   node client/test/name-animation.mjs

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attach, findPage, launchApp, reporter, sleep } from './cdp.mjs';

const { check, summary } = reporter();
const app = launchApp({ port: 9557, userDataDir: mkdtempSync(join(tmpdir(), 'harmony-na-')) });
process.on('exit', () => { try { app.kill(); } catch { /* gone */ } });

async function run() {
  const cdp = await attach(await findPage(9557));
  await sleep(1500);
  await cdp.evaluate(`
    const s = document.createElement('span'); s.id = 'probe-name'; s.textContent = 'moving'; s.setAttribute('data-name-style', 'rainbow');
    document.body.append(s); return true;`);
  const style = () => cdp.evaluate(`
    const cs = getComputedStyle(document.getElementById('probe-name'));
    return { timing: cs.animationTimingFunction, state: cs.animationPlayState, name: cs.animationName, blurred: document.documentElement.hasAttribute('data-blurred') };`);

  const focused = await style();
  check('a name with a moving colour is animated in steps, not smoothly', /steps\(120/.test(focused.timing) && focused.name === 'name-flow', JSON.stringify(focused));

  // The window goes behind a game: the handler marks the page, and the rule stops the animation.
  await cdp.evaluate("document.documentElement.setAttribute('data-blurred', ''); return true;");
  check('with the window marked as behind, the animation is paused', (await style()).state === 'paused', JSON.stringify(await style()));
  await cdp.evaluate("document.documentElement.removeAttribute('data-blurred'); return true;");
  check('and runs again when it comes back', (await style()).state === 'running', JSON.stringify(await style()));
}

run().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  const failed = summary();
  setTimeout(() => process.exit(process.exitCode ?? (failed ? 1 : 0)), 200);
});
