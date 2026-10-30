// A video, a sound and a file with no preview, as they are drawn in a text channel.
//
//   node client/test/media-attachments.mjs
//
// A video has to PLAY, not just be there: the page serves attachments from its
// own scheme, and Chromium will only stream media from one that answers byte
// ranges. The clips are made with ffmpeg (skipped without it), the mp4 with its
// index at the end as a phone writes it, which is the case that needs ranges.

import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const HARMONY_PORT = 18221;
const FAKE_MTX_PORT = 20121;
const DEBUG_PORT = 9496;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-media-att-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-media-att-profile-'));
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


const clipDir = mkdtempSync(join(tmpdir(), 'harmony-media-att-clips-'));
function makeClips() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    return null;
  }
  const ff = (...args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
  const mp4 = join(clipDir, 'phone.mp4');
  const webm = join(clipDir, 'screen.webm');
  const wav = join(clipDir, 'note.wav');
  // No faststart: the index is at the end of the file, as a phone writes it.
  ff('-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', mp4);
  ff('-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30', '-t', '4', '-c:v', 'libvpx', webm);
  ff('-f', 'lavfi', '-i', 'sine=frequency=330', '-t', '3', wav);
  return [
    [mp4, 'video/mp4', 'video'],
    [webm, 'video/webm', 'video'],
    [wav, 'audio/wav', 'audio'],
  ];
}

