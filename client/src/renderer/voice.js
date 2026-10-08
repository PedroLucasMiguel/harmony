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

import { publish, watch } from './webrtc.js';
import { createSink, createMeter, createMicChain, MAX_GAIN } from './gain.js';

/**
 * Microphone constraints.
 *
 * All three processors ON, which is the opposite of what AudioBridge does for
 * a capture card -- and correct for the opposite reason. A capture card is
 * already-mixed game audio where echo cancellation would duck the music and
 * noise suppression would eat it; a microphone in a room with speakers is the
 * textbook case for all three.
 */
const MIC_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

/** Opus for speech. 32 kbps is ~52 kbps on the wire once RTP is counted. */
const VOICE_BITRATE = 32_000;

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
  #cam = null;
  #camStream = null;

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
    if (this.#micMeter && !this.muted && this.#micMeter.speaking) out.add(this.mid);
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

  async startMic(publishUrl, deviceId) {
    if (this.#mic) return;
    this.#micStream = await navigator.mediaDevices.getUserMedia({
      audio: { ...MIC_CONSTRAINTS, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
    });
    // Apply the current mute state immediately: joining already muted must not
    // broadcast a second of room noise before the toggle is read.
    for (const track of this.#micStream.getAudioTracks()) track.enabled = !this.muted;

    this.#mic = await publish({
      url: publishUrl,
      stream: this.#processed(this.#micStream),
      iceServers: this.iceServers,
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
  #processed(stream) {
    this.#micChain?.close();
    this.#micChain = createMicChain(stream, {
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

  /** Input volume, 0..MAX_GAIN. Kept on the session, so it survives a
   *  device switch and a rejoin. */
  micGain = 1;

  /** Noise gate, as an RMS level between 0 and 1. 0 is off. */
  micThreshold = 0;

  setMicGain(value) {
    this.micGain = Math.max(0, Math.min(MAX_GAIN, Number(value) || 0));
    this.#micChain?.setGain(this.micGain);
    return this.micGain;
  }

  setMicThreshold(value) {
    this.micThreshold = Math.max(0, Number(value) || 0);
    this.#micChain?.setThreshold(this.micThreshold);
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
    return this.#micChain?.level ?? this.#micMeter?.read().level ?? 0;
  }

  /** Whether the gate is currently letting sound through. */
  get micOpen() {
    return this.#micChain ? this.#micChain.open : true;
  }

  /**
   * Switch microphone mid-call.
   *
   * replaceTrack on the existing sender, NOT a new publish: the WHIP session
   * stays up, so nobody else has to tear down and rebuild their subscription
   * and there is no gap in the path. Swapping a track of the same kind needs
   * no renegotiation, which is the one thing MediaMTX's WHIP cannot do.
   *
   * @returns {Promise<boolean>} false if the device could not be opened, in
   *   which case the old microphone is still running and still published.
   */
  async switchMic(deviceId) {
    if (!this.#mic) return false;

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...MIC_CONSTRAINTS, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
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
    track.enabled = !this.muted;

    const sender = this.#mic.pc.getSenders().find((s) => s.track?.kind === 'audio');
    if (!sender) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    // Through the chain again, or changing headset silently drops the input
    // volume and the gate -- which reads as "picking my headset breaks my
    // microphone settings" and is impossible to guess the cause of.
    const processed = this.#processed(stream);
    await sender.replaceTrack(processed.getAudioTracks()[0] ?? track);

    this.#micStream?.getTracks().forEach((t) => t.stop());
    this.#micStream = stream;

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
  async restartMic(deviceId) {
    const url = this.publishUrls?.voice;
    if (!url) throw new Error('no publish URL for the microphone');
    await this.stopMic();
    this.#micDisconnectedSince = null;
    await this.startMic(url, deviceId);
  }

  /** The device the microphone is actually on, as the browser reports it. */
  get micDeviceId() {
    return this.#micStream?.getAudioTracks()[0]?.getSettings?.().deviceId ?? '';
  }

  async stopMic() {
    const mic = this.#mic;
    this.#mic = null;
    this.#micMeter?.close();
    this.#micMeter = null;
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
    for (const track of this.#micStream?.getAudioTracks() ?? []) {
      track.enabled = !this.muted;
    }
    return this.muted;
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
  async startCam(stream, { bitrate = 400_000, framerate = 24 } = {}) {
    if (this.#cam) return;
    this.#camStream = stream;
    this.#cam = await publish({
      url: this.publishUrls.cam,
      stream,
      iceServers: this.iceServers,
      codec: 'H264',
      maxBitrate: bitrate,
      maxFramerate: framerate,
      contentHint: 'motion',
    });
  }

  async stopCam() {
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
        const sink = createSink(stream);
        sink.set(this.#tileGains.get(key) ?? 1);
        this.#video.set(key, { pc, stream, sink, mid, kind });
        changed = true;
      } catch {
        // 404 while the path warms up. The caller's timer comes back.
      } finally {
        this.#openingVideo.delete(key);
      }
      await new Promise((r) => setTimeout(r, SUBSCRIBE_STAGGER_MS));
    }
    return { tiles: this.#video.size, changed };
  }

  /** True while somebody is publishing video we have not managed to open. */
  get hasMissingVideo() {
    return (this.lastRoster ?? []).some((m) => m.mid !== this.mid
      && ['c', 's'].some((k) => m.publishing?.includes(k) && !this.#video.has(`${m.mid}:${k}`)));
  }

  unsubscribeVideo(key) {
    const sub = this.#video.get(key);
    if (!sub) return;
    this.#video.delete(key);
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
    this.#closedVideo.clear();
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
