// WHIP (publish) and WHEP (watch).
//
// Both are the same three-line protocol: POST an SDP offer as text/sdp, get an
// SDP answer back plus a Location header naming the session, DELETE that
// Location to hang up. The HTTP itself happens in the main process; this module
// only drives the RTCPeerConnection.

import { harmony } from './bridge.js';

const ICE_GATHER_TIMEOUT_MS = 4000;

/**
 * The ICE servers worth using: TURN relays, never STUN.
 *
 * Every connection here is to the media server, which advertises its own
 * address and learns ours from our first packet, so a STUN-discovered public
 * address adds nothing. It costs, though. Measured on a network with no
 * public IPv6: with STUN configured, gathering never completed -- the IPv6
 * lookups fail (ERR_NAME_NOT_RESOLVED) and that port never reports done -- so
 * every publish and every subscription waited the whole timeout above before
 * sending its offer. Without STUN it finishes in ~140 ms.
 *
 * Servers since 3.0 send no STUN by default; this covers one that still does.
 */
export function relayServers(iceServers = []) {
  const out = [];
  for (const server of iceServers ?? []) {
    const urls = [].concat(server?.urls ?? []).filter((u) => !/^stuns?:/i.test(String(u)));
    if (urls.length) out.push({ ...server, urls });
  }
  return out;
}

/**
 * Wait for ICE gathering to finish so we can send one complete offer.
 *
 * WHIP supports trickle ICE, but MediaMTX answers a single shot fine and
 * non-trickle keeps this code to a fraction of the size. The timeout stops a
 * slow or unreachable STUN server from hanging the whole connect: whatever
 * candidates we have by then are good enough, since the server's own candidate
 * is usually the one that wins.
 */