async function postFile(channelId, path, type) {
  const bytes = readFileSync(path);
  const up = await fetch(`${BASE}/api/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': type, Authorization: `Bearer ${token}` },
    body: bytes,
  });
  const { hash } = await up.json();
  const name = path.split('/').pop();
  const { message } = await api(`/api/channels/${channelId}/messages`, { body: '', attachmentHash: hash, attachmentName: name });
  return message;
}

async function run() {
  const clips = makeClips();
  if (!clips) {
    check('ffmpeg is there to make the clips (skipped without it)', true, 'not found');
    return;
  }
  await startFakeMediaMtx();
  await startServer();
  token = (await api('/api/accounts/register', { nickname: 'tester', password: 'hunter22', ownerKey })).token;
  const channel = (await api('/api/channels')).channels.find((c) => c.kind === 'text');
  const messages = [];
  for (const [path, type] of clips) messages.push(await postFile(channel.id, path, type));
  // Text files: a short log, a big one (read only at its start), a huge one (a card only), and a binary with a text name.
  const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1} of the log: <b>not html</b> & still text`).join('\n');
  const texts = [
    ['server.log', lines(500)],
    ['big.md', lines(30_000)],
    ['huge.txt', `${lines(60_000)}\n`.repeat(2)],
  ];
  for (const [name, content] of texts) {
    const path = join(clipDir, name);
    writeFileSync(path, content);
    messages.push(await postFile(channel.id, path, 'text/plain'));
  }
  const binary = join(clipDir, 'not-really.txt');
  writeFileSync(binary, Buffer.from([80, 75, 3, 4, 0, 0, 0, 1, 2, 3, ...Array(500).fill(0)]));
  messages.push(await postFile(channel.id, binary, 'text/plain'));
  // Two files with nothing to look at.
  for (const [name, type, size] of [['Harmony-2.9.1-portable.exe', 'application/x-msdownload', 86_000_000 / 1000], ['notes.zip', 'application/zip', 4_000]]) {
    const path = join(clipDir, name);
    writeFileSync(path, Buffer.alloc(size, 9));
    messages.push(await postFile(channel.id, path, type));
  }

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
  await waitFor(cdp, "document.querySelectorAll('.chat-msg .attachment').length >= 9", { label: 'the nine attachments' });
  await sleep(800);

  const video = await cdp.evaluate(`return document.querySelectorAll('.chat-msg video').length`);
  check('both videos are drawn', video === 2, String(video));

  const results = [];
  for (let n = 0; n < 2; n += 1) {
    results.push(await cdp.evaluate(`
      const el = document.querySelectorAll('.chat-msg video')[${n}];
      const until = (fn, ms) => new Promise((ok) => { const t0 = performance.now(); const tick = () => (fn() || performance.now() - t0 > ms ? ok() : setTimeout(tick, 50)); tick(); });
      el.scrollIntoView({ block: 'center' });
      await until(() => el.readyState >= 1 || el.error, 6000);
      if (el.error) return { error: 'media error ' + el.error.code };
      const duration = el.duration;
      el.muted = true;
      try { await el.play(); } catch (err) { return { error: 'play() ' + err.message, duration }; }
      await until(() => el.currentTime > 0.4, 5000);
      const advanced = el.currentTime;
      el.currentTime = 2;
      await until(() => !el.seeking && Math.abs(el.currentTime - 2) < 1, 5000);
      const seeked = el.currentTime;
      const box = el.getBoundingClientRect();
      el.pause();
      return { duration, advanced, seeked, width: Math.round(box.width), height: Math.round(box.height) };`));
  }
  const [vp, vw] = results;
  check('an mp4 with its index at the end plays', !vp.error && vp.advanced > 0.4, JSON.stringify(vp));
  check('and can be moved around in', !vp.error && Math.abs(vp.seeked - 2) < 1, JSON.stringify(vp));
  check('a webm plays', !vw.error && vw.advanced > 0.4, JSON.stringify(vw));
  check('and can be moved around in', !vw.error && Math.abs(vw.seeked - 2) < 1, JSON.stringify(vw));

  const sound = await cdp.evaluate(`
    const el = document.querySelector('.chat-msg audio');
    if (!el) return { error: 'not drawn' };
    const until = (fn, ms) => new Promise((ok) => { const t0 = performance.now(); const tick = () => (fn() || performance.now() - t0 > ms ? ok() : setTimeout(tick, 50)); tick(); });
    await until(() => el.readyState >= 1 || el.error, 6000);
    if (el.error) return { error: 'media error ' + el.error.code };
    el.muted = true;
    try { await el.play(); } catch (err) { return { error: 'play() ' + err.message }; }
    await until(() => el.currentTime > 0.4, 5000);
    const t = el.currentTime; el.pause(); return { advanced: t, duration: el.duration };`);
  check('a sound plays', !sound.error && sound.advanced > 0.4, JSON.stringify(sound));

  // --- text files: the first lines, read from the start of the file ---------------------------------------------------------
  const textState = () => cdp.evaluate(`
    const out = {};
    for (const c of document.querySelectorAll('.chat-msg .attachment-textfile')) {
      const name = c.querySelector('.attachment-name').textContent;
      out[name] = {
        shown: c.querySelector('.textfile-body')?.hidden === false,
        lines: c.querySelector('.textfile-lines').textContent.split('\\n').length,
        chars: c.querySelector('.textfile-lines').textContent.length,
        left: c.querySelector('.textfile-left')?.textContent,
        html: c.querySelector('.textfile-lines').children.length,
        toggle: c.querySelector('.textfile-toggle')?.hidden === false,
        height: Math.round(c.getBoundingClientRect().height),
      };
    }
    return out;`);
  await cdp.evaluate("document.querySelectorAll('.chat-msg .attachment-textfile').forEach((c) => c.scrollIntoView({ block: 'center' })); return true;");
  await sleep(1200);
  let texts1 = await textState();
  check('a text file shows its first ten lines and says how many are left',
    texts1['server.log']?.shown && texts1['server.log'].lines === 10 && /490 lines left/.test(texts1['server.log'].left), JSON.stringify(texts1['server.log']));
  check('a big one shows ten lines as well, and how much of it is left',
    texts1['big.md']?.shown && texts1['big.md'].lines === 10 && /KB left/.test(texts1['big.md'].left), JSON.stringify(texts1['big.md']));
  check('what is in the file is shown as text, never as markup', texts1['server.log']?.html === 0);
  check('a text file over 2 MB, and one that is not text, are only a row',
    !texts1['huge.txt'] && (!texts1['not-really.txt'] || !texts1['not-really.txt'].shown), JSON.stringify([texts1['huge.txt'], texts1['not-really.txt']]));
  await cdp.evaluate("document.querySelector('.chat-msg .attachment-textfile .textfile-toggle').click(); return true;");
  await sleep(300);
  const unfolded = (await textState())['server.log'];
  check('unfolding it shows more, but not the whole file', unfolded.lines === 400 && /100 lines left/.test(unfolded.left), JSON.stringify(unfolded));
  const unfoldedBig = await cdp.evaluate(`
    const c = [...document.querySelectorAll('.chat-msg .attachment-textfile')].find((x) => x.querySelector('.attachment-name').textContent === 'big.md');
    c.querySelector('.textfile-toggle').click();
    const pre = c.querySelector('.textfile-lines');
    return { lines: pre.textContent.split('\\n').length, chars: pre.textContent.length };`);
  check('and a big one is read only as far as the preview goes (64 KB), not in full', unfoldedBig.chars < 70_000 && unfoldedBig.lines > 400 === false, JSON.stringify(unfoldedBig));
  await cdp.evaluate("document.querySelector('.chat-msg .attachment-textfile .textfile-toggle').click(); return true;");
  await sleep(200);

  const cards = await cdp.evaluate(`
    return [...document.querySelectorAll('.chat-msg .attachment-card')].map((c) => ({
      icon: c.querySelector('.attachment-icon')?.dataset.icon,
      name: c.querySelector('.attachment-name')?.textContent,
      size: c.querySelector('.attachment-size')?.textContent,
      linked: c.querySelector('.attachment-name')?.getAttribute('role') === 'button',
      save: Boolean(c.querySelector('.msg-tool[data-icon="download-simple"]')),
      iconPx: Math.round(c.querySelector('.attachment-icon').getBoundingClientRect().width),
      width: Math.round(c.getBoundingClientRect().width),
    }));`);
  check('a file with no preview is a card, with a kind of icon for what it is',
    cards.length === 3 && cards[0].icon === 'file-text' && cards[1].icon === 'file' && cards[2].icon === 'file-zip', JSON.stringify(cards.map((c) => c.icon)));
  check('that says its name and size, and can be saved from the name and from a button',
    cards[1]?.name === 'Harmony-2.9.1-portable.exe' && /KB|MB/.test(cards[1].size) && cards.every((c) => c.linked && c.save), JSON.stringify(cards[1]));
  check('and the card is drawn at a size, not collapsed', cards.every((c) => c.iconPx >= 30 && c.width >= 200), JSON.stringify(cards.map((c) => [c.iconPx, c.width])));
  await cdp.evaluate("document.querySelector('.chat-msg .attachment-textfile')?.scrollIntoView({ block: 'center' }); return true;");
  await sleep(400);
  await cdp.send('Page.enable');
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(clipDir, 'channel.png'), Buffer.from(shot.data, 'base64'));
  console.log('screenshot:', join(clipDir, 'channel.png'));
  console.log('sizes on screen:', JSON.stringify(results.map((r) => `${r.width}x${r.height}`)));
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
