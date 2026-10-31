// A benchmark of the screen-share path: one client publishes a game-like feed through a real server and a
// real MediaMTX, another watches it, and what each side saw is written down.
//
//   node client/test/share-bench.mjs                       every scenario
//   node client/test/share-bench.mjs base-sharp smooth      only those
//   node client/test/share-bench.mjs --duration=60 --out=/tmp/bench.json
//   MEDIAMTX_BIN=/path/to/mediamtx node client/test/share-bench.mjs
//
// The picture carries the time it was drawn at, in 32 black and white blocks, and a flash with a beep once a
// second; the viewer reads the time back from each frame it shows (that is the latency, from drawing to
// showing), how far apart the frames arrive (stalls), how loud the beep is and when (audio against video).
// Everything goes through the app's own webrtc.js and gain.js. Only the capture is replaced -- by a canvas
// -- so what is measured is the encoder, the relay and the playout, not the screen grab.
//
// A machine under load is made with --load: busy processes on every core, which is what a game does to the
// encoder's thread and the page.

import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { cpus, homedir, tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, sleep } from './cdp.mjs';
import { COLLECT_STREAMER, COLLECT_VIEWER, STOP_STREAMER, STOP_VIEWER, STREAMER, VIEWER } from './share-bench/page.js';
import { SCENARIOS } from './share-bench/scenarios.js';
import { summarize } from './share-bench/summary.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const MEDIAMTX_BIN = process.env.MEDIAMTX_BIN ?? join(homedir(), 'mediamtx', 'mediamtx');
if (!existsSync(MEDIAMTX_BIN)) { console.log(`No MediaMTX at ${MEDIAMTX_BIN}. Set MEDIAMTX_BIN.`); process.exit(0); }

const HARMONY_PORT = 18620;
const MTX_API_PORT = 9640;
const MTX_WEBRTC_PORT = 8640;
const MTX_ICE_PORT = 8740;
const BASE = `http://127.0.0.1:${HARMONY_PORT}`;
const SIGNALING = `http://127.0.0.1:${MTX_WEBRTC_PORT}`;

const args = process.argv.slice(2);
const option = (name, fallback) => (args.find((a) => a.startsWith(`--${name}=`)) ?? '').split('=')[1] ?? fallback;
const duration = Number(option('duration', 40));
const outFile = option('out', '');
const repeats = Math.max(1, Number(option('repeat', 1)));
const names = args.filter((a) => !a.startsWith('--'));

const procs = [];
const dataDir = mkdtempSync(join(tmpdir(), 'harmony-sb-'));
let mtxLog = '';
let serverLog = '';
process.on('exit', () => { for (const p of procs) { try { p.kill(); } catch { /* gone */ } } });
process.on('SIGINT', () => process.exit(130));