function waitForIceGathering(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, ICE_GATHER_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

/**
 * How much we want each H.264 profile, lowest number first.
 *
 * This ordering is the whole difference between hardware and software video on
 * Windows, and it is not obvious. Chromium offers constrained baseline
 * (profile_idc 42) first, and NVIDIA's H.264 encoder and decoder MFTs do not
 * accept baseline at all -- so every call silently ran on the CPU while
 * `getGPUFeatureStatus()` cheerfully reported `video_encode: enabled`, because
 * that flag describes ordinary media playback and says nothing about WebRTC.
 *
 * Measured on an RTX 5060, 1440p screen capture, same build, same everything:
 *
 *   baseline (42001f)   videoencode  0.00%   videodecode 0.00%   3d 18.2%
 *   high     (640032)   videoencode 19.03%   videodecode 3.67%   3d 10.6%
 *
 * and only in the second case does getStats() name an implementation at all:
 * "MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)" /
 * "ExternalDecoder (D3D11VideoDecoder)".
 */
const H264_PROFILE_RANK = { 64: 0, '4d': 1, 42: 2 };

/**
 * Sort key for one H.264 codec entry: profile first, then packetization mode,
 * then level.
 *
 * Level is not decoration. Chromium lists High at level 3.1 (`64001f`) ahead of
 * High at level 5.0 (`640032`), and 3.1 tops out around 720p30 -- so taking the
 * first High on the list would cap a native-resolution stream. Packetization
 * mode 1 allows a frame to be split across packets, which anything above a
 * small picture needs.
 */
function h264Rank(codec) {
  const fmtp = codec.sdpFmtpLine ?? '';
  const match = /profile-level-id=([0-9a-fA-F]{6})/.exec(fmtp);
  return {
    profile: match ? H264_PROFILE_RANK[match[1].slice(0, 2).toLowerCase()] ?? 3 : 3,
    // Lower sorts first, so invert: mode 1 wanted before mode 0.
    packetization: /packetization-mode=1/.test(fmtp) ? 0 : 1,
    level: match ? parseInt(match[1].slice(4, 6), 16) : 0,
  };
}

function byH264Preference(a, b) {
  const ra = h264Rank(a);
  const rb = h264Rank(b);
  return ra.profile - rb.profile || ra.packetization - rb.packetization || rb.level - ra.level;
}

/**
 * Ask for a specific codec first. H.264 is the default because it is the one
 * codec with hardware encoders on essentially every Windows GPU -- the
 * broadcaster's machine does the encoding so the Raspberry Pi never has to.
 *
 * Within H.264, profiles are ordered High, Main, baseline. Ordered rather than
 * filtered on purpose: a machine with no hardware encoder falls back to
 * OpenH264, which only speaks constrained baseline, so baseline has to stay on
 * the list or such a machine could not publish at all.
 */
export function preferCodec(transceiver, codecName, { direction = 'send' } = {}) {
  const source = direction === 'receive' ? RTCRtpReceiver : RTCRtpSender;
  if (!codecName || typeof source.getCapabilities !== 'function') return;
  const caps = source.getCapabilities('video');
  if (!caps) return;

  const isWanted = (c) => c.mimeType.toLowerCase() === `video/${codecName.toLowerCase()}`;
  const wanted = caps.codecs.filter(isWanted).sort(byH264Preference);
  if (!wanted.length) return;

  const rest = caps.codecs.filter((c) => !isWanted(c));
  const ordered = [...wanted, ...rest];
  try {
    transceiver.setCodecPreferences(ordered);
  } catch {
    // Not fatal -- we just get the browser's default ordering.
    return null;
  }
  // Returned so a test can see the ordering that was applied; there is no
  // getter for codec preferences on the transceiver.
  return ordered;
}

export async function applySenderSettings(sender, { maxBitrate, maxFramerate, degradationPreference }) {
  const params = sender.getParameters();
  if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
  params.encodings[0].maxBitrate = maxBitrate;
  // No rate means no ceiling: a cap set earlier is lifted, not left behind.
  if (maxFramerate) params.encodings[0].maxFramerate = maxFramerate;
  else delete params.encodings[0].maxFramerate;

  // How the encoder should spend a bitrate budget it cannot meet:
  //   maintain-resolution -- keep every pixel, drop frames (sharp but choppy)
  //   maintain-framerate  -- keep it smooth, shrink the picture
  //   balanced            -- give up some of each
  // This single setting is the difference between 7 fps and 30 fps on a busy
  // 1080p screen, so it is a user-facing choice rather than a constant.
  params.degradationPreference = degradationPreference;
  await sender.setParameters(params);
}

/**
 * Say how much a sender matters to the network: 'high' for the voice, 'low'
 * for pictures.
 *
 * Voice and a camera are two connections that know nothing of each other, each
 * probing for the uplink on its own, so nothing here decides who waits when
 * they meet on one home line. `priority` is how the browser splits its own
 * budget; `networkPriority` marks the packets (DSCP) for the routers that
 * honour it. Many home routers do not, and then this changes nothing -- which
 * is why it is best-effort and never worth failing a call over.
 */
export async function setSenderPriority(sender, level) {
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].priority = level;
    params.encodings[0].networkPriority = level;
    await sender.setParameters(params);
  } catch {
    // An engine without these fields keeps its defaults.
  }
}

/**
 * Tune the sender's Opus encoder through the answer it is about to be given.
 *
 *   dtx    silence costs one small packet every few hundred milliseconds
 *          instead of fifty a second
 *   ptime  audio goes out in frames of this many milliseconds, so 40 is
 *          twenty-five packets a second where the default is fifty
 *
 * The sender's own settings come from what the OTHER side's description says
 * it wants to receive (RFC 7587: `usedtx` and `ptime` are a receiver's
 * requests), and the other side here is a relay that asks for neither, so the
 * answer is edited on its way in. Nothing is renegotiated and the relay does
 * not know the difference: it forwards RTP, and fewer packets is all it sees.
 *
 * Why it matters at all. What a relay costs is packets, not bits: every packet
 * it forwards is a system call for each person listening, and measured on a
 * ten-person server those calls were nearly half of all the CPU it used, with
 * the encryption a rounding error. A voice channel is mostly silence -- one
 * person talking and three of the four streams the sound of nothing, and a
 * muted person's too, since muting keeps the stream and silences the track --
 * and every audio stream is the same fifty packets a second whatever is in it.
 *
 * Done on the audio section only, only for the Opus line, and only where it is
 * not already stated.
 *
 * @param {string} sdp the relay's answer
 * @param {{dtx?: boolean, ptime?: number}} options
 * @returns {string}
 */
