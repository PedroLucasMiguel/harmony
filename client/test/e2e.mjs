// Full-stack end-to-end test.
//
// Starts a real MediaMTX and a real Harmony control server, then drives two
// real Electron clients: one claims a username and publishes its screen, the
// other enters the same username and must end up watching it. Nothing is
// mocked -- this is the actual WHIP/WHEP path over real WebRTC.
//
// Requires a MediaMTX binary:
//   MEDIAMTX_BIN=/path/to/mediamtx node client/test/e2e.mjs

import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { attach, findPage, launchApp, reporter, sleep, waitFor, waitUntil } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const serverEntry = resolve(repoRoot, 'server', 'src', 'index.js');
const mediamtxConfig = resolve(repoRoot, 'server', 'mediamtx.yml');

const MEDIAMTX_BIN = process.env.MEDIAMTX_BIN;
const HARMONY_PORT = 18081;
const MTX_API_PORT = 9997;
const SIGNALING = 'http://127.0.0.1:8889';
const USERNAME = 'e2etest';

const { check, summary } = reporter();
const procs = [];
let mtxLog = '';
let serverLog = '';

function cleanup() {
  for (const p of procs) {
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  }
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

// ---------------------------------------------------------------------------

async function startMediaMtx() {
  if (!MEDIAMTX_BIN || !existsSync(MEDIAMTX_BIN)) {
    throw new Error('Set MEDIAMTX_BIN to a MediaMTX binary to run this test.');
  }
  const dir = mkdtempSync(join(tmpdir(), 'harmony-mtx-'));
  const cfg = join(dir, 'mediamtx.yml');
  copyFileSync(mediamtxConfig, cfg);

  const p = spawn(MEDIAMTX_BIN, [cfg], {
    env: { ...process.env, MTX_AUTHHTTPADDRESS: `http://127.0.0.1:${HARMONY_PORT}/mediamtx/auth` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(p);
  p.stdout.on('data', (b) => (mtxLog += b.toString()));
  p.stderr.on('data', (b) => (mtxLog += b.toString()));

  // Match on the port rather than the sentence: MediaMTX has reworded this
  // line between releases ("listener opened on" -> "started with listeners on").
  await waitUntil(() => /\[WebRTC\].*:8889/.test(mtxLog), { label: 'MediaMTX startup' });
  return p;
}

async function startHarmonyServer() {
  const p = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      HARMONY_PORT: String(HARMONY_PORT),
      HARMONY_HOST: '127.0.0.1',
      HARMONY_MEDIAMTX_API: `http://127.0.0.1:${MTX_API_PORT}`,
      HARMONY_SIGNALING_URL: SIGNALING,
      HARMONY_POLL_INTERVAL_MS: '400',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(p);
  p.stdout.on('data', (b) => (serverLog += b.toString()));
  p.stderr.on('data', (b) => (serverLog += b.toString()));

  await waitUntil(() => serverLog.includes('control server on'), { label: 'Harmony server startup' });
  return p;
}

const mtxPaths = async () => {
  const res = await fetch(`http://127.0.0.1:${MTX_API_PORT}/v3/paths/list`);
  return (await res.json()).items ?? [];
};

/** Type into an input and fire the events the app listens for. */
const setInput = (id, value) =>
  `const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)}; ` +
  `i.dispatchEvent(new Event('input', {bubbles:true})); i.dispatchEvent(new Event('change', {bubbles:true}));`;

// ---------------------------------------------------------------------------

async function run() {
  console.log('Starting MediaMTX and the Harmony control server…\n');
  await startMediaMtx();
  await startHarmonyServer();
  await sleep(1200);

  const health = await (await fetch(`http://127.0.0.1:${HARMONY_PORT}/api/health`)).json();
  check('control server sees MediaMTX', health.ok === true, `mediamtx: ${health.mediamtx}`);

  // ---------------- broadcaster ----------------

  const bcUserData = mkdtempSync(join(tmpdir(), 'harmony-bc-'));
  const bc = launchApp({ port: 9401, userDataDir: bcUserData });
  procs.push(bc);
  const bcCdp = await attach(await findPage(9401));
  await sleep(1200);

  await bcCdp.evaluate(`${setInput('server-url', `http://127.0.0.1:${HARMONY_PORT}`)} return true;`);
  await bcCdp.evaluate(`${setInput('username', USERNAME)} return true;`);
  await bcCdp.evaluate("document.getElementById('continue').click(); return true;");

  const gotPicker = await waitFor(
    bcCdp,
    "document.querySelector('.view[data-active]')?.id === 'view-picker'",
    { label: 'source picker' },
  );
  check('free username makes you the broadcaster', gotPicker === true);

  const sourceCount = await waitFor(bcCdp, "document.querySelectorAll('.source').length", {
    label: 'source thumbnails',
  });
  check('shareable sources are listed', sourceCount > 0, `${sourceCount} screens`);

  const audioPlan = await bcCdp.evaluate(
    "return { note: document.getElementById('audio-note').textContent, warn: document.getElementById('audio-note').hasAttribute('data-warn') };",
  );
  check('audio intent is stated up front', audioPlan.note.length > 0, audioPlan.note);

  // ---------------- excluding one app's audio from a screen share ----------------

  // The process list is filled in the background so the source grid is not held
  // up waiting on it; wait for it here rather than racing it.
  await waitFor(bcCdp, "document.getElementById('exclude-app').options.length > 1", {
    label: 'process list for audio exclusion',
    timeoutMs: 20_000,
  });

  const exclusion = await bcCdp.evaluate(`
    const field = document.getElementById('exclude-field');
    const sel = document.getElementById('exclude-app');
    const before = document.getElementById('audio-note').textContent;
    // Option 0 is "share everything"; pick a real process if one is listed.
    const pick = sel.options[1];
    if (pick) { sel.value = pick.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
    await new Promise(r => setTimeout(r, 200));
    const after = document.getElementById('audio-note').textContent;
    // Put it back so the rest of the run shares normally.
    sel.value = ''; sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { shown: !field.hidden, options: sel.options.length, label: pick?.textContent ?? null, before, after };
  `);
  check(
    'a screen share offers apps to exclude from its audio',
    exclusion.shown === true && exclusion.options > 1,
    `${exclusion.options - 1} processes listed`,
  );
  check(
    'choosing one says so before going live',
    exclusion.after.includes('except'),
    `"${exclusion.after}"`,
  );

  // The native layer must really use exclusion mode, not just relabel the UI.
  const excludeMode = await bcCdp.evaluate(`
    const { harmony } = await import('./bridge.js');
    const procs = await harmony.sources.processes();
    if (!procs.length) return { skipped: true };
    const res = await harmony.audio.start({ kind: 'screen', sourceId: '', sourceName: '', excludePid: procs[0].pid });
    await harmony.audio.stop();
    return { mode: res.mode, pid: res.pid, target: procs[0].name };
  `);
  check(
    'the native capture runs in exclude-process mode',
    excludeMode.skipped || excludeMode.mode === 'system-excluding',
    excludeMode.skipped ? 'no processes to exclude' : `mode=${excludeMode.mode} excluding ${excludeMode.target}`,
  );

  // ---------------- cameras and capture cards ----------------

  const cameras = await bcCdp.evaluate(`
    document.querySelector('.tab[data-kind="camera"]').click();
    await new Promise(r => setTimeout(r, 1200));
    const grid = document.getElementById('source-grid');
    return {
      tiles: grid.querySelectorAll('.source').length,
      emptyMsg: grid.querySelector('.empty')?.textContent ?? null,
      audioInputShown: !document.getElementById('audio-input-field').hidden,
      audioInputs: document.getElementById('audio-input').options.length,
      excludeHidden: document.getElementById('exclude-field').hidden,
      note: document.getElementById('audio-note').textContent,
    };
  `);
  check(
    'the camera tab lists devices or says there are none',
    cameras.tiles > 0 || (cameras.emptyMsg ?? '').includes('No cameras'),
    cameras.tiles > 0 ? `${cameras.tiles} devices` : cameras.emptyMsg,
  );
  check(
    'choosing a camera offers an audio input instead of loopback',
    cameras.audioInputShown === true && cameras.excludeHidden === true && cameras.audioInputs > 0,
    `${cameras.audioInputs} inputs offered`,
  );

  // Back to screens for the rest of the run.
  await bcCdp.evaluate("document.querySelector('.tab[data-kind=\"screen\"]').click(); return true;");
  await sleep(400);

  // Pick the first screen and go.
  await bcCdp.evaluate("document.querySelector('.source').click(); return true;");
  await bcCdp.evaluate("document.getElementById('start-stream').click(); return true;");

  const live = await waitFor(
    bcCdp,
    "document.querySelector('.view[data-active]')?.id === 'view-broadcast'",
    { label: 'broadcast view', timeoutMs: 45_000 },
  );
  check('the client reaches the broadcasting view', live === true);

  const connected = await waitFor(
    bcCdp,
    "(await (async () => { const pcs = performance.now(); return document.getElementById('broadcast-stats').textContent; })()).includes('fps')",
    { label: 'outbound video stats', timeoutMs: 45_000 },
  );
  check('video is actually being encoded and sent', connected === true);

  const stats = await bcCdp.evaluate(
    "return document.getElementById('broadcast-stats').textContent;",
  );
  console.log(`         broadcaster stats: ${stats}`);

  // Monitoring is refused for loopback audio: the machine is already playing
  // that sound, and routing it back to the speakers would land in the capture.
  const monitor = await bcCdp.evaluate(`
    const b = document.getElementById('monitor-toggle');
    b.click();
    await new Promise(r => setTimeout(r, 200));
    return { disabled: b.disabled, active: b.classList.contains('active'), title: b.title };
  `);
  check(
    'monitoring is refused while sharing system audio',
    monitor.disabled === true && monitor.active === false,
    monitor.title,
  );

  // ---------------- what MediaMTX sees ----------------

  const path = await waitUntil(
    async () => (await mtxPaths()).find((p) => p.name === USERNAME && p.ready),
    { label: 'MediaMTX path to go ready', timeoutMs: 30_000 },
  );
  check('MediaMTX is relaying the stream', Boolean(path), `tracks: ${path.tracks?.join(', ')}`);
  check('video track arrived at the server', (path.tracks ?? []).some((t) => /H264|VP8|VP9|AV1/i.test(t)));
  check(
    'audio track arrived at the server',
    (path.tracks ?? []).some((t) => /opus|pcm|aac/i.test(t)),
    `tracks: ${path.tracks?.join(', ')}`,
  );

  check('server auth hook accepted the publish', serverLog.includes(`publish accepted for "${USERNAME}"`));

  // ---------------- viewer ----------------

  const vwUserData = mkdtempSync(join(tmpdir(), 'harmony-vw-'));
  const vw = launchApp({ port: 9402, userDataDir: vwUserData });
  procs.push(vw);
  const vwCdp = await attach(await findPage(9402));
  await sleep(1200);

  await vwCdp.evaluate(`${setInput('server-url', `http://127.0.0.1:${HARMONY_PORT}`)} return true;`);

  const listed = await waitFor(vwCdp, "document.querySelectorAll('#live-items li').length", {
    label: 'live stream list',
  });
  check('live streams are discoverable from the lobby', listed === 1, `${listed} listed`);

  await vwCdp.evaluate(`${setInput('username', USERNAME)} return true;`);
  await vwCdp.evaluate("document.getElementById('continue').click(); return true;");

  const watching = await waitFor(
    vwCdp,
    "document.querySelector('.view[data-active]')?.id === 'view-watch'",
    { label: 'watch view' },
  );
  check('a taken username joins as a viewer instead of stealing it', watching === true);

  const playing = await waitFor(
    vwCdp,
    "(() => { const v = document.getElementById('remote'); return v.videoWidth > 0 && v.currentTime > 0; })()",
    { label: 'decoded video frames', timeoutMs: 45_000 },
  );
  check('viewer is decoding live video', playing === true);

  const dims = await vwCdp.evaluate(
    "const v = document.getElementById('remote'); return { w: v.videoWidth, h: v.videoHeight, audio: v.srcObject.getAudioTracks().length };",
  );
  check('viewer received a real picture', dims.w > 100 && dims.h > 100, `${dims.w}×${dims.h}`);
  check('viewer received an audio track', dims.audio > 0, `${dims.audio} audio track(s)`);

  // Decoding is not the same as being visible. A video element covered by an
  // opaque overlay still reports videoWidth and still plays its audio, which is
  // exactly how a stuck "Connecting..." overlay once shipped: sound, no picture.
  // So ask the document what is actually painted at the centre of the video.
  const painted = await vwCdp.evaluate(`
    const v = document.getElementById('remote');
    const r = v.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      overlay: getComputedStyle(document.getElementById('watch-waiting')).display,
      topmost: top ? (top.id || top.tagName) : null,
    };
  `);
  check(
    'the waiting overlay is really hidden, not just flagged hidden',
    painted.overlay === 'none',
    `computed display: ${painted.overlay}`,
  );
  check(
    'the video is the topmost element where the picture should be',
    painted.topmost === 'remote',
    `topmost element: ${painted.topmost}`,
  );

  const inboundStats = await waitFor(
    vwCdp,
    "document.getElementById('watch-stats').textContent.includes('fps')",
    { label: 'inbound video stats', timeoutMs: 20_000 },
  );
  check('viewer reports inbound stats', inboundStats === true);
  console.log(
    `         viewer stats: ${await vwCdp.evaluate("return document.getElementById('watch-stats').textContent;")}`,
  );

  // Volume control is the one viewer affordance that is pure UI.
  const volume = await vwCdp.evaluate(
    `${setInput('volume', '40')} return document.getElementById('remote').dataset.gain;`,
  );
  check('volume control adjusts playback', Math.abs(volume - 0.4) < 0.01, `volume = ${volume}`);

  // ---------------- live source and quality changes ----------------
  //
  // replaceTrack() swaps the sender's source without renegotiation, so the
  // viewer opened above must survive a source change untouched.

  // MediaMTX names the publishing session; if a source change restarted the
  // connection this id would change, and every viewer would have been dropped.
  const sessionBefore = (await mtxPaths()).find((p) => p.name === USERNAME)?.source?.id;
  const beforeSwitch = await bcCdp.evaluate(`
    const v = document.getElementById('preview');
    return { stats: document.getElementById('broadcast-stats').textContent, w: v.videoWidth };
  `);

  await bcCdp.evaluate("document.getElementById('change-source').click(); return true;");
  await waitFor(bcCdp, "document.querySelector('.view[data-active]')?.id === 'view-picker'", {
    label: 'picker reopened while live',
  });
  check('the picker reopens without dropping the stream', beforeSwitch.w > 0, `preview was ${beforeSwitch.w}px`);

  const stillLive = (await mtxPaths()).find((p) => p.name === USERNAME && p.ready);
  check('the stream stays live while choosing a new source', Boolean(stillLive));

  // Pick a different screen/window than the one already being shared.
  await bcCdp.evaluate("document.querySelector('.tab[data-kind=\"window\"]').click(); return true;");
  await waitFor(bcCdp, "document.querySelectorAll('.source').length > 0", { label: 'window list' });
  await bcCdp.evaluate("document.querySelector('.source').click(); return true;");
  await bcCdp.evaluate("document.getElementById('start-stream').click(); return true;");

  const switched = await waitFor(
    bcCdp,
    "document.querySelector('.view[data-active]')?.id === 'view-broadcast'",
    { label: 'return to broadcast after switching', timeoutMs: 45_000 },
  );
  check('switching source returns to the broadcast view', switched === true);

  const sameSession = (await mtxPaths()).find((p) => p.name === USERNAME);
  check(
    'switching source did not restart the publishing session',
    Boolean(sameSession?.ready) && sameSession.source?.id === sessionBefore,
    sameSession?.source?.id === sessionBefore ? 'same session id' : 'session id CHANGED',
  );

  // The viewer opened before the switch must still be playing, on the same
  // connection, having seen nothing but the picture change.
  const viewerSurvived = await vwCdp.evaluate(
    "const v = document.getElementById('remote'); return { w: v.videoWidth, playing: !v.paused && v.currentTime > 0 };",
  );
  check(
    'the viewer keeps playing across a source change',
    viewerSurvived.w > 0 && viewerSurvived.playing,
    `${viewerSurvived.w}px, playing=${viewerSurvived.playing}`,
  );

  // Quality on the fly. applyLiveQuality() persists the choice as its last
  // step, so reading it back proves the whole handler ran without throwing.
  const requalified = await bcCdp.evaluate(`
    const { harmony } = await import('./bridge.js');
    const q = document.getElementById('live-quality');
    q.value = 'low';
    q.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 2000));
    const saved = await harmony.settings.get();
    return { preset: q.value, saved: saved.quality };
  `);
  check(
    'quality can be changed while live',
    requalified.preset === 'low' && requalified.saved === 'low',
    `select=${requalified.preset}, persisted=${requalified.saved}`,
  );


  // ---------------- the publisher cannot be hijacked ----------------

  const hijack = await fetch(`http://127.0.0.1:${HARMONY_PORT}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.50' },
    body: JSON.stringify({ username: USERNAME }),
  });
  const hijackBody = await hijack.json();
  check(
    'a live username cannot be claimed by anyone else',
    hijackBody.role === 'viewer',
    `got role "${hijackBody.role}"`,
  );

  // ---------------- stopping frees the name ----------------

  await bcCdp.evaluate("document.getElementById('stop-stream').click(); return true;");

  const freed = await waitUntil(
    async () => {
      const res = await fetch(`http://127.0.0.1:${HARMONY_PORT}/api/streams`);
      const { streams } = await res.json();
      return !streams.some((s) => s.username === USERNAME);
    },
    { label: 'username to be released', timeoutMs: 20_000 },
  );
  check('stopping the stream frees the username', freed === true);

  // ---------------- window share: audio must be scoped to one app ----------------
  //
  // This is the part Chromium cannot do on its own, so it is worth proving
  // rather than assuming: the PID lookup has to resolve the window to a process
  // and the native capture has to attach to it.

  await vwCdp.evaluate("document.getElementById('leave-stream').click(); return true;");
  await sleep(1500);

  await bcCdp.evaluate(`${setInput('username', 'windowtest')} return true;`);
  await bcCdp.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(bcCdp, "document.querySelector('.view[data-active]')?.id === 'view-picker'", {
    label: 'picker for the window share',
  });

  await bcCdp.evaluate("document.querySelector('.tab[data-kind=\"window\"]').click(); return true;");
  const windowCount = await waitFor(bcCdp, "document.querySelectorAll('.source').length", {
    label: 'window list',
  });
  check('shareable windows are listed', windowCount > 0, `${windowCount} windows`);

  const windowIntent = await bcCdp.evaluate(
    "document.querySelector('.source').click(); return { note: document.getElementById('audio-note').textContent, warn: document.getElementById('audio-note').hasAttribute('data-warn') };",
  );
  check(
    'window share promises application-only audio',
    windowIntent.note.includes('only this application') && !windowIntent.warn,
    windowIntent.note,
  );

  await bcCdp.evaluate("document.getElementById('start-stream').click(); return true;");
  await waitFor(bcCdp, "document.querySelector('.view[data-active]')?.id === 'view-broadcast'", {
    label: 'broadcast view for the window share',
    timeoutMs: 45_000,
  });

  const windowAudioNote = await bcCdp.evaluate(
    "return document.getElementById('broadcast-audio-note').textContent;",
  );
  check(
    'per-application audio capture attached to the window',
    windowAudioNote.includes('only this application'),
    windowAudioNote,
  );

  const windowPath = await waitUntil(
    async () => (await mtxPaths()).find((p) => p.name === 'windowtest' && p.ready),
    { label: 'window stream to go live', timeoutMs: 30_000 },
  );
  check('window share reaches the server', Boolean(windowPath), `tracks: ${windowPath.tracks?.join(', ')}`);

  await bcCdp.evaluate("document.getElementById('stop-stream').click(); return true;");
  await sleep(1500);

  // ---------------- the media server's own lock ----------------
  //
  // The control server refuses to hand out a second token for a live name, but
  // that is only half the guarantee. This checks the other half: even holding a
  // token the control server considers valid, MediaMTX itself must refuse a
  // second publisher on a path that already has one (overridePublisher: no).
  // A synthetic canvas stream stands in for a screen so no picker is involved.

  const SERVER = `http://127.0.0.1:${HARMONY_PORT}`;
  const MAKE_STREAM = `
    const makeStream = () => {
      const c = Object.assign(document.createElement('canvas'), { width: 320, height: 240 });
      const ctx = c.getContext('2d');
      setInterval(() => {
        ctx.fillStyle = '#' + ((Math.random() * 0xffffff) | 0).toString(16).padStart(6, '0');
        ctx.fillRect(0, 0, 320, 240);
      }, 100);
      return c.captureStream(10);
    };`;

  const claimed = await bcCdp.evaluate(`
    const { harmony } = await import('./bridge.js');
    const { publish } = await import('./webrtc.js');
    ${MAKE_STREAM}
    const session = await harmony.api.session('${SERVER}', 'locktest');
    if (session.role !== 'broadcaster') return { error: 'expected broadcaster, got ' + session.role };
    window.__lock = { session, publish, harmony };
    window.__lock.first = await publish({ url: session.whipUrl, stream: makeStream(), iceServers: session.iceServers, maxBitrate: 300000 });
    return { ok: true };
  `);
  check('canvas publisher went live for the lock test', claimed.ok === true, claimed.error ?? '');

  await waitUntil(async () => (await mtxPaths()).find((p) => p.name === 'locktest' && p.ready), {
    label: 'lock-test path to go ready',
  });
  const before = (await mtxPaths()).find((p) => p.name === 'locktest').bytesReceived;

  // Same URL, same token that the control server still considers valid.
  const second = await bcCdp.evaluate(`
    ${MAKE_STREAM}
    const { session, publish } = window.__lock;
    try {
      window.__lock.second = await publish({ url: session.whipUrl, stream: makeStream(), iceServers: session.iceServers, maxBitrate: 300000 });
      return { handshake: 'accepted' };
    } catch (e) {
      return { handshake: 'refused', detail: e.message };
    }
  `);

  await sleep(3000);
  const lockPath = (await mtxPaths()).find((p) => p.name === 'locktest');
  const firstState = await bcCdp.evaluate('return window.__lock.first.pc.connectionState;');

  // The documented guarantee is about the *incumbent*: overridePublisher: no
  // means a newcomer cannot take the path away. Note that the WHIP handshake
  // itself still succeeds -- MediaMTX answers the offer before deciding -- which
  // is exactly why the client verifies it really went live rather than
  // trusting the 201.
  check(
    'a second publisher cannot take over a live path',
    Boolean(lockPath?.ready) && lockPath.bytesReceived > before,
    `path ready=${lockPath?.ready}, bytes ${before} -> ${lockPath?.bytesReceived}`,
  );
  check(
    'the original publisher keeps its connection',
    firstState === 'connected',
    `first connection: ${firstState} (handshake for the newcomer was ${second.handshake})`,
  );

  // And the client-side guard catches what the handshake does not report.
  const guard = await bcCdp.evaluate(`
    const { harmony } = await import('./bridge.js');
    const { streams } = await harmony.api.streams('${SERVER}');
    return streams.filter(s => s.username === 'locktest').length;
  `);
  check('the server still reports exactly one publisher', guard === 1, `${guard} entries`);

  await bcCdp.evaluate(`
    window.__lock.first.pc.close();
    window.__lock.second?.pc.close();
    await window.__lock.harmony.api.release('${SERVER}', 'locktest', window.__lock.session.token);
    return true;
  `);

  // ---------------- clips ----------------
  //
  // The buffer taps already-encoded frames, so the two things worth proving are
  // that tapping does not disturb the media, and that what comes out is a real
  // MP4 that decodes.

  const clipResult = await bcCdp.evaluate(`
    const { harmony } = await import('./bridge.js');
    const { ClipBuffer } = await import('./clip-buffer.js');
    const { publish } = await import('./webrtc.js');
    ${MAKE_STREAM}

    const session = await harmony.api.session('${SERVER}', 'cliptest');
    if (session.role !== 'broadcaster') return { error: 'role=' + session.role };
    const { pc, resourceUrl } = await publish({
      url: session.whipUrl, stream: makeStream(), iceServers: session.iceServers, maxBitrate: 1500000,
      insertableStreams: true,
    });

    const buffer = new ClipBuffer('cliptest');
    let attached = false;
    for (const s of pc.getSenders()) {
      if (s.track?.kind === 'video') attached = buffer.attach(s, 'video') || attached;
      else if (s.track?.kind === 'audio') buffer.attach(s, 'audio');
    }

    // Let real frames accumulate.
    await new Promise(r => setTimeout(r, 9000));

    // Tapping must not have stopped the stream: check bytes are still moving.
    const s1 = await pc.getStats(); let a = 0;
    s1.forEach(x => { if (x.type === 'outbound-rtp' && x.kind === 'video') a = x.bytesSent; });
    await new Promise(r => setTimeout(r, 2500));
    const s2 = await pc.getStats(); let b = 0, frames = 0;
    s2.forEach(x => { if (x.type === 'outbound-rtp' && x.kind === 'video') { b = x.bytesSent; frames = x.framesEncoded; } });

    const built = buffer.build();

    // Does the MP4 actually decode? Load it into a video element.
    const blob = new Blob([built.data], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.muted = true; v.src = url;
    const playable = await new Promise(resolve => {
      const done = (ok, why) => resolve({ ok, why, w: v.videoWidth, h: v.videoHeight, dur: v.duration });
      v.onloadeddata = () => done(true, 'loadeddata');
      v.onerror = () => done(false, 'error ' + (v.error && v.error.code));
      setTimeout(() => done(false, 'timeout'), 8000);
    });
    URL.revokeObjectURL(url);

    // And can it be written to disk?
    let saved = null;
    try { saved = await harmony.clips.save(built.data, 'e2e-cliptest'); } catch (e) { saved = { error: e.message }; }

    buffer.detach();
    pc.close();
    await harmony.api.hangup(resourceUrl);
    await harmony.api.release('${SERVER}', 'cliptest', session.token);

    return {
      attached, bytesMoved: b - a, frames,
      bufferedSeconds: built.seconds, size: built.data.byteLength,
      width: built.width, height: built.height,
      playable, saved,
    };
  `);

  check('the encoded-frame tap attaches', clipResult.attached === true, clipResult.error ?? '');
  check(
    'tapping frames does not interrupt the stream',
    clipResult.bytesMoved > 2_000,
    `${(clipResult.bytesMoved / 1024).toFixed(0)} KB sent while tapped`,
  );
  check(
    'the buffer holds several seconds of footage',
    clipResult.bufferedSeconds > 3,
    `${clipResult.bufferedSeconds?.toFixed(1)}s, ${(clipResult.size / 1e6).toFixed(2)} MB`,
  );
  check(
    'the clip is a decodable MP4',
    clipResult.playable?.ok === true && clipResult.playable.w > 0,
    `${clipResult.playable?.why}, ${clipResult.playable?.w}x${clipResult.playable?.h}, dur=${Number(clipResult.playable?.dur).toFixed(1)}s`,
  );
  check(
    'the clip resolution matches the stream',
    clipResult.playable?.w === clipResult.width,
    `muxed ${clipResult.width}x${clipResult.height}, decoded ${clipResult.playable?.w}x${clipResult.playable?.h}`,
  );
  check(
    'the clip is written to disk',
    Boolean(clipResult.saved?.path),
    clipResult.saved?.path ?? clipResult.saved?.error,
  );

  // ---------------- a broadcaster watching other people ----------------
  //
  // The mosaic and the broadcast share nothing but the window, and closing the
  // mosaic must not disturb the publish -- including the heartbeat that holds
  // the username, which used to live in the same timer pool.

  const watcherNames = ['peerone', 'peertwo'];
  const peers = await bcCdp.evaluate(`
    const { harmony } = await import('./bridge.js');
    const { publish } = await import('./webrtc.js');
    ${MAKE_STREAM}
    window.__P = [];
    for (const name of ${JSON.stringify(watcherNames)}) {
      const session = await harmony.api.session('${SERVER}', name);
      if (session.role !== 'broadcaster') return { error: name + ' role=' + session.role };
      const r = await publish({ url: session.whipUrl, stream: makeStream(), iceServers: session.iceServers, maxBitrate: 400000 });
      window.__P.push({ ...r, session, name });
    }
    return { ok: true };
  `);
  check('two other people are streaming', peers.ok === true, peers.error ?? '');

  // The viewer client goes live itself, then opens the mosaic while publishing.
  const selfName = 'selfcast';
  await vwCdp.evaluate(`${setInput('username', selfName)} return true;`);
  await vwCdp.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(vwCdp, "document.querySelector('.view[data-active]')?.id === 'view-picker'", {
    label: 'picker for the self-broadcast',
  });
  await waitFor(vwCdp, "document.querySelectorAll('.source').length > 0", { label: 'sources' });
  await vwCdp.evaluate("document.querySelector('.source').click(); return true;");
  await vwCdp.evaluate("document.getElementById('start-stream').click(); return true;");
  await waitFor(vwCdp, "document.querySelector('.view[data-active]')?.id === 'view-broadcast'", {
    label: 'self-broadcast live',
    timeoutMs: 45_000,
  });
  await waitUntil(async () => (await mtxPaths()).some((p) => p.name === selfName && p.ready), {
    label: 'self-broadcast on the server',
  });
  check('the client is broadcasting before opening the mosaic', true);

  await vwCdp.evaluate("document.getElementById('broadcast-watch').click(); return true;");
  const watchingWhileLive = await waitFor(
    vwCdp,
    "document.querySelector('.view[data-active]')?.id === 'view-mosaic' && " +
      "[...document.querySelectorAll('.tile video')].filter(v => v.videoWidth > 0).length >= 2",
    { label: 'other streams tiled while broadcasting', timeoutMs: 45_000 },
  );
  check('a broadcaster can watch other streams', watchingWhileLive === true);

  const ownTile = await vwCdp.evaluate(
    `return [...document.querySelectorAll('.tile')].map(t => t.dataset.user);`,
  );
  check(
    'the mosaic leaves out your own stream',
    !ownTile.includes(selfName),
    `tiles: ${ownTile.join(', ')}`,
  );

  const stillPublishing = (await mtxPaths()).find((p) => p.name === selfName);
  check(
    'opening the mosaic did not interrupt the broadcast',
    Boolean(stillPublishing?.ready),
    stillPublishing?.ready ? 'still live' : 'DROPPED',
  );

  // Closing the mosaic must return to the stream, not to the lobby, and the
  // username must still be held afterwards.
  await vwCdp.evaluate("document.getElementById('mosaic-leave').click(); return true;");
  await sleep(1500);
  const backToStream = await vwCdp.evaluate(
    "return { view: document.querySelector('.view[data-active]')?.id, tiles: document.querySelectorAll('.tile').length, label: document.getElementById('mosaic-leave').textContent };",
  );
  check(
    'leaving the mosaic returns to your own stream',
    backToStream.view === 'view-broadcast' && backToStream.tiles === 0,
    `view=${backToStream.view}, ${backToStream.tiles} tiles`,
  );

  await sleep(4000); // longer than a heartbeat interval
  const survived = (await mtxPaths()).find((p) => p.name === selfName);
  check(
    'the broadcast and its username survive the round trip',
    Boolean(survived?.ready),
    survived?.ready ? 'still live after closing the mosaic' : 'DROPPED',
  );

  // ---------------- hiding the preview ----------------
  //
  // Painting the preview is GPU work piled on top of whatever is being shared,
  // which on a gaming machine is the thing that makes a high frame rate feel
  // low. Detaching srcObject stops that work -- and the whole point is that it
  // must NOT stop the stream, because the sender holds the track independently
  // of any element showing it.
  // The server is the witness here rather than local stats: what matters is
  // that media keeps arriving at MediaMTX, not merely that the sender claims to
  // be encoding.
  const bytesBefore = (await mtxPaths()).find((p) => p.name === selfName)?.bytesReceived ?? 0;

  const hidden = await vwCdp.evaluate(`
    document.getElementById('toggle-preview').click();
    await new Promise(r => setTimeout(r, 1000));
    const v = document.getElementById('preview');
    return {
      srcDetached: v.srcObject === null,
      placeholderShown: !document.getElementById('preview-off').hidden,
      label: document.getElementById('toggle-preview').textContent.trim(),
    };
  `);
  check(
    'hiding the preview detaches the video element',
    hidden.srcDetached === true && hidden.placeholderShown === true && hidden.label === 'Show preview',
    `srcObject=${hidden.srcDetached ? 'null' : 'STILL ATTACHED'}, button says "${hidden.label}"`,
  );

  await sleep(4000);
  const afterHide = (await mtxPaths()).find((p) => p.name === selfName);
  const gained = (afterHide?.bytesReceived ?? 0) - bytesBefore;
  check(
    'hiding the preview does NOT interrupt the stream',
    Boolean(afterHide?.ready) && gained > 0,
    afterHide?.ready
      ? `server received +${(gained / 1024).toFixed(0)} KB while the preview was hidden`
      : 'DROPPED',
  );

  const reshown = await vwCdp.evaluate(`
    document.getElementById('toggle-preview').click();
    await new Promise(r => setTimeout(r, 1200));
    const v = document.getElementById('preview');
    return { attached: !!v.srcObject, playing: v.videoWidth > 0, label: document.getElementById('toggle-preview').textContent.trim() };
  `);
  check(
    'showing it again reattaches the same stream',
    reshown.attached === true && reshown.playing === true && reshown.label === 'Hide preview',
    `${reshown.playing ? 'painting again' : 'BLANK'}, button says "${reshown.label}"`,
  );

  // ---------------- responsive layout ----------------

  await vwCdp.evaluate("document.getElementById('broadcast-watch').click(); return true;");
  await waitFor(vwCdp, "document.querySelectorAll('.tile').length >= 2", { label: 'tiles for the layout test' });

  const probeLayout = () =>
    vwCdp.evaluate(`
      const grid = document.getElementById('mosaic-grid');
      return {
        cols: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 2,
        compact: document.querySelectorAll('.tile.compact').length,
        tiles: document.querySelectorAll('.tile').length,
      };
    `);

  // The layout maximises tile size for the shape of the window, so the column
  // count follows the aspect ratio rather than the stream count: a short wide
  // window wants them side by side, a tall narrow one wants them stacked.
  await vwCdp.setViewport(1500, 520);
  await sleep(900);
  const shortWide = await probeLayout();

  await vwCdp.setViewport(620, 900);
  await sleep(900);
  const tallNarrow = await probeLayout();

  await vwCdp.clearViewport();
  await sleep(900);
  const restored = await probeLayout();

  check(
    'the grid follows the shape of the window',
    shortWide.cols > tallNarrow.cols,
    `${shortWide.tiles} tiles: ${shortWide.cols} cols when short and wide, ${tallNarrow.cols} when tall and narrow`,
  );
  check(
    'nothing overflows horizontally at the minimum window size',
    tallNarrow.overflow === false && shortWide.overflow === false && restored.overflow === false,
    'no horizontal overflow at any size',
  );
  check(
    'a narrow window keeps tiles usable rather than shrinking them',
    tallNarrow.compact === 0 && tallNarrow.cols === 1,
    `${tallNarrow.cols} column, ${tallNarrow.compact} tiles too small for their controls`,
  );

  await vwCdp.evaluate("document.getElementById('mosaic-leave').click(); return true;");
  await sleep(800);
  await vwCdp.evaluate("document.getElementById('stop-stream').click(); return true;");
  await sleep(1500);
  await bcCdp.evaluate(`
    const { harmony } = await import('./bridge.js');
    for (const p of window.__P) {
      try { p.pc.close(); await harmony.api.hangup(p.resourceUrl);
            await harmony.api.release('${SERVER}', p.name, p.session.token); } catch {}
    }
    return true;
  `);
  await sleep(1200);

  // ---------------- mosaic: several streams at once ----------------

  const mosaicNames = ['mosaicone', 'mosaictwo', 'mosaicthree'];
  const opened = await bcCdp.evaluate(`
    const { harmony } = await import('./bridge.js');
    const { publish } = await import('./webrtc.js');
    ${MAKE_STREAM}
    window.__M = [];
    for (const name of ${JSON.stringify(mosaicNames)}) {
      const session = await harmony.api.session('${SERVER}', name);
      if (session.role !== 'broadcaster') return { error: name + ' role=' + session.role };
      const r = await publish({ url: session.whipUrl, stream: makeStream(), iceServers: session.iceServers, maxBitrate: 400000 });
      window.__M.push({ ...r, session, name });
    }
    return { ok: true, n: window.__M.length };
  `);
  check('three publishers went live for the mosaic', opened.ok === true, opened.error ?? `${opened.n} streams`);

  await waitUntil(
    async () => {
      const { streams } = await (await fetch(`${SERVER}/api/streams`)).json();
      return mosaicNames.every((n) => streams.some((s) => s.username === n));
    },
    { label: 'all three streams live' },
  );

  // The listing must carry everything needed to watch, so the mosaic never has
  // to call /api/session and risk claiming a name.
  const listing = await (await fetch(`${SERVER}/api/streams`)).json();
  check(
    'stream listing carries watch URLs and ICE servers',
    listing.streams.every((s) => typeof s.whepUrl === 'string') && Array.isArray(listing.iceServers),
    `whepUrl on ${listing.streams.filter((s) => s.whepUrl).length}/${listing.streams.length}`,
  );

  await vwCdp.evaluate("document.getElementById('watch-all').click(); return true;");

  const tilesReady = await waitFor(
    vwCdp,
    "[...document.querySelectorAll('.tile video')].filter(v => v.videoWidth > 0).length >= 3",
    { label: 'three mosaic tiles decoding', timeoutMs: 45_000 },
  );
  check('every stream is decoding in its own tile', tilesReady === true);

  const grid = await vwCdp.evaluate(`
    const g = document.getElementById('mosaic-grid');
    const tiles = [...document.querySelectorAll('.tile')];
    return {
      columns: getComputedStyle(g).gridTemplateColumns.split(' ').length,
      tiles: tiles.length,
      audible: [...document.querySelectorAll('.tile video')].filter(v => v.dataset.muted === 'false').length,
      users: tiles.map(t => t.dataset.user).sort(),
      sliders: document.querySelectorAll('.tile .tile-volume').length,
      fsButtons: tiles.filter(t => t.querySelector('.tile-btn[data-role="fullscreen"]') && t.querySelector('.tile-btn[data-role="mute"]')).length,
    };
  `);
  check('tiles are laid out in a square-ish grid', grid.columns === 2, `${grid.tiles} tiles in ${grid.columns} columns`);

  // The reported bug: with tall tiles the bottom row ran past the window, so its
  // volume slider and fullscreen button could not be reached at all. Sizing by
  // width alone did that. Check the controls are genuinely hittable, across
  // several window shapes including a wide short one.
  const controlsReachable = async (w, h) => {
    await vwCdp.setViewport(w, h);
    await sleep(900);
    return vwCdp.evaluate(`
      const tiles = [...document.querySelectorAll('.tile')];
      const hits = tiles.map(t => {
        const btn = t.querySelector('.tile-btn[data-role="fullscreen"]');
        const r = btn.getBoundingClientRect();
        if (r.width === 0 || r.bottom > window.innerHeight || r.top < 0) return false;
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!at && (at === btn || btn.contains(at));
      });
      const grid = document.getElementById('mosaic-grid');
      return {
        tiles: tiles.length,
        reachable: hits.filter(Boolean).length,
        overflowY: grid.scrollHeight > grid.clientHeight + 2,
        overflowX: grid.scrollWidth > grid.clientWidth,
        cols: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      };
    `);
  };

  for (const [w, h, label] of [
    [1600, 900, 'wide'],
    [1600, 620, 'wide and short'],
    [1100, 720, 'medium'],
    [760, 560, 'small'],
  ]) {
    const r = await controlsReachable(w, h);
    check(
      `tile controls are reachable at ${w}x${h} (${label})`,
      r.reachable === r.tiles && !r.overflowY && !r.overflowX,
      `${r.reachable}/${r.tiles} reachable in ${r.cols} cols` +
        (r.overflowY ? ', GRID OVERFLOWS VERTICALLY' : '') +
        (r.overflowX ? ', HORIZONTAL SCROLLBAR' : ''),
    );
  }
  await vwCdp.clearViewport();
  await sleep(700);
  check(
    'every stream is audible at once',
    grid.audible === 3,
    `${grid.audible}/3 unmuted`,
  );
  check('each tile has its own volume slider', grid.sliders === 3, `${grid.sliders} sliders`);
  check('each tile has mute and fullscreen buttons', grid.fsButtons === 3, `${grid.fsButtons}/3 tiles`);

  // Per-tile volume must be independent, and scaled by the master control.
  const target = grid.users[0];
  const volumes = await vwCdp.evaluate(`
    const tile = document.querySelector('.tile[data-user="${target}"]');
    const slider = tile.querySelector('.tile-volume');
    slider.value = '40';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const read = () => [...document.querySelectorAll('.tile')].map(t => ({
      user: t.dataset.user, vol: +(+t.querySelector('video').dataset.gain).toFixed(3),
    }));
    const afterTile = read();

    const master = document.getElementById('mosaic-volume');
    master.value = '50';
    master.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    return { afterTile, afterMaster: read() };
  `);
  const tileVol = volumes.afterTile.find((v) => v.user === target).vol;
  const otherVol = volumes.afterTile.find((v) => v.user !== target).vol;
  check(
    'a tile slider changes only that tile',
    Math.abs(tileVol - 0.4) < 0.01 && Math.abs(otherVol - 1) < 0.01,
    `${target}=${tileVol}, other=${otherVol}`,
  );
  const scaled = volumes.afterMaster.find((v) => v.user === target).vol;
  const scaledOther = volumes.afterMaster.find((v) => v.user !== target).vol;
  check(
    'the master volume scales every tile',
    Math.abs(scaled - 0.2) < 0.01 && Math.abs(scaledOther - 0.5) < 0.01,
    `${target}=${scaled} (0.4x0.5), other=${scaledOther} (1x0.5)`,
  );

  // Muting one tile must not silence the rest.
  const muted = await vwCdp.evaluate(`
    document.querySelector('.tile[data-user="${target}"] .tile-btn[data-role="mute"]').click();
    await new Promise(r => setTimeout(r, 200));
    return [...document.querySelectorAll('.tile')].map(t => ({
      user: t.dataset.user, muted: t.querySelector('video').dataset.muted === 'true',
    }));
  `);
  check(
    'muting one tile leaves the others playing',
    muted.find((m) => m.user === target).muted === true &&
      muted.filter((m) => m.user !== target).every((m) => !m.muted),
    muted.map((m) => `${m.user}:${m.muted ? 'muted' : 'on'}`).join(' '),
  );

  // Fullscreen, and Escape to leave it.
  const fs = await vwCdp.evaluate(
    `
    const tile = document.querySelector('.tile[data-user="${target}"]');
    tile.querySelector('.tile-btn[data-role="fullscreen"]').click();
    await new Promise(r => setTimeout(r, 800));
    const entered = document.fullscreenElement === tile;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 800));
    return { entered, exited: document.fullscreenElement === null };
  `,
    { userGesture: true },
  );
  check('a tile can go fullscreen', fs.entered === true);
  check('Escape leaves fullscreen', fs.exited === true);

  // A publisher leaving must drop its tile and re-home the audio.
  await bcCdp.evaluate(`
    const { harmony } = await import('./bridge.js');
    const gone = window.__M.find(m => m.name === ${JSON.stringify(mosaicNames[0])});
    gone.pc.close();
    await harmony.api.hangup(gone.resourceUrl);
    await harmony.api.release('${SERVER}', gone.name, gone.session.token);
    return true;
  `);

  const shrank = await waitFor(
    vwCdp,
    `[...document.querySelectorAll('.tile')].every(t => t.dataset.user !== ${JSON.stringify(mosaicNames[0])})`,
    { label: 'ended stream to drop out of the mosaic', timeoutMs: 25_000 },
  );
  check('a stream that ends disappears from the mosaic', shrank === true);

  const afterDrop = await vwCdp.evaluate(
    "return { tiles: document.querySelectorAll('.tile').length, audible: [...document.querySelectorAll('.tile video')].filter(v => v.dataset.muted === 'false').length };",
  );
  check(
    'the remaining tiles keep playing after one leaves',
    afterDrop.tiles === 2 && afterDrop.audible === 2,
    `${afterDrop.tiles} tiles, ${afterDrop.audible} audible`,
  );

  // Adding a stream from inside the mosaic.
  const addedInside = await vwCdp.evaluate(`
    document.getElementById('mosaic-add').click();
    await new Promise(r => setTimeout(r, 800));
    const modalOpen = !document.getElementById('add-stream').hidden;
    const offered = [...document.querySelectorAll('#add-stream-items .who')].map(e => e.textContent);
    document.getElementById('add-stream-close').click();
    return { modalOpen, offered };
  `);
  check(
    'the picker offers only streams not already shown',
    addedInside.modalOpen === true && !addedInside.offered.includes(mosaicNames[1]),
    `offered: ${addedInside.offered.join(', ') || '(none)'}`,
  );

  await vwCdp.evaluate("document.getElementById('mosaic-leave').click(); return true;");
  await sleep(1200);
  const leftMosaic = await vwCdp.evaluate(
    "return { view: document.querySelector('.view[data-active]')?.id, tiles: document.querySelectorAll('.tile').length };",
  );
  check(
    'leaving the mosaic closes every connection',
    leftMosaic.view === 'view-connect' && leftMosaic.tiles === 0,
    `view=${leftMosaic.view}, ${leftMosaic.tiles} tiles left`,
  );

  // ---------------- watching one stream, then adding a second ----------------

  await vwCdp.evaluate(`${setInput('username', mosaicNames[1])} return true;`);
  await vwCdp.evaluate("document.getElementById('continue').click(); return true;");
  await waitFor(vwCdp, "document.querySelector('.view[data-active]')?.id === 'view-watch'", {
    label: 'single watch view',
  });
  await waitFor(vwCdp, "document.getElementById('remote').videoWidth > 0", {
    label: 'single stream decoding',
    timeoutMs: 30_000,
  });
  check('watching a single stream again', true);

  const promoted = await vwCdp.evaluate(`
    document.getElementById('watch-add').click();
    await new Promise(r => setTimeout(r, 900));
    const offered = [...document.querySelectorAll('#add-stream-items .who')].map(e => e.textContent);
    const pick = [...document.querySelectorAll('#add-stream-items li')]
      .find(li => li.querySelector('.who').textContent === ${JSON.stringify(mosaicNames[2])});
    if (!pick) return { error: 'target not offered: ' + offered.join(',') };
    pick.click();
    return { ok: true, offered };
  `);
  check(
    'the picker excludes the stream already being watched',
    promoted.ok === true && !promoted.offered.includes(mosaicNames[1]),
    promoted.error ?? `offered: ${promoted.offered.join(', ')}`,
  );

  const bothTiles = await waitFor(
    vwCdp,
    "document.querySelector('.view[data-active]')?.id === 'view-mosaic' && " +
      "[...document.querySelectorAll('.tile video')].filter(v => v.videoWidth > 0).length === 2",
    { label: 'both streams tiled', timeoutMs: 45_000 },
  );
  check('adding a stream while watching switches to a 2-up mosaic', bothTiles === true);

  const kept = await vwCdp.evaluate(
    "return [...document.querySelectorAll('.tile')].map(t => t.dataset.user).sort();",
  );
  check(
    'the mosaic keeps the original stream and the added one',
    kept.length === 2 && kept.includes(mosaicNames[1]) && kept.includes(mosaicNames[2]),
    kept.join(', '),
  );

  // A hand-picked mosaic must not absorb unrelated streams that appear later.
  const stayedPicked = await vwCdp.evaluate(
    "await new Promise(r => setTimeout(r, 4000)); return document.querySelectorAll('.tile').length;",
  );
  check('a hand-picked mosaic does not absorb other live streams', stayedPicked === 2, `${stayedPicked} tiles`);

  // ---------------- the reported horizontal scrollbar ----------------
  //
  // Two tiles at the default window size raised a horizontal scrollbar on a
  // grid that had just been sized to fit. The cause was measuring
  // `clientWidth`, which includes the grid's own padding, and then laying the
  // tiles out in the content box inside it -- so the layout came out up to
  // 2 x 12px too wide, which is exactly enough to overflow.
  const fits = async (w, h) => {
    await vwCdp.setViewport(w, h);
    await sleep(800);
    return vwCdp.evaluate(`
      const g = document.getElementById('mosaic-grid');
      return {
        overflowX: g.scrollWidth > g.clientWidth,
        overflowY: g.scrollHeight > g.clientHeight + 2,
        cols: getComputedStyle(g).gridTemplateColumns.split(' ').length,
        pageScroll: document.documentElement.scrollWidth > window.innerWidth + 2,
      };
    `);
  };

  for (const [w, h, label] of [
    [1180, 800, 'the default window'],
    [1600, 900, 'wide'],
    [1280, 720, 'medium'],
    [900, 700, 'narrow'],
  ]) {
    const r = await fits(w, h);
    check(
      `two tiles fit without a horizontal scrollbar at ${w}x${h} (${label})`,
      !r.overflowX && !r.overflowY && !r.pageScroll,
      r.overflowX || r.pageScroll
        ? 'HORIZONTAL SCROLLBAR'
        : `2 tiles in ${r.cols} cols, fits both ways`,
    );
  }
  await vwCdp.clearViewport();
  await sleep(700);

  // ---------------- maximize one tile, without fullscreen ----------------
  const maximized = await vwCdp.evaluate(`
    const first = document.querySelector('.tile');
    const who = first.dataset.user;
    first.querySelector('.tile-btn[data-role="maximize"]').click();
    await new Promise(r => setTimeout(r, 400));
    const tiles = [...document.querySelectorAll('.tile')];
    const shown = tiles.filter(t => !t.hidden);
    return {
      who,
      shown: shown.length,
      showsTheRightOne: shown.length === 1 && shown[0].dataset.user === who,
      stillConnected: tiles.length,
      fullscreen: !!document.fullscreenElement,
      biggerThanBefore: shown[0]?.getBoundingClientRect().width > 0,
      cols: getComputedStyle(document.getElementById('mosaic-grid')).gridTemplateColumns.split(' ').length,
    };
  `);
  check(
    'maximizing a tile fills the grid with just that stream',
    maximized.showsTheRightOne && maximized.cols === 1,
    `${maximized.shown}/${maximized.stillConnected} visible in ${maximized.cols} col`,
  );
  check(
    'maximize does not go fullscreen',
    maximized.fullscreen === false,
    'the window chrome and the rest of the desktop stay visible',
  );

  const backToGrid = await vwCdp.evaluate(`
    document.querySelector('.tile:not([hidden]) .tile-btn[data-role="maximize"]').click();
    await new Promise(r => setTimeout(r, 400));
    return [...document.querySelectorAll('.tile')].filter(t => !t.hidden).length;
  `);
  check('the same button restores the grid', backToGrid === 2, `${backToGrid} tiles back`);

  // Escape is the other way out, and must not be swallowed by fullscreen
  // handling that is not active.
  const escaped = await vwCdp.evaluate(`
    document.querySelector('.tile .tile-btn[data-role="maximize"]').click();
    await new Promise(r => setTimeout(r, 300));
    const whileMax = [...document.querySelectorAll('.tile')].filter(t => !t.hidden).length;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    return { whileMax, after: [...document.querySelectorAll('.tile')].filter(t => !t.hidden).length };
  `);
  check('Escape leaves a maximized tile', escaped.whileMax === 1 && escaped.after === 2, JSON.stringify(escaped));

  // ---------------- close one stream from the mosaic ----------------
  const closed = await vwCdp.evaluate(`
    const first = document.querySelector('.tile');
    const who = first.dataset.user;
    first.querySelector('.tile-btn[data-role="close"]').click();
    await new Promise(r => setTimeout(r, 500));
    return {
      who,
      remaining: [...document.querySelectorAll('.tile')].map(t => t.dataset.user),
      count: document.getElementById('mosaic-count').textContent,
    };
  `);
  check(
    'closing a tile removes that stream from the mosaic',
    closed.remaining.length === 1 && !closed.remaining.includes(closed.who),
    `closed ${closed.who}, left with ${closed.remaining.join(', ') || 'nothing'} (${closed.count})`,
  );

  // The important half: the periodic sync runs every 3s and must not cheerfully
  // reopen what the user just dismissed.
  const stayedClosed = await vwCdp.evaluate(`
    await new Promise(r => setTimeout(r, 5000));
    return [...document.querySelectorAll('.tile')].map(t => t.dataset.user);
  `);
  check(
    'a closed stream stays closed across a sync',
    stayedClosed.length === 1 && !stayedClosed.includes(closed.who),
    `after 5s: ${stayedClosed.join(', ') || 'nothing'}`,
  );

  // ...and + Add stream is the way back, overriding the dismissal.
  const reopened = await vwCdp.evaluate(`
    document.getElementById('mosaic-add').click();
    await new Promise(r => setTimeout(r, 600));
    return { offered: [...document.querySelectorAll('#add-stream-items li .who')].map(w => w.textContent) };
  `);
  check(
    'a closed stream is offered again by + Add stream',
    reopened.offered.includes(closed.who),
    `offered: ${reopened.offered.join(', ') || 'none'}`,
  );
  await vwCdp.evaluate("document.getElementById('add-stream-close').click(); return true;");

  await vwCdp.evaluate("document.getElementById('mosaic-leave').click(); return true;");
  await sleep(1000);

  await bcCdp.evaluate(`
    const { harmony } = await import('./bridge.js');
    for (const m of window.__M) {
      try { m.pc.close(); await harmony.api.hangup(m.resourceUrl);
            await harmony.api.release('${SERVER}', m.name, m.session.token); } catch {}
    }
    return true;
  `);

  bcCdp.close();
  vwCdp.close();
}

run()
  .catch((err) => check('e2e run completed', false, err.message))
  .finally(async () => {
    cleanup();
    await sleep(600);
    const failed = summary();
    if (failed) {
      console.error(`\n--- mediamtx ---\n${mtxLog.slice(-3000)}`);
      console.error(`\n--- harmony server ---\n${serverLog.slice(-2000)}`);
    }
    process.exit(failed ? 1 : 0);
  });
