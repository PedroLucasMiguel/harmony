// WHIP (publish) and WHEP (watch).
//
// Both are the same three-line protocol: POST an SDP offer as text/sdp, get an
// SDP answer back plus a Location header naming the session, DELETE that
// Location to hang up. The HTTP itself happens in the main process; this module
// only drives the RTCPeerConnection.

import { harmony } from './bridge.js';

const ICE_GATHER_TIMEOUT_MS = 4000;

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
  if (maxFramerate) params.encodings[0].maxFramerate = maxFramerate;

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
 * Publish a MediaStream to a WHIP endpoint.
 * @returns {Promise<{pc: RTCPeerConnection, resourceUrl: string|null}>}
 */
export async function publish({
  url,
  stream,
  iceServers,
  codec = 'H264',
  maxBitrate,
  maxFramerate,
  contentHint = 'motion',
  degradationPreference = 'balanced',
  insertableStreams = false,
}) {
  const pc = new RTCPeerConnection({
    iceServers,
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

    const { answer, resourceUrl } = await harmony.api.sdp(url, pc.localDescription.sdp);
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });

    // Bitrate has to be set after the answer -- before it, the sender has no
    // negotiated encoding to configure.
    if (videoTrack) {
      const sender = pc.getSenders().find((s) => s.track === videoTrack);
      if (sender) await applySenderSettings(sender, { maxBitrate, maxFramerate, degradationPreference });
    }

    return { pc, resourceUrl };
  } catch (err) {
    pc.close();
    throw err;
  }
}

/**
 * Subscribe to a WHEP endpoint.
 * @returns {Promise<{pc: RTCPeerConnection, stream: MediaStream, resourceUrl: string|null}>}
 */
export async function watch({ url, iceServers, insertableStreams = false, codec = 'H264' }) {
  const pc = new RTCPeerConnection({
    iceServers,
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
    const rx = pc.addTransceiver('video', { direction: 'recvonly' });
    preferCodec(rx, codec, { direction: 'receive' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    pc.addEventListener('track', (event) => {
      stream.addTrack(event.track);
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