export function tuneOpusAnswer(sdp, { dtx = true, ptime = 0 } = {}) {
  const lines = sdp.split(/\r?\n/);
  let audioStart = -1;
  let audioEnd = lines.length;
  let opus = null;
  lines.forEach((line, i) => {
    if (line.startsWith('m=')) {
      if (audioStart >= 0 && audioEnd === lines.length) audioEnd = i;
      if (line.startsWith('m=audio') && audioStart < 0) audioStart = i;
    }
    if (audioStart >= 0 && i > audioStart && i < audioEnd) {
      const rtpmap = /^a=rtpmap:(\d+) opus\/48000/i.exec(line);
      if (rtpmap) opus = rtpmap[1];
    }
  });
  if (audioStart < 0 || !opus) return sdp;

  const section = lines.slice(audioStart, audioEnd);
  const fmtp = new RegExp(`^a=fmtp:${opus} (.*)$`);
  let found = false;
  const edited = section.map((line) => {
    const m = fmtp.exec(line);
    if (!m) return line;
    found = true;
    return !dtx || /(^|;)\s*usedtx=/.test(m[1]) ? line : `a=fmtp:${opus} ${m[1]};usedtx=1`;
  });
  if (!found && dtx) {
    const at = edited.findIndex((l) => new RegExp(`^a=rtpmap:${opus} `).test(l));
    edited.splice(at + 1, 0, `a=fmtp:${opus} usedtx=1`);
  }
  if (ptime > 0 && !edited.some((l) => l.startsWith('a=ptime:'))) {
    // Before any trailing blank line: attributes belong inside the section.
    let end = edited.length;
    while (end > 0 && edited[end - 1] === '') end -= 1;
    edited.splice(end, 0, `a=ptime:${ptime}`, `a=maxptime:${ptime}`);
  }
  return [...lines.slice(0, audioStart), ...edited, ...lines.slice(audioEnd)].join('\r\n');
}

/**
 * Whether a connection comes up within `ms`.
 *
 * Resolves false for a connection that fails or closes first, as well as for
 * one that is merely slow: either way it is not going to carry anything, and
 * waiting on it is how a call looked joined for the better part of a minute
 * while nobody could hear anybody.
 */
function waitConnected(pc, ms) {
  if (pc.connectionState === 'connected') return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok) => {
      clearTimeout(timer);
      pc.removeEventListener('connectionstatechange', onChange);
      resolve(ok);
    };
    const onChange = () => {
      if (pc.connectionState === 'connected') done(true);
      else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') done(false);
    };
    const timer = setTimeout(() => done(false), ms);
    pc.addEventListener('connectionstatechange', onChange);
  });
}

/** Failures that a second try can fix: a slow or lossy link, or a session the relay has not let go of yet. */
const retryable = (err) => err?.code === 'media_unreachable' || err?.code === 'media_error'
  || err?.code === 'not_connected' || !err?.code;

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Publish a MediaStream to a WHIP endpoint.
 *
 * With `connectTimeoutMs` it also waits for the connection to be UP, and tries
 * again (up to `attempts`, each on a fresh connection) if it is not. Without,
 * it returns as soon as the relay has answered -- which is when the connection
 * has only begun, and on a poor link may never complete.
 *
 * @returns {Promise<{pc: RTCPeerConnection, resourceUrl: string|null}>}
 */
