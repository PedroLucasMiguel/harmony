// The server's head: its picture and name at the top of the channel list, over its banner when it has one, taking
// the height of the strip across the top, which keeps the buttons. And the owner's way to a banner: the same cropping
// window as a profile banner, staged and saved from the server's settings.
//
//   node client/test/server-head-ui.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const HARMONY_PORT = 18182;
const FAKE_MTX_PORT = 20082;
const DEBUG_PORT = 9482;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-head-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-head-profile-'));
const { check, summary } = reporter();
const procs = [];
let fakeMtx = null;
let serverLog = '';
let ownerKey = null;

process.on('exit', () => {
  for (const p of procs) { try { p.kill(); } catch { /* gone */ } }
  try { fakeMtx?.close(); } catch { /* closed */ }
});

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
      if (serverLog.includes('control server on')) { clearTimeout(timer); done(p); }
    });
    p.stderr.on('data', (b) => (serverLog += b.toString()));
  });
}

const setInput = (id, value) => `{ const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
  i.dispatchEvent(new Event('input', {bubbles:true})); i.dispatchEvent(new Event('change', {bubbles:true})); }`;


/** A real PNG, a gradient, `w` x `h`: so that what is seen in the screenshot is a picture. */
function gradientPng(w, h) {
  const crc = (buf) => {
    let c;
    let crcv = 0xffffffff;
    for (let n = 0; n < buf.length; n += 1) {
      c = (crcv ^ buf[n]) & 0xff;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcv = (crcv >>> 8) ^ c;
    }
    return (crcv ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x += 1) {
      raw[row + 1 + x * 3] = Math.round(40 + 180 * (x / w));
      raw[row + 2 + x * 3] = Math.round(90 + 120 * (y / h));
      raw[row + 3 + x * 3] = 200 - Math.round(120 * (x / w));
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function run() {
  await startFakeMediaMtx();
  await startHarmonyServer();
  const app = launchApp({ port: DEBUG_PORT, userDataDir });
  procs.push(app);
  const cdp = await attach(await findPage(DEBUG_PORT));
  await sleep(1200);
  await cdp.evaluate(`${setInput('server-url', BASE)} return true;`);
  await sleep(1500);
  for (const [id, value] of [['username', 'pedro'], ['account-password', 'hunter22'], ['account-confirm', 'hunter22'], ['owner-key', ownerKey]]) {
    await cdp.evaluate(`${setInput(id, value)} return true;`);
  }
  await cdp.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'");
  await sleep(800);
  const shot = async (name) => {
    if (!process.env.HEAD_SHOTS) return;
    mkdirSync(process.env.HEAD_SHOTS, { recursive: true });
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.HEAD_SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
  };
  const rect = (sel) => cdp.evaluate(`const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
    const r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), b: Math.round(r.bottom), r: Math.round(r.right) };`);
  const q = (sel) => cdp.evaluate(`return !!document.querySelector(${JSON.stringify(sel)});`);
  const visible = (sel) => cdp.evaluate(`const e = document.querySelector(${JSON.stringify(sel)}); return !!e && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;`);

  // ---- no banner: the head is the strip's height, at the top of the list
  const view = await rect('#view-channels');
  let head = await rect('#server-head');
  let bar = await rect('#view-channels > .bar');
  let list = await rect('.channel-list');
  check('the head is at the very top of the view, over the strip\'s height', head.y === view.y && head.h === bar.h, JSON.stringify({ head, bar }));
  check('and as wide as the channel list, reaching to its divider', head.x <= list.x && head.r >= list.r - 2 && head.r <= list.r, JSON.stringify({ head, list }));
  check('the strip is where it was and keeps the buttons on its right', bar.y === view.y && (await visible('#server-settings')) && (await visible('#channels-members')) && (await visible('#channels-signout')));
  const settings = await rect('#channels-members');
  check('the buttons are clear of the head', settings.x > head.r, JSON.stringify({ settings, head }));
  check('the name is in the head, and no longer in the strip', (await visible('#server-head-name')) && !(await visible('#server-name')) && !(await visible('#view-channels .bar-left > #server-icon')));
  check('the head has the name, the picture and the role', (await cdp.evaluate("return document.getElementById('server-head-name').textContent")) === 'Harmony' && (await visible('#server-head-icon')) && /owner/i.test(await cdp.evaluate("return document.getElementById('channels-role').textContent")));
  check('the channels start under it, as far down as before', (await rect('.channel-list-head')).y >= head.b);
  check('no banner, no picture and the list not moved', !(await visible('#server-head-banner')) && !(await cdp.evaluate("return document.getElementById('view-channels').hasAttribute('data-server-banner')")));
  const listTopBefore = (await rect('.channel-list-head')).y;
  await shot('1-no-banner');

  // ---- the owner's flow: the editor, the preview, Save
  await cdp.evaluate("document.getElementById('server-settings').click(); return true;");
  await waitFor(cdp, "document.getElementById('server-dialog').open", { label: 'the server dialog' });
  check('the settings have a banner field, with nothing chosen yet', (await visible('#server-banner-pick')) && await cdp.evaluate("return document.getElementById('server-banner-remove').disabled && !document.getElementById('server-banner-preview').hasAttribute('data-has')"));
  const png = gradientPng(1200, 400).toString('base64');
  await cdp.evaluate(`window.__picked = null; const click = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () { if (this.type === 'file') { window.__picked = this; return; } return click.call(this); };
    document.getElementById('server-banner-pick').click(); return true;`);
  await cdp.evaluate(`const bytes = Uint8Array.from(atob(${JSON.stringify(png)}), (c) => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([bytes], 'banner.png', { type: 'image/png' }));
    window.__picked.files = dt.files; window.__picked.dispatchEvent(new Event('change')); return true;`);
  await waitFor(cdp, "!!document.querySelector('dialog.image-editor[open] .ie-save')", { label: 'the editor' });
  check('the cropping window opens, in the server banner\'s words', /server banner/i.test(await cdp.evaluate("return document.querySelector('dialog.image-editor h3').textContent")));
  check('it is the profile banner\'s window: the same shape, 3 to 1', await cdp.evaluate(`const m = document.querySelector('.ie-mask').getBoundingClientRect(); return Math.abs(m.width / m.height - 3) < 0.05;`));
  check('without the member list\'s dashed lines, which are not what is shown here', !(await q('.ie-strip')));
  await shot('2-editor');
  await cdp.evaluate("document.querySelector('dialog.image-editor .ie-save').click(); return true;");
  await waitFor(cdp, "document.getElementById('server-banner-preview').hasAttribute('data-has')", { label: 'the preview' });
  check('what was cut is shown in the field, and can be removed', await cdp.evaluate("return !document.getElementById('server-banner-remove').disabled"));
  check('nothing has changed on the screen before Save', !(await visible('#server-head-banner')));
  await cdp.evaluate("document.getElementById('server-form').requestSubmit(); return true;");
  await waitFor(cdp, "document.getElementById('view-channels').hasAttribute('data-server-banner')", { label: 'the banner arriving', timeoutMs: 15_000 });
  await waitFor(cdp, "!document.getElementById('server-dialog').open", { label: 'the dialog closing' }).catch(() => {});
  await sleep(500);
  check('Save puts the banner behind the name', await visible('#server-head-banner'));

  // ---- with a banner
  head = await rect('#server-head');
  bar = await rect('#view-channels > .bar');
  list = await rect('.channel-list');
  check('the head is taller than the strip now, from the top of the view', head.y === view.y && head.h > bar.h, JSON.stringify({ head, bar }));
  check('the strip did not grow, and still has its buttons beside the head', bar.h === (await rect('#view-channels > .bar')).h && bar.h === 60 && (await rect('#channels-members')).x > head.r);
  check('the banner fills the head', await cdp.evaluate(`const i = document.getElementById('server-head-banner').getBoundingClientRect(); const h = document.getElementById('server-head').getBoundingClientRect();
    return Math.abs(i.width - h.width) < 2 && Math.abs(i.height - h.height) < 2 && document.getElementById('server-head-banner').naturalWidth > 0;`));
  check('the channels moved down with it, and are clear of it', (await rect('.channel-list-head')).y >= head.b && (await rect('.channel-list-head')).y > listTopBefore, JSON.stringify({ was: listTopBefore, now: (await rect('.channel-list-head')).y, head }));
  check('the name still reads: white, over a darkened picture', await cdp.evaluate("return getComputedStyle(document.getElementById('server-head-name')).color === 'rgb(255, 255, 255)'"));
  await shot('3-banner');

  // ---- the card over the server in the rail: its picture, its name and its banner
  const moveTo = (x, y) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  const railBubble = await rect('#server-rail .rail-item[data-server]');
  const bx = railBubble.x + railBubble.w / 2;
  const by = railBubble.y + railBubble.h / 2;
  check('the bubble has no browser tooltip to double the card', !(await cdp.evaluate("return document.querySelector('#server-rail .rail-item[data-server]').title")));
  await moveTo(bx, by);
  await sleep(150);
  check('the card waits a moment before it opens', !(await q('.server-card')));
  await waitFor(cdp, "!!document.querySelector('.server-card')", { label: 'the server card', timeoutMs: 4000 });
  await waitFor(cdp, "(document.querySelector('.server-card-banner')?.naturalWidth ?? 0) > 0", { label: 'the card\'s banner', timeoutMs: 8000 });
  const card = await rect('.server-card');
  check('it is beside the bubble, to its right', card.x >= railBubble.r && (Math.abs((card.y + card.h / 2) - by) < 4 || card.y <= 8), JSON.stringify({ card, railBubble }));
  check('it names the server', (await cdp.evaluate("return document.querySelector('.server-card-name').textContent")) === 'Harmony');
  check('it shows the server\'s picture (or its initial)', await cdp.evaluate("return !!document.querySelector('.server-card-icon')?.textContent || !!document.querySelector('.server-card-icon img')"));
  check('and the banner, over the name', await cdp.evaluate(`const b = document.querySelector('.server-card-banner').getBoundingClientRect(); const n = document.querySelector('.server-card-name').getBoundingClientRect(); return b.bottom <= n.top + 1 && b.width > 100;`));
  check('it never takes the pointer', await cdp.evaluate("return getComputedStyle(document.querySelector('.server-card')).pointerEvents === 'none'"));
  await shot('3b-card');
  await moveTo(card.x + card.w + 200, 400);
  await sleep(200);
  check('it goes when the pointer leaves', !(await q('.server-card')));
  await moveTo(bx, by);
  await waitFor(cdp, "!!document.querySelector('.server-card')", { label: 'the card again', timeoutMs: 4000 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(150);
  check('Escape closes it', !(await q('.server-card')));
  await moveTo(card.x + card.w + 200, 400);

  // ---- somebody else sees it, without a refresh; and it can be taken away
  await cdp.evaluate("document.getElementById('server-settings').click(); return true;");
  await waitFor(cdp, "document.getElementById('server-dialog').open", { label: 'the dialog again' });
  check('the field shows the banner that is set', await cdp.evaluate("return document.getElementById('server-banner-preview').hasAttribute('data-has') && !document.getElementById('server-banner-remove').disabled"));
  await cdp.evaluate("document.getElementById('server-banner-remove').click(); document.getElementById('server-form').requestSubmit(); return true;");
  await waitFor(cdp, "!document.getElementById('view-channels').hasAttribute('data-server-banner')", { label: 'the banner going', timeoutMs: 15_000 });
  await sleep(500);
  check('removed, the head is the strip\'s height again and the list is back where it was', (await rect('#server-head')).h === (await rect('#view-channels > .bar')).h && (await rect('.channel-list-head')).y === listTopBefore);

  // ---- without a banner the card is the picture and the name
  await moveTo(bx, by);
  await waitFor(cdp, "!!document.querySelector('.server-card')", { label: 'the card, no banner', timeoutMs: 4000 });
  check('no banner, none on the card', !(await q('.server-card-banner')) && !(await cdp.evaluate("return document.querySelector('.server-card').hasAttribute('data-banner')")));
  await shot('3c-card-no-banner');
  await moveTo(card.x + card.w + 200, 400);

  // ---- a phone: the head is the top of the drawer, and the strip names the server
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(700);
  check('on a phone the strip names the server', (await visible('#server-name')) && (await visible('#channels-menu')));
  await cdp.evaluate("document.getElementById('channels-menu').click(); return true;");
  await sleep(600);
  const phoneHead = await rect('#server-head');
  const drawer = await rect('.channel-list');
  check('and the head is the top of the open drawer, inside it', phoneHead && phoneHead.x >= drawer.x - 1 && phoneHead.r <= drawer.r + 1 && phoneHead.y <= drawer.y + 2, JSON.stringify({ phoneHead, drawer }));
  check('with the channels under it, not covered by it', (await rect('.channel-list-head')).y >= phoneHead.b);
  await shot('4-phone');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
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