async function startInfra() {
  const dir = mkdtempSync(join(tmpdir(), 'harmony-sb-mtx-'));
  const config = join(dir, 'mediamtx.yml');
  copyFileSync(join(repoRoot, 'server', 'mediamtx.yml'), config);
  const mtx = spawn(MEDIAMTX_BIN, [config], {
    env: {
      ...process.env,
      MTX_AUTHHTTPADDRESS: `${BASE}/mediamtx/auth`,
      MTX_WEBRTCADDRESS: `:${MTX_WEBRTC_PORT}`,
      MTX_APIADDRESS: `127.0.0.1:${MTX_API_PORT}`,
      MTX_WEBRTCLOCALUDPADDRESS: `:${MTX_ICE_PORT}`,
      MTX_WEBRTCLOCALTCPADDRESS: `:${MTX_ICE_PORT}`,
      ...JSON.parse(process.env.BENCH_MTX_ENV ?? '{}'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(mtx);
  mtx.stdout.on('data', (b) => (mtxLog += b.toString()));
  mtx.stderr.on('data', (b) => (mtxLog += b.toString()));
  for (let i = 0; i < 100 && !new RegExp(`\\[WebRTC\\].*:${MTX_WEBRTC_PORT}`).test(mtxLog); i += 1) await sleep(200);

  const server = spawn(process.execPath, [join(repoRoot, 'server', 'src', 'index.js')], {
    env: {
      ...process.env,
      HARMONY_PORT: String(HARMONY_PORT),
      HARMONY_HOST: '127.0.0.1',
      HARMONY_DATA_DIR: dataDir,
      HARMONY_MEDIAMTX_API: `http://127.0.0.1:${MTX_API_PORT}`,
      HARMONY_SIGNALING_URL: SIGNALING,
      HARMONY_POLL_INTERVAL_MS: '400',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(server);
  server.stdout.on('data', (b) => (serverLog += b.toString()));
  server.stderr.on('data', (b) => (serverLog += b.toString()));
  for (let i = 0; i < 75 && !serverLog.includes('control server on'); i += 1) await sleep(200);
  if (!serverLog.includes('control server on')) throw new Error('the server did not start');
  await sleep(1500);
}

/**
 * A line between the publisher and the relay: a UDP proxy that holds the publisher's side to a bandwidth, with
 * a delay each way and some loss. The publisher is given the proxy's port instead of the relay's (the answer's
 * candidates are rewritten), so nothing else about the connection changes.
 *
 * `kbps` is what the uplink carries; a packet that would wait longer than `queueMs` for its turn is dropped,
 * as a router's buffer does. `delayMs` is added each way. `lossPct` is random loss on the uplink.
 */
function startLink({ kbps = 0, delayMs = 0, lossPct = 0, downLossPct = 0, queueMs = 150, seed = 1 }) {
  // the same pseudo-random sequence for the same seed, so two relays face the same losses
  let state = seed >>> 0 || 1;
  const random = () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 4294967296; };
  const front = dgram.createSocket('udp4');
  const back = dgram.createSocket('udp4');
  let client = null;
  let freeAt = 0;
  const stats = { sent: 0, dropped: 0 };
  let closed = false;
  const safe = (fn) => { if (!closed) { try { fn(); } catch { /* closed while a packet was waiting */ } } };
  front.on('message', (msg, rinfo) => {
    client = rinfo;
    stats.sent += 1;
    if (lossPct && random() * 100 < lossPct) { stats.dropped += 1; return; }
    const now = Date.now();
    let depart = now;
    if (kbps) {
      freeAt = Math.max(freeAt, now) + (msg.length * 8) / kbps; // ms: bits / (kbit/s)
      if (freeAt - now > queueMs) { stats.dropped += 1; freeAt -= (msg.length * 8) / kbps; return; }
      depart = freeAt;
    }
    setTimeout(() => safe(() => back.send(msg, MTX_ICE_PORT, '127.0.0.1')), Math.max(0, depart - now) + delayMs);
  });
  back.on('message', (msg) => {
    if (downLossPct && random() * 100 < downLossPct) { stats.dropped += 1; return; }
    if (client) setTimeout(() => safe(() => front.send(msg, client.port, client.address)), delayMs);
  });
  return new Promise((resolve) => front.bind(0, '127.0.0.1', () => resolve({
    port: front.address().port,
    stats,
    close() { closed = true; front.close(); back.close(); },
  })));
}

/** Busy processes on every core, for as long as the scenario runs. */
function startLoad(kind, nice = 0) {
  if (!kind || kind === 'none') return [];
  const n = kind === 'half' ? Math.ceil(cpus().length / 2) : cpus().length;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(nice ? spawn('nice', ['-n', String(nice), process.execPath, '-e', 'for(;;){}'], { stdio: 'ignore' }) : spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }));
  }
  return out;
}

async function runScenario(streamer, viewer, scenario, index, repeat = 0) {
  const username = `bench${index}x${Date.now() % 100000}`;
  const claim = await (await fetch(`${BASE}/api/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username }),
  })).json();
  if (claim.role !== 'broadcaster') throw new Error(`could not claim ${username}: ${JSON.stringify(claim)}`);
  const heartbeat = setInterval(() => {
    fetch(`${BASE}/api/session/heartbeat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, token: claim.token }) }).catch(() => {});
  }, 4000);

  const S = {
    ...scenario,
    whipUrl: claim.whipUrl,
    whepUrl: `${SIGNALING}/${username}/whep`,
    iceServers: claim.iceServers,
  };
  const link = scenario.link ? await startLink({ seed: 7 + repeat * 101, ...scenario.link }) : null;
  if (link) S.proxyPort = link.port;
  const viewerLink = scenario.viewerLink ? await startLink({ seed: 13 + repeat * 101, ...scenario.viewerLink }) : null;
  if (viewerLink) S.viewerProxyPort = viewerLink.port;
  const load = startLoad(scenario.load, scenario.loadNice);
  const startedAt = Date.now();
  let published;
  try {
    published = await streamer.evaluate(STREAMER(S));
    const viewerStartedAt = Date.now() + (scenario.viewerDelayMs ?? 1500);
    await sleep(scenario.viewerDelayMs ?? 1500);
    const watching = await viewer.evaluate(VIEWER(S));
    await sleep(scenario.seconds ? scenario.seconds * 1000 : duration * 1000);
    const v = await viewer.evaluate(COLLECT_VIEWER);
    const s = await streamer.evaluate(COLLECT_STREAMER);
    return { scenario, published, watching, startedAt, viewerStartedAt, viewer: v, streamer: s, link: link?.stats, viewerLink: viewerLink?.stats };
  } finally {
    clearInterval(heartbeat);
    for (const p of load) p.kill();
    link?.close();
    viewerLink?.close();
    await viewer.evaluate(STOP_VIEWER).catch(() => {});
    await streamer.evaluate(STOP_STREAMER).catch(() => {});
    fetch(`${BASE}/api/session/release`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, token: claim.token }) }).catch(() => {});
    await sleep(1500);
  }
}