export async function publish(options) {
  const { connectTimeoutMs = 0, attempts = 1 } = options;
  let failure;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // More patience each time: the first try is cut short so a lost handshake
      // costs seconds, and a link that is merely slow is given longer on the next.
      return await publishOnce(options, connectTimeoutMs * (1 + 0.5 * (attempt - 1)));
    } catch (err) {
      failure = err;
      if (attempt === attempts || !retryable(err)) break;
      // A beat before the next: a relay that is still holding the last session
      // lets go of it within seconds, and a link that is dropping packets is
      // not helped by being asked again in the same instant.
      await pause(1000 * attempt);
    }
  }
  throw failure;
}

async function publishOnce({
  url,
  stream,
  iceServers,
  audioTuning = null,
  codec = 'H264',
  maxBitrate,
  maxFramerate,
  contentHint = 'motion',
  degradationPreference = 'balanced',
  insertableStreams = false,
}, connectTimeoutMs) {
  let resourceUrl = null;
  const pc = new RTCPeerConnection({
    iceServers: relayServers(iceServers),
    bundlePolicy: 'max-bundle',
    // Only when a clip buffer is going to read the frames.
    //
    // This is NOT free to leave on: with the flag set and nothing reading the
    // encoded stream, Chromium keeps encoding but sends nothing at all
    // (measured: framesEncoded 178, bytesSent 0). The frames wait for a
    // transform that never arrives. Whoever sets this must attach.
    ...(insertableStreams ? { encodedInsertableStreams: true } : {}),
  });

  try {
    const videoTrack = stream.getVideoTracks()[0];
    const audioTrack = stream.getAudioTracks()[0];

    if (audioTrack) {
      pc.addTransceiver(audioTrack, { direction: 'sendonly', streams: [stream] });
    }

    if (videoTrack) {
      // 'detail' asks the encoder to preserve fine detail (text) at the cost of
      // framerate; 'motion' asks it to keep motion smooth. Wrong choice here is
      // very visible: 'detail' on a game looks like a slideshow.
      videoTrack.contentHint = contentHint;
      const tx = pc.addTransceiver(videoTrack, { direction: 'sendonly', streams: [stream] });
      preferCodec(tx, codec);
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);

    const reply = await harmony.api.sdp(url, pc.localDescription.sdp);
    resourceUrl = reply.resourceUrl;
    await pc.setRemoteDescription({ type: 'answer', sdp: audioTuning ? tuneOpusAnswer(reply.answer, audioTuning) : reply.answer });

    // Bitrate has to be set after the answer -- before it, the sender has no
    // negotiated encoding to configure.
    if (videoTrack) {
      const sender = pc.getSenders().find((s) => s.track === videoTrack);
      if (sender) {
        await applySenderSettings(sender, { maxBitrate, maxFramerate, degradationPreference });
        await setSenderPriority(sender, 'low');
      }
    }

    if (connectTimeoutMs && !(await waitConnected(pc, connectTimeoutMs))) {
      const error = new Error('The connection to the media server did not come up.');
      error.code = 'not_connected';
      throw error;
    }

    return { pc, resourceUrl };
  } catch (err) {
    pc.close();
    // The relay may already hold a session for the offer it answered. Let it
    // go now rather than leave it to time out: the next attempt publishes to
    // the same path, and a session still holding it is refused.
    if (resourceUrl) harmony.api.hangup(resourceUrl).catch(() => {});
    throw err;
  }
}

/**
 * Subscribe to a WHEP endpoint.
 * @returns {Promise<{pc: RTCPeerConnection, stream: MediaStream, resourceUrl: string|null}>}
 */
