// Voice messages in a text channel, through the real client: Chromium's fake
// microphone is what is recorded.
//
//   node client/test/voice-notes.mjs
//
// The microphone takes the send button's place while the box is empty; pressing
// it records (pause, discard and send work); what is sent is an audio/webm file
// with a voice-message name; and it comes back as a player that knows how long
// it is, draws its waveform, plays, moves around and changes speed.

import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', '..', 'server', 'src', 'index.js');

const HARMONY_PORT = 18222;
const FAKE_MTX_PORT = 20122;
const DEBUG_PORT = 9497;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), 'harmony-voice-'));
const userDataDir = mkdtempSync(join(tmpdir(), 'harmony-voice-profile-'));
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



async function run() {
  await startFakeMediaMtx();
  await startServer();
  token = (await api('/api/accounts/register', { nickname: 'tester', password: 'hunter22', ownerKey })).token;
  const channel = (await api('/api/channels')).channels.find((c) => c.kind === 'text');
  const messages = async () => (await api(`/api/channels/${channel.id}/messages`)).messages;

  const app = launchApp({
    port: DEBUG_PORT,
    userDataDir,
    extraArgs: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  procs.push(app);
  const cdp = await attach(await findPage(DEBUG_PORT));
  await sleep(1200);
  const set = (id, value) => cdp.evaluate(`
    const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
    return true;`);
  const click = (id) => cdp.evaluate(`document.getElementById(${JSON.stringify(id)}).click(); return true;`);
  const text = (selector) => cdp.evaluate(`return document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
  const visible = (id) => cdp.evaluate(`const e = document.getElementById(${JSON.stringify(id)}); return Boolean(e) && !e.hidden && e.getBoundingClientRect().width > 0`);

  await set('server-url', BASE);
  await sleep(1500);
  await set('username', 'tester');
  await set('account-password', 'hunter22');
  await click('continue');
  await waitFor(cdp, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: 'the channels view' });
  await sleep(600);
  await cdp.evaluate(`
    [...document.querySelectorAll('#channel-items li.channel-row')]
      .find((li) => li.querySelector('.channel-name')?.textContent === ${JSON.stringify(channel.name)}).click();
    return true;`);
  await waitFor(cdp, "document.getElementById('chat-name').textContent.length > 0", { label: 'the text channel' });
  await sleep(500);

  // --- the microphone where the send button is -------------------------------------------------------------------------------
  check('with nothing to send the microphone is shown, and not the send button',
    await visible('chat-record') && !(await visible('chat-send')));
  await set('chat-input', 'hello');
  check('typing swaps it for the send button', !(await visible('chat-record')) && await visible('chat-send'));
  await set('chat-input', '');
  check('and emptying the box brings the microphone back', await visible('chat-record') && !(await visible('chat-send')));

  // --- recording ------------------------------------------------------------------------------------------------------------------
  await click('chat-record');
  await waitFor(cdp, "!document.getElementById('chat-recorder').hidden", { label: 'the recorder' });
  check('pressing it replaces the box with the recorder', await visible('chat-recorder') && !(await cdp.evaluate("return document.querySelector('.composer-row').getBoundingClientRect().height > 0")));
  await sleep(1400);
  const t1 = await text('.voice-time');
  check('the time runs', /^0:0[1-9]$/.test(t1), t1);
  const drawn = await cdp.evaluate(`
    const c = document.querySelector('.voice-live'); const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data; let on = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) on += 1; return on;`);
  check('and the level is drawn', drawn > 50, String(drawn));

  const shot = async (name) => {
    await cdp.send('Page.enable');
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(userDataDir, name), Buffer.from(data, 'base64'));
    console.log('screenshot:', join(userDataDir, name));
  };
  await shot('recording.png');
  await cdp.evaluate("document.querySelector('.voice-pause').click(); return true;");
  await sleep(300);
  const p1 = await text('.voice-time');
  await sleep(1300);
  const p2 = await text('.voice-time');
  check('pausing stops the time', p1 === p2, `${p1} ${p2}`);
  check('and the button says it can go on', (await cdp.evaluate("return document.querySelector('.voice-pause').dataset.icon")) === 'microphone');
  await cdp.evaluate("document.querySelector('.voice-pause').click(); return true;");
  await sleep(1200);
  const p3 = await text('.voice-time');
  check('going on starts it again', p3 !== p2, `${p2} -> ${p3}`);

  // --- discarding ----------------------------------------------------------------------------------------------------------------
  const before = (await messages()).length;
  await cdp.evaluate("document.querySelector('.voice-trash').click(); return true;");
  await sleep(500);
  check('the bin throws the recording away: the box is back and nothing was sent',
    !(await visible('chat-recorder')) && await visible('chat-record') && (await messages()).length === before);

  await click('chat-record');
  await waitFor(cdp, "!document.getElementById('chat-recorder').hidden", { label: 'the recorder again' });
  await sleep(800);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(400);
  check('Escape does too', !(await visible('chat-recorder')) && (await messages()).length === before);

  // --- too short -----------------------------------------------------------------------------------------------------------------
  await click('chat-record');
  await waitFor(cdp, "document.getElementById('chat-recorder').hasAttribute('data-ready')", { label: 'the recorder for a short one' });
  await cdp.evaluate("document.querySelector('.voice-send').click(); return true;");
  await sleep(700);
  const note = await text('#chat-note');
  check('a slip of the finger is not sent, and says so', (await messages()).length === before && /too short/i.test(note ?? ''), note);

  // --- sending -------------------------------------------------------------------------------------------------------------------
  await click('chat-record');
  await waitFor(cdp, "document.getElementById('chat-recorder').hasAttribute('data-ready')", { label: 'the recorder to send from' });
  await sleep(2600);
  await cdp.evaluate("document.querySelector('.voice-send').click(); return true;");
  const deadline = Date.now() + 15_000;
  let sent = null;
  while (Date.now() < deadline && !sent) {
    sent = (await messages()).find((m) => /^voice-message-/.test(m.attachmentName ?? ''));
    if (!sent) await sleep(300);
  }
  check('sending keeps it as a voice message: a dated audio/webm file', Boolean(sent) && /^voice-message-\d{8}-\d{6}\.webm$/.test(sent.attachmentName) && sent.mediaType === 'audio' && sent.attachmentBytes > 2000,
    sent ? `${sent.attachmentName} ${sent.attachmentBytes} bytes ${sent.mediaType}` : 'nothing arrived');
  check('and the box is back to the microphone', await visible('chat-record') && !(await visible('chat-recorder')));

  // --- the player ----------------------------------------------------------------------------------------------------------------
  await waitFor(cdp, "document.querySelector('.chat-msg .voice-note')", { label: 'the player' });
  await cdp.evaluate("document.querySelector('.voice-note').scrollIntoView({ block: 'center' }); return true;");
  await waitFor(cdp, "/^\\d+:\\d\\d$/.test(document.querySelector('.voice-note .voice-length').textContent)", { label: 'its length', timeoutMs: 15_000 });
  const player = await cdp.evaluate(`
    const n = document.querySelector('.voice-note');
    const heights = [...n.querySelectorAll('.voice-bar')].map((b) => parseFloat(b.style.height));
    return { length: n.querySelector('.voice-length').textContent, bars: heights.length, spread: Math.max(...heights) - Math.min(...heights),
      audioElements: document.querySelectorAll('.chat-msg audio').length, width: Math.round(n.getBoundingClientRect().width) };`);
  const seconds = Number(player.length.split(':')[0]) * 60 + Number(player.length.split(':')[1]);
  check('it knows how long it is', seconds >= 2 && seconds <= 4, player.length);
  check('and draws a waveform', player.bars === 40 && player.spread > 10, JSON.stringify(player));
  check('as its own player, not the browser\'s', player.audioElements === 0 && player.width > 200, JSON.stringify(player));

  await shot('player.png');
  await cdp.evaluate("document.querySelector('.voice-note .voice-play').click(); return true;");
  await waitFor(cdp, "document.querySelector('.voice-note')?.hasAttribute('data-playing')", { label: 'playing' });
  await sleep(900);
  const during = await cdp.evaluate("return document.querySelector('.voice-note .voice-length').textContent");
  check('it plays, and the time counts up', /^0:0[0-9]$/.test(during) && during !== player.length, `${during} of ${player.length}`);
  check('the play button becomes a pause', (await cdp.evaluate("return document.querySelector('.voice-play').dataset.icon")) === 'pause');
  const done = await cdp.evaluate("return document.querySelectorAll('.voice-note .voice-bar[data-done]').length");
  check('and the waveform fills as it goes', done > 0 && done < 40, String(done));

  await cdp.evaluate("document.querySelector('.voice-note .voice-speed').click(); return true;");
  await sleep(200);
  check('the speed button goes to 1.5x', (await text('.voice-note .voice-speed')) === '1.5\u00d7');

  // Stopped, so that it is the press that moves it and not the sound running out.
  await cdp.evaluate("document.querySelector('.voice-note .voice-play').click(); return true;");
  await sleep(300);
  // Press near the end of the waveform.
  await cdp.evaluate(`
    const w = document.querySelector('.voice-note .voice-bars').getBoundingClientRect();
    document.querySelector('.voice-note .voice-bars').dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: w.left + w.width * 0.8, clientY: w.top + 5 }));
    return true;`);
  await sleep(500);
  const moved = await cdp.evaluate("return document.querySelectorAll('.voice-note .voice-bar[data-done]').length");
  check('pressing the waveform moves to that place', moved >= 28, String(moved));

  // A new message re-draws the chat; the one that is playing must go on.
  await api(`/api/channels/${channel.id}/messages`, undefined);
  await fetch(`${BASE}/api/channels/${channel.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ body: 'a message that redraws the chat' }) });
  await sleep(1000);
  check('and a message arriving keeps the place it was moved to', (await cdp.evaluate("return document.querySelectorAll('.voice-note .voice-bar[data-done]').length")) >= 28);
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
