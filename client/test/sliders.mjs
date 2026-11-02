// Sliders: the wheel moves every one of them, and a volume's number can be typed.
//
//   - a notch of the wheel over a slider moves it, the page does not scroll, and what listens to the slider hears it
//     (`input` at once, `change` when the wheel has stopped); Shift is one step; past an end is the end
//   - a slider made later (a stream's tile, a person's menu) works the same with nothing wired to it
//   - a volume's number is pressed to type in: Enter keeps it (even where the slider steps by five), Escape and an
//     empty box leave it, a number past the end is the end
//   - sliders that are not volumes answer the wheel but their numbers are not typed in
//
//   node client/test/sliders.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const HARMONY_PORT = 18240;
const FAKE_MTX_PORT = 20140;
const DEBUG_PORT = 9540;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-sl-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-sl-profile-'));
const { check, summary } = reporter();
const procs = [];
let fakeMtx = null;
let serverLog = '';
let ownerKey = null;

process.on('exit', () => {
  for (const p of procs) {
    try { p.kill(); } catch { /* already gone */ }
  }
  try { fakeMtx?.close(); } catch { /* already closed */ }
});
process.on('SIGINT', () => process.exit(130));

function startFakeMediaMtx() {
  return new Promise((done) => {
    fakeMtx = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ itemCount: 0, pageCount: 0, items: [] }));
    });
    fakeMtx.listen(FAKE_MTX_PORT, '127.0.0.1', done);
  });
}

function startHarmonyServer() {
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        HARMONY_PORT: String(HARMONY_PORT),
        HARMONY_HOST: '127.0.0.1',
        HARMONY_DATA_DIR: dataDir,
        HARMONY_MEDIAMTX_API: `http://127.0.0.1:${FAKE_MTX_PORT}`,
        HARMONY_SIGNALING_URL: 'http://127.0.0.1:8889',
        HARMONY_POLL_INTERVAL_MS: '500',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    procs.push(p);
    const timer = setTimeout(() => fail(new Error('server did not start')), 15_000);
    p.stdout.on('data', (b) => {
      serverLog += b.toString();
      const match = /^\s*│\s+([A-Za-z0-9_-]{20,})\s+│$/m.exec(serverLog);
      if (match) ownerKey = match[1];
      if (serverLog.includes('control server on')) {
        clearTimeout(timer);
        done(p);
      }
    });
    p.stderr.on('data', (b) => (serverLog += b.toString()));
  });
}

let token = null;
const api = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
};

const post = (channelId, body) => api(`/api/channels/${channelId}/messages`, { body });

/** Where the log is scrolled, as the renderer sees it. */
const logState = (cdp) => cdp.evaluate(`
  const log = document.getElementById('chat-log');
  const rows = [...log.querySelectorAll('.chat-msg')];
  const last = rows.at(-1);
  return {
    top: Math.round(log.scrollTop),
    fromBottom: Math.round(log.scrollHeight - log.scrollTop - log.clientHeight),
    scrollable: log.scrollHeight > log.clientHeight + 100,
    count: rows.length,
    lastText: last?.textContent ?? '',
    title: document.getElementById('chat-name').textContent,
  };
`);

const openChannel = async (cdp, name) => {
  await cdp.evaluate(`
    const li = [...document.querySelectorAll('#channel-items li.channel-row')]
      .find((row) => row.querySelector('.channel-name')?.textContent === ${JSON.stringify(name)});
    li.click();
    return true;
  `);
  await waitFor(
    cdp,
    `document.getElementById('chat-name').textContent === '#${name}'
      && document.querySelectorAll('#chat-log .chat-msg').length > 0`,
    { label: `#${name} to show its messages` },
  );
  // Let the scroll that follows the render settle.
  await sleep(250);
};

