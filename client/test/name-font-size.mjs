// The fonts a name may be drawn in come out about the same size.
//
//   node client/test/name-font-size.mjs
//
// Each face has its own idea of how big a letter is at 16px; the rule for each
// (fonts.css) says how much to scale it. This measures what they come to, in the
// page: the height of the letters (the mean of a lowercase x and a capital H, the
// way the eye sizes a name), the width of a name, and how tall the row they sit in
// is -- against the ordinary font of a name.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attach, findPage, launchApp, reporter, sleep } from './cdp.mjs';

const { check, summary } = reporter();
const app = launchApp({ port: 9556, userDataDir: mkdtempSync(join(tmpdir(), 'harmony-nfs-')) });
process.on('exit', () => { try { app.kill(); } catch { /* gone */ } });

async function run() {
  const cdp = await attach(await findPage(9556));
  await sleep(1500);
  const sizes = await cdp.evaluate(`
    const ids = ['pacifico', 'press-start', 'orbitron', 'playfair', 'bebas', 'caveat', 'fredoka', 'cinzel', 'typewriter', 'marker'];
    const families = { pacifico: 'Pacifico', 'press-start': 'Press Start 2P', orbitron: 'Orbitron', playfair: 'Playfair Display', bebas: 'Bebas Neue', caveat: 'Caveat', fredoka: 'Fredoka', cinzel: 'Cinzel', typewriter: 'Special Elite', marker: 'Permanent Marker' };
    for (const id of ids) await document.fonts.load('16px "' + families[id] + '"');
    const host = document.createElement('div');
    host.className = 'chat-msg';
    host.style.cssText = 'position:fixed;left:0;top:0;width:600px;visibility:hidden';
    host.innerHTML = '<div class="msg-main"><div class="msg-head"><strong class="who">anatakehara</strong></div></div>';
    document.body.append(host);
    const who = host.querySelector('.who');
    const head = host.querySelector('.msg-head');
    const c = document.createElement('canvas').getContext('2d');
    const measure = (id) => {
      if (id) who.setAttribute('data-name-font', id); else who.removeAttribute('data-name-font');
      const cs = getComputedStyle(who);
      c.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
      const x = c.measureText('x').actualBoundingBoxAscent;
      const H = c.measureText('H').actualBoundingBoxAscent;
      return { letters: (x + H) / 2, width: who.getBoundingClientRect().width, row: Math.round(head.getBoundingClientRect().height * 10) / 10, px: cs.fontSize };
    };
    const out = { default: measure(null) };
    for (const id of ids) out[id] = measure(id);
    host.remove();
    return out;`);
  const ref = sizes.default;
  const report = Object.entries(sizes).filter(([id]) => id !== 'default').map(([id, s]) => ({
    id, letters: +(s.letters / ref.letters).toFixed(2), width: +(s.width / ref.width).toFixed(2), row: s.row,
  }));
  console.log('against the ordinary font (letters, width, row height):', JSON.stringify(report));
  check('the letters of every face are within 8% of the ordinary font\'s', report.every((r) => Math.abs(r.letters - 1) <= 0.08), JSON.stringify(report.map((r) => [r.id, r.letters])));
  check('no name is more than 1.45 times as wide as the same name in the ordinary font', report.every((r) => r.width <= 1.45), JSON.stringify(report.map((r) => [r.id, r.width])));
  check('and none is under half as wide', report.every((r) => r.width >= 0.5), JSON.stringify(report.map((r) => [r.id, r.width])));
  const rows = report.map((r) => r.row);
  check('the row a name sits in is about the same height for all of them', Math.max(...rows, ref.row) - Math.min(...rows, ref.row) <= 6, JSON.stringify({ default: ref.row, rows }));
}

run().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => {
  const failed = summary();
  setTimeout(() => process.exit(process.exitCode ?? (failed ? 1 : 0)), 200);
});