const pad = (v, n) => String(v ?? '-').padEnd(n);
const num = (v, d = 0) => (v == null || Number.isNaN(v) ? '-' : Number(v).toFixed(d));

async function main() {
  const chosen = names.length ? SCENARIOS.filter((s) => names.includes(s.name)) : SCENARIOS;
  if (!chosen.length) { console.log('no such scenario; known:', SCENARIOS.map((s) => s.name).join(', ')); return; }
  console.log(`MediaMTX and the server starting; ${chosen.length} scenario(s) of ${duration}s each...\n`);
  await startInfra();

  const streamerApp = launchApp({ port: 9611, userDataDir: mkdtempSync(join(tmpdir(), 'harmony-sb-a-')), extraArgs: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const viewerApp = launchApp({ port: 9612, userDataDir: mkdtempSync(join(tmpdir(), 'harmony-sb-b-')), extraArgs: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  procs.push(streamerApp, viewerApp);
  const streamer = await attach(await findPage(9611));
  const viewer = await attach(await findPage(9612));
  await sleep(2500);

  const results = [];
  const header = `${pad('scenario', 26)}${pad('ttff', 6)}${pad('lat p50', 8)}${pad('p95', 6)}${pad('max', 6)}${pad('fps', 5)}${pad('stalls', 7)}${pad('>250', 5)}${pad('ramp s', 7)}${pad('Mbps', 6)}${pad('qp', 5)}${pad('enc ms', 7)}${pad('send ms', 8)}${pad('a/v ms', 7)}`;
  console.log(header);
  console.log('-'.repeat(header.length));
  const median = (xs) => {
    const v = xs.filter(Number.isFinite).sort((x, y) => x - y);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  };
  const row = (label, m) => `${pad(label, 26)}${pad(num(m.ttffMs), 6)}${pad(num(m.latency.p50), 8)}${pad(num(m.latency.p95), 6)}${pad(num(m.latency.max), 6)}${pad(num(m.fps, 1), 5)}${pad(m.stalls100, 7)}${pad(m.stalls250, 5)}${pad(num(m.rampSeconds, 1), 7)}${pad(num(m.mbps, 1), 6)}${pad(num(m.qp, 1), 5)}${pad(num(m.encodeMs, 1), 7)}${pad(num(m.sendDelayMs, 1), 8)}${pad(num(m.avOffsetMs), 7)}`;

  for (const [i, scenario] of chosen.entries()) {
    const summaries = [];
    for (let r = 0; r < repeats; r += 1) {
      let run;
      try {
        run = await runScenario(streamer, viewer, { seconds: duration, ...scenario }, i, r);
      } catch (err) {
        console.log(`${pad(scenario.name, 26)}FAILED: ${String(err?.message ?? err).slice(0, 160)}`);
        continue;
      }
      const m = summarize(run);
      summaries.push(m);
      results.push({ name: scenario.name, run: r, ...m, link: run.link ?? run.viewerLink });
      console.log(row(repeats > 1 ? `${scenario.name} #${r + 1}` : scenario.name, m));
      if (r > 0) continue;
      if (run.link || run.viewerLink) console.log(`   ${run.link ? 'publisher' : 'viewer'} link dropped ${(run.link ?? run.viewerLink).dropped} of ${(run.link ?? run.viewerLink).sent} packets; early (first 10 s): ${num(m.mbpsEarly, 1)} Mbps at qp ${num(m.qpEarly, 1)}, latency ${num(m.latency.early)} ms`);
      if (m.stereoRatio != null) console.log(`   stereo check: right/left level during a left-only beep = ${m.stereoRatio.toFixed(2)} (0 = stereo kept, 1 = mixed down to mono)`);
      if (m.localOffsetMs != null) console.log(`   calibration: the sender's own audio is ${m.localOffsetMs.toFixed(0)} ms after its own flash before it leaves (the viewer's number minus this is what the way is adding)`);
      if (run.streamer.sdp?.fb && scenario.dumpFb) console.log(`   negotiated feedback and extensions:\n${run.streamer.sdp.fb.split('\n').map((l) => '     ' + l).join('\n')}`);
      else if (run.streamer.sdp) console.log(`   offer/answer:\n${['offer', 'answer'].map((k) => `     ${k}:\n${run.streamer.sdp[k].split('\n').map((l) => '       ' + l).join('\n')}`).join('\n')}`);
    }
    if (repeats > 1 && summaries.length > 1) {
      const med = (pick) => median(summaries.map(pick));
      const m = {
        ttffMs: med((x) => x.ttffMs), latency: { p50: med((x) => x.latency.p50), p95: med((x) => x.latency.p95), max: med((x) => x.latency.max) },
        fps: med((x) => x.fps), stalls100: med((x) => x.stalls100), stalls250: med((x) => x.stalls250), rampSeconds: med((x) => x.rampSeconds),
        mbps: med((x) => x.mbps), qp: med((x) => x.qp), encodeMs: med((x) => x.encodeMs), sendDelayMs: med((x) => x.sendDelayMs), avOffsetMs: med((x) => x.avOffsetMs),
      };
      console.log(row(`${scenario.name} MEDIAN of ${summaries.length}`, m));
      console.log(`   p95 across the runs: ${summaries.map((x) => num(x.latency.p95)).join(', ')} ms; worst: ${summaries.map((x) => num(x.latency.max)).join(', ')} ms; fps: ${summaries.map((x) => num(x.fps)).join(', ')}`);
    }
    if (outFile) writeFileSync(outFile, JSON.stringify(results, null, 2));
  }
  console.log('\nlatency in ms from drawn to shown; ttff = time to first frame; stalls = gaps over 100 ms between shown frames; >250 = gaps over 250 ms');
  console.log('ramp = seconds until the sent bitrate first reaches 80% of its steady level; send ms = how long a packet waited in the sender before leaving');
  console.log('a/v = how much later the beep is heard than the flash is seen (positive: sound late)');
  if (outFile) console.log(`details in ${outFile}`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300));
