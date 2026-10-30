// Voice channels: one microphone out, N-1 subscriptions in.
//
// The relay cannot mix. Discord sends each listener one pre-mixed stream;
// mixing is decode + sum + re-encode, which is exactly the transcoding Harmony
// refuses to do and a Pi 5 could not do anyway. So every member subscribes to
// every other member individually and the browser mixes locally. That is why
// the member cap is a real constraint rather than a conservative guess: the
// relay carries N*(N-1) streams.
//
// Phase 0 measured the client side of that at 7.3% of one core for sixteen
// concurrent subscriptions with zero loss, so the cap is about the relay's
// bandwidth, not this file.

import { harmony } from './bridge.js';
import { publish, watch, applySenderSettings, setSenderPriority, describePc } from './webrtc.js';
import { judgeVideo, VIDEO_MAX_REBUILDS } from './video-health.js';
import {
  createSink, createMeter, createMicChain, createMicValve, workerMicChain, canProcessInWorker, MAX_GAIN,
  audioContextStats,
} from './gain.js';

/**
 * Microphone constraints that do not depend on a setting.
 *
 * Echo cancellation and noise suppression are the two the person chooses
 * (see micConstraints), and both default to off: they are what makes a
 * headset sound muffled or clipped to anybody who does not need them, and
 * what somebody on speakers does. Automatic gain stays on, since the input
 * volume slider sits after it and a quiet microphone is the commoner fault.
 */
const MIC_CONSTRAINTS = {
  autoGainControl: true,
  channelCount: 1,
};

/** Opus for speech. 32 kbps is ~52 kbps on the wire once RTP is counted. */
const VOICE_BITRATE = 32_000;

/**
 * How much speech goes in each packet.
 *
 * 40 ms is twenty-five packets a second instead of fifty, which is the biggest
 * single thing that can be done about what a relay spends -- see
 * tuneOpusAnswer -- for twenty milliseconds more before a word leaves. That is
 * under what anybody can hear, against the delay and stutter of a relay that is
 * out of CPU, which they can. Opus's own error recovery rides along in each
 * packet, so a lost one costs forty milliseconds of the previous one's guess
 * rather than a hole.
 */
const VOICE_PTIME_MS = 40;

/** How long the microphone's connection has to come up, and how many tries it gets. */
const MIC_CONNECT_TIMEOUT_MS = 5000;
const MIC_CONNECT_ATTEMPTS = 3;

/**
 * What a camera may send while it is starting, and when it may send more.
 *
 * A camera that opens at its full rate starts with a keyframe and then climbs
 * as fast as the line lets it, on the same home uplink the voice is using;
 * the voice's packets wait behind that, arrive late and bunched, and sound
 * crackly for the first seconds -- or for as long as a weak line stays
 * saturated. Opening small and stepping up lets the line's bandwidth estimate
 * settle before the picture asks for its full share. Each step is a ceiling
 * for the encoder, not a target: a line that cannot carry it never gets there.
 */
const CAM_RAMP = [
  { bitrate: 250_000, after: 0 },
  { bitrate: 600_000, after: 2500 },
  { bitrate: Infinity, after: 5000 },
];

/**
 * How long a subscription may deliver nothing before it is presumed dead.
 *
 * A quiet person is NOT quiet on the wire: Opus keeps sending, and a muted
 * track in Chromium still produces silence packets, so a subscription that
 * has received no packet at all for this long is not listening to somebody
 * who is not talking -- it is broken.
 */
const STALL_MS = 8000;

/**
 * Stagger between opening subscriptions.
 *
 * The N-th person to join opens N-1 WHEP sessions at once, each with its own
 * ICE gather and DTLS handshake. Firing them simultaneously is the join storm
 * the costing called out as the third thing to break.
 */
const SUBSCRIBE_STAGGER_MS = 75;


/**
 * How long the microphone's connection may sit in 'disconnected' before it is
 * rebuilt. ICE passes through that state on a momentary blip and recovers on
 * its own; past this it is not coming back.
 */
const DISCONNECT_GRACE_MS = 8000;

export class VoiceSession {
  /** @type {{pc: RTCPeerConnection, resourceUrl: string|null}|null} */
  #mic = null;
  #micStream = null;
  /** @type {Map<number, {pc: RTCPeerConnection, sink: object, stream: MediaStream}>} */
  #subs = new Map();
  /** mid -> {packets, since}: how we notice a subscription has gone quiet. */
  #flow = new Map();
  #opening = new Set();

  /**
   * Incoming video, keyed `<mid>:<kind>` -- the channel mosaic.
   *
   * Separate from #subs rather than one map of everything, because the two are
   * driven by different parts of the roster and fail independently: losing a
   * camera must not take anybody's voice with it, and a member can publish a
   * camera and a screen at once.
   */
  /** @type {Map<string, {pc: RTCPeerConnection, stream: MediaStream, mid: number, kind: string}>} */
  #video = new Map();
  #openingVideo = new Set();

  /** @type {{pc: RTCPeerConnection, resourceUrl: string|null}|null} */
  /*
   * Tiles the user has closed, by key.
   *
   * syncVideo is driven by the roster, so without this a closed tile is
   * reopened by the very next roster push -- which is every time anybody
   * mutes. The key is remembered rather than the subscription kept, because
   * the whole point of closing one is to stop paying for its decoder and
   * its downstream bandwidth.
   */
  #closedVideo = new Set();
  #micChain = null;
  /**
   * The noise gate, when the microphone goes out as it is: it listens on a
   * clone of the track and switches the real one. See createMicValve.
   */
  #valve = null;
  #valveTrack = null;
  /** The valve could not run here, so the gate lives in the chain. */
  #valveFailed = false;
  /** The worker that applies volume and gate to the frames could not run here (or stopped). */
  #workerFailed = false;
  #cam = null;
  #camStream = null;
  /** True while a camera's publish is in flight, so a second start is refused. */
  #camOpening = false;
  #camRamp = [];

  /**
   * Microphone work, one piece at a time.
   *
   * Starting, switching device, changing processing, restarting after a fault
   * and stopping all touch the same capture, the same chain and the same
   * sender, and each of them waits on the network or on the browser for a
   * while. On a slow link that wait is seconds, which is long enough for
   * another of them to begin in the middle -- a device-change event, the health
   * check, a switch in Settings -- and two interleaved halves of different
   * operations leave a capture running that nothing owns, or a chain feeding a
   * track nothing sends. So they queue.
   */
  #micWork = Promise.resolve();

