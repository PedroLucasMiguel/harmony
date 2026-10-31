// The two halves of the screen-share benchmark that run inside the Electron pages. They are strings of
// code for the harness (share-bench.mjs) to evaluate, so that what is measured goes through the app's own
// modules -- webrtc.js to publish and watch, gain.js for the sound -- and not a copy of them.


/** Reads the clock out of the frames a <video> shows, and notes the flashes. Used by the viewer, and by the streamer to calibrate. */
export const PROBE = (S) => `
function makeProbe(video) {
  const crop = document.createElement('canvas'); crop.width = 32 * 24; crop.height = 24;
  const cg = crop.getContext('2d', { willReadFrequently: true });
  const frames = []; const flashes = []; let lastFrameAt = 0;
  const onFrame = (_now, meta) => {
    const shown = performance.timeOrigin + (meta.expectedDisplayTime ?? performance.now());
    const w = video.videoWidth;
    if (w >= 768) {
      const scale = w / ${S.width};
      cg.drawImage(video, 0, 0, 768 * scale, 24 * scale, 0, 0, 768, 24);
      const px = cg.getImageData(0, 0, 768, 24).data;
      let stamp = 0;
      for (let b = 0; b < 32; b += 1) { const o = ((12 * 768) + b * 24 + 12) * 4; stamp = stamp * 2 + (px[o] > 127 ? 1 : 0); }
      stamp >>>= 0;
      const nowFull = Date.now(); const high = Math.floor(nowFull / 4294967296) * 4294967296;
      let sent = high + stamp; if (sent > nowFull + 1000) sent -= 4294967296;
      cg.drawImage(video, (${S.width} - 420 + 100) * scale, 20 * scale, 10 * scale, 10 * scale, 0, 0, 1, 1);
      const flash = cg.getImageData(0, 0, 1, 1).data[0] > 200;
      frames.push([Math.round(shown), Math.round(shown - sent), meta.presentedFrames, Math.round((_now - lastFrameAt) * 10) / 10, flash ? 1 : 0, w, video.videoHeight]);
      if (flash) flashes.push({ sent, shown });
      lastFrameAt = _now;
    }
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
  return { frames, flashes };
}
/** Times the start of every beep in a stream's sound, as the moment it would leave for the speakers. */
async function tapOnsets(ctx, mediaStream, { stereo = false } = {}) {
  const onsets = []; const rms = { l: [], r: [] };
  const tap = ctx.createMediaStreamSource(mediaStream);
  const node = ctx.createScriptProcessor(256, 2, 1);
  const mute = ctx.createGain(); mute.gain.value = 0;
  let was = false;
  node.onaudioprocess = (e) => {
    const a = e.inputBuffer.getChannelData(0); const b = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : a;
    let sa = 0, sb = 0; for (let k = 0; k < a.length; k += 1) { sa += a[k] * a[k]; sb += b[k] * b[k]; }
    const la = Math.sqrt(sa / a.length), lb = Math.sqrt(sb / b.length);
    const loud = Math.max(la, lb) > 0.05;
    if (loud) { rms.l.push(la); rms.r.push(lb); }
    if (loud && !was) {
      const ts = ctx.getOutputTimestamp();
      onsets.push(performance.timeOrigin + ts.performanceTime + (e.playbackTime - ts.contextTime) * 1000);
    }
    was = loud;
  };
  tap.connect(node); node.connect(mute); mute.connect(ctx.destination);
  if (ctx.state === 'suspended') await ctx.resume();
  return { onsets, rms };
}
`;
/**
 * The streamer: a game-like feed with the time written into every frame, a flash and a beep once a second,
 * published the way startBroadcast publishes it. `S` is the scenario.
 */
