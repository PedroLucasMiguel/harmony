// From what the two pages wrote down to the numbers worth comparing.

const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const percentile = (xs, p) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null;
};
const mean = (xs) => {
  const s = xs.filter(Number.isFinite);
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
};
const delta = (series, pick, from, to) => {
  const a = pick(series[from]);
  const b = pick(series[to]);
  return Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
};

/** Seconds of video the sender had up to each sample, as Mbit/s sent in the second before it. */
function bitrateSeries(out) {
  const rows = [];
  for (let i = 1; i < out.length; i += 1) {
    const dt = (out[i].at - out[i - 1].at) / 1000;
    const bytes = (out[i].v?.bytesSent ?? 0) - (out[i - 1].v?.bytesSent ?? 0);
    rows.push({ t: (out[i].at - out[0].at) / 1000, mbps: dt > 0 ? (bytes * 8) / dt / 1e6 : 0 });
  }
  return rows;
}

export function summarize(run) {
  const { frames, flashes, onsets, stats: vin } = run.viewer;
  const { stats: out, beeps } = run.streamer;

  // ---- the picture, as it was shown
  const first = frames[0];
  const ttffMs = first ? first[0] - run.viewerStartedAt : null;
  const warm = first ? frames.filter((f) => f[0] >= first[0] + 6000) : [];
  const lat = warm.map((f) => f[1]).filter((l) => l > -50 && l < 20000);
  const seconds = warm.length > 1 ? (warm.at(-1)[0] - warm[0][0]) / 1000 : 0;
  const gaps = [];
  for (let i = 1; i < warm.length; i += 1) gaps.push(warm[i][0] - warm[i - 1][0]);
  const early = first ? frames.filter((f) => f[0] < first[0] + 5000).map((f) => f[1]).filter((l) => l > -50 && l < 20000) : [];

  // ---- the sender
  const last = out.length - 1;
  const mid = Math.floor(last / 2);
  const bitrate = bitrateSeries(out);
  const steady = median(bitrate.slice(Math.floor(bitrate.length / 2)).map((r) => r.mbps));
  const ramp = steady ? bitrate.find((r) => r.mbps >= 0.8 * steady)?.t ?? null : null;
  const dEnc = delta(out, (s) => s.v?.framesEncoded, mid, last);
  const dEncTime = delta(out, (s) => s.v?.totalEncodeTime, mid, last);
  const dQp = delta(out, (s) => s.v?.qpSum, mid, last);
  const e10 = out.findIndex((x) => x.at - out[0].at >= 10000);
  const dQpEarly = e10 > 0 ? delta(out, (x) => x.v?.qpSum, 0, e10) : null;
  const dEncEarly = e10 > 0 ? delta(out, (x) => x.v?.framesEncoded, 0, e10) : null;
  const dBytesEarly = e10 > 0 ? delta(out, (x) => x.v?.bytesSent, 0, e10) : null;
  const dPackets = delta(out, (s) => s.v?.packetsSent, 0, last);
  const dDelay = delta(out, (s) => s.v?.totalPacketSendDelay, 0, last);
  const early10 = out.findIndex((s) => s.at - out[0].at >= 10000);
  const dPacketsEarly = early10 > 0 ? delta(out, (s) => s.v?.packetsSent, 0, early10) : null;
  const dDelayEarly = early10 > 0 ? delta(out, (s) => s.v?.totalPacketSendDelay, 0, early10) : null;
  const v = out[last]?.v ?? {};

  // ---- the viewer's receiver
  const vlast = vin.length - 1;
  const vmid = Math.floor(vlast / 2);
  const vv = vin[vlast]?.v ?? {};
  const va = vin[vlast]?.a ?? {};
  const dJbDelay = delta(vin, (s) => s.v?.jitterBufferDelay, vmid, vlast);
  const dJbEmitted = delta(vin, (s) => s.v?.jitterBufferEmittedCount, vmid, vlast);
  const dDecodeTime = delta(vin, (s) => s.v?.totalDecodeTime, vmid, vlast);
  const dDecoded = delta(vin, (s) => s.v?.framesDecoded, vmid, vlast);
  const aJbDelay = delta(vin, (s) => s.a?.jitterBufferDelay, vmid, vlast);
  const aJbEmitted = delta(vin, (s) => s.a?.jitterBufferEmittedCount, vmid, vlast);

  // ---- the beep against the flash
  const against = (flashList, onsetList, from) => {
    const groups = [];
    for (const f of [...flashList].sort((x, y) => x.sent - y.sent)) {
      if (!groups.length || f.sent - groups.at(-1).at(-1).sent > 300) groups.push([f]);
      else groups.at(-1).push(f);
    }
    const found = [];
    for (const T of beeps) {
      const g = groups.find((x) => x[0].sent >= T - 5 && x[0].sent <= T + 80);
      const heard = onsetList.filter((o) => o > T && o < T + 2000).sort((x, y) => x - y)[0];
      if (!g || heard == null || T < from) continue;
      found.push({ audio: heard - T, video: g[0].shown - T, offset: heard - T - (g[0].shown - T) });
    }
    return found;
  };
  const pairs = against(flashes, onsets, (first?.[0] ?? 0) + 6000);
  const local = run.streamer.local ? against(run.streamer.local.flashes, run.streamer.local.onsets, (out[0]?.at ?? 0) + 6000) : [];
  const rms = run.viewer.rms;
  const stereoRatio = rms?.l?.length ? median(rms.l.map((l, i) => rms.r[i] / (l || 1e-9))) : null;

  return {
    ttffMs,
    latency: { p50: median(lat), p95: percentile(lat, 0.95), max: lat.length ? Math.max(...lat) : null, early: mean(early) },
    fps: (() => { const dt = (vin[vlast].at - vin[vmid].at) / 1000; const df = delta(vin, (x) => x.v?.framesDecoded, vmid, vlast); return dt > 0 && df != null ? df / dt : null; })(),
    stalls100: gaps.filter((g) => g > 100).length,
    stalls250: gaps.filter((g) => g > 250).length,
    maxGapMs: gaps.length ? Math.max(...gaps) : null,
    rampSeconds: ramp,
    mbps: steady,
    qpEarly: dQpEarly != null && dEncEarly ? dQpEarly / dEncEarly : null,
    mbpsEarly: dBytesEarly != null && e10 > 0 ? (dBytesEarly * 8) / ((out[e10].at - out[0].at) / 1000) / 1e6 : null,
    qp: dQp != null && dEnc ? dQp / dEnc : null,
    encodeMs: dEnc ? (dEncTime * 1000) / dEnc : null,
    sendDelayMs: dPackets ? (dDelay * 1000) / dPackets : null,
    sendDelayEarlyMs: dPacketsEarly ? (dDelayEarly * 1000) / dPacketsEarly : null,
    avOffsetMs: pairs.length ? median(pairs.map((p) => p.offset)) : null,
    audioDelayMs: pairs.length ? median(pairs.map((p) => p.audio)) : null,
    videoDelayMs: pairs.length ? median(pairs.map((p) => p.video)) : null,
    avPairs: pairs.length,
    localOffsetMs: local.length ? median(local.map((p) => p.offset)) : null,
    stereoRatio,
    sender: {
      encoder: v.encoder ?? v.encoderImplementation,
      fmtp: out[last]?.fmtp,
      limited: v.qualityLimitationDurations,
      reason: v.qualityLimitationReason,
      keyFrames: v.keyFramesEncoded,
      framesEncoded: v.framesEncoded,
      nack: v.nackCount,
      pli: v.pliCount,
      size: `${v.frameWidth}x${v.frameHeight}`,
      encodedFps: v.framesPerSecond,
      targetKbps: v.targetBitrate ? Math.round(v.targetBitrate / 1000) : null,
      rttMs: out[last]?.rtt != null ? Math.round(out[last].rtt * 1000) : null,
      srcFps: out[last]?.src?.fps,
    },
    viewer: {
      decoder: vv.decoderImplementation,
      size: `${vv.frameWidth}x${vv.frameHeight}`,
      dropped: vv.framesDropped,
      freezes: vv.freezeCount,
      freezeSeconds: vv.totalFreezesDuration,
      keyFrames: vv.keyFramesDecoded,
      lost: vv.packetsLost,
      videoJitterBufferMs: dJbEmitted ? (dJbDelay * 1000) / dJbEmitted : null,
      decodeMs: dDecoded ? (dDecodeTime * 1000) / dDecoded : null,
      audioJitterBufferMs: aJbEmitted ? (aJbDelay * 1000) / aJbEmitted : null,
      audioConcealedSamples: va.concealedSamples,
    },
    // what the first seconds looked like, for the ramp
    bitrate: bitrate.slice(0, 40).map((r) => Number(r.mbps.toFixed(2))),
  };
}
