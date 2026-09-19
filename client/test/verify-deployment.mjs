// Verify a real Harmony deployment from a real client.
//
// Publishes a synthetic stream to the configured server, then watches it back
// with a second client, and prints the ICE candidates the server advertised --
// which is the thing that decides whether anyone outside the LAN can connect.
//
//   HARMONY_SERVER=https://stream.example.com:8444 node client/test/verify-deployment.mjs
//
// HARMONY_MAP_HOST=hostname:ip resolves that hostname locally, for testing from
// inside the same LAN as the server when the router has no hairpin NAT.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attach, findPage, launchApp, reporter, sleep, waitFor } from './cdp.mjs';

const SERVER = process.env.HARMONY_SERVER;
const USERNAME = process.env.HARMONY_USERNAME ?? 'deploycheck';
if (!SERVER) {
  console.error('Set HARMONY_SERVER, e.g. https://stream.example.com:8444');
  process.exit(2);
}

const { check, summary } = reporter();
const procs = [];
const kill = () => procs.forEach((p) => { try { p.kill(); } catch {} });
process.on('exit', kill);

const MAKE_STREAM = `
  const makeStream = () => {
    const c = Object.assign(document.createElement('canvas'), { width: 640, height: 360 });
    const ctx = c.getContext('2d');
    setInterval(() => {
      ctx.fillStyle = '#' + ((Math.random() * 0xffffff) | 0).toString(16).padStart(6, '0');
      ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = '#fff'; ctx.font = '28px sans-serif';
      ctx.fillText(new Date().toISOString(), 20, 60);
    }, 100);
    return c.captureStream(15);
  };`;

function spawnClient(port) {
  const child = launchApp({ port, userDataDir: mkdtempSync(join(tmpdir(), 'harmony-verify-')) });
  procs.push(child);
  return child;
}

async function run() {
  // --- health ---------------------------------------------------------------
  const health = await (await fetch(`${SERVER}/api/health`)).json();
  check('server is reachable over TLS', health.ok === true, JSON.stringify(health));
  check('control server can see MediaMTX', health.mediamtx === 'up');

  // --- publish --------------------------------------------------------------
  spawnClient(9501);
  const pub = await attach(await findPage(9501));
  await sleep(1200);

  const published = await pub.evaluate(`
    const { harmony } = await import('./bridge.js');
    const { publish } = await import('./webrtc.js');
    ${MAKE_STREAM}
    const session = await harmony.api.session('${SERVER}', '${USERNAME}');
    if (session.role !== 'broadcaster') return { error: 'username busy: role=' + session.role };
    const r = await publish({ url: session.whipUrl, stream: makeStream(), iceServers: session.iceServers, maxBitrate: 800000 });
    window.__pub = { ...r, session };
    return { ok: true, whip: session.whipUrl };
  `);
  check('client could claim the username and publish', published.ok === true, published.error ?? published.whip);

  const state = await waitFor(pub, "window.__pub.pc.connectionState === 'connected'", {
    label: 'publisher ICE connection',
    timeoutMs: 40_000,
  });
  check('publisher reached connected state', state === true);

  // --- what the server advertised ------------------------------------------
  const ice = await pub.evaluate(`
    const sdp = window.__pub.pc.remoteDescription.sdp;
    const candidates = sdp.split('\\r\\n').filter(l => l.startsWith('a=candidate:'));
    let selected = null;
    const stats = await window.__pub.pc.getStats();
    stats.forEach(r => {
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
        const remote = stats.get(r.remoteCandidateId);
        if (remote) selected = remote.address + ':' + remote.port + ' (' + remote.candidateType + ')';
      }
    });
    return { candidates, selected };
  `);
  console.log('\n  server ICE candidates advertised:');
  ice.candidates.forEach((c) => console.log(`    ${c}`));
  console.log(`  selected remote candidate: ${ice.selected}\n`);

  check('server advertised at least one candidate', ice.candidates.length > 0, `${ice.candidates.length} candidates`);
  check('a candidate pair was nominated', Boolean(ice.selected), ice.selected ?? 'none');

  const live = await (await fetch(`${SERVER}/api/streams`)).json();
  check(
    'the stream is live on the server',
    live.streams.some((s) => s.username === USERNAME),
    JSON.stringify(live.streams),
  );

  // --- watch it back --------------------------------------------------------
  spawnClient(9502);
  const sub = await attach(await findPage(9502));
  await sleep(1200);

  const watched = await sub.evaluate(`
    const { harmony } = await import('./bridge.js');
    const { watch } = await import('./webrtc.js');
    const session = await harmony.api.session('${SERVER}', '${USERNAME}');
    if (session.role !== 'viewer') return { error: 'expected viewer, got ' + session.role };
    const r = await watch({ url: session.whepUrl, iceServers: session.iceServers });
    const v = document.createElement('video');
    v.autoplay = true; v.muted = true; v.srcObject = r.stream;
    document.body.append(v);
    window.__sub = { ...r, video: v };
    return { ok: true };
  `);
  check('second client joined as a viewer', watched.ok === true, watched.error ?? '');

  const decoding = await waitFor(sub, 'window.__sub.video.videoWidth > 0', {
    label: 'viewer decoding video',
    timeoutMs: 40_000,
  });
  check('viewer is decoding real frames', decoding === true);

  const dims = await sub.evaluate(
    'return { w: window.__sub.video.videoWidth, h: window.__sub.video.videoHeight };',
  );
  check('picture has real dimensions', dims.w > 100, `${dims.w}x${dims.h}`);

  // --- clean up -------------------------------------------------------------
  await pub.evaluate(`
    const { harmony } = await import('./bridge.js');
    window.__pub.pc.close();
    await harmony.api.hangup(window.__pub.resourceUrl);
    await harmony.api.release('${SERVER}', '${USERNAME}', window.__pub.session.token);
    return true;
  `);
  pub.close();
  sub.close();
}

run()
  .catch((err) => check('verification completed', false, err.message))
  .finally(async () => {
    kill();
    await sleep(500);
    process.exit(summary() ? 1 : 0);
  });
