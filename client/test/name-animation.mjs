// A name with a moving colour costs next to nothing: moved from one timer, only while it can be seen, a few
// times a second, and not at all while the window is behind another.
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
  // The window may or may not have focus in a test run; the page's own marking is what the motion reads.
  await cdp.evaluate(`
    document.documentElement.removeAttribute('data-blurred');
    const box = document.createElement('div'); box.id = 'probe-box';
    box.style.cssText = 'position:fixed;top:0;right:0;width:260px;height:60px;overflow:auto;background:#222;z-index:99999';
    const add = (id, speed) => {
      const row = document.createElement('div'); row.style.cssText = 'height:20px';
      const s = document.createElement('span'); s.id = id; s.textContent = 'moving'; s.setAttribute('data-name-style', 'rainbow');
      if (speed) s.style.setProperty('--name-speed', speed + 's');
      row.append(s); box.append(row);
    };
    add('near'); add('fast', 2); add('slow', 24);
    for (let i = 0; i < 12; i += 1) add('filler-' + i);
    document.body.append(box); return true;`);
  await sleep(600);

  const x = (id) => cdp.evaluate(`return parseFloat(getComputedStyle(document.getElementById('${id}')).backgroundPositionX)`);
  const css = await cdp.evaluate(`const cs = getComputedStyle(document.getElementById('near')); return { name: cs.animationName, image: cs.backgroundImage.startsWith('linear-gradient'), size: cs.backgroundSize };`);
  check('a name with a moving colour has no CSS animation on it', css.name === 'none' && css.image, JSON.stringify(css));

  const a = await x('near');
  await sleep(1000);
  const b = await x('near');
  check('and still moves, seen', a !== b, `${a} -> ${b}`);

  // How many times a second its position is written.
  const writes = await cdp.evaluate(`
    let n = 0;
    const o = new MutationObserver((records) => { n += records.length; });
    o.observe(document.getElementById('near'), { attributes: true, attributeFilter: ['style'] });
    await new Promise((r) => setTimeout(r, 2000));
    o.disconnect(); return n / 2;`);
  check('a few times a second, not once per refresh of the display', writes >= 3 && writes <= 12, `${writes} a second`);

  const speeds = await cdp.evaluate(`
    const at = (id) => parseFloat(document.getElementById(id).style.backgroundPositionX);
    const one = [at('fast'), at('slow')];
    await new Promise((r) => setTimeout(r, 400));
    const two = [at('fast'), at('slow')];
    const moved = (a, b) => Math.abs(((b - a) + 200) % 200);
    return { fast: moved(one[0], two[0]), slow: moved(one[1], two[1]) };`);
  check("each name's own speed is kept: 2 s moves further than 24 s in the same time", speeds.fast > speeds.slow * 3, JSON.stringify(speeds));

  const hidden = await cdp.evaluate(`
    const before = document.getElementById('filler-11').style.backgroundPositionX;
    await new Promise((r) => setTimeout(r, 800));
    return { before, after: document.getElementById('filler-11').style.backgroundPositionX };`);
  check('a name scrolled out of view is left alone', hidden.before === '' && hidden.after === '', JSON.stringify(hidden));
  await cdp.evaluate(`const box = document.getElementById('probe-box'); box.scrollTop = box.scrollHeight; return true;`);
  await sleep(700);
  const scrolledTo = await x('filler-11');
  const scrolledAgain = await (async () => { await sleep(500); return x('filler-11'); })();
  check('and moves once it is scrolled into view', scrolledTo !== scrolledAgain, `${scrolledTo} -> ${scrolledAgain}`);

  await cdp.evaluate(`document.getElementById('probe-box').scrollTop = 0; return true;`);
  await sleep(500);

  // The window goes behind a game: the page is marked, and everything stops.
  await cdp.evaluate("document.documentElement.setAttribute('data-blurred', ''); return true;");
  await sleep(300);
  const c = await x('near');
  await sleep(800);
  const d = await x('near');
  check('with the window behind another, nothing moves', c === d, `${c} -> ${d}`);
  await cdp.evaluate("document.documentElement.removeAttribute('data-blurred'); return true;");
  await sleep(500);
  const e = await x('near');
  await sleep(500);
  check('and it moves again when the window comes back', e !== (await x('near')), `from ${e}`);

  // A name added later, and one that stops being one.
  await cdp.evaluate(`
    const s = document.createElement('span'); s.id = 'late'; s.textContent = 'late'; s.setAttribute('data-name-style', 'gradient');
    s.style.setProperty('--name-gradient', 'linear-gradient(90deg, red, blue, red)');
    document.getElementById('probe-box').prepend(s); return true;`);
  await sleep(700);
  const l1 = await x('late');
  await sleep(500);
  check('a name that appears later moves too', l1 !== (await x('late')), `${l1}`);
  await cdp.evaluate("document.getElementById('late').removeAttribute('data-name-style'); return true;");
  await sleep(300);
  const m1 = await cdp.evaluate("return document.getElementById('late').style.backgroundPositionX");
  await sleep(600);
  check('and one that stops being a coloured name stops', m1 === (await cdp.evaluate("return document.getElementById('late').style.backgroundPositionX")), m1);
}

run().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  const failed = summary();
  setTimeout(() => process.exit(process.exitCode ?? (failed ? 1 : 0)), 200);
});