async function run() {
  await startFakeMediaMtx();
  await startHarmonyServer();
  const me = await api('/api/accounts/register', { nickname: 'tester', password: 'hunter22', ownerKey });
  token = me.token;
  const app = launchApp({ port: DEBUG_PORT, userDataDir });
  procs.push(app);
  const cdp = await attach(await findPage(DEBUG_PORT));
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await sleep(1200);
  const set = (id, value) => cdp.evaluate(`
    const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
    i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  await set('server-url', BASE);
  await sleep(1500);
  await set('username', 'tester');
  await set('account-password', 'hunter22');
  await cdp.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'the channels view' });
  await sleep(600);

  const val = (id) => cdp.evaluate(`const s = document.getElementById(${JSON.stringify(id)}); return { v: Number(s.value), label: document.getElementById(${JSON.stringify(id + '-label')})?.textContent ?? null };`);
  /** One notch of a wheel over an element, as the page gets it; says whether the page's own scroll was left alone. */
  const wheel = (selector, deltaY, extra = {}) => cdp.evaluate(`
    const e = document.querySelector(${JSON.stringify(selector)});
    const ev = new WheelEvent('wheel', { deltaY: ${deltaY}, bubbles: true, cancelable: true, ...${JSON.stringify(extra)} });
    e.dispatchEvent(ev); return { prevented: ev.defaultPrevented };`);

  // --- a real wheel, over a real slider, in the settings ------------------------------------------------------------------------------
  await cdp.evaluate("document.getElementById('devices').showModal(); document.querySelector('#devices .settings-tab[data-tab=\"sounds\"]').click(); return true;");
  await sleep(500);
  const where = await cdp.evaluate("const r = document.getElementById('master-volume').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width };");
  check('the master volume is on the screen', where.w > 40 && where.x > 0, JSON.stringify(where));
  await cdp.evaluate("window.__heard = []; for (const t of ['input', 'change']) document.getElementById('master-volume').addEventListener(t, () => window.__heard.push(t)); return true;");
  const before = await val('master-volume');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: where.x, y: where.y, deltaX: 0, deltaY: -100 });
  await sleep(120);
  const up = await val('master-volume');
  check('a notch of the wheel up raises it, and its label follows', up.v > before.v && up.label === `${up.v}%`, JSON.stringify([before, up]));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: where.x, y: where.y, deltaX: 0, deltaY: 200 });
  await sleep(120);
  const down = await val('master-volume');
  check('two notches down lower it by twice as much', Math.abs((up.v - down.v) - 2 * (up.v - before.v)) < 1e-9, JSON.stringify([before.v, up.v, down.v]));
  await sleep(500);
  const heard = await cdp.evaluate("return { heard: window.__heard };");
  check('what listens to it heard `input` for every notch and `change` once it settled', heard.heard.filter((t) => t === 'input').length === 2 && heard.heard.filter((t) => t === 'change').length >= 1, JSON.stringify(heard));
  const kept = await cdp.evaluate("const s = await harmony.settings.get(); return { v: (s.data ?? s).masterVolume };");
  check('and the setting was kept, as it is when it is dragged', kept.v === (await val('master-volume')).v, JSON.stringify(kept));
  const scrolled = await cdp.evaluate("const body = document.querySelector('#server-dialog .settings-body, #server-dialog'); return { top: document.getElementById('master-volume').closest('section')?.scrollTop ?? 0 };");
  void scrolled;

  // the ends
  for (let i = 0; i < 80; i += 1) await wheel('#master-volume', -100);
  await sleep(60);
  check('wheeled past the top it stops at the top', (await val('master-volume')).v === 200, JSON.stringify(await val('master-volume')));
  for (let i = 0; i < 120; i += 1) await wheel('#master-volume', 100);
  check('and past the bottom at the bottom', (await val('master-volume')).v === 0, JSON.stringify(await val('master-volume')));
  await set('master-volume', '100');
  const shift = await wheel('#master-volume', -100, { shiftKey: true });
  
  check('Shift is the fine one: one step', (await val('master-volume')).v === 101 && shift.prevented, JSON.stringify(await val('master-volume')));
  // a trackpad's small turns add up
  await set('master-volume', '100');
  for (let i = 0; i < 6; i += 1) await wheel('#master-volume', -10);
  check('a trackpad\'s small turns add up to a notch, not to nothing', (await val('master-volume')).v > 100, JSON.stringify(await val('master-volume')));
  check('a wheel with the Ctrl key (the page zoom) is left alone', await wheel('#master-volume', -100, { ctrlKey: true }).then((r) => !r.prevented), '');

  // every other slider answers it too
  const others = await cdp.evaluate("return { ids: [...document.querySelectorAll('input[type=\"range\"][id]')].map((s) => s.id) };");
  const moved = [];
  for (const id of others.ids) {
    const r = await cdp.evaluate(`
      const s = document.getElementById(${JSON.stringify(id)}); if (s.disabled) return { id: ${JSON.stringify(id)}, skip: true };
      const mid = String((Number(s.min || 0) + Number(s.max || 100)) / 2); s.value = mid;
      const before = Number(s.value); const ev = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }); s.dispatchEvent(ev);
      return { id: ${JSON.stringify(id)}, moved: Number(s.value) > before, prevented: ev.defaultPrevented, before, after: Number(s.value), min: s.min, max: s.max, step: s.step };`);
    if (!r.skip) moved.push(r);
  }
  check(`all ${moved.length} sliders in the page answer the wheel (settings, soundpad, the watch and mosaic volumes...)`, moved.length >= 8 && moved.every((m) => m.moved && m.prevented), JSON.stringify(moved.filter((m) => !m.moved)));

  // --- one made later: a stream's tile and a person's menu ----------------------------------------------------------------------------------
  await cdp.evaluate(`
    document.body.insertAdjacentHTML('beforeend', '<div id="probe"><span class="tile-controls"><input type="range" class="tile-volume" min="0" max="350" value="100"><span class="tile-volume-label volume-value">100%</span></span><span class="peer-row"><input type="range" class="peer-volume" min="0" max="350" step="5" value="100"><span class="peer-volume-label">100%</span></span></div>');
    for (const [sel, lab] of [['#probe .tile-volume', '#probe .tile-volume-label'], ['#probe .peer-volume', '#probe .peer-volume-label']]) {
      const s = document.querySelector(sel); const l = document.querySelector(lab);
      s.addEventListener('input', () => { l.textContent = s.value + '%'; });
    }
    return true;`);
  await wheel('#probe .tile-volume', -100);
  const tile = await cdp.evaluate("return { v: Number(document.querySelector('#probe .tile-volume').value), label: document.querySelector('#probe .tile-volume-label').textContent };");
  check('a slider made later -- a stream\'s volume -- answers the wheel with nothing wired to it', tile.v > 100 && tile.label === `${tile.v}%`, JSON.stringify(tile));

  // --- typing a number ---------------------------------------------------------------------------------------------------------------------
  const typeInto = async (sliderSel, labelSel, text, key = 'Enter') => {
    await cdp.evaluate(`const l = document.querySelector(${JSON.stringify(labelSel)}); l.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); l.click(); return true;`);
    await sleep(60);
    const box = await cdp.evaluate(`const i = document.querySelector('.volume-exact'); return { box: Boolean(i), focused: document.activeElement === i, min: i?.min, max: i?.max, hidden: document.querySelector(${JSON.stringify(labelSel)}).hidden, value: i?.value };`);
    if (!box.box) return { box };
    await cdp.evaluate(`const i = document.querySelector('.volume-exact'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true })); return true;`);
    await sleep(100);
    return { box, after: await cdp.evaluate(`return { v: Number(document.querySelector(${JSON.stringify(sliderSel)}).value), label: document.querySelector(${JSON.stringify(labelSel)}).textContent, shown: !document.querySelector(${JSON.stringify(labelSel)}).hidden, left: Boolean(document.querySelector('.volume-exact')) };`) };
  };
  await set('master-volume', '100');
  let r = await typeInto('#master-volume', '#master-volume-label', '37');
  check('pressing the number gives a box to type in, focused, with the slider\'s own limits, in its place', r.box.box && r.box.focused && r.box.max === '200' && r.box.hidden && r.box.value === '100', JSON.stringify(r.box));
  check('Enter keeps 37 -- not the 35 a step of five would land on -- and the label follows', r.after.v === 37 && r.after.label === '37%' && r.after.shown && !r.after.left, JSON.stringify(r.after));
  const typedKept = await cdp.evaluate("await new Promise((r) => setTimeout(r, 600)); const s = await harmony.settings.get(); return { v: (s.data ?? s).masterVolume };");
  check('and it is kept in the settings as the slider\'s own change is', typedKept.v === 37, JSON.stringify(typedKept));
  r = await typeInto('#master-volume', '#master-volume-label', '999');
  check('a number past the end is the end', r.after.v === 200 && r.after.label === '200%', JSON.stringify(r.after));
  r = await typeInto('#master-volume', '#master-volume-label', '12', 'Escape');
  check('Escape leaves it as it was', r.after.v === 200 && r.after.shown && !r.after.left, JSON.stringify(r.after));
  r = await typeInto('#master-volume', '#master-volume-label', '');
  check('an empty box leaves it as it was', r.after.v === 200 && !r.after.left, JSON.stringify(r.after));
  r = await typeInto('#master-volume', '#master-volume-label', '-40');
  check('and a negative number is silence', r.after.v === 0 && r.after.label === '0%', JSON.stringify(r.after));
  r = await typeInto('#master-volume', '#master-volume-label', '63.6');
  check('a fraction is rounded', r.after.v === 64, JSON.stringify(r.after));

  r = await typeInto('#probe .tile-volume', '#probe .tile-volume-label', '275');
  check('a stream\'s volume takes a number too, up to its 350%', r.box.max === '350' && r.after.v === 275 && r.after.label === '275%', JSON.stringify(r));
  r = await typeInto('#probe .peer-volume', '#probe .peer-volume-label', '123');
  check('and so does a person\'s (whose slider stepped by five)', r.after.v === 123, JSON.stringify(r));
  r = await typeInto('#mic-gain', '#mic-gain-label', '150');
  check('the input volume, which has its number in an <output>', r.after.v === 150 && r.after.label === '150%', JSON.stringify(r));
  r = await typeInto('#sound-volume', '#sound-volume-label', '20');
  check('and the sound effects volume', r.after.v === 20, JSON.stringify(r));
  r = await typeInto('#soundpad-volume', '#soundpad-volume-label', '80');
  check('and the soundpad\'s', r.after.v === 80, JSON.stringify(r));
  r = await typeInto('#volume', '#volume-label', '300');
  check('and the watch view\'s, and the mosaic\'s', r.after.v === 300 && (await typeInto('#mosaic-volume', '#mosaic-volume-label', '210')).after.v === 210, JSON.stringify(r));

  // not a volume
  await cdp.evaluate("const l = document.getElementById('mic-gate-label'); l.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); l.click(); return true;");
  await sleep(100);
  check('the number of a slider that is not a volume is not a box to type in', await cdp.evaluate("return { none: !document.querySelector('.volume-exact') }").then((x) => x.none), '');

  // a click inside the box is the box's own
  await cdp.evaluate(`document.body.insertAdjacentHTML('beforeend', '<div id="outer"><input type="range" class="tile-volume" id="inner" min="0" max="100" value="50"><span class="tile-volume-label">50%</span></div>'); window.__outerClicks = 0; document.getElementById('outer').addEventListener('click', () => { window.__outerClicks += 1; }); return true;`);
  await cdp.evaluate("const l = document.querySelector('#outer .tile-volume-label'); l.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); l.click(); document.querySelector('.volume-exact').click(); return true;");
  await sleep(60);
  check('pressing the number, or the box, does not press what the number is part of (a tile that maximises)', await cdp.evaluate("return { n: window.__outerClicks }").then((x) => x.n === 0), '');
  await cdp.evaluate("const l = document.getElementById('master-volume-label'); l.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); l.click(); return true;");
  await sleep(150);
  const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })).data;
  (await import('node:fs')).writeFileSync(`${process.env.SHOT_DIR ?? tmpdir()}/sliders.png`, Buffer.from(shot, 'base64'));

  app.kill();
}

run()
  .catch((err) => {
    console.error(err);
    console.error(serverLog.split('\n').slice(-15).join('\n'));
    process.exitCode = 1;
  })
  .finally(() => {
    const failed = summary();
    setTimeout(() => process.exit(process.exitCode ?? (failed ? 1 : 0)), 200);
  });