export async function watch({
  url,
  iceServers,
  insertableStreams = false,
  codec = 'H264',
  media = 'both',
}) {
  const pc = new RTCPeerConnection({
    iceServers: relayServers(iceServers),
    bundlePolicy: 'max-bundle',
    // Only when a clip buffer is going to read the frames.
    //
    // This is NOT free to leave on: with the flag set and nothing reading the
    // encoded stream, Chromium keeps encoding but sends nothing at all
    // (measured: framesEncoded 178, bytesSent 0). The frames wait for a
    // transform that never arrives. Whoever sets this must attach.
    ...(insertableStreams ? { encodedInsertableStreams: true } : {}),
  });
  const stream = new MediaStream();

  try {
    // Declared up front so the offer advertises both kinds even though the
    // publisher's tracks have not arrived yet.
    //
    // The receive side needs the same profile ordering as the send side: offer
    // baseline first and the hardware decoder is never chosen, which is what
    // made watching a stream cost as much as sending one.
    // media: 'audio' is for voice-channel paths, which carry Opus and nothing
    // else. Offering a video transceiver there still works -- MediaMTX simply
    // answers with nothing on it -- but it costs an m-line and a decoder slot
    // per subscription, and a 16-person channel opens fifteen of them.
    if (media !== 'audio') {
      const rx = pc.addTransceiver('video', { direction: 'recvonly' });
      preferCodec(rx, codec, { direction: 'receive' });
    }
    pc.addTransceiver('audio', { direction: 'recvonly' });

    pc.addEventListener('track', (event) => {
      stream.addTrack(event.track);
      /*
       * addTrack() from script does NOT raise `addtrack` -- the event is
       * only fired for tracks the user agent adds itself. Anything waiting
       * on it to notice late-arriving audio (gain.js did) would wait for
       * ever, which is how a subscription came up perfectly and carried no
       * sound. Raise it by hand so the stream behaves the way the rest of
       * the app reasonably assumes it does.
       */
      try {
        stream.dispatchEvent(new MediaStreamTrackEvent('addtrack', { track: event.track }));
      } catch {
        // Older engines without the constructor: the pollers cope.
      }
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);

    const { answer, resourceUrl } = await harmony.api.sdp(url, pc.localDescription.sdp);
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });

    return { pc, stream, resourceUrl };
  } catch (err) {
    pc.close();
    throw err;
  }
}

export async function hangup(pc, resourceUrl) {
  try {
    await harmony.api.hangup(resourceUrl);
  } catch {
    /* best effort */
  }
  pc?.close();
}