export const STREAMER = (S) => `
const { publish, preferCodec, applySenderSettings, setSenderPriority, relayServers } = await import('./webrtc.js');
const { harmony } = await import('./bridge.js');
const S = ${JSON.stringify(S)};
window.__h = harmony;
window.__sdp = null;
${PROBE(S)}

// ---- the picture: layers that scroll at different speeds, a crowd of small movers, a HUD, and the clock
const W = S.width, H = S.height;
const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
const g = canvas.getContext('2d', { alpha: false });
const tile = document.createElement('canvas'); tile.width = 1024; tile.height = 1024;
{
  const t = tile.getContext('2d');
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  t.fillStyle = '#1b2a1f'; t.fillRect(0, 0, 1024, 1024);
  for (let i = 0; i < 220; i += 1) {
    const x = rnd() * 1024, y = rnd() * 1024, r = 12 + rnd() * 90;
    const grad = t.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'hsla(' + Math.floor(rnd() * 360) + ',55%,' + (30 + rnd() * 35) + '%,0.9)');
    grad.addColorStop(1, 'hsla(0,0%,10%,0)');
    t.fillStyle = grad; t.beginPath(); t.arc(x, y, r, 0, 7); t.fill();
  }
  for (let i = 0; i < 1500; i += 1) { t.fillStyle = 'rgba(255,255,255,' + (rnd() * 0.25) + ')'; t.fillRect(rnd() * 1024, rnd() * 1024, 1 + rnd() * 3, 1 + rnd() * 3); }
}
let seed2 = 99; const rnd2 = () => (seed2 = (seed2 * 16807) % 2147483647) / 2147483647;
const movers = Array.from({ length: S.movers ?? 260 }, () => ({ x: rnd2() * W, y: rnd2() * H, vx: (rnd2() - 0.5) * 14, vy: (rnd2() - 0.5) * 14, s: 6 + rnd2() * 26, h: Math.floor(rnd2() * 360) }));

const BLOCK = 24, BITS = 32;
let beepAt = 0, flashUntil = 0, frames = 0;
const beeps = [];   // when each beep was asked for, on this page's clock (Date.now)
const draws = [];

function drawFrame() {
  const now = Date.now();
  const t = performance.now() / 1000;
  for (const [i, speed] of [[0, 90], [1, 210], [2, 420]]) {
    const ox = (t * speed) % 1024, oy = (t * speed * 0.4) % 1024;
    g.globalAlpha = i === 0 ? 1 : 0.55;
    const scale = W / 1024 * (1 + i * 0.35);
    g.save(); g.scale(scale, scale);
    for (let x = -1; x < Math.ceil(W / scale / 1024) + 1; x += 1) for (let y = -1; y < Math.ceil(H / scale / 1024) + 1; y += 1) g.drawImage(tile, x * 1024 - ox, y * 1024 - oy);
    g.restore();
  }
  g.globalAlpha = 1;
  for (const m of movers) {
    m.x += m.vx; m.y += m.vy; if (m.x < 0 || m.x > W) m.vx *= -1; if (m.y < 0 || m.y > H) m.vy *= -1;
    g.fillStyle = 'hsl(' + ((m.h + t * 60) % 360) + ',80%,55%)'; g.fillRect(m.x, m.y, m.s, m.s);
  }
  g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(W - 360, H - 150, 330, 120);
  g.fillStyle = '#fff'; g.font = '600 34px sans-serif'; g.fillText('FPS ' + (S.fps), W - 340, H - 100); g.font = '400 24px monospace'; g.fillText('HP 100  AMMO 24/90', W - 340, H - 55);
  if (now >= beepAt) { beepAt = now + 1000; flashUntil = now + 45; beeps.push(now); beeper?.port.postMessage('beep'); }
  if (now < flashUntil) { g.fillStyle = '#fff'; g.fillRect(W - 420, 0, 420, 80); }
  // the clock: 32 blocks, black or white, each a whole number of macroblocks
  const stamp = now % 4294967296;
  for (let b = 0; b < BITS; b += 1) { g.fillStyle = ((stamp >>> (BITS - 1 - b)) & 1) ? '#fff' : '#000'; g.fillRect(b * BLOCK, 0, BLOCK, BLOCK); }
  frames += 1;
}

// ---- the sound: a beep when a flash starts
const actx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
const dest = actx.createMediaStreamDestination();
const level = actx.createGain(); level.gain.value = 0;
if (S.stereoProbe) { const merger = actx.createChannelMerger(2); level.connect(merger, 0, 0); merger.connect(dest); } else level.connect(dest);
const tone = actx.createOscillator(); tone.frequency.value = 1000; tone.connect(level); tone.start();
window.__ctxs = [actx];
if (actx.state === 'suspended') await actx.resume();
const beeper = { port: { postMessage() {
  const at = actx.currentTime;
  level.gain.cancelScheduledValues(at); level.gain.setValueAtTime(0.5, at); level.gain.setValueAtTime(0, at + 0.04);
} } };

// ---- the stream
const capture = canvas.captureStream(S.fps);
let running = true;
const loop = () => { if (!running) return; drawFrame(); requestAnimationFrame(loop); };
requestAnimationFrame(loop);
const stream = new MediaStream([capture.getVideoTracks()[0], dest.stream.getAudioTracks()[0]]);

window.__stream = { stop() { running = false; }, beeps, getFrames: () => frames };

// ---- publish (the same steps as publishOnce, with hooks for what an experiment changes)
async function benchPublish() {
  const editSdp = (sdp) => {
    const lines = sdp.split(/\\r?\\n/); let kind = ''; const pts = { video: new Set(), audio: new Set() };
    for (const l of lines) {
      if (l.startsWith('m=')) kind = l.slice(2).split(' ')[0];
      const m = /^a=rtpmap:(\\d+) (H264\\/90000|opus\\/48000)/i.exec(l);
      if (m && pts[kind]) pts[kind].add(m[1]);
    }
    kind = '';
    return lines.map((l) => {
      if (l.startsWith('m=')) kind = l.slice(2).split(' ')[0];
      const m = /^a=fmtp:(\\d+) (.*)$/.exec(l);
      if (!m || !pts[kind]?.has(m[1])) return l;
      let extra = '';
      if (kind === 'video' && S.startBitrate && !/x-google-start/.test(m[2])) extra += ';x-google-start-bitrate=' + S.startBitrate.start + ';x-google-min-bitrate=' + S.startBitrate.min;
      if (kind === 'audio' && S.opus && !/stereo=1/.test(m[2])) extra += ';stereo=1;sprop-stereo=1;maxaveragebitrate=' + S.opus.kbps * 1000;
      return l + extra;
    }).join('\\r\\n');
  };

  const pc = new RTCPeerConnection({ iceServers: relayServers(S.iceServers), bundlePolicy: 'max-bundle' });
  const videoTrack = stream.getVideoTracks()[0];
  const audioTrack = stream.getAudioTracks()[0];
  pc.addTransceiver(audioTrack, { direction: 'sendonly', streams: [stream] });
  videoTrack.contentHint = S.contentHint;
  const tx = pc.addTransceiver(videoTrack, { direction: 'sendonly', streams: [stream] });
  preferCodec(tx, S.codec ?? 'H264');
  if (S.h264Only) { const caps = RTCRtpSender.getCapabilities('video').codecs.filter((c) => c.mimeType === 'video/H264' && (c.sdpFmtpLine ?? '').includes('profile-level-id=' + S.h264Only)); tx.setCodecPreferences(caps); }
  const offer = await pc.createOffer();
  await pc.setLocalDescription(S.opus ? { type: 'offer', sdp: editSdp(offer.sdp) } : offer);
  await new Promise((resolve) => { if (pc.iceGatheringState === 'complete') resolve(); else { pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && resolve()); setTimeout(resolve, 4000); } });
  const offerSdp = S.proxyPort ? pc.localDescription.sdp.split(/\\r?\\n/).filter((l) => !l.startsWith('a=candidate:')).join('\\r\\n') : pc.localDescription.sdp;
  const reply = await harmony.api.sdp(S.whipUrl, offerSdp);
  let answer = reply.answer;
  const keep = (sdp) => sdp.split(/\\r?\\n/).filter((l) => /^(m=|a=rtpmap|a=fmtp)/.test(l)).join('\\n');
  if (S.startBitrate || S.opus) answer = editSdp(answer);
  if (S.noRtx) {
    // tell the sender the relay has no RTX: a lost packet is then sent again as itself
    const lines = answer.split(/\\r?\\n/); let kind = ''; const rtx = new Set();
    for (const l of lines) { if (l.startsWith('m=')) kind = l.slice(2).split(' ')[0]; const m = /^a=rtpmap:(\\d+) rtx\\/90000/.exec(l); if (m && kind === 'video') rtx.add(m[1]); }
    kind = '';
    answer = lines.filter((l) => {
      if (l.startsWith('m=')) kind = l.slice(2).split(' ')[0];
      if (kind !== 'video') return true;
      const pt = /^a=(?:rtpmap|fmtp|rtcp-fb):(\\d+) /.exec(l)?.[1];
      return !(pt && rtx.has(pt));
    }).map((l) => (l.startsWith('m=video') ? l.split(' ').filter((tok, i) => i < 3 || !rtx.has(tok)).join(' ') : l)).join('\\r\\n');
  }
  if (S.proxyPort) {
    // the publisher talks to the line instead of the relay: one UDP candidate, the proxy's
    const lines = answer.split(/\\r?\\n/); let placed = false;
    answer = lines.filter((l) => { if (!l.startsWith('a=candidate:')) return true; if (placed || !/ udp /.test(l)) return false; placed = true; return true; })
      .map((l) => (l.startsWith('a=candidate:') ? l.replace(/^(a=candidate:\\S+ \\S+ udp \\S+ )\\S+ \\S+( typ .*)$/, '$1127.0.0.1 ' + S.proxyPort + '$2') : l)).join('\\r\\n');
  }
  if (S.dumpSdp) {
    const keep = (sdp) => sdp.split(/\\r?\\n/).filter((l) => /^(m=|a=rtpmap|a=fmtp)/.test(l)).join('\\n');
    window.__sdp = { offer: keep(pc.localDescription.sdp), answer: keep(answer), fb: answer.split(/\\r?\\n/).filter((l) => /^a=(rtcp-fb|extmap|rtcp-mux|rtcp-rsize)/.test(l)).join('\\n') };
  }
  await pc.setRemoteDescription({ type: 'answer', sdp: answer });
  const sender = pc.getSenders().find((x) => x.track === videoTrack);
  await applySenderSettings(sender, { maxBitrate: S.maxBitrate, maxFramerate: S.maxFramerate, degradationPreference: S.degradationPreference });
  await setSenderPriority(sender, 'low');
  if (S.audioMaxKbps) {
    const a = pc.getSenders().find((x) => x.track?.kind === 'audio'); const p = a.getParameters();
    if (!p.encodings?.length) p.encodings = [{}]; p.encodings[0].maxBitrate = S.audioMaxKbps * 1000; await a.setParameters(p);
  }
  return { pc, resourceUrl: reply.resourceUrl };
}

const t0 = performance.now();
const { pc, resourceUrl } = S.useRealPublish
  ? await publish({ url: S.whipUrl, stream, iceServers: S.iceServers, codec: S.codec ?? 'H264', maxBitrate: S.maxBitrate, maxFramerate: S.maxFramerate, contentHint: S.contentHint, degradationPreference: S.degradationPreference, startBitrate: S.realStart ?? 0, stereoAudio: S.realStereo ?? 0 })
  : await benchPublish();
window.__pc = pc; window.__resourceUrl = resourceUrl;
window.__publishMs = Math.round(performance.now() - t0);
if (S.localSync) {
  const lv = document.createElement('video'); lv.muted = true; lv.playsInline = true;
  lv.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:180px;z-index:99998';
  lv.srcObject = new MediaStream([stream.getVideoTracks()[0]]); document.body.append(lv); await lv.play().catch(() => {});
  window.__local = { probe: makeProbe(lv), audio: await tapOnsets(actx, new MediaStream([stream.getAudioTracks()[0]])) };
}

// ---- what the sender reports, once a second
window.__out = [];
window.__outTimer = setInterval(async () => {
  const rows = []; (await pc.getStats()).forEach((r) => rows.push(r));
  const v = rows.find((r) => r.type === 'outbound-rtp' && r.kind === 'video');
  const a = rows.find((r) => r.type === 'outbound-rtp' && r.kind === 'audio');
  const rin = rows.find((r) => r.type === 'remote-inbound-rtp' && r.kind === 'video');
  const pair = rows.find((r) => r.type === 'candidate-pair' && (r.nominated || r.state === 'succeeded') && r.availableOutgoingBitrate != null);
  const src = rows.find((r) => r.type === 'media-source' && r.kind === 'video');
  window.__out.push({ at: Date.now(), fmtp: rows.find((r) => r.id === v?.codecId)?.sdpFmtpLine, v: v && { ...v }, a: a && { bytesSent: a.bytesSent, packetsSent: a.packetsSent, totalPacketSendDelay: a.totalPacketSendDelay }, rtt: rin?.roundTripTime, loss: rin?.fractionLost, avail: pair?.availableOutgoingBitrate, src: src && { fps: src.framesPerSecond, frames: src.frames, w: src.width, h: src.height } });
}, 1000);
return { publishMs: window.__publishMs };
`;

