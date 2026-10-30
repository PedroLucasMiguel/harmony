// Cards under links, through the real client and server.
//
//   node client/test/link-embeds.mjs
//
// A small web server stands in for the internet. The Harmony server reads its
// pages (it is told it may, for this test only -- it will not read an address on
// the computer it runs on otherwise), keeps their pictures as files, and the
// client draws a card: site, title, text, picture, with a wide picture under the
// text and a small one beside it, and the choice of removing one or all of them.

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const HARMONY_PORT = 18223;
const FAKE_MTX_PORT = 20123;
const DEBUG_PORT = 9498;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-embeds-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-embeds-profile-'));
const { check, summary } = reporter();
const procs = [];
process.env.HARMONY_LINKS_ALLOW_PRIVATE = '1';
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

const startFakeMediaMtx = () => new Promise((done) => {
  fakeMtx = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ itemCount: 0, pageCount: 0, items: [] }));
  });
  fakeMtx.listen(FAKE_MTX_PORT, '127.0.0.1', done);
});

const startServer = () => new Promise((done, fail) => {
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
      done();
    }
  });
  p.stderr.on('data', (b) => (serverLog += b.toString()));
});

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



/** A plain picture of a given size: enough for the server to keep and the page to draw. */
function png(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

let site;
let siteBase;
const asked = [];
const startSite = () => new Promise((done) => {
  site = http.createServer((req, res) => {
    asked.push(req.url);
    const html = (body) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(body); };
    if (req.url === '/video') {
      return html(`<meta property="og:site_name" content="YouTube"><meta property="og:type" content="video.other">
        <meta property="og:title" content="Guia LORD KNIGHT &amp; mais"><meta property="og:description" content="Classe top pra PVE"><meta property="og:image" content="${siteBase}/wide.png"><meta name="theme-color" content="#ff0000">`);
    }
    if (req.url === '/shop') {
      return html(`<title>Grip Para Mao | Shopee</title><meta property="og:description" content="Compre na Shopee Brasil"><meta property="og:image" content="${siteBase}/square.png">`);
    }
    if (req.url === '/text-only') return html('<meta property="og:title" content="Just words"><meta property="og:description" content="No picture here">');
    if (req.url === '/wide.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(png(640, 336, [200, 40, 40])); }
    if (req.url === '/square.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(png(120, 120, [40, 120, 200])); }
    res.writeHead(404);
    return res.end('no');
  });
  site.listen(0, '127.0.0.1', () => {
    siteBase = `http://127.0.0.1:${site.address().port}`;
    done();
  });
});
process.on('exit', () => { try { site?.close(); } catch { /* closed */ } });

async function run() {
  await startFakeMediaMtx();
  await startServer();
  await startSite();
  token = (await api('/api/accounts/register', { nickname: 'tester', password: 'hunter22', ownerKey })).token;
  const channel = (await api('/api/channels')).channels.find((c) => c.kind === 'text');
  const post = (body) => api(`/api/channels/${channel.id}/messages`, { body });

  await post(`watch this ${siteBase}/video, it is good`);
  await post(`a shop link ${siteBase}/shop`);
  await post(`words only ${siteBase}/text-only`);
  await post('nothing to see here');
  await post(`in code \`${siteBase}/video\` is not a link`);
  await post(`two links ${siteBase}/text-only and ${siteBase}/video`);
  await post(`a dead link ${siteBase}/gone and one on this very computer http://169.254.169.254/latest/meta-data/`);

  const app = launchApp({ port: DEBUG_PORT, userDataDir });
  procs.push(app);
  const cdp = await attach(await findPage(DEBUG_PORT));
  await sleep(1200);
  const set = (id, value) => cdp.evaluate(`
    const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
    return true;`);
  await set('server-url', BASE);
  await sleep(1500);
  await set('username', 'tester');
  await set('account-password', 'hunter22');
  await cdp.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'the channels view' });
  await sleep(600);
  await cdp.evaluate(`
    [...document.querySelectorAll('#channel-items li.channel-row')]
      .find((li) => li.querySelector('.channel-name')?.textContent === ${JSON.stringify(channel.name)}).click();
    return true;`);
  await waitFor(cdp, "document.querySelectorAll('.chat-msg').length >= 7", { label: 'the messages' });
  await cdp.evaluate("document.getElementById('chat-log')?.scrollTo?.(0, 0); document.querySelectorAll('.chat-msg').forEach((m) => m.scrollIntoView({ block: 'center' })); return true;");
  await waitFor(cdp, "document.querySelectorAll('.link-embed').length >= 3", { label: 'the cards', timeoutMs: 20_000 });
  await sleep(1500);

  const cards = () => cdp.evaluate(`
    return [...document.querySelectorAll('.chat-msg')].map((m) => {
      const c = m.querySelector('.link-embed');
      const img = c?.querySelector('.link-embed-image');
      return {
        body: m.querySelector('.text')?.firstChild?.textContent?.slice(0, 24) ?? '',
        card: Boolean(c),
        site: c?.querySelector('.link-embed-site')?.textContent ?? null,
        title: c?.querySelector('.link-embed-title')?.textContent ?? null,
        description: c?.querySelector('.link-embed-description')?.textContent ?? null,
        href: c?.querySelector('.link-embed-title')?.href ?? null,
        layout: c?.dataset.layout ?? null,
        video: c ? c.hasAttribute('data-video') : false,
        stripe: c ? getComputedStyle(c).borderLeftColor : null,
        imageLoaded: img ? img.complete && img.naturalWidth > 0 : null,
        imageSrc: img?.src ?? null,
        width: c ? Math.round(c.getBoundingClientRect().width) : null,
      };
    });`);
  const all = await cards();
  const by = (text) => all.find((m) => m.body.startsWith(text));

  const video = by('watch this');
  check('a link gets a card with the site, the title and what the page says',
    video?.card && video.site === 'YouTube' && video.title === 'Guia LORD KNIGHT & mais' && video.description === 'Classe top pra PVE', JSON.stringify(video));
  check('whose title is the link', video?.href === `${siteBase}/video`);
  check('with the page\'s own colour for the stripe', video?.stripe === 'rgb(255, 0, 0)', video?.stripe);
  check('and a video is marked as one', video?.video === true);
  check('its wide picture is under the text, drawn from the app\'s own media route',
    video?.layout === 'large' && video.imageLoaded === true && video.imageSrc.startsWith('harmony://app/media/'), `${video?.layout} ${video?.imageSrc}`);

  const shop = by('a shop link');
  check('a small square picture sits beside the text', shop?.card && shop.layout === 'thumb' && shop.imageLoaded === true && shop.title === 'Grip Para Mao | Shopee' && shop.site === `127.0.0.1`, JSON.stringify(shop));
  const words = by('words only');
  check('a page without a picture is a card of text', words?.card && words.layout === 'plain' && words.title === 'Just words', JSON.stringify(words));
  check('a message with no link has no card', !by('nothing to see')?.card);
  check('and a link in code is left as code', !by('in code')?.card);
  const two = by('two links');
  check('of two links the first one is shown', two?.card && two.title === 'Just words', JSON.stringify(two));
  check('a dead link, and an address inside a network, show nothing', !by('a dead link')?.card);
  check('and the client never went to the site itself: only the server did',
    asked.filter((u) => u === '/video').length === 1 && !asked.includes('/169'), JSON.stringify(asked));

  await cdp.evaluate("document.querySelector('.chat-msg .link-embed')?.scrollIntoView({ block: 'start' }); return true;");
  await sleep(500);
  await cdp.send('Page.enable');
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(userDataDir, 'cards.png'), Buffer.from(shot.data, 'base64'));
  console.log('screenshot:', join(userDataDir, 'cards.png'));

  // --- taking one away -------------------------------------------------------------------------------------------------------------
  await cdp.evaluate("const c = document.querySelector('.link-embed-close'); c.click(); return true;");
  await sleep(300);
  const after = await cards();
  const shown = all.filter((m) => m.card).length;
  check('the cross takes a card away', after.filter((m) => m.card).length === shown - 1);

  // --- switching them off -----------------------------------------------------------------------------------------------------------
  await cdp.evaluate(`
    const box = document.getElementById('link-previews');
    box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  await sleep(800);
  const off = await cdp.evaluate("return document.querySelectorAll('.link-embed').length");
  check('the setting turns them all off', off === 0, String(off));
  await cdp.evaluate(`
    const box = document.getElementById('link-previews');
    box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  await cdp.evaluate("document.querySelectorAll('.chat-msg').forEach((m) => m.scrollIntoView({ block: 'center' })); return true;");
  await sleep(2500);
  const on = await cdp.evaluate("return document.querySelectorAll('.link-embed').length");
  check('and on again brings them back, but not the one that was taken away', on === shown - 1, `${on} of ${shown}`);

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