/** Poll getStats() for the handful of numbers worth putting on screen. */
export function createStatsReader(pc, direction /* 'outbound' | 'inbound' */) {
  let lastBytes = 0;
  let lastAt = 0;

  return async function read() {
    const reports = await pc.getStats();
    const out = {
      kbps: 0,
      width: 0,
      height: 0,
      fps: 0,
      codec: null,
      packetsLost: 0,
      rtt: null,
      // Sender-side only. `limitedBy` is the single most useful number when a
      // stream looks bad: WebRTC states outright whether the encoder is being
      // held back by the network ('bandwidth'), the machine ('cpu'), or neither.
      limitedBy: null,
      availableKbps: null,
      // Average milliseconds spent encoding one frame. A GPU encoder (NVENC,
      // AMD AMF, Intel QuickSync) sits around 1-3 ms a frame, while the
      // software fallback at 1080p runs an order of magnitude slower.
      encodeMs: null,
      /**
       * What is actually doing the work, straight from the horse's mouth --
       * e.g. "MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)"
       * or "ExternalDecoder (D3D11VideoDecoder)".
       *
       * Chromium only fills this in once a hardware path is running, so its
       * absence is itself the answer. That is worth far more than
       * `getGPUFeatureStatus()`, which reports on ordinary media playback and
       * will happily say `video_encode: enabled` while a WebRTC call runs
       * entirely on the CPU -- which is exactly what it used to do here.
       */
      implementation: null,
      powerEfficient: null,
    };
    let codecId = null;

    reports.forEach((r) => {
      const isTarget =
        (direction === 'outbound' && r.type === 'outbound-rtp' && r.kind === 'video') ||
        (direction === 'inbound' && r.type === 'inbound-rtp' && r.kind === 'video');

      if (isTarget) {
        const bytes = direction === 'outbound' ? r.bytesSent : r.bytesReceived;
        const now = r.timestamp;
        if (lastAt && now > lastAt) {
          out.kbps = Math.round(((bytes - lastBytes) * 8) / (now - lastAt));
        }
        lastBytes = bytes;
        lastAt = now;

        out.width = r.frameWidth ?? 0;
        out.height = r.frameHeight ?? 0;
        out.fps = Math.round(r.framesPerSecond ?? 0);
        out.packetsLost = r.packetsLost ?? 0;
        codecId = r.codecId;

        out.implementation =
          (direction === 'outbound' ? r.encoderImplementation : r.decoderImplementation) ?? null;
        out.powerEfficient =
          (direction === 'outbound' ? r.powerEfficientEncoder : r.powerEfficientDecoder) ?? null;

        if (direction === 'outbound') {
          if (r.qualityLimitationReason) out.limitedBy = r.qualityLimitationReason;
          if (r.totalEncodeTime && r.framesEncoded) {
            out.encodeMs = (r.totalEncodeTime / r.framesEncoded) * 1000;
          }
        }
      }

      if (r.type === 'candidate-pair' && r.state === 'succeeded') {
        if (r.currentRoundTripTime != null) out.rtt = Math.round(r.currentRoundTripTime * 1000);
        if (direction === 'outbound' && r.availableOutgoingBitrate != null) {
          out.availableKbps = Math.round(r.availableOutgoingBitrate / 1000);
        }
      }
    });

    if (codecId) {
      const codec = reports.get(codecId);
      if (codec?.mimeType) out.codec = codec.mimeType.replace('video/', '');
    }

    return out;
  };
}

/**
 * Everything about one connection that helps explain how a call sounds and
 * looks, in a flat shape for the debug log: the state of the connection, the
 * path it took (types and protocols only -- never an address), and for each
 * direction the counters that tell loss, delay and the machine's own effort
 * apart. Counters are running totals; the log turns them into changes.
 *
 * @param {RTCPeerConnection} pc
 * @returns {Promise<object>}
 */