  #serial(work) {
    const run = this.#micWork.then(work, work);
    // The queue goes on whether or not this piece failed; the caller sees the
    // failure through `run`.
    this.#micWork = run.catch(() => {});
    return run;
  }

  /**
   * What happened to the microphone and the camera, and when: the last few
   * dozen events, in memory only. A fault that cannot be reproduced on demand
   * -- and these are the ones that only show on a slow link -- can then be read
   * off diagnostics() instead of guessed at.
   */
  #events = [];

  note(what) {
    this.#events.push({ at: Date.now(), what });
    if (this.#events.length > 60) this.#events.shift();
    this.onNote?.(what);
  }

  /** Told of every note as it is made; the debug log hangs off this. */
  onNote = null;

  channelId = null;
  mid = null;
  token = '';
  whepBase = '';
  iceServers = [];
  /** The WHIP URLs the server minted for this membership: voice, cam, screen. */
  publishUrls = { voice: '', cam: '', screen: '' };
  /**
   * The last roster the server sent.
   *
   * Kept so subscriptions can be retried without waiting for another push --
   * see the note on syncPeers about why that matters.
   */
  lastRoster = [];

  /** Local mute: the track stays published, the audio stops. */
  muted = false;
  /** Output mute, applied to every incoming sink. */
  deafened = false;

  /** Meters our own microphone, so the speaking ring works on ourselves too. */
  #micMeter = null;

  /**
   * Per-person volume and local mute, keyed by USER id, not by slot.
   *
   * A slot is reused: the lowest free number is handed to the next person who
   * joins, so turning Bob down and watching him leave would turn the next
   * arrival down instead. Keyed by user, a preference follows the person
   * across a reconnect and across channels, which is what anybody setting one
   * expects.
   *
   * @type {Map<number, {gain: number, muted: boolean}>}
   */
  #peerPrefs = new Map();

  /** mid -> userId, so a sink can be matched to a preference. */
  #owners = new Map();

  get micLive() {
    return Boolean(this.#mic);
  }

  get subscriberCount() {
    return this.#subs.size;
  }

  get subscribedMids() {
    return [...this.#subs.keys()];
  }

  configure({ channelId, mid, token, whepBase, iceServers, publish }) {
    this.channelId = channelId;
    this.mid = mid;
    this.token = token;
    this.whepBase = whepBase;
    if (publish) this.publishUrls = publish;
    if (iceServers) this.iceServers = iceServers;
  }

  /**
   * Re-key an existing membership after the server re-issues its tokens.
   *
   * The slot does not change, so nothing has to be torn down: only the URLs
   * handed to the NEXT subscription or publish need to be current. Sessions
   * already open keep running, because MediaMTX consults the auth hook at
   * setup and never again.
   */
  retoken({ token, publish }) {
    if (token) this.token = token;
    if (publish) this.publishUrls = publish;
  }

  // ------------------------------------------------------- per-person audio

  /** The volume somebody is played at, 0..MAX_GAIN. 1 is untouched. */
  peerGain(userId) {
    return this.#peerPrefs.get(userId)?.gain ?? 1;
  }

  peerMuted(userId) {
    return this.#peerPrefs.get(userId)?.muted ?? false;
  }

  #prefFor(userId) {
    let pref = this.#peerPrefs.get(userId);
    if (!pref) {
      pref = { gain: 1, muted: false };
      this.#peerPrefs.set(userId, pref);
    }
    return pref;
  }

  /** Apply one person's preference to whichever slot they currently hold. */
  #applyPref(userId) {
    const pref = this.#prefFor(userId);
    for (const [mid, owner] of this.#owners) {
      if (owner !== userId) continue;
      const sub = this.#subs.get(mid);
      if (sub) sub.sink.set(this.deafened || pref.muted ? 0 : pref.gain);
    }
  }

  setPeerGain(userId, gain) {
    const pref = this.#prefFor(userId);
    pref.gain = Math.max(0, Math.min(MAX_GAIN, Number(gain) || 0));
    // Turning somebody up from zero is unambiguous: you want to hear them.
    if (pref.gain > 0) pref.muted = false;
    this.#applyPref(userId);
    return pref.gain;
  }

  setPeerMuted(userId, muted) {
    const pref = this.#prefFor(userId);
    pref.muted = Boolean(muted);
    this.#applyPref(userId);
    return pref.muted;
  }

  /**
   * Who is talking right now, as a Set of slot numbers.
   *
   * Read rather than pushed: this changes several times a second, and an
   * event per change would be a storm. The UI polls it on a short timer and
   * toggles one attribute.
   */
  speakingMids() {
    const out = new Set();
    if (this.#micMeter && this.transmitting && this.#micMeter.speaking) out.add(this.mid);
    for (const [mid, sub] of this.#subs) {
      if (sub.sink.speaking) out.add(mid);
    }
    return out;
  }

  /**
   * What the microphone publish is actually putting on the wire.
   *
   * Separate from diagnostics() because getStats is async. It answers the
   * one question a local level meter cannot: the capture can be perfect and
   * the sender still be sending nothing, and from the UI those are the same
   * thing -- a person nobody can hear.
   */
  /**
   * Drop subscriptions that have stopped delivering, so they get rebuilt.
   *
   * This is the half that was missing, and it is the one that matters most.
   * syncPeers only ever OPENS subscriptions for members it has none for, so
   * a subscription that connected, carried audio and then died stayed in the
   * map for ever and was never retried. The peer connection does not go to
   * `failed` when this happens -- MediaMTX drops the reader while the ICE
   * transport sits there reading `connected` -- so nothing in the UI, the
   * roster or the connection state showed anything wrong. One person simply
   * became permanently inaudible.
   *
   * It is not rare either: it happens every time the other side's path is
   * rebuilt, which is every reconnect and every rejoin.
   *
   * Dropping the entry is the whole fix -- the next syncPeers tick sees a
   * publisher with no subscription and opens a fresh one.
   *
   * @returns {Promise<number[]>} the slots that were reaped
   */
  async reapStalled() {
    const now = Date.now();
    const dead = [];

    for (const [mid, sub] of this.#subs) {
      let packets = 0;
      try {
        const stats = await sub.pc.getStats();
        stats.forEach((r) => {
          if (r.type === 'inbound-rtp' && r.kind === 'audio') packets += r.packetsReceived || 0;
        });
      } catch {
        continue; // a connection being torn down; the next tick will see it
      }

      const seen = this.#flow.get(mid);
      if (!seen || packets > seen.packets) {
        this.#flow.set(mid, { packets, since: now });
        continue;
      }
      // Nothing new since `since`. Give it a window before calling it.
      if (now - seen.since >= STALL_MS) dead.push(mid);
    }

    for (const mid of dead) {
      await this.unsubscribe(mid);
      this.#flow.delete(mid);
    }
    return dead;
  }

  /**
   * What each voice subscription is actually receiving.
   *
   * The pair to publishStats. Between them they place a silent peer on one
   * side or the other of the relay, which is the only question worth asking
   * first when somebody cannot be heard.
   */
  async subscribeStats() {
    const out = [];
    for (const [mid, sub] of this.#subs) {
      const row = {
        mid,
        pc: sub.pc.connectionState,
        routed: sub.sink.connected,
        level: Number(sub.sink.level.toFixed(4)),
        tracks: sub.stream.getAudioTracks().length,
        trackMuted: sub.stream.getAudioTracks()[0]?.muted ?? null,
        trackState: sub.stream.getAudioTracks()[0]?.readyState ?? null,
        bytesReceived: 0,
        packetsReceived: 0,
      };
      const stats = await sub.pc.getStats();
      stats.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') {
          row.bytesReceived += r.bytesReceived || 0;
          row.packetsReceived += r.packetsReceived || 0;
        }
      });
      out.push(row);
    }
    return out;
  }

  /**
   * What the audio is going through, in the numbers that tell crackle apart.
   *
   *   receiving   per person: `lost` packets and `jitterMs` say the network;
   *               `concealedPct` and `stretchedMs`/`squeezedMs` say what the
   *               player did about it (made up, slowed down, sped up), which is
   *               the sound of it; `bufferMs` is how far behind it is playing
   *   sending     our own voice as the relay reports receiving it: loss and
   *               jitter on the way up, and the round trip
   *   camera      what is holding the picture back -- `limit` is 'cpu' when the
   *               machine cannot encode it, 'bandwidth' when the line cannot
   *               carry it
   *
   * Counters are totals since each connection opened; read it twice and subtract
   * to see a stretch of time.
   */
  async audioQuality() {
    const ms = (seconds) => (seconds == null ? null : Math.round(seconds * 1000));
    const read = async (pc) => {
      const rows = [];
      (await pc.getStats()).forEach((r) => rows.push(r));
      return rows;
    };

    const receiving = [];
    for (const [mid, sub] of this.#subs) {
      const r = (await read(sub.pc)).find((x) => x.type === 'inbound-rtp' && x.kind === 'audio');
      if (!r) { receiving.push({ mid, pc: sub.pc.connectionState }); continue; }
      const samples = r.totalSamplesReceived || 0;
      receiving.push({
        mid,
        pc: sub.pc.connectionState,
        packets: r.packetsReceived,
        lost: r.packetsLost,
        jitterMs: ms(r.jitter),
        bufferMs: r.jitterBufferEmittedCount ? ms(r.jitterBufferDelay / r.jitterBufferEmittedCount) : null,
        concealedPct: samples ? Number(((100 * (r.concealedSamples || 0)) / samples).toFixed(2)) : null,
        concealmentEvents: r.concealmentEvents ?? null,
        stretchedMs: r.insertedSamplesForDeceleration != null ? Math.round(r.insertedSamplesForDeceleration / 48) : null,
        squeezedMs: r.removedSamplesForAcceleration != null ? Math.round(r.removedSamplesForAcceleration / 48) : null,
      });
    }

    let sending = null;
    if (this.#mic) {
      const rows = await read(this.#mic.pc);
      const out = rows.find((x) => x.type === 'outbound-rtp' && x.kind === 'audio');
      const back = rows.find((x) => x.type === 'remote-inbound-rtp' && x.kind === 'audio');
      sending = {
        pc: this.#mic.pc.connectionState,
        packets: out?.packetsSent ?? null,
        lost: back?.packetsLost ?? null,
        jitterMs: ms(back?.jitter),
        rttMs: ms(back?.roundTripTime),
      };
    }

    let camera = null;
    if (this.#cam) {
      const rows = await read(this.#cam.pc);
      const out = rows.find((x) => x.type === 'outbound-rtp' && x.kind === 'video');
      const back = rows.find((x) => x.type === 'remote-inbound-rtp' && x.kind === 'video');
      camera = {
        pc: this.#cam.pc.connectionState,
        size: out ? `${out.frameWidth}x${out.frameHeight}` : null,
        fps: out?.framesPerSecond ?? null,
        limit: out?.qualityLimitationReason ?? null,
        lost: back?.packetsLost ?? null,
        rttMs: ms(back?.roundTripTime),
      };
    }
    return { receiving, sending, camera };
  }

  /**
   * Everything that bears on how the call sounds and looks, for the debug log:
   * each connection we hold (the microphone, the camera, every voice and video
   * we are receiving) described by describePc, the capture devices as they
   * were actually opened, and what the two audio contexts are doing.
   */
  async debugSnapshot() {
    const trackOf = (stream, kind) => {
      const track = kind === 'audio' ? stream?.getAudioTracks()[0] : stream?.getVideoTracks()[0];
      if (!track) return null;
      const s = track.getSettings?.() ?? {};
      return {
        label: track.label, state: track.readyState, muted: track.muted, enabled: track.enabled,
        ...(s.width ? { size: `${s.width}x${s.height}` } : {}),
        ...(s.frameRate ? { fps: s.frameRate } : {}),
        ...(s.sampleRate ? { sampleRate: s.sampleRate } : {}),
        ...(s.channelCount ? { channels: s.channelCount } : {}),
        ...(s.latency != null ? { latency_ms: Number((s.latency * 1000).toFixed(1)) } : {}),
        ...(s.echoCancellation !== undefined ? { echoCancellation: s.echoCancellation } : {}),
        ...(s.noiseSuppression !== undefined ? { noiseSuppression: s.noiseSuppression } : {}),
        ...(s.autoGainControl !== undefined ? { autoGainControl: s.autoGainControl } : {}),
      };
    };
    const subs = await Promise.all([...this.#subs.entries()].map(async ([mid, sub]) => ({
      mid,
      routed: sub.sink.connected,
      speaking: sub.sink.speaking,
      level: Number(sub.sink.level.toFixed(4)),
      ...await describePc(sub.pc),
    })));
    const video = await Promise.all([...this.#video.entries()].map(async ([key, sub]) => ({
      key,
      ...await describePc(sub.pc),
    })));
    return {
      room: {
        channel: this.channelId, mid: this.mid, muted: this.muted, deafened: this.deafened,
        transmitting: this.transmitting, camerasPaused: this.#camerasPaused,
        micGate: this.#micGateKind,
        micLevel: Number((this.#micMeter?.read().level ?? 0).toFixed(4)),
        gate: this.#micChain || this.#valve ? (this.micOpen ? 'open' : 'closed') : 'none',
      },
      micTrack: trackOf(this.#micStream, 'audio'),
      camTrack: trackOf(this.#camStream, 'video'),
      mic: this.#mic ? await describePc(this.#mic.pc) : null,
      cam: this.#cam ? await describePc(this.#cam.pc) : null,
      subs,
      video,
      audioContexts: audioContextStats(),
    };
  }

  /**
   * Round trip to the relay, in milliseconds.
   *
   * A real measurement over the live media path -- STUN consent checks on
   * the connection actually carrying the audio -- rather than an HTTP ping
   * to the control server, which would travel a different route to a
   * different process and describe neither.
   *
   * Three ways of finding the pair, in order, because the first one is the
   * only CORRECT one and the only one that is not always there:
   *
   *   1. transport.selectedCandidatePairId. Authoritative, but Chromium
   *      does not always expose a transport stat for a WHIP connection
   *      with no DTLS role change, and it is absent entirely while ICE is
   *      still checking.
   *   2. a nominated pair in state 'succeeded'. Chromium spells it
   *      `nominated`, Firefox `selected`, and a sendonly connection to a
   *      relay sometimes reports NEITHER flag while still being connected
   *      on exactly one pair -- which is what made the first attempt here
   *      show "Measuring..." forever.
   *   3. any succeeded pair that has a round trip at all. With one pair,
   *      which is the normal case for a host-to-host LAN connection, this
   *      is the same pair the other two would have chosen.
   *
   * And where the pair has no currentRoundTripTime yet -- it only appears
   * once a STUN response has come back -- the running average from
   * totalRoundTripTime is used instead, which is a slightly staler number
   * and much better than none.
   *
   * @returns {Promise<number|null>} null only when there is genuinely
   *   nothing to measure: no microphone, or no response yet.
   */
  async rtt() {
    const pc = this.#mic?.pc ?? [...this.#subs.values()][0]?.pc ?? null;
    if (!pc) return null;

    let stats;
    try {
      stats = await pc.getStats();
    } catch {
      return null;
    }

    const pairs = new Map();
    let selectedId = null;
    stats.forEach((r) => {
      if (r.type === 'candidate-pair') pairs.set(r.id, r);
      // Both spellings: the stat moved between spec revisions and
      // Chromium still reports the old one on some connections.
      if (r.type === 'transport' && (r.selectedCandidatePairId || r.selectedCandidatePair)) {
        selectedId = r.selectedCandidatePairId ?? r.selectedCandidatePair;
      }
    });
    if (pairs.size === 0) return null;

    const succeeded = [...pairs.values()].filter((r) => r.state === 'succeeded');
    const pair = pairs.get(selectedId)
      ?? succeeded.find((r) => r.nominated === true || r.selected === true)
      ?? succeeded.find((r) => typeof r.currentRoundTripTime === 'number')
      ?? succeeded[0]
      ?? null;
    if (!pair) return null;

    if (typeof pair.currentRoundTripTime === 'number') {
      return Math.round(pair.currentRoundTripTime * 1000);
    }
    if (pair.responsesReceived > 0 && typeof pair.totalRoundTripTime === 'number') {
      return Math.round((pair.totalRoundTripTime / pair.responsesReceived) * 1000);
    }
    return null;
  }

  async publishStats() {
    if (!this.#mic) return null;
    const sender = this.#mic.pc.getSenders().find((x) => x.track?.kind === 'audio');
    if (!sender) return { sender: null };
    const out = {
      sender: 'present',
      trackId: sender.track?.id ?? null,
      trackEnabled: sender.track?.enabled ?? null,
      trackMuted: sender.track?.muted ?? null,
      trackState: sender.track?.readyState ?? null,
      pc: this.#mic.pc.connectionState,
      bytesSent: 0,
      packetsSent: 0,
    };
    const stats = await sender.getStats();
    stats.forEach((r) => {
      if (r.type === 'outbound-rtp' && r.kind === 'audio') {
        out.bytesSent += r.bytesSent || 0;
        out.packetsSent += r.packetsSent || 0;
      }
    });
    return out;
  }

  /**
   * What this session currently believes about itself.
   *
   * Exists because the failure that matters here -- somebody inaudible --
   * looks exactly like silence from the outside. Whether a subscription was
   * opened at all, and whether its audio was ever routed, are the two facts
   * that tell those apart, and neither is visible in the UI.
   */
  diagnostics() {
    return {
      mid: this.mid,
      channelId: this.channelId,
      muted: this.muted,
      deafened: this.deafened,
      micLive: this.micLive,
      // Where volume and gate run: 'worker' on the frames of the track, 'worklet' on an audio thread,
      // 'polled' a timer, 'valve' a switch on the track.
      micGate: this.#micGateKind,
      camerasPaused: this.#camerasPaused,
      events: this.#events.map((e) => ({ ago: Date.now() - e.at, what: e.what })),
      // What our own microphone is producing. A live, unmuted microphone
      // reading zero is a dead input -- which is indistinguishable from a
      // broken publish from anywhere else in the system.
      micLevel: Number((this.#micMeter?.read().level ?? 0).toFixed(4)),
      micDeviceId: this.micDeviceId,
      wanted: (this.lastRoster ?? [])
        .filter((m) => m.mid !== this.mid && m.publishing?.includes('v'))
        .map((m) => m.mid),
      subs: [...this.#subs.entries()].map(([mid, sub]) => ({
        mid,
        connected: sub.sink.connected,
        speaking: sub.sink.speaking,
        level: Number(sub.sink.level.toFixed(4)),
        pc: sub.pc.connectionState,
        tracks: sub.stream.getAudioTracks().length,
      })),
      roster: (this.lastRoster ?? []).map((m) => ({
        mid: m.mid, nickname: m.nickname, publishing: m.publishing, muted: m.muted,
      })),
    };
  }

  /**
   * The WHEP URL for one of another member's paths in this channel.
   *
   * `kind` is the single letter MediaMTX sees in the path: v voice, c camera,
   * s screen. One read token covers all three -- the auth hook only compares
   * the channel for a read, so any member may watch any other member.
   */
  peerUrl(mid, kind = 'v') {
    const path = `vc-${this.channelId.toString(36)}-${mid.toString(36)}-${kind}`;
    return `${this.whepBase}/${path}/whep?token=${encodeURIComponent(this.token)}`;
  }

  // -------------------------------------------------------------- outgoing

  /** Echo cancellation and noise suppression, both off until asked for. */
  micEchoCancellation = false;
  micNoiseSuppression = false;

  #micConstraints(deviceId) {
    return {
      ...MIC_CONSTRAINTS,
      echoCancellation: this.micEchoCancellation,
      noiseSuppression: this.micNoiseSuppression,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    };
  }

  /**
   * Choose the browser's processing for the microphone, and apply it to the
   * one that is live: the constraints only take effect on a new capture, so
   * a running microphone is swapped for one opened with them, through the
   * same replaceTrack as a device change -- after the old capture has let go
   * of the device, or Chromium would give the new one the old processing.
   *
   * @returns {Promise<boolean>} false if the live microphone could not be
   *   reopened, in which case the old one is still published.
   */
  async setMicProcessing({ echoCancellation, noiseSuppression }) {
    const same = Boolean(echoCancellation) === this.micEchoCancellation
      && Boolean(noiseSuppression) === this.micNoiseSuppression;
    this.micEchoCancellation = Boolean(echoCancellation);
    this.micNoiseSuppression = Boolean(noiseSuppression);
    if (same) return true;
    // Queued: the device is read when its turn comes, not now.
    return this.#serial(() => (this.#mic
      ? this.#switchMic(this.micDeviceId, { releaseFirst: true })
      : true));
  }

  startMic(publishUrl, deviceId) {
    return this.#serial(() => this.#startMic(publishUrl, deviceId));
  }

  async #startMic(publishUrl, deviceId) {
    if (this.#mic) return;
    this.note('mic: starting');
    this.#micStream = await navigator.mediaDevices.getUserMedia({
      audio: this.#micConstraints(deviceId),
    });
    // Apply the current mute state immediately: joining already muted must not
    // broadcast a second of room noise before the toggle is read. With push to
    // talk on the same goes for a key that is not held.
    for (const track of this.#micStream.getAudioTracks()) track.enabled = this.transmitting;

    const processed = await this.#processed(this.#micStream);
    this.#mic = await publish({
      url: publishUrl,
      stream: processed,
      iceServers: this.iceServers,
      // Fewer, bigger packets, and none for silence: see tuneOpusAnswer.
      audioTuning: { dtx: true, ptime: VOICE_PTIME_MS },
      // Joined means CONNECTED. On a poor link the first connection can stall
      // (lost checks, a lost handshake) and Chromium gives up on it only
      // after fifteen seconds or much more -- a call that looks joined while
      // nobody can hear you, until you leave and join again. Five seconds
      // is several round trips of margin even on a slow link, a good one
      // connects in well under one, and each further try gets half as long
      // again.
      connectTimeoutMs: MIC_CONNECT_TIMEOUT_MS,
      attempts: MIC_CONNECT_ATTEMPTS,
    });

    // Either of these is a microphone nobody can hear any more, and nothing
    // else would notice: the caller is told at once, and micHealth() says
    // what happened. See the watchdog in app.js.
    const mic = this.#mic;
    mic.pc.addEventListener('connectionstatechange', () => {
      if (this.#mic === mic) this.onMicTrouble?.();
    });
    for (const track of this.#micStream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        if (this.#mic === mic) this.onMicTrouble?.();
      });
    }

    // Metered, not played: see createMeter.
    this.#micMeter = createMeter(this.#micStream);

    const sender = this.#mic.pc.getSenders().find((s) => s.track?.kind === 'audio');
    if (sender) {
      const params = sender.getParameters();
      params.encodings = params.encodings?.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = VOICE_BITRATE;
      await sender.setParameters(params).catch(() => { /* not fatal */ });
      await setSenderPriority(sender, 'high');
    }
  }

  /**
   * The stream that is actually published: the capture, then volume and gate.
   *
   * Falls back to the raw capture when Web Audio will not take the stream.
   * Losing the input volume is a shame; losing the microphone entirely over
   * it would not be, and this is the path that took three releases to make
   * audible in the first place.
   *
   * Mute still acts on the SOURCE track rather than on the chain's output,
   * deliberately: `enabled = false` collapses the bitrate on the wire,
   * while a gain of zero would go on encoding silence at full price.
   */
  async #processed(stream) {
    this.#micChain?.close();
    this.#micChain = null;
    this.#closeValve();
    if (this.#wantsWorker()) {
      try {
        this.#micChain = await workerMicChain(stream, {
          gain: this.micGain,
          threshold: this.micThreshold,
          onBroken: () => this.#workerStopped(),
        });
        return new MediaStream([this.#micChain.track]);
      } catch (err) {
        this.#workerFailed = true;
        this.note(`mic: volume and gate could not run in a worker (${err?.message ?? err})`);
      }
    }
    // Volume at 100% is no volume at all, and then the gate needs nothing in
    // the path: the microphone goes out untouched and the gate switches it.
    if (!this.#wantsChain()) {
      if (await this.#openValve(stream)) return stream;
    }
    this.#micChain = await createMicChain(stream, {
      gain: this.micGain,
      threshold: this.micThreshold,
    });
    const track = this.#micChain?.track;
    if (!track) {
      this.#micChain = null;
      return stream;
    }
    return new MediaStream([track]);
  }

  /**
   * Whether volume and gate are applied to the frames of the track in a worker:
   * the way that neither depends on an audio thread being on time (the chain,
   * where a busy machine leaves gaps) nor cuts the sound where it stands (the
   * valve, where every opening and closing of the gate is a click).
   */
  #wantsWorker() {
    return !this.#workerFailed && canProcessInWorker() && (this.micGain !== 1 || this.micThreshold > 0);
  }

  /** The worker died in the middle of a call: the sound is put back through what the engine can do. */
  #workerStopped() {
    this.#workerFailed = true;
    this.note('mic: the volume and gate worker stopped; rewiring');
    this.#micChain = null;
    void this.#serial(() => this.#rewireMic({ force: true }));
  }

  /**
   * Whether what is sent has to pass through Web Audio: only an input volume
   * other than 100% needs it, or a gate that could not be run on the side --
   * and neither once the worker can do it.
   * Everything that goes through that chain goes through an audio thread, and
   * on a machine that is busy a thread like that leaves gaps in the sound.
   */
  #wantsChain() {
    return this.micGain !== 1 || (this.micThreshold > 0 && this.#valveFailed);
  }

  /** @returns {Promise<boolean>} false if the gate was wanted and could not be run */
  async #openValve(stream) {
    if (this.micThreshold <= 0) return true;
    const track = stream.getAudioTracks()[0];
    if (!track) return true;
    const tap = track.clone();
    // Muting and push to talk are on the real track; this one must go on hearing.
    tap.enabled = true;
    try {
      this.#valve = await createMicValve(new MediaStream([tap]), {
        threshold: this.micThreshold,
        onChange: () => this.#applyTransmit(),
      });
    } catch (err) {
      tap.stop();
      this.#valveFailed = true;
      this.note(`mic: the gate could not run beside the microphone (${err?.message ?? err})`);
      return false;
    }
    this.#valveTrack = tap;
    this.#applyTransmit(stream);
    return true;
  }

  #closeValve() {
    this.#valve?.close();
    this.#valve = null;
    this.#valveTrack?.stop();
    this.#valveTrack = null;
    this.#applyTransmit();
  }

  get #micGateKind() {
    return this.#micChain?.kind ?? (this.#valve ? 'valve' : null);
  }

  /** Whether volume and gate are wired the way the settings now ask. */
  #micWiringStale() {
    if (!this.#mic) return false;
    if (this.#wantsWorker()) return this.#micChain?.kind !== 'worker';
    if (this.#micChain?.kind === 'worker') return true;
    const chain = this.#wantsChain();
    if (chain !== Boolean(this.#micChain)) return true;
    return !chain && (this.micThreshold > 0) !== Boolean(this.#valve);
  }

  /**
   * Rewire to match the settings: volume crossing 100%, or the gate coming on or
   * off, changes what sits between the microphone and the publish. The old
   * track is replaced while it is still the one being sent, as for a device change.
   */
  async #rewireMic({ force = false } = {}) {
    if (!(force || this.#micWiringStale()) || !this.#micStream) return;
    const sender = this.#mic.pc.getSenders().find((s) => s.track?.kind === 'audio');
    if (!sender) return;
    const processed = await this.#processed(this.#micStream);
    const track = processed.getAudioTracks()[0];
    if (track && sender.track !== track) await sender.replaceTrack(track);
    this.#applyTransmit();
  }

  /** Input volume, 0..MAX_GAIN. Kept on the session, so it survives a
   *  device switch and a rejoin. */
  micGain = 1;

  /** Noise gate, as an RMS level between 0 and 1. 0 is off. */
  micThreshold = 0;

  setMicGain(value) {
    this.micGain = Math.max(0, Math.min(MAX_GAIN, Number(value) || 0));
    this.#micChain?.setGain(this.micGain);
    if (this.#micWiringStale()) void this.#serial(() => this.#rewireMic());
    return this.micGain;
  }

  setMicThreshold(value) {
    this.micThreshold = Math.max(0, Number(value) || 0);
    this.#micChain?.setThreshold(this.micThreshold);
    if (this.#valve && this.micThreshold > 0) this.#valve.setThreshold(this.micThreshold);
    else if (this.#micWiringStale()) void this.#serial(() => this.#rewireMic());
    return this.micThreshold;
  }

  /**
   * What the microphone is hearing right now, 0..1.
   *
   * Read BEFORE the gate, which is the only useful place to read it from:
   * a meter showing the gate's output reads zero whenever the gate is shut,
   * so it could never show you that the gate is shut too often.
   */
  get micLevel() {
    // The valve listens to a clone that never goes quiet; what is shown is what
    // is being sent, so nothing while muted, as with the meter on the track.
    if (this.#valve) return this.transmitting ? this.#valve.level : 0;
    return this.#micChain?.level ?? this.#micMeter?.read().level ?? 0;
  }

  /** Whether the gate is currently letting sound through. */
  get micOpen() {
    return (this.#micChain ?? this.#valve)?.open ?? true;
  }

  /**
   * Switch microphone mid-call.
   *
   * replaceTrack on the existing sender, NOT a new publish: the WHIP session
   * stays up, so nobody else has to tear down and rebuild their subscription
   * and there is no gap in the path. Swapping a track of the same kind needs
   * no renegotiation, which is the one thing MediaMTX's WHIP cannot do.
   *
   * `releaseFirst` is for reopening the SAME device with different echo
   * cancellation or noise suppression. Chromium hands a second capture of a
   * device that is already open the first one's processing and ignores what
   * the second asked for -- checked against its own getSettings(), which says
   * echoCancellation: false for a capture that asked for true -- so the new
   * choice only takes effect once the old capture has let go of the device.
   * The cost is a gap of a few tens of milliseconds in the microphone
   * instead of none, which is the price of the switch doing anything.
   *
   * @returns {Promise<boolean>} false if the device could not be opened. By
   *   default the old microphone is then still running and still published;
   *   with `releaseFirst` it has already been let go, and the health check
   *   sees it as lost and restarts it.
   */
  switchMic(deviceId, options) {
    return this.#serial(() => this.#switchMic(deviceId, options));
  }

  async #switchMic(deviceId, { releaseFirst = false } = {}) {
    if (!this.#mic) return false;
    this.note(`mic: switching${releaseFirst ? ' (processing)' : ''}`);

    const sender = this.#mic.pc.getSenders().find((s) => s.track?.kind === 'audio');
    if (!sender) return false;

    if (releaseFirst) this.#micStream?.getTracks().forEach((t) => t.stop());

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: this.#micConstraints(deviceId),
      });
    } catch {
      // Unplugged between listing it and asking for it, or in use elsewhere.
      return false;
    }

    const track = stream.getAudioTracks()[0];
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    // Carry the mute across, or switching device would quietly unmute you.
    track.enabled = this.transmitting;

    // Through the chain again, or changing headset silently drops the input
    // volume and the gate -- which reads as "picking my headset breaks my
    // microphone settings" and is impossible to guess the cause of.
    const processed = await this.#processed(stream);
    await sender.replaceTrack(processed.getAudioTracks()[0] ?? track);

    this.#micStream?.getTracks().forEach((t) => t.stop());
    this.#micStream = stream;
    this.#applyTransmit();

    this.#micMeter?.close();
    this.#micMeter = createMeter(stream);
    return true;
  }

  /** Called when the microphone's connection or device changes state. */
  onMicTrouble = null;

  /** When the publish connection went 'disconnected', or null. */
  #micDisconnectedSince = null;

  /**
   * Whether anybody can still hear this microphone.
   *
   * 'ok', 'none' (no microphone published), 'device-lost' (the capture
   * track ended -- a headset unplugged, asleep, or switching mode) or
   * 'connection-lost' (the publish to the media server failed or closed).
   *
   * 'disconnected' is not lost on its own: ICE goes through it on a brief
   * blip and comes back by itself. Only after DISCONNECT_GRACE_MS of it is
   * it treated as gone.
   */
  micHealth() {
    if (!this.#mic) return 'none';
    const track = this.#micStream?.getAudioTracks()[0];
    if (!track || track.readyState === 'ended') return 'device-lost';
    const state = this.#mic.pc.connectionState;
    if (state === 'failed' || state === 'closed') return 'connection-lost';
    if (state === 'disconnected') {
      this.#micDisconnectedSince ??= Date.now();
      if (Date.now() - this.#micDisconnectedSince > DISCONNECT_GRACE_MS) return 'connection-lost';
    } else {
      this.#micDisconnectedSince = null;
    }
    return 'ok';
  }

  /**
   * Publish the microphone again from scratch: a new capture and a new WHIP
   * session, on whatever publish URL the session holds now -- so the caller
   * should refresh the tokens first. Mute, input volume and the gate carry
   * over, because they live on the session rather than on the publish.
   */
  restartMic(deviceId) {
    return this.#serial(async () => {
      const url = this.publishUrls?.voice;
      if (!url) throw new Error('no publish URL for the microphone');
      this.note('mic: restarting');
      await this.#stopMic();
      this.#micDisconnectedSince = null;
      await this.#startMic(url, deviceId);
    });
  }

  /** The device the microphone is actually on, as the browser reports it. */
  get micDeviceId() {
    return this.#micStream?.getAudioTracks()[0]?.getSettings?.().deviceId ?? '';
  }

  stopMic() {
    return this.#serial(() => this.#stopMic());
  }

  async #stopMic() {
    this.note('mic: stopping');
    const mic = this.#mic;
    this.#mic = null;
    this.#micMeter?.close();
    this.#micMeter = null;
    this.#closeValve();
    this.#micStream?.getTracks().forEach((t) => t.stop());
    this.#micStream = null;
    if (!mic) return;
    mic.pc.close();
    if (mic.resourceUrl) await harmony.api.hangup(mic.resourceUrl).catch(() => {});
  }

  /**
   * Mute by disabling the track, never by stopping the publish.
   *
   * Stopping it would destroy the MediaMTX path and force every other member
   * to tear down and rebuild their subscription -- 2(N-1) sessions churned on
   * every push-to-talk. A disabled track collapses to comfort noise instead,
   * and unmuting is instant.
   */
  setMuted(muted) {
    this.muted = Boolean(muted);
    this.#applyTransmit();
    return this.muted;
  }

  /**
   * Push to talk: the microphone is silent unless the key is held.
   *
   * Done on the track, exactly like mute, and NOT by touching `muted`: the
   * mute button, its sound, the muted marker everybody sees and the server's
   * idea of who is muted are all about a decision somebody made, and a key
   * going down and up forty times a minute is not one. Mute still wins -- a
   * muted person holding the key is heard by nobody.
   */
  pushToTalk = false;
  pttHeld = false;

  /** Whether the microphone is open to the channel right now. */
  get transmitting() {
    return !this.muted && (!this.pushToTalk || this.pttHeld);
  }

  setPushToTalk(on) {
    this.pushToTalk = Boolean(on);
    if (!this.pushToTalk) this.pttHeld = false;
    this.#applyTransmit();
  }

  setPttHeld(held) {
    this.pttHeld = Boolean(held);
    this.#applyTransmit();
  }

  #applyTransmit(stream = this.#micStream) {
    // Muted, not pushing to talk, or a gate that is shut: the same switch.
    const open = this.transmitting && (this.#valve?.open ?? true);
    for (const track of stream?.getAudioTracks() ?? []) track.enabled = open;
  }

  // -------------------------------------------------------------- incoming

  /**
   * Bring subscriptions in line with the roster.
   *
   * Idempotent and safe to call repeatedly, which is exactly how it is used:
   * on every roster push AND on a slow timer. The timer is not belt-and-braces,
   * it is load-bearing, and a relay load test is what proved it.
   *
   * MediaMTX answers a WHIP publish with 201 as soon as SIGNALLING completes,
   * but the path only becomes readable once the first RTP packet actually
   * arrives. A peer who subscribes inside that window gets
   * `404 no stream is available` -- measured on a real 16-member channel,
   * where every other member failed to subscribe to one slot for exactly that
   * reason.
   *
   * Retrying on the next roster push is not enough, because in a settled
   * channel there is no next push: nobody joins, leaves or mutes, so the
   * failure is permanent and that one person is silently inaudible to
   * everybody. Hence `retrySoon`, and hence the caller's timer.
   */
  async syncPeers(roster) {
    if (roster) this.lastRoster = roster;
    const current = this.lastRoster ?? [];

    // Keep the slot-to-person map current before anything reads it: a
    // preference is stored against the person, and the sink is found by slot.
    for (const member of current) this.#owners.set(member.mid, member.userId);

    const wanted = new Set(
      current
        .filter((m) => m.mid !== this.mid && m.publishing?.includes('v'))
        .map((m) => m.mid),
    );

    for (const mid of [...this.#subs.keys()]) {
      if (!wanted.has(mid)) await this.unsubscribe(mid);
    }

    const missed = [];
    for (const mid of wanted) {
      if (this.#subs.has(mid) || this.#opening.has(mid)) continue;
      this.#opening.add(mid);
      try {
        await this.subscribe(mid);
      } catch (err) {
        missed.push({ mid, reason: err?.code ?? err?.message ?? 'failed' });
      } finally {
        this.#opening.delete(mid);
      }
      await new Promise((r) => setTimeout(r, SUBSCRIBE_STAGGER_MS));
    }
    return { subscribed: this.#subs.size, missed };
  }

  /** True while somebody on the roster is publishing but not yet subscribed. */
  get hasMissingPeers() {
    return (this.lastRoster ?? []).some(
      (m) => m.mid !== this.mid && m.publishing?.includes('v') && !this.#subs.has(m.mid),
    );
  }

  // ---------------------------------------------------------- channel video

  /**
   * Publish a camera into this channel.
   *
   * A path of its own (`vc-<cid>-<mid>-c`), never a second track on the voice
   * path. MediaMTX's WHIP cannot renegotiate an added track -- measured in the
   * Phase 0 spike, where PATCH accepted only ICE trickle fragments -- so
   * adding video to the live audio session would mean tearing it down and
   * cutting everyone's audio to turn a camera on.
   */
  /**
   * @returns {Promise<boolean>} true once the camera is published. False when
   *   one is already running or on its way -- the caller's own stream is then
   *   spare and is the caller's to stop -- or when the call ended while the
   *   publish was crossing the network, in which case it has been taken down
   *   again.
   */
  async startCam(stream, { bitrate = 400_000, framerate = 24 } = {}) {
    // A camera's publish takes a round trip or three, and until it finishes
    // `#cam` is still empty: a second start in that time (a double click, a
    // hotkey held a moment, impatience on a slow link) would publish to the
    // same path and either be refused or take the first one down with it.
    if (this.#cam || this.#camOpening) return false;
    this.#camOpening = true;
    const channelId = this.channelId;
    this.note('cam: starting');
    try {
      const cam = await publish({
        url: this.publishUrls.cam,
        stream,
        iceServers: this.iceServers,
        codec: 'H264',
        maxBitrate: Math.min(bitrate, CAM_RAMP[0].bitrate),
        maxFramerate: framerate,
        contentHint: 'motion',
      });
      if (this.channelId !== channelId) {
        cam.pc.close();
        if (cam.resourceUrl) harmony.api.hangup(cam.resourceUrl).catch(() => {});
        return false;
      }
      this.#cam = cam;
      this.#camStream = stream;
      this.#rampCam(cam, bitrate, framerate);
      return true;
    } finally {
      this.#camOpening = false;
    }
  }

  /** Raise the camera's ceiling a step at a time, up to what was asked for. */
  #rampCam(cam, bitrate, framerate) {
    this.#cancelRamp();
    for (const step of CAM_RAMP.slice(1)) {
      if (step.bitrate !== Infinity && step.bitrate >= bitrate) continue;
      const target = Math.min(step.bitrate, bitrate);
      this.#camRamp.push(setTimeout(() => {
        // The camera may have been stopped, replaced or retuned meanwhile.
        if (this.#cam !== cam) return;
        const sender = cam.pc.getSenders().find((s) => s.track?.kind === 'video');
        if (!sender) return;
        applySenderSettings(sender, {
          maxBitrate: target,
          maxFramerate: framerate,
          degradationPreference: 'balanced',
        }).catch(() => { /* the next step, or a retune, tries again */ });
      }, step.after));
    }
  }

  #cancelRamp() {
    this.#camRamp.forEach(clearTimeout);
    this.#camRamp = [];
  }

  /** A camera is being published right now. */
  get camStarting() {
    return this.#camOpening;
  }

  async stopCam() {
    this.note('cam: stopping');
    this.#cancelRamp();
    const cam = this.#cam;
    this.#cam = null;
    this.#camStream?.getTracks().forEach((t) => t.stop());
    this.#camStream = null;
    if (!cam) return;
    cam.pc.close();
    if (cam.resourceUrl) await harmony.api.hangup(cam.resourceUrl).catch(() => {});
  }

  /**
   * Switch camera mid-call.
   *
   * replaceTrack, exactly as switchMic does, and for the same reason: the
   * WHIP session stays up, so nobody watching has to tear their subscription
   * down and rebuild it. Swapping a track of the same kind needs no
   * renegotiation, which is the one thing MediaMTX's WHIP cannot do.
   *
   * Takes an already-open stream rather than a device id, because deciding
   * what to do when a camera will not open is the caller's business -- it is
   * the only one that can say so.
   *
   * @returns {Promise<boolean>} false if the stream had no video track or
   *   there is no camera running, in which case nothing has changed.
   */
  async switchCam(stream) {
    if (!this.#cam) return false;
    const track = stream.getVideoTracks()[0];
    if (!track) return false;

    const sender = this.#cam.pc.getSenders().find((s) => s.track?.kind === 'video');
    if (!sender) return false;
    track.contentHint = 'motion';
    await sender.replaceTrack(track);

    this.#camStream?.getTracks().forEach((t) => t.stop());
    this.#camStream = stream;
    return true;
  }

  /**
   * Re-aim a running camera's encoder at a new size or rate.
   *
   * A different resolution comes in through switchCam; what the encoder is
   * allowed to spend on it does not follow by itself, because the ceiling was
   * set once, after the first answer.
   *
   * @returns {Promise<boolean>} false when there is no camera running.
   */
  async retuneCam({ bitrate, framerate }) {
    const sender = this.#cam?.pc.getSenders().find((s) => s.track?.kind === 'video');
    if (!sender) return false;
    // A deliberate setting: it replaces the climb, which would otherwise come
    // along later and lower it again.
    this.#cancelRamp();
    await applySenderSettings(sender, {
      maxBitrate: bitrate,
      maxFramerate: framerate,
      degradationPreference: 'balanced',
    });
    return true;
  }

  /** The device the camera is actually on, as the browser reports it. */
  get camDeviceId() {
    return this.#camStream?.getVideoTracks()[0]?.getSettings?.().deviceId ?? '';
  }

  get camLive() {
    return Boolean(this.#cam);
  }

  /** The local camera capture, for showing yourself without a round trip. */
  get camStream() {
    return this.#cam ? this.#camStream : null;
  }

  /**
   * Stop watching one tile, keeping the fact that it exists.
   *
   * The subscription really is torn down. `closedTiles` then reports it so
   * the UI can leave a square in its place, which is what makes this
   * different from the stream simply ending.
   */
  closeVideo(key) {
    this.#closedVideo.add(key);
    this.unsubscribeVideo(key);
  }

  /** Watch it again. The next syncVideo opens it. */
  reopenVideo(key) {
    this.#closedVideo.delete(key);
  }

  /** Closed tiles whose owner is still publishing, for the empty squares. */
  get closedTiles() {
    const out = [];
    for (const key of this.#closedVideo) {
      const [mid, kind] = key.split(':');
      out.push({ key, mid: Number(mid), kind });
    }
    return out.sort((a, b) => a.mid - b.mid || a.kind.localeCompare(b.kind));
  }

  /** Tiles to draw, in a stable order so the grid does not reshuffle itself. */
  get videoTiles() {
    return [...this.#video.entries()]
      // tileGain rather than the sink's own value: the remembered level is
      // the one source of truth, and a tile whose subscription has just
      // been rebuilt would otherwise report 1 until the sink caught up.
      .map(([key, { mid, kind, stream }]) => ({
        key, mid, kind, stream, gain: this.tileGain(key),
      }))
      .sort((a, b) => a.mid - b.mid || a.kind.localeCompare(b.kind));
  }

  /*
   * What each tile was last set to, by key.
   *
   * Kept outside the subscription so that closing a share and reopening it
   * -- or its owner's path dropping and coming back -- does not quietly
   * reset a level somebody chose.
   */
  #tileGains = new Map();

  /**
   * How loudly one screen share is played, 0..MAX_GAIN.
   *
   * Per tile rather than per person: somebody's game audio and their voice
   * are different things to want at different volumes, and turning a noisy
   * share down should not also turn them down when they talk.
   *
   * Deafen does NOT reach this. See setDeafened.
   */
  setTileGain(key, gain) {
    const value = Math.max(0, Math.min(MAX_GAIN, Number(gain) || 0));
    this.#tileGains.set(key, value);
    this.#video.get(key)?.sink?.set(value);
    return value;
  }

  tileGain(key) {
    return this.#tileGains.get(key) ?? this.#video.get(key)?.sink?.value ?? 1;
  }

  /**
   * Bring the video subscriptions in line with the roster.
   *
   * The same shape as syncPeers, and for the same reason: a publisher's path
   * is not readable until the first RTP packet arrives, so an early subscribe
   * 404s and has to be retried on a timer rather than on the next push, which
   * in a settled channel never comes.
   */
  async syncVideo(roster) {
    const current = roster ?? this.lastRoster ?? [];

    const wanted = new Map();
    for (const member of current) {
      if (member.mid === this.mid) continue;
      for (const kind of ['c', 's']) {
        // Cameras are not watched while nobody is looking: see setCamerasPaused.
        if (kind === 'c' && this.#camerasPaused) continue;
        if (member.publishing?.includes(kind)) {
          wanted.set(`${member.mid}:${kind}`, { mid: member.mid, kind });
        }
      }
    }

    for (const key of [...this.#video.keys()]) {
      if (!wanted.has(key)) this.unsubscribeVideo(key);
    }

    // A closed tile whose stream has ended stops being closed: the square
    // goes away with the stream, and if they ever share again it opens
    // normally rather than staying invisibly suppressed.
    for (const key of [...this.#closedVideo]) {
      if (!wanted.has(key)) this.#closedVideo.delete(key);
    }

    let changed = false;
    const missed = [];
    for (const [key, { mid, kind }] of wanted) {
      if (this.#closedVideo.has(key)) continue;
      if (this.#video.has(key) || this.#openingVideo.has(key)) continue;
      this.#openingVideo.add(key);
      try {
        const { pc, stream } = await watch({
          url: this.peerUrl(mid, kind),
          iceServers: this.iceServers,
        });
        // A screen share carries the sharer's audio. It goes through
        // gain.js like every other incoming stream rather than through the
        // <video> element, so that the tile's own volume slider has
        // something to act on.
        //
        // Straight to whatever this tile was last set to, rather than to 1
        // and then corrected: a share whose path drops and comes back
        // should not blast at full volume for the moment before the next
        // render.
        //
        // No keep-alive element is needed here: the tile IS one. See
        // #keepAlive for why voice subscriptions have to make their own.
        // Paused while this was opening: it has arrived for nobody.
        if (kind === 'c' && this.#camerasPaused) {
          pc.close();
          continue;
        }
        const sink = createSink(stream);
        sink.set(this.#tileGains.get(key) ?? 1);
        this.#video.set(key, { pc, stream, sink, mid, kind });
        changed = true;
      } catch (err) {
        // 404 while the path warms up. The caller's timer comes back. Anything
        // else is reported, so a refused token can be renewed rather than
        // retried unchanged for ever -- see syncPeers.
        missed.push({ key, reason: err?.code ?? err?.message ?? 'failed' });
      } finally {
        this.#openingVideo.delete(key);
      }
      await new Promise((r) => setTimeout(r, SUBSCRIBE_STAGGER_MS));
    }
    return { tiles: this.#video.size, changed, missed };
  }

  /** What the last look at each video subscription left, by tile key (see video-health.js). */
  #videoHealth = new Map();

  /** How many times each tile has been rebuilt for showing nothing. */
  #videoRebuilds = new Map();

  /**
   * Let go of a video subscription that is up and shows black, so that the next
   * sync opens it again from a fresh key frame.
   *
   * Connected, with packets arriving and nothing decoded: the connection looks
   * fine and the tile is black, and until now the only remedy was for somebody to
   * stop everything and start it again. A tile that stays black after a few
   * rebuilds is left as it is.
   *
   * @returns {Promise<string[]>} the tiles that were let go
   */
  async reapStalledVideo() {
    const now = Date.now();
    const dead = [];
    for (const [key, sub] of this.#video) {
      let stats = null;
      try {
        const reports = await sub.pc.getStats();
        reports.forEach((r) => {
          if (r.type === 'inbound-rtp' && (r.kind ?? r.mediaType) === 'video') {
            stats = {
              framesReceived: r.framesReceived,
              framesDecoded: r.framesDecoded,
              packetsReceived: r.packetsReceived ?? 0,
            };
          }
        });
      } catch {
        continue; // a connection being torn down
      }
      // Nothing to judge by (no video report yet, or an engine that does not report frames).
      if (!stats || stats.framesReceived === undefined || stats.framesDecoded === undefined) continue;

      const { verdict, next } = judgeVideo(this.#videoHealth.get(key) ?? null, stats, now);
      this.#videoHealth.set(key, next);
      if (verdict === 'ok') {
        if (stats.framesDecoded > 0) this.#videoRebuilds.delete(key);
        continue;
      }
      const times = this.#videoRebuilds.get(key) ?? 0;
      if (times >= VIDEO_MAX_REBUILDS) continue;
      this.#videoRebuilds.set(key, times + 1);
      this.note(`video ${key}: ${verdict} (received ${stats.framesReceived}, decoded ${stats.framesDecoded}, packets ${stats.packetsReceived}); opening it again (${times + 1}/${VIDEO_MAX_REBUILDS})`);
      dead.push(key);
    }
    for (const key of dead) {
      this.unsubscribeVideo(key);
      this.#videoHealth.delete(key);
    }
    return dead;
  }

  /** The tiles being received, by key. */
  get videoKeys() {
    return [...this.#video.keys()];
  }

  /** True while somebody is publishing video we have not managed to open. */
  get hasMissingVideo() {
    return (this.lastRoster ?? []).some((m) => m.mid !== this.mid
      && ['c', 's'].some((k) => !(k === 'c' && this.#camerasPaused)
        && m.publishing?.includes(k) && !this.#video.has(`${m.mid}:${k}`)));
  }

  /**
   * Whether other people's cameras are being watched at all.
   *
   * Switched off while the window is out of sight. A camera is the biggest
   * thing the relay sends after the voices, and on a machine where Harmony sits
   * minimised behind a game it is decoded, relayed and drawn for nobody. Only
   * cameras: a screen share's sound rides on the same connection as its
   * picture, and somebody listening to a friend's stream with Harmony in the
   * tray is exactly who must not lose it.
   */
  #camerasPaused = false;

  setCamerasPaused(paused) {
    this.#camerasPaused = Boolean(paused);
    // Let go now, not at the next sync: one may be half way through opening.
    if (this.#camerasPaused) {
      for (const [key, sub] of [...this.#video]) if (sub.kind === 'c') this.unsubscribeVideo(key);
    }
  }

  get camerasPaused() {
    return this.#camerasPaused;
  }

  unsubscribeVideo(key) {
    const sub = this.#video.get(key);
    if (!sub) return;
    this.#video.delete(key);
    this.#videoHealth.delete(key);
    sub.sink?.close?.();
    sub.pc.close();
  }

  /**
   * Attach a remote stream to a muted audio element, and keep it attached.
   *
   * Chromium will not run the remote audio render path for a WebRTC stream
   * that no media element is consuming. createMediaStreamSource succeeds, the
   * graph looks right, RTP arrives and is decoded -- and the AudioContext
   * gets silence. Measured directly: a subscription with 1601 packets
   * received, `routed: true`, and an analyser reading exactly 0.
   *
   * It is also why the fault came and went. The mosaic has always worked,
   * because every tile is a <video> consuming its stream; voice had no
   * element at all, so whether you could hear somebody depended on whether
   * you happened to have a video tile open from the same peer connection.
   *
   * The element is MUTED on purpose: gain.js does the actual playing, via
   * the gain node that gives volume past 100% and the analyser that drives
   * the speaking ring. This element exists only to make Chromium start the
   * pipeline, and unmuting it would play everybody twice.
   */
  #keepAlive(stream) {
    const el = document.createElement('audio');
    el.srcObject = stream;
    el.muted = true;
    el.autoplay = true;
    el.playsInline = true;
    el.setAttribute('aria-hidden', 'true');
    el.style.display = 'none';
    document.body.append(el);
    el.play().catch(() => { /* muted autoplay is always allowed */ });
    return el;
  }

  async subscribe(mid) {
    const { pc, stream } = await watch({
      url: this.peerUrl(mid),
      iceServers: this.iceServers,
      media: 'audio',
    });
    const anchor = this.#keepAlive(stream);
    const sink = createSink(stream);
    this.#subs.set(mid, { pc, sink, stream, anchor });
    // Straight to whatever this person was last set to, rather than to 1 and
    // then corrected: a peer who reconnects should not blast back at full
    // volume for the moment before the next render.
    const userId = this.#owners.get(mid);
    if (userId != null) this.#applyPref(userId);
    else sink.set(this.deafened ? 0 : 1);
    return sink;
  }

  async unsubscribe(mid) {
    const sub = this.#subs.get(mid);
    if (!sub) return;
    this.#subs.delete(mid);
    this.#flow.delete(mid);
    sub.sink.close?.();
    if (sub.anchor) {
      sub.anchor.srcObject = null;
      sub.anchor.remove();
    }
    sub.pc.close();
  }

  /**
   * Deafen: silence every VOICE, without tearing the subscriptions down.
   *
   * Voices only. A screen share's audio is not a person talking to you --
   * it is part of the thing you are watching, and it has its own slider and
   * its own mute on the tile. Deafening used to take it too, on the
   * reasoning that "a deafen that leaves one person's game audio playing is
   * not a deafen"; in use that is wrong, because the reason to deafen is
   * usually that people are talking while you are trying to watch
   * something. The two controls are independent.
   *
   * Gain rather than hang-up because this is a toggle people flip
   * constantly. Hanging up would make un-deafening cost a full round of ICE
   * per member.
   */
  setDeafened(deafened) {
    this.deafened = Boolean(deafened);
    for (const [mid, sub] of this.#subs) {
      const userId = this.#owners.get(mid);
      const pref = userId != null ? this.#peerPrefs.get(userId) : null;
      // Un-deafening restores each person to THEIR level, not to 1 -- it must
      // not quietly undo somebody you turned down or muted.
      sub.sink.set(this.deafened || pref?.muted ? 0 : (pref?.gain ?? 1));
    }
    return this.deafened;
  }

  async leave() {
    this.lastRoster = [];
    this.#owners.clear();
    this.#flow.clear();
    // #peerPrefs deliberately survives: turning somebody down is about that
    // person, not about this channel, and re-muting them on every rejoin is
    // the kind of thing that makes a mute feel broken.
    await this.stopMic();
    this.#micChain?.close();
    this.#micChain = null;
    this.#closeValve();
    this.#closedVideo.clear();
    this.#videoHealth.clear();
    this.#videoRebuilds.clear();
    this.#tileGains.clear();
    await this.stopCam();
    for (const mid of [...this.#subs.keys()]) await this.unsubscribe(mid);
    for (const key of [...this.#video.keys()]) this.unsubscribeVideo(key);
    this.channelId = null;
    this.mid = null;
    this.token = '';
    this.publishUrls = { voice: '', cam: '', screen: '' };
  }
}