/** The viewer: watches the way the app does, and writes down what each frame and each beep looked like. `S` is the scenario. */
export const VIEWER = (S) => `
const { watch } = await import('./webrtc.js');
const { createSink } = await import('./gain.js');
const S = ${JSON.stringify(S)};
${PROBE(S)}

const video = document.createElement('video');
video.muted = S.audioPath !== 'element';
video.autoplay = true; video.playsInline = true;
video.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:360px;z-index:99999;background:#000';
document.body.append(video);

// the viewer's own line: its connection goes through a proxy that loses packets coming towards it
const bridgeApi = (await import('./bridge.js')).harmony.api;
const realSdp = bridgeApi.sdp;
if (S.viewerProxyPort) {
  bridgeApi.sdp = async (url, sdp) => {
    const stripped = sdp.split(/\\r?\\n/).filter((l) => !l.startsWith('a=candidate:')).join('\\r\\n');
    const reply = await realSdp(url, stripped);
    let placed = false;
    const lines = reply.answer.split(/\\r?\\n/).filter((l) => { if (!l.startsWith('a=candidate:')) return true; if (placed || !/ udp /.test(l)) return false; placed = true; return true; })
      .map((l) => (l.startsWith('a=candidate:') ? l.replace(/^(a=candidate:\\S+ \\S+ udp \\S+ )\\S+ \\S+( typ .*)$/, '$1127.0.0.1 ' + S.viewerProxyPort + '$2') : l));
    return { ...reply, answer: lines.join('\\r\\n') };
  };
}
const realOffer = RTCPeerConnection.prototype.createOffer;
if (S.viewerStereo) {
  // a receiver that says it wants stereo, which is what makes its decoder keep two channels
  RTCPeerConnection.prototype.createOffer = async function (...args) {
    const o = await realOffer.apply(this, args);
    return { type: o.type, sdp: o.sdp.replace(/(a=fmtp:\\d+ minptime=10;useinbandfec=1)/g, '$1;stereo=1;sprop-stereo=1') };
  };
}
const t0 = performance.now();
const { pc, stream } = await watch({ url: S.whepUrl, iceServers: S.iceServers, ...(S.watchStereo === false ? { stereoAudio: false } : {}) });
RTCPeerConnection.prototype.createOffer = realOffer;
bridgeApi.sdp = realSdp;
window.__vpc = pc;
video.srcObject = stream;
window.__watchMs = Math.round(performance.now() - t0);

// receiver knobs an experiment may turn
const videoRx = pc.getReceivers().find((r) => r.track?.kind === 'video');
if (S.jitterBufferTarget != null && videoRx && 'jitterBufferTarget' in videoRx) videoRx.jitterBufferTarget = S.jitterBufferTarget;
if (S.playoutDelayHint != null && videoRx && 'playoutDelayHint' in videoRx) videoRx.playoutDelayHint = S.playoutDelayHint;
const audioRx = pc.getReceivers().find((r) => r.track?.kind === 'audio');
if (S.audioJitterBufferTarget != null && audioRx && 'jitterBufferTarget' in audioRx) audioRx.jitterBufferTarget = S.audioJitterBufferTarget;

// the sound, the way a room plays it: through a sink (WebAudio), with a tap that times each beep
let sink = null, actx = null, audio = { onsets: [], rms: { l: [], r: [] } };
if (S.audioPath === 'webaudio' || S.stereoProbe) {
  if (S.audioPath === 'webaudio') sink = createSink(stream);
  actx = new AudioContext({ latencyHint: 'interactive' });
  window.__vctxs = [actx];
  audio = await tapOnsets(actx, stream);
}

const probe = makeProbe(video);
await video.play().catch(() => {});

window.__in = [];
window.__inTimer = setInterval(async () => {
  const rows = []; (await pc.getStats()).forEach((r) => rows.push(r));
  const v = rows.find((r) => r.type === 'inbound-rtp' && r.kind === 'video');
  const a = rows.find((r) => r.type === 'inbound-rtp' && r.kind === 'audio');
  window.__in.push({ at: Date.now(), v: v && { ...v }, a: a && { ...a } });
}, 1000);

window.__viewer = { frames: probe.frames, flashes: probe.flashes, onsets: audio.onsets, rms: audio.rms, sink, actx };
return { watchMs: window.__watchMs };
`;

/** Pull everything the viewer wrote down into plain data. */
export const COLLECT_VIEWER = `
const { frames, flashes, onsets, rms } = window.__viewer;
return { frames, flashes, onsets, rms, stats: window.__in, watchMs: window.__watchMs };`;

export const COLLECT_STREAMER = `
return { sdp: window.__sdp ?? null, stats: window.__out, beeps: window.__stream.beeps, publishMs: window.__publishMs, local: window.__local ? { flashes: window.__local.probe.flashes, onsets: window.__local.audio.onsets } : null };`;

export const STOP_STREAMER = `
clearInterval(window.__outTimer); window.__stream.stop();
try { await window.__h.api.hangup(window.__resourceUrl); } catch {}
try { window.__pc.close(); } catch {}
for (const c of window.__ctxs ?? []) { try { await c.close(); } catch {} }
return true;`;

export const STOP_VIEWER = `
clearInterval(window.__inTimer);
try { window.__vpc.close(); } catch {}
for (const c of window.__vctxs ?? []) { try { await c.close(); } catch {} }
window.__viewer?.sink?.close?.();
return true;`;