export async function describePc(pc) {
  const out = {
    state: pc.connectionState,
    ice: pc.iceConnectionState,
    signaling: pc.signalingState,
  };
  let reports;
  try {
    reports = await pc.getStats();
  } catch {
    return out;
  }
  const rows = [];
  reports.forEach((r) => rows.push(r));
  const byId = new Map(rows.map((r) => [r.id, r]));

  const pick = (report, fields) => {
    const o = {};
    for (const field of fields) {
      const v = report[field];
      if (v === undefined) continue;
      if (field === 'qualityLimitationDurations' && v) {
        for (const [k, seconds] of Object.entries(v)) o[`limited_${k}_s`] = Number(seconds.toFixed(2));
      } else {
        o[field] = v;
      }
    }
    return o;
  };

  const kindOf = (r) => (r.kind ?? r.mediaType);
  const first = (type, kind) => rows.find((r) => r.type === type && kindOf(r) === kind);

  const transport = rows.find((r) => r.type === 'transport');
  const pair = (transport?.selectedCandidatePairId && byId.get(transport.selectedCandidatePairId))
    ?? rows.find((r) => r.type === 'candidate-pair' && (r.nominated || r.selected) && r.state === 'succeeded')
    ?? rows.find((r) => r.type === 'candidate-pair' && r.state === 'succeeded');
  if (pair) {
    const local = byId.get(pair.localCandidateId);
    const remote = byId.get(pair.remoteCandidateId);
    out.path = {
      local: `${local?.candidateType ?? '?'}/${local?.protocol ?? '?'}${local?.networkType ? `/${local.networkType}` : ''}`,
      remote: `${remote?.candidateType ?? '?'}/${remote?.protocol ?? '?'}`,
      rtt_ms: pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : null,
      availableOut_kbps: pair.availableOutgoingBitrate != null ? Math.round(pair.availableOutgoingBitrate / 1000) : null,
      availableIn_kbps: pair.availableIncomingBitrate != null ? Math.round(pair.availableIncomingBitrate / 1000) : null,
      requestsSent: pair.requestsSent,
      responsesReceived: pair.responsesReceived,
      consentRequestsSent: pair.consentRequestsSent,
    };
  }
  if (transport) out.dtls = transport.dtlsState;

  const sections = {
    outAudio: [first('outbound-rtp', 'audio'), ['packetsSent', 'bytesSent', 'targetBitrate', 'totalPacketSendDelay', 'nackCount', 'active']],
    outVideo: [first('outbound-rtp', 'video'), [
      'packetsSent', 'bytesSent', 'framesEncoded', 'framesSent', 'keyFramesEncoded', 'hugeFramesSent',
      'totalEncodeTime', 'totalPacketSendDelay', 'frameWidth', 'frameHeight', 'framesPerSecond', 'targetBitrate',
      'qualityLimitationReason', 'qualityLimitationDurations', 'nackCount', 'pliCount', 'firCount',
      'retransmittedPacketsSent', 'encoderImplementation', 'powerEfficientEncoder', 'scalabilityMode', 'active',
    ]],
    remoteOutAudio: [first('remote-inbound-rtp', 'audio'), ['packetsLost', 'jitter', 'roundTripTime', 'fractionLost']],
    remoteOutVideo: [first('remote-inbound-rtp', 'video'), ['packetsLost', 'jitter', 'roundTripTime', 'fractionLost']],
    srcAudio: [first('media-source', 'audio'), ['audioLevel', 'totalAudioEnergy', 'totalSamplesDuration', 'echoReturnLoss', 'echoReturnLossEnhancement']],
    srcVideo: [first('media-source', 'video'), ['width', 'height', 'framesPerSecond', 'frames']],
    inAudio: [first('inbound-rtp', 'audio'), [
      'packetsReceived', 'packetsLost', 'packetsDiscarded', 'bytesReceived', 'jitter',
      'jitterBufferDelay', 'jitterBufferEmittedCount', 'jitterBufferTargetDelay', 'jitterBufferMinimumDelay',
      'totalSamplesReceived', 'concealedSamples', 'silentConcealedSamples', 'concealmentEvents',
      'insertedSamplesForDeceleration', 'removedSamplesForAcceleration',
      'interruptionCount', 'totalInterruptionDuration', 'audioLevel', 'decoderImplementation',
    ]],
    inVideo: [first('inbound-rtp', 'video'), [
      'packetsReceived', 'packetsLost', 'jitter', 'framesReceived', 'framesDecoded', 'framesDropped',
      'freezeCount', 'totalFreezesDuration', 'pauseCount', 'totalDecodeTime', 'frameWidth', 'frameHeight',
      'framesPerSecond', 'nackCount', 'pliCount', 'decoderImplementation', 'powerEfficientDecoder',
    ]],
  };
  for (const [name, [report, fields]] of Object.entries(sections)) {
    if (report) out[name] = pick(report, fields);
  }
  const codec = (report) => byId.get(report?.codecId)?.mimeType;
  const profile = (report) => byId.get(report?.codecId)?.sdpFmtpLine;
  if (out.outVideo) {
    out.outVideo.codec = codec(first('outbound-rtp', 'video'));
    const fmtp = profile(first('outbound-rtp', 'video'));
    const id = /profile-level-id=([0-9a-fA-F]{6})/.exec(fmtp ?? '');
    if (id) out.outVideo.h264 = id[1];
  }
  if (out.outAudio) out.outAudio.codec = codec(first('outbound-rtp', 'audio'));
  return out;
}
