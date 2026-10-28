// A load run: ten people on one server, measured.
//
// The scenario from a real evening: four in one voice room with camera and
// microphone on, four in a second room muted, two in a third with a microphone
// only. Real clients, a real server and a real MediaMTX; nothing is asserted --
// it prints what the server and the relay cost while this goes on, so that a
// change to either can be compared with the last run.
//
//   MEDIAMTX_BIN=/path/to/mediamtx node client/test/load.mjs
//   LOAD_SECONDS=60   how long to measure (default 60)

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const serverEntry = resolve(repoRoot, 'server', 'src', 'index.js');

const MEDIAMTX_BIN = process.env.MEDIAMTX_BIN ?? join(homedir(), 'mediamtx', 'mediamtx');
if (!existsSync(MEDIAMTX_BIN)) {
  console.log(`No MediaMTX at ${MEDIAMTX_BIN}. Set MEDIAMTX_BIN.`);
  process.exit(0);
}

const HARMONY_PORT = 18260;
const MTX_API_PORT = 9997 - 110;
const MTX_WEBRTC_PORT = 8889 - 110;
const MTX_ICE_PORT = 8189 - 110;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;
/** Where the clients go: the same server, a slow road away. */


const dataDir = mkdtempSync(join(tmpdir(), 'harmony-ld-'));
const { check, summary } = reporter();
const procs = [];
let mtxLog = '';
let serverLog = '';
let ownerKey = null;

process.on('exit', () => {
  for (const p of procs) {
    try { p.kill(); } catch { /* already gone */ }
  }
});
process.on('SIGINT', () => process.exit(130));

