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
 * Ask for a specific codec first. H.264 is the default because it is the one
 * codec with hardware encoders on essentially every Windows GPU -- the
 * broadcaster's machine does the encoding so the Raspberry Pi never has to.
 */
function preferCodec(transceiver, codecName) {
  if (!codecName || typeof RTCRtpSender.getCapabilities !== 'function') return;
  const caps = RTCRtpSender.getCapabilities('video');
  if (!caps) return;

  const wanted = caps.codecs.filter((c) => c.mimeType.toLowerCase() === `video/${codecName.toLowerCase()}`);
  if (!wanted.length) return;

  const rest = caps.codecs.filter((c) => c.mimeType.toLowerCase() !== `video/${codecName.toLowerCase()}`);
  try {
    transceiver.setCodecPreferences([...wanted, ...rest]);
  } catch {
    // Not fatal -- we just get the browser's default ordering.
  }
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
export async function watch({ url, iceServers, insertableStreams = false }) {
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
    pc.addTransceiver('video', { direction: 'recvonly' });
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
      // Average milliseconds spent encoding one frame. Electron does not expose
      // `encoderImplementation`, so this stands in for it: a GPU encoder
      // (NVENC, AMD AMF, Intel QuickSync) sits around 1-3 ms a frame, while the
      // software fallback at 1080p runs an order of magnitude slower.
      encodeMs: null,
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
