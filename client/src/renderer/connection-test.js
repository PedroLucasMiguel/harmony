// Connection diagnostic.
//
// When somebody cannot stream, the useful question is *where* it breaks, and
// the three candidates look identical from the outside: the control server is
// unreachable, STUN is blocked, or media cannot get through. This walks the
// same path a real broadcast takes and reports which step failed.
//
// It publishes a tiny throwaway stream under a scratch username, because only
// a real WHIP session proves the media path.

import { harmony } from './bridge.js';
import { t } from './i18n.js';

const TEST_TIMEOUT_MS = 20_000;

/** A 2x2 canvas is a legal video source and costs nothing to encode. */
function tinyStream() {
  const canvas = Object.assign(document.createElement('canvas'), { width: 160, height: 90 });
  const ctx = canvas.getContext('2d');
  const timer = setInterval(() => {
    ctx.fillStyle = `hsl(${Date.now() / 20 % 360},60%,50%)`;
    ctx.fillRect(0, 0, 160, 90);
  }, 100);
  const stream = canvas.captureStream(10);
  return { stream, stop: () => clearInterval(timer) };
}

const describeCandidate = (c) =>
  `${c.candidateType}/${c.protocol}${c.address ? ` ${c.address}:${c.port}` : ''}`;

/**
 * @param {string} server
 * @param {(step: {name: string, ok: boolean|null, detail?: string}) => void} onStep
 * @returns {Promise<{ok: boolean, verdict: string}>}
 */
export async function runConnectionTest(server, onStep) {
  const username = `conntest${Math.floor(Math.random() * 1e6)}`;
  let pc = null;
  let resourceUrl = null;
  let token = null;
  let tiny = null;

  const step = (name, ok, detail) => onStep({ name, ok, detail });

  try {
    // --- 1. the control server -----------------------------------------------
    let health;
    try {
      health = await harmony.api.health(server);
    } catch (err) {
      step(t('diag.step_reach'), false, err.message);
      return {
        ok: false,
        verdict: t('diag.verdict_unreachable'),
      };
    }
    step(t('diag.step_reach'), true, t('diag.signaling_on', { address: health.signalingBase }));

    if (!health.ok) {
      step(t('diag.step_media'), false, `mediamtx: ${health.mediamtx}`);
      return { ok: false, verdict: t('diag.verdict_media_down') };
    }
    step(t('diag.step_media'), true);

    // --- 2. a session --------------------------------------------------------
    const session = await harmony.api.session(server, username);
    if (session.role !== 'broadcaster') {
      step(t('diag.step_reserve'), false, t('diag.got_role', { role: session.role }));
      return { ok: false, verdict: t('diag.verdict_reserve') };
    }
    token = session.token;
    step(t('diag.step_reserve'), true, username);

    // --- 3. gather candidates ------------------------------------------------
    tiny = tinyStream();
    pc = new RTCPeerConnection({ iceServers: session.iceServers, bundlePolicy: 'max-bundle' });
    pc.addTransceiver(tiny.stream.getVideoTracks()[0], { direction: 'sendonly' });

    const types = new Set();
    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate?.candidate) {
        const m = /typ (\w+)/.exec(e.candidate.candidate);
        if (m) types.add(m[1]);
      }
    });

    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const t = setTimeout(resolve, 6000);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(t);
          resolve();
        }
      });
    });

    // srflx means a STUN server answered, which also proves outbound UDP works.
    // A server that hands out no STUN -- the default since 3.0, because none is
    // needed -- has nothing to ask, so the step says so instead of failing.
    const hasSrflx = types.has('srflx');
    const stunOffered = (session.iceServers ?? []).some(
      (s) => [].concat(s?.urls ?? []).some((u) => /^stuns?:/i.test(String(u))),
    );
    step(
      t('diag.step_stun'),
      hasSrflx || !stunOffered,
      !stunOffered
        ? t('diag.stun_not_needed')
        : hasSrflx
          ? [...types].join(', ')
          : t('diag.stun_only', { types: [...types].join(', ') || t('diag.none') }),
    );

    // --- 4. the media path ---------------------------------------------------
    const exchange = await harmony.api.sdp(session.whipUrl, pc.localDescription.sdp);
    resourceUrl = exchange.resourceUrl;
    step(t('diag.step_exchange'), true);

    await pc.setRemoteDescription({ type: 'answer', sdp: exchange.answer });

    const connected = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), TEST_TIMEOUT_MS);
      const check = () => {
        if (pc.connectionState === 'connected') {
          clearTimeout(t);
          resolve(true);
        } else if (pc.connectionState === 'failed') {
          clearTimeout(t);
          resolve(false);
        }
      };
      pc.addEventListener('connectionstatechange', check);
      check();
    });

    if (!connected) {
      step(t('diag.step_send'), false, t('diag.no_path'));
      return {
        ok: false,
        verdict: hasSrflx
          ? t('diag.verdict_blocked_ports')
          : t('diag.verdict_udp_blocked'),
      };
    }

    // Which pair actually won tells us whether UDP or the TCP fallback is in use.
    await new Promise((r) => setTimeout(r, 1500));
    const stats = await pc.getStats();
    let local = null;
    let remote = null;
    let rtt = null;
    stats.forEach((r) => {
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
        local = stats.get(r.localCandidateId);
        remote = stats.get(r.remoteCandidateId);
        rtt = r.currentRoundTripTime;
      }
    });

    const via = local && remote ? `${describeCandidate(local)} → ${describeCandidate(remote)}` : t('diag.connected');
    step(t('diag.step_send'), true, `${via}${rtt != null ? `, ${Math.round(rtt * 1000)} ms` : ''}`);

    const overTcp = remote?.protocol === 'tcp' || local?.protocol === 'tcp';
    return {
      ok: true,
      verdict: overTcp
        ? t('diag.verdict_tcp')
        : t('diag.verdict_ok'),
    };
  } catch (err) {
    step(t('diag.step_test'), false, err.message);
    return { ok: false, verdict: t('diag.verdict_stopped', { message: err.message }) };
  } finally {
    tiny?.stop();
    tiny?.stream.getTracks().forEach((t) => t.stop());
    if (pc) {
      try {
        await harmony.api.hangup(resourceUrl);
      } catch {
        /* best effort */
      }
      pc.close();
    }
    if (token) await harmony.api.release(server, username, token).catch(() => {});
  }
}
