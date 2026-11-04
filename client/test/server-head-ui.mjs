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


/** A PNG of noise: what a photograph is to an encoder, far bigger than a gradient and nothing like as small after it. */
function noisePng(w, h) {
  const base = gradientPng(8, 8);
  // Same encoder, random pixels: rebuild the IDAT by hand.
  const crc = (buf) => { let c; let v = 0xffffffff; for (let n = 0; n < buf.length; n += 1) { c = (v ^ buf[n]) & 0xff; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; v = (v >>> 8) ^ c; } return (v ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let seed = 12345;
  for (let i = 0; i < raw.length; i += 1) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; raw[i] = i % (w * 3 + 1) === 0 ? 0 : seed >> 16; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  void base;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

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

const ANIMATED_GIF = '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';

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

  // ---- a banner that is changed: the new one is saved, kept by the server, and shown
  const hashOf = async () => (await (await fetch(`${BASE}/api/health`)).json()).banner;
  const hashBefore = await hashOf();
  await cdp.evaluate("document.getElementById('server-settings').click(); return true;");
  await waitFor(cdp, "document.getElementById('server-dialog').open", { label: 'the dialog, to change the banner' });
  const other = gradientPng(900, 300).toString('base64');
  await cdp.evaluate(`window.__picked = null; document.getElementById('server-banner-pick').click(); return true;`);
  await cdp.evaluate(`const bytes = Uint8Array.from(atob(${JSON.stringify(other)}), (c) => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([bytes], 'second.png', { type: 'image/png' }));
    window.__picked.files = dt.files; window.__picked.dispatchEvent(new Event('change')); return true;`);
  await waitFor(cdp, "!!document.querySelector('dialog.image-editor[open] .ie-save')", { label: 'the editor, again' });
  await cdp.evaluate("document.querySelector('dialog.image-editor .ie-save').click(); return true;");
  await sleep(800);
  await cdp.evaluate("document.getElementById('server-form').requestSubmit(); return true;");
  await waitFor(cdp, "!document.getElementById('server-dialog').open", { label: 'the dialog closing after the change', timeoutMs: 15_000 });
  await sleep(800);
  const hashAfter = await hashOf();
  check('a banner replaced by another is saved: the server now has a different one', Boolean(hashAfter) && hashAfter !== hashBefore, `${hashBefore} -> ${hashAfter}`);
  check('and the head shows it', await cdp.evaluate(`const img = document.getElementById('server-head-banner'); return !img.hidden && img.naturalWidth > 0 && img.src.includes(${JSON.stringify(hashAfter ?? 'none')});`));
  // Reopened, the field has what was saved.
  await cdp.evaluate("document.getElementById('server-settings').click(); return true;");
  await waitFor(cdp, "document.getElementById('server-dialog').open", { label: 'the dialog, reopened' });
  check('reopening the settings shows the banner that was saved', await cdp.evaluate("return document.getElementById('server-banner-preview').hasAttribute('data-has')"));
  await cdp.evaluate("document.getElementById('server-dialog').close(); return true;");

  // ---- pictures of every kind the picker accepts: a JPEG and a WebP made like a photograph, and a GIF
  for (const type of ['image/jpeg', 'image/webp', 'image/gif']) {
    await cdp.evaluate("document.getElementById('server-settings').click(); return true;");
    await waitFor(cdp, "document.getElementById('server-dialog').open", { label: `the dialog, for ${type}` });
    const was = await hashOf();
    await cdp.evaluate(`document.getElementById('server-banner-pick').click(); return true;`);
    const made = await cdp.evaluate(`const c = document.createElement('canvas'); c.width = 1800; c.height = 900; const g = c.getContext('2d');
      for (let i = 0; i < 400; i += 1) { g.fillStyle = 'hsl(' + (i * 37 % 360) + ',70%,' + (30 + i % 40) + '%)'; g.fillRect((i * 97) % 1800, (i * 53) % 900, 200, 140); }
      const blob = await new Promise((done) => c.toBlob(done, ${JSON.stringify(type)}, 0.92));
      window.__made = { type: blob.type, size: blob.size };
      const dt = new DataTransfer(); dt.items.add(new File([blob], 'picture', { type: blob.type }));
      window.__picked.files = dt.files; window.__picked.dispatchEvent(new Event('change')); return window.__made;`);
    await waitFor(cdp, "!!document.querySelector('dialog.image-editor[open] .ie-save') || !document.getElementById('server-error').hidden", { label: `the editor for ${type}`, timeoutMs: 30_000 });
    const stage = await cdp.evaluate("return document.getElementById('server-error').hidden ? 'editor' : document.getElementById('server-error').textContent");
    await cdp.evaluate("document.querySelector('dialog.image-editor .ie-save')?.click(); return true;");
    await sleep(2500);
    const staged = await cdp.evaluate("return { err: document.getElementById('server-error').hidden ? null : document.getElementById('server-error').textContent, preview: document.getElementById('server-banner-preview').hasAttribute('data-has') }");
    await cdp.evaluate("document.getElementById('server-form').requestSubmit(); return true;");
    await sleep(3000);
    const saved = await cdp.evaluate("return { open: document.getElementById('server-dialog').open, err: document.getElementById('server-error').hidden ? null : document.getElementById('server-error').textContent }");
    check(`a ${made.type} picture (${Math.round(made.size / 1024)} KB) goes through the editor, is staged and saved`, stage === 'editor' && staged.preview && !staged.err && !saved.open && !saved.err && (await hashOf()) !== was, JSON.stringify({ made, stage, staged, saved }));
    await cdp.evaluate("if (document.getElementById('server-dialog').open) document.getElementById('server-dialog').close(); return true;");
  }

  // ---- an animated GIF stays a GIF
  {
    await cdp.evaluate("document.getElementById('server-settings').click(); return true;");
    await waitFor(cdp, "document.getElementById('server-dialog').open", { label: 'the dialog, for a GIF' });
    const was = await hashOf();
    await cdp.evaluate(`document.getElementById('server-banner-pick').click(); return true;`);
    await cdp.evaluate(`const bytes = Uint8Array.from(atob(${JSON.stringify(ANIMATED_GIF)}), (c) => c.charCodeAt(0));
      const dt = new DataTransfer(); dt.items.add(new File([bytes], 'moving.gif', { type: 'image/gif' }));
      window.__picked.files = dt.files; window.__picked.dispatchEvent(new Event('change')); return true;`);
    await waitFor(cdp, "!!document.querySelector('dialog.image-editor[open] .ie-save') || !document.getElementById('server-error').hidden", { label: 'the editor for a GIF', timeoutMs: 30_000 });
    const opened = await cdp.evaluate("return document.getElementById('server-error').hidden ? 'editor' : document.getElementById('server-error').textContent");
    await cdp.evaluate("document.querySelector('dialog.image-editor .ie-save')?.click(); return true;");
    await sleep(4000);
    const staged = await cdp.evaluate("return { err: document.getElementById('server-error').hidden ? null : document.getElementById('server-error').textContent, preview: document.getElementById('server-banner-preview').hasAttribute('data-has') }");
    await cdp.evaluate("document.getElementById('server-form').requestSubmit(); return true;");
    await sleep(3000);
    const saved = await cdp.evaluate("return { open: document.getElementById('server-dialog').open, err: document.getElementById('server-error').hidden ? null : document.getElementById('server-error').textContent }");
    const type = (await fetch(`${BASE}/api/server/banner`)).headers.get('content-type');
    check('an animated GIF goes through the editor, is staged and saved, and is kept as a GIF', opened === 'editor' && staged.preview && !staged.err && !saved.open && !saved.err && (await hashOf()) !== was && /gif/.test(type ?? ''), JSON.stringify({ opened, staged, saved, type }));
    await cdp.evaluate("if (document.getElementById('server-dialog').open) document.getElementById('server-dialog').close(); return true;");
  }

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
