// How a voice call holds up on a line that drops packets: two real clients, a real MediaMTX, and loss put on one of them
// through a UDP proxy that drops (in runs, as a wireless line does) and delays packets -- the browser's own network
// emulation does not reach WebRTC's UDP. Reports what each hears of the other over the same stretch: packets lost, how much
// of the sound the decoder made up, and how long a sound waited to be played, so that a change to how voice is sent, or to
// the relay, can be compared with the one before it.
//
//   MEDIAMTX_BIN=/path/to/mediamtx PROFILE=legacy node client/test/voice-loss.mjs
//   MEDIAMTX_BIN=/path/to/mediamtx PROFILE=auto   node client/test/voice-loss.mjs
//
//   PROFILE  how voice is sent: auto (by the size of the room, as it is now), legacy (40 ms packets, silence suppressed,
//            32 kbit/s -- how it was), long-packets, few-bits, ptime10 (one thing changed at a time; see voice-quality.js)
//   LOSS     the percentages tried, each for SECONDS seconds after a clean stretch to compare with (default 3,8)
//   JITTER   milliseconds a packet may be held back, at random (default 25)
//   DELAY    milliseconds each way, so a round trip is twice it (default 0)
//   NACK=0   the clients do not ask for lost voice packets to be sent again (the relay must answer for it to matter)
//
// The call is a recording of something like speech (made here, and cached): the browser's own test tone is a beep and a
// silence, which hides loss, and with silence suppressed it sends almost nothing.

import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const serverEntry = resolve(repoRoot, 'server', 'src', 'index.js');
const MEDIAMTX_BIN = process.env.MEDIAMTX_BIN ?? join(homedir(), 'mediamtx', 'mediamtx');
const PROFILE = process.env.PROFILE ?? 'auto';
const SPEECH = process.env.SPEECH_WAV ?? speechWav();
const LOSSES = (process.env.LOSS ?? '3,8').split(',').map(Number);
const SECONDS = Number(process.env.SECONDS ?? 24);

const PORT = 18214;
const MTX_API = 9899;
const MTX_WEBRTC = 8791;
const MTX_ICE = 8091;
const PROXY_PORT = 8191;
const DEBUG_A = 9496;
const DEBUG_B = 9497;
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE_DEVICES = [
  '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  // A recording to speak with: the browser's own tone is a beep and a silence, and a silence hides loss.
  `--use-file-for-fake-audio-capture=${SPEECH}`,
];