async function startMediaMtx() {
  const dir = mkdtempSync(join(tmpdir(), 'harmony-ld-mtx-'));
  const config = join(dir, 'mediamtx.yml');
  copyFileSync(join(repoRoot, 'server', 'mediamtx.yml'), config);
  const p = spawn(MEDIAMTX_BIN, [config], {
    env: {
      ...process.env,
      MTX_AUTHHTTPADDRESS: `${BASE}/mediamtx/auth`,
      MTX_WEBRTCADDRESS: `:${MTX_WEBRTC_PORT}`,
      MTX_PPROF: 'yes',
      MTX_PPROFADDRESS: '127.0.0.1:19999',
      MTX_APIADDRESS: `127.0.0.1:${MTX_API_PORT}`,
      MTX_WEBRTCLOCALUDPADDRESS: `:${MTX_ICE_PORT}`,
      MTX_WEBRTCLOCALTCPADDRESS: `:${MTX_ICE_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(p);
  p.stdout.on('data', (b) => (mtxLog += b.toString()));
  p.stderr.on('data', (b) => (mtxLog += b.toString()));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (new RegExp(`\\[WebRTC\\].*:${MTX_WEBRTC_PORT}`).test(mtxLog)) return;
    await sleep(200);
  }
  throw new Error('MediaMTX did not start');
}

function startServer() {
  return new Promise((done, fail) => {
    const p = spawn(process.execPath, [serverEntry], {
      env: {
        ...process.env,
        HARMONY_PORT: String(HARMONY_PORT),
        HARMONY_HOST: '127.0.0.1',
        HARMONY_DATA_DIR: dataDir,
        HARMONY_MEDIAMTX_API: `http://127.0.0.1:${MTX_API_PORT}`,
        HARMONY_SIGNALING_URL: `http://127.0.0.1:${MTX_WEBRTC_PORT}`,
        HARMONY_POLL_INTERVAL_MS: '400',
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
}

const register = async (nickname, extra = {}) => {
  const res = await fetch(`${BASE}/api/accounts/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, password: 'hunter22', ...extra }),
  });
  if (!res.ok) throw new Error(`register ${nickname}: ${res.status}`);
};

const SECONDS = Number(process.env.LOAD_SECONDS ?? 60);
const BASE_PORT = 9600;

const STUBS = `
  const md = navigator.mediaDevices;
  md.enumerateDevices = async () => [
    { kind: 'audioinput', deviceId: 'default', label: 'Microphone', groupId: 'g1' },
    { kind: 'videoinput', deviceId: 'camera', label: 'Camera', groupId: 'g2' },
  ].map((d) => ({ ...d, toJSON: () => d }));
  // LOAD_NO_DTX / LOAD_NO_PTIME: strip what the app asked of the encoder, to measure without it.
  const stripDtx = ${JSON.stringify(Boolean(process.env.LOAD_NO_DTX))};
  const stripPtime = ${JSON.stringify(Boolean(process.env.LOAD_NO_PTIME))};
  if (stripDtx || stripPtime) {
    const real = RTCPeerConnection.prototype.setRemoteDescription;
    RTCPeerConnection.prototype.setRemoteDescription = function (d) {
      if (!d || !d.sdp) return real.call(this, d);
      let sdp = d.sdp;
      if (stripDtx) sdp = sdp.replace(/;usedtx=1/g, '');
      if (stripPtime) sdp = sdp.replace(/a=(max)?ptime:\\d+\\r?\\n/g, '');
      return real.call(this, { type: d.type, sdp });
    };
  }
  md.getUserMedia = async (c = {}) => {
    const tracks = [];
    if (c.audio) {
      const ctx = new AudioContext(); const out = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator(); osc.frequency.value = 180 + Math.random() * 200;
      const g = ctx.createGain(); g.gain.value = 0.05;
      osc.connect(g); g.connect(out); osc.start();
      tracks.push(...out.stream.getAudioTracks());
    }
    if (c.video) {
      const w = c.video.width?.ideal ?? 640, h = c.video.height?.ideal ?? 360;
      const feed = document.createElement('canvas'); feed.width = w; feed.height = h;
      const g = feed.getContext('2d'); let n = 0;
      // Moving, so the encoder has real work and the bitrate is what a camera's would be.
      setInterval(() => {
        n += 1;
        const grad = g.createLinearGradient(0, 0, w, h); grad.addColorStop(0, 'hsl(' + (n * 3 % 360) + ',60%,40%)'); grad.addColorStop(1, '#101830');
        g.fillStyle = grad; g.fillRect(0, 0, w, h);
        for (let i = 0; i < 40; i++) { g.fillStyle = 'hsl(' + ((i * 40 + n * 5) % 360) + ',70%,60%)'; g.fillRect((i * 97 + n * 13) % w, (i * 53 + n * 7) % h, 30, 30); }
      }, 1000 / 24);
      tracks.push(feed.captureStream(24).getVideoTracks()[0]);
    }
    return new MediaStream(tracks);
  };
  return true;`;

const setInput = (id, value) => `{
  const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)};
  i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
}`;

/** Cumulative CPU seconds and resident memory. `ps %cpu` on macOS is a decayed average, which cannot be compared between runs. */
const ps = (pid) => {
  try {
    const [time, rss] = execFileSync('ps', ['-o', 'time=,rss=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/);
    const [m, sec] = time.split(':');
    return { cpuSeconds: Number(m) * 60 + Number(sec), rssMb: Math.round(Number(rss) / 1024) };
  } catch { return { cpuSeconds: 0, rssMb: 0 }; }
};

const mtxApi = async (path) => (await fetch(`http://127.0.0.1:${MTX_API_PORT}${path}`)).json();

const sessionTotals = async () => {
  const [reads, writes] = [await mtxApi('/v3/webrtcsessions/list?itemsPerPage=1000'), null];
  let sent = 0; let received = 0; let lost = 0; let sentPackets = 0; let receivedPackets = 0;
  for (const s of reads.items ?? []) {
    sent += s.bytesSent ?? 0; received += s.bytesReceived ?? 0;
    lost += s.rtpPacketsLost ?? 0; sentPackets += s.rtpPacketsSent ?? 0; receivedPackets += s.rtpPacketsReceived ?? 0;
  }
  return { sessions: reads.items?.length ?? 0, sent, received, lost, sentPackets, receivedPackets, byState: (reads.items ?? []).reduce((m, s) => ({ ...m, [s.state]: (m[s.state] ?? 0) + 1 }), {}) };
};

async function run() {
  console.log('Starting MediaMTX, the server and ten clients…\n');
  await startMediaMtx();
  await startServer();
  const mtxPid = procs[0].pid;
  const serverPid = procs[1].pid;

  const owner = (await (await fetch(`${BASE}/api/accounts/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: 'boss', password: 'hunter22', ownerKey }),
  })).json());
  for (const name of ['room-a', 'room-b', 'room-c']) {
    await fetch(`${BASE}/api/channels`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ name, kind: 'voice' }),
    });
  }
  const people = [
    ...[1, 2, 3, 4].map((n) => ({ nick: `cam${n}`, room: 'room-a', cam: true, muted: false })),
    ...[1, 2, 3, 4].map((n) => ({ nick: `quiet${n}`, room: 'room-b', cam: false, muted: true })),
    ...[1, 2].map((n) => ({ nick: `talk${n}`, room: 'room-c', cam: false, muted: false })),
  ];
  for (const person of people) await register(person.nick);

  const pages = [];
  for (const [i, person] of people.entries()) {
    const port = BASE_PORT + i;
    const app = launchApp({
      port,
      userDataDir: mkdtempSync(join(tmpdir(), 'harmony-ld-profile-')),
      extraArgs: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
    });
    procs.push(app);
    const page = await attach(await findPage(port));
    await sleep(1200);
    await page.evaluate(STUBS);
    await page.evaluate(`${setInput('server-url', BASE)} return true;`);
    await sleep(1200);
    await page.evaluate(`${setInput('username', person.nick)} ${setInput('account-password', 'hunter22')}
      document.getElementById('continue').click(); return true;`);
    await waitFor(page, "document.querySelector('.view[data-active]')?.id === 'view-channels'", { label: `${person.nick} signing in`, timeoutMs: 40_000 });
    await sleep(600);
    pages.push(page);
  }
  console.log('all signed in; joining\n');

  for (const [i, person] of people.entries()) {
    const page = pages[i];
    await page.evaluate(`
      [...document.querySelectorAll('#channel-items li.channel-row')]
        .find((li) => li.querySelector('.channel-name')?.textContent === ${JSON.stringify(person.room)}).click(); return true;`);
    await waitFor(page, "!document.getElementById('voice-active').hidden && document.querySelectorAll('#voice-roster li').length >= 1", { label: `${person.nick} joining`, timeoutMs: 40_000 });
    await sleep(700);
    if (person.muted) await page.evaluate("document.getElementById('voice-mute').click(); return true;");
    if (person.cam) await page.evaluate("document.getElementById('voice-cam').click(); return true;");
  }
  console.log('everybody is in; letting it settle\n');
  await sleep(20_000);

  // What the clients ended up with: did every subscription come up?
  const subs = await Promise.all(pages.map((page) => page.evaluate(`
    const d = window.__harmony().voice;
    return { subs: d.subs.length, connected: d.subs.filter((s) => s.connected).length, wanted: d.wanted.length };`)));
  const missing = subs.filter((s) => s.subs < s.wanted).length;
  console.log('voice subscriptions per client (have/wanted):', subs.map((s) => `${s.subs}/${s.wanted}`).join(' '));

  // --- measure -------------------------------------------------------------------------------------------------------
  const logStart = mtxLog.length;
  const start = await sessionTotals();
  if (process.env.LOAD_PROFILE) {
    // Go's own CPU profile of the relay, for the middle of the window.
    setTimeout(async () => {
      try {
        const res = await fetch('http://127.0.0.1:19999/debug/pprof/profile?seconds=20');
        writeFileSync(process.env.LOAD_PROFILE, Buffer.from(await res.arrayBuffer()));
      } catch (err) { console.log('profile failed:', err.message); }
    }, 8000);
  }
  if (process.env.LOAD_SAMPLE) {
    // macOS's own stack sampler, on the relay, for the middle of the window.
    setTimeout(() => {
      try { execFileSync('sample', [String(mtxPid), '12', '-file', process.env.LOAD_SAMPLE], { stdio: 'ignore' }); } catch { /* not macOS */ }
    }, (SECONDS * 1000) / 3);
  }
  const mtx0 = ps(mtxPid);
  const node0 = ps(serverPid);
  const t0 = Date.now();
  await sleep(SECONDS * 1000);
  const mtx1 = ps(mtxPid);
  const node1 = ps(serverPid);
  const end = await sessionTotals();
  const secs = (Date.now() - t0) / 1000;
  const samples = [{ mtx: mtx1 }];
  const mtxCpu = [((mtx1.cpuSeconds - mtx0.cpuSeconds) / secs) * 100];
  const nodeCpu = [((node1.cpuSeconds - node0.cpuSeconds) / secs) * 100];
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const peak = (xs) => Math.max(...xs);
  const log = mtxLog.slice(logStart);
  const count = (re) => (log.match(re) ?? []).length;

  console.log('\n================ result ================');
  console.log(`window                  ${secs.toFixed(0)} s`);
  console.log(`relay sessions          ${end.sessions}  ${JSON.stringify(end.byState)}`);
  console.log(`relay CPU (% of one core) ${avg(mtxCpu).toFixed(1)}   memory ${samples.at(-1).mtx.rssMb} MB`);
  console.log(`control server CPU       ${avg(nodeCpu).toFixed(1)}`);
  console.log(`relay egress            ${(((end.sent - start.sent) * 8) / secs / 1e6).toFixed(2)} Mbit/s   (${Math.round((end.sentPackets - start.sentPackets) / secs)} packets/s)`);
  console.log(`relay ingress           ${(((end.received - start.received) * 8) / secs / 1e6).toFixed(2)} Mbit/s   (${Math.round((end.receivedPackets - start.receivedPackets) / secs)} packets/s)`);
  console.log(`packets lost (rtp)      ${end.lost - start.lost}`);
  console.log(`relay log in window     ${log.split('\n').filter(Boolean).length} lines; "created" ${count(/created/g)}, "closed" ${count(/closed/g)}, "too slow" ${count(/too slow|discard/gi)}, errors ${count(/ERR|WAR/g)}`);
  console.log(`clients missing a voice subscription: ${missing} of ${pages.length}`);
  console.log('relay log, last lines:');
  console.log(log.split('\n').filter(Boolean).slice(-8).join('\n'));
}

run()
  .catch((err) => {
    console.error(err);
    console.error(serverLog.split('\n').slice(-10).join('\n'));
    process.exitCode = 1;
  })
  .finally(() => {
    for (const p of procs) { try { p.kill(); } catch { /* gone */ } }
    setTimeout(() => process.exit(process.exitCode ?? 0), 500);
  });