/** Forty seconds of something like speech -- syllables of harmonics shaped by three formants, with pauses -- as a WAV. */
function speechWav() {
  const rate = 48000;
  const total = rate * 40;
  let seed = 3;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const samples = new Float32Array(total);
  const phase = new Float64Array(26);
  let at = 0;
  while (at < total) {
    if (random() < 0.3) { at += Math.floor(rate * (0.08 + random() * 0.22)); continue; }
    const length = Math.floor(rate * (0.12 + random() * 0.14));
    const base = 100 + random() * 90;
    const formants = [500 + random() * 300, 1100 + random() * 1100, 2500 + random() * 700];
    for (let k = 0; k < length && at < total; k += 1, at += 1) {
      const envelope = Math.sin(Math.PI * (k / length)) ** 0.7;
      const pitch = base * (1 + 0.08 * Math.sin((2 * Math.PI * 5 * at) / rate));
      let sum = 0;
      for (let h = 1; h <= 25; h += 1) {
        const frequency = pitch * h;
        if (frequency > 6000) break;
        const gain = formants.reduce((all, f) => all + Math.exp(-(((frequency - f) / (0.25 * f)) ** 2)), 0) + 0.05 / h;
        phase[h] += (2 * Math.PI * frequency) / rate;
        sum += gain * Math.sin(phase[h]);
      }
      samples[at] = (sum * 0.22 + (random() * 2 - 1) * 0.01) * envelope;
    }
  }
  const peak = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  const data = Buffer.alloc(44 + total * 2);
  data.write('RIFF', 0); data.writeUInt32LE(36 + total * 2, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(total * 2, 40);
  for (let i = 0; i < total; i += 1) data.writeInt16LE(Math.round((samples[i] / peak) * 0.8 * 32767), 44 + i * 2);
  const file = join(tmpdir(), 'harmony-speechlike.wav');
  writeFileSync(file, data);
  return file;
}

const { check, summary } = reporter();
const procs = [];
process.on('exit', () => procs.forEach((p) => { try { p.kill('SIGKILL'); } catch { /* gone */ } }));

if (!existsSync(MEDIAMTX_BIN)) {
  console.log(`skipped: no MediaMTX at ${MEDIAMTX_BIN} (set MEDIAMTX_BIN)`);
  process.exit(0);
}


/**
 * A UDP proxy in front of MediaMTX's media port, for one client: what it sends and what it is sent both pass through
 * `impair`, which drops a share of them (in runs, as a wireless line does) and holds some back a few milliseconds.
 */
function startProxy() {
  const state = { lossPct: 0, burst: 0.5, jitterMs: 0, delayMs: 0, sent: 0, dropped: 0 };
  const server = dgram.createSocket('udp4');
  /** client "ip:port" -> {socket, client} */
  const flows = new Map();
  let inBurst = false;
  const impair = (buf, send) => {
    state.sent += 1;
    // Gilbert-Elliott: a drop makes the next one likelier, and the average stays at lossPct.
    const p = state.lossPct / 100;
    const stay = state.burst;
    const enter = p > 0 ? (p * (1 - stay)) / (1 - p) : 0;
    inBurst = inBurst ? Math.random() < stay : Math.random() < enter;
    if (inBurst && p > 0) { state.dropped += 1; return; }
    const wait = state.delayMs + (state.jitterMs > 0 ? Math.random() * state.jitterMs : 0);
    if (wait > 0) setTimeout(() => send(buf), wait);
    else send(buf);
  };
  server.on('message', (buf, rinfo) => {
    const key = `${rinfo.address}:${rinfo.port}`;
    let flow = flows.get(key);
    if (!flow) {
      const socket = dgram.createSocket('udp4');
      socket.on('message', (reply) => impair(reply, (b) => server.send(b, rinfo.port, rinfo.address)));
      flow = { socket };
      flows.set(key, flow);
    }
    impair(buf, (b) => flow.socket.send(b, MTX_ICE, '127.0.0.1'));
  });
  return new Promise((done) => server.bind(PROXY_PORT, '127.0.0.1', () => done({ state, close: () => { server.close(); for (const f of flows.values()) f.socket.close(); } })));
}

async function startMediaMtx() {
  const dir = mkdtempSync(join(tmpdir(), 'harmony-loss-mtx-'));
  const config = join(dir, 'mediamtx.yml');
  copyFileSync(join(repoRoot, 'server', 'mediamtx.yml'), config);
  const p = spawn(MEDIAMTX_BIN, [config], {
    env: {
      ...process.env,
      MTX_AUTHHTTPADDRESS: `${BASE}/mediamtx/auth`,
      MTX_WEBRTCADDRESS: `:${MTX_WEBRTC}`,
      MTX_APIADDRESS: `127.0.0.1:${MTX_API}`,
      MTX_WEBRTCLOCALUDPADDRESS: `:${MTX_ICE}`,
      MTX_WEBRTCLOCALTCPADDRESS: `:${MTX_ICE}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(p);
  let log = '';
  p.stdout.on('data', (b) => (log += b.toString()));
  p.stderr.on('data', (b) => (log += b.toString()));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (new RegExp(`\\[WebRTC\\].*:${MTX_WEBRTC}`).test(log)) return;
    await sleep(200);
  }
  throw new Error('MediaMTX did not start');
}

function startServer() {
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        HARMONY_PORT: String(PORT),
        HARMONY_HOST: '127.0.0.1',
        HARMONY_DATA_DIR: mkdtempSync(join(tmpdir(), 'harmony-loss-')),
        HARMONY_POLL_INTERVAL_MS: '400',
        HARMONY_MEDIAMTX_API: `http://127.0.0.1:${MTX_API}`,
        HARMONY_SIGNALING_URL: `http://127.0.0.1:${MTX_WEBRTC}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    procs.push(p);
    const timer = setTimeout(() => fail(new Error('server did not start')), 15_000);
    let log = '';
    let ownerKey = null;
    p.stdout.on('data', (b) => {
      log += b.toString();
      const match = /^\s*│\s+([A-Za-z0-9_-]{20,})\s+│$/m.exec(log);
      if (match) ownerKey = match[1];
      if (log.includes('control server on')) { clearTimeout(timer); done(() => ownerKey); }
    });
    p.stderr.on('data', (b) => (log += b.toString()));
  });
}

const setInput = (id, value) => `{ const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
  i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); }`;

async function signIn(page, nickname, ownerKey) {
  await page.evaluate(`${setInput('server-url', BASE)} return true;`);
  await sleep(1500);
  await page.evaluate(`${setInput('username', nickname)} ${setInput('account-password', 'hunter22')} ${setInput('account-confirm', 'hunter22')} ${ownerKey ? setInput('owner-key', ownerKey) : ''}
    document.getElementById('continue').click(); return true;`);
  await waitFor(page, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: `${nickname} signing in` });
  await sleep(800);
}

/** What this client hears of everybody else, as the browser counts it. */
const heard = (page) => page.evaluate('return window.__harmonyVoice().audioQuality()');

/** What happened between two readings of what a client hears. */
function between(first, last) {
  const s = last.receiving[0];
  const f = first.receiving[0];
  const received = (s?.packets ?? 0) - (f?.packets ?? 0);
  const lost = (s?.lost ?? 0) - (f?.lost ?? 0);
  const samples = (s?.samples ?? 0) - (f?.samples ?? 0);
  const emitted = (s?.bufferEmitted ?? 0) - (f?.bufferEmitted ?? 0);
  return {
    packets: received,
    lostPct: received + lost > 0 ? Number(((100 * lost) / (received + lost)).toFixed(1)) : 0,
    concealedPct: samples > 0 ? Number(((100 * ((s.concealedSamples ?? 0) - (f.concealedSamples ?? 0))) / samples).toFixed(1)) : null,
    // How long, on average, a sample waited to be played in the stretch: what the listener's delay was.
    bufferMs: emitted > 0 ? Math.round((1000 * ((s.bufferDelaySum ?? 0) - (f.bufferDelaySum ?? 0))) / emitted) : null,
    jitterMs: s?.jitterMs ?? null,
  };
}

/** Two readings a while apart, and what happened between them. */
async function measure(page, seconds) {
  const first = await heard(page);
  await sleep(seconds * 1000);
  return between(first, await heard(page));
}

async function run() {
  console.log(`Profile "${PROFILE}"; ${LOSSES.join('%, ')}% loss on the second client.\n`);
  await startMediaMtx();
  const ownerKey = await startServer();

  const a = launchApp({ port: DEBUG_A, userDataDir: mkdtempSync(join(tmpdir(), 'harmony-loss-a-')), extraArgs: FAKE_DEVICES });
  procs.push(a);
  const pageA = await attach(await findPage(DEBUG_A));
  await sleep(1500);
  await signIn(pageA, 'ana', ownerKey());
  const b = launchApp({ port: DEBUG_B, userDataDir: mkdtempSync(join(tmpdir(), 'harmony-loss-b-')), extraArgs: FAKE_DEVICES });
  procs.push(b);
  const pageB = await attach(await findPage(DEBUG_B));
  await sleep(1500);
  await fetch(`${BASE}/api/accounts/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nickname: 'bob', password: 'hunter22' }) });
  await signIn(pageB, 'bob');

  const proxy = await startProxy();
  // Bob's media goes through the proxy: the address MediaMTX gives for UDP is swapped for the proxy's, and the others
  // (a LAN address, TCP) are taken out, so that nothing reaches the relay another way.
  // And the relay is told of none of Bob's own addresses, so that it can only answer where Bob's checks come from.
  await pageB.evaluate(`const { harmony } = await import('./bridge.js'); const original = harmony.api.sdp;
    harmony.api.sdp = (url, offer) => original(url, offer.split(/\\r?\\n/).filter((l) => !l.startsWith('a=candidate:')).join('\\r\\n')); return true;`);
  await pageB.evaluate(`const sr = RTCPeerConnection.prototype.setRemoteDescription;
    RTCPeerConnection.prototype.setRemoteDescription = function (d) {
      if (d?.type === 'answer') {
        const lines = d.sdp.split(/\\r?\\n/).filter((l) => !l.startsWith('a=candidate:') || (/ udp /.test(l) && / 127\\.0\\.0\\.1 /.test(l)));
        d = { type: d.type, sdp: lines.map((l) => (l.startsWith('a=candidate:') ? l.replace(' ${MTX_ICE} ', ' ${PROXY_PORT} ') : l)).join('\\r\\n') };
      }
      return sr.call(this, d);
    }; return true;`);
  for (const page of [pageA, pageB]) {
    if (process.env.NACK === '0') await page.evaluate('window.__harmonyAudioNack = false; return true;');
    await page.evaluate(`window.__harmonyVoice().profileOverride = ${PROFILE === 'auto' ? 'null' : JSON.stringify(PROFILE)}; return true;`);
    await page.evaluate(`[...document.querySelectorAll('#channel-items li.channel-row')].find((li) => li.querySelector('.channel-name')?.textContent === 'voice').click(); return true;`);
    await waitFor(page, "!document.getElementById('voice-active').hidden", { label: 'in the room', timeoutMs: 40_000 });
  }
  for (const page of [pageA, pageB]) await waitFor(page, 'document.querySelectorAll("#voice-roster li").length === 2', { label: 'both in the room', timeoutMs: 40_000 });
  await waitFor(pageB, '(await window.__harmonyVoice().audioQuality()).receiving.some((r) => (r.packets ?? 0) > 50)', { label: 'sound arriving', timeoutMs: 40_000 });
  await waitFor(pageA, '(await window.__harmonyVoice().audioQuality()).receiving.some((r) => (r.packets ?? 0) > 50)', { label: 'sound arriving at ana', timeoutMs: 40_000 });
  await sleep(3000);

  const rows = [];
  const cleanUpStart = await heard(pageA);
  const clean = await measure(pageB, 12);
  rows.push({ loss: 0, ...clean });
  const upRows = [{ loss: 0, ...between(cleanUpStart, await heard(pageA)) }];
  for (const loss of LOSSES) {
    proxy.state.lossPct = loss;
    proxy.state.jitterMs = Number(process.env.JITTER ?? 25);
    // One way, each way: a round trip is twice it.
    proxy.state.delayMs = Number(process.env.DELAY ?? 0);
    // Let the encoder and the buffer notice it, then read both ways over the same stretch.
    await sleep(6000);
    const startA = await heard(pageA);
    const down = await measure(pageB, SECONDS);
    rows.push({ loss, ...down });
    upRows.push({ loss, ...between(startA, await heard(pageA)) });
    proxy.state.lossPct = 0;
    proxy.state.jitterMs = 0;
    proxy.state.delayMs = 0;
    await sleep(8000);
  }
  console.log(`\n  proxy: ${proxy.state.dropped} of ${proxy.state.sent} datagrams dropped`);
  console.log('\n  what Ana hears of Bob (his line is the bad one)');
  console.table(upRows);
  proxy.close();
  console.log('\n  what Bob hears of Ana');
  console.table(rows);
  check('the measurement ran', rows.length === 1 + LOSSES.length);
}

run()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => {
    const failed = summary();
    setTimeout(() => process.exit(process.exitCode ?? (failed ? 1 : 0)), 200);
  });
