// The page's half of the debug log (the main process's half is main/debug-log.js).
//
// While it is on, every couple of seconds this writes what the page can see and
// the main process cannot: how the audio and video connections are doing (loss,
// jitter, what the player had to patch over, what the encoder is costing and
// whether it is running on the GPU), what the capture devices actually gave us,
// whether the audio contexts ran dry, and whether the page itself stalled --
// because a stalled page is what a busy machine looks like from in here.
//
// Counters from the browser are running totals, which tell nothing about NOW; so
// each is written as the change since the previous sample, and the rates that
// matter (bitrate, frames per second, milliseconds to encode a frame, how far
// behind the player is) are worked out from those changes.
//
// OFF at every start: nothing here is remembered between runs. See main/debug-log.js.

const TICK_MS = 2000;

/** Running totals: written as the change since the last sample. */
const COUNTERS = new Set([
  'packetsSent', 'bytesSent', 'packetsReceived', 'bytesReceived', 'packetsLost', 'packetsDiscarded',
  'framesEncoded', 'framesSent', 'keyFramesEncoded', 'hugeFramesSent', 'framesReceived', 'framesDecoded', 'framesDropped',
  'nackCount', 'pliCount', 'firCount', 'retransmittedPacketsSent', 'freezeCount', 'pauseCount',
  'totalSamplesReceived', 'concealedSamples', 'silentConcealedSamples', 'concealmentEvents',
  'insertedSamplesForDeceleration', 'removedSamplesForAcceleration', 'interruptionCount',
  'totalSamplesDuration', 'totalAudioEnergy', 'frames',
  'requestsSent', 'responsesReceived', 'consentRequestsSent', 'underrunEvents',
  'limited_none_s', 'limited_cpu_s', 'limited_bandwidth_s', 'limited_other_s',
]);

/** Totals in seconds that are better read as milliseconds of change. */
const SECOND_COUNTERS = new Set([
  'totalEncodeTime', 'totalDecodeTime', 'totalPacketSendDelay', 'totalInterruptionDuration', 'totalFreezesDuration',
  'jitterBufferDelay', 'jitterBufferTargetDelay', 'jitterBufferMinimumDelay',
]);

/** Instantaneous values in seconds, written in milliseconds. */
const SECOND_VALUES = new Set(['jitter', 'roundTripTime']);

/** Settings worth knowing about when reading a log: none of them names anybody. */
const SETTINGS_SHOWN = [
  'hardwareEncoding', 'gpuAdapter', 'cameraResolution', 'cameraFramerate', 'cameraPreview',
  'micGain', 'micSensitivity', 'micEchoCancellation', 'micNoiseSuppression', 'pushToTalk',
  'pauseHiddenCameras', 'pictureInPicture', 'uiScale', 'soundVolume', 'voiceSounds',
];

const round = (n, digits = 1) => (Number.isFinite(n) ? Number(n.toFixed(digits)) : n);

/**
 * @param {object} deps
 * @param {object} deps.harmony                       the bridge
 * @param {() => import('./voice.js').VoiceSession} deps.voice
 * @param {() => object|null} deps.effectStats        the camera's background effect, if running
 * @param {() => object|undefined} deps.settings
 */
export function createDebugLog({ harmony, voice, effectStats, settings }) {
  let on = false;
  let timer = null;
  let lagTimer = null;
  let observers = [];
  let removers = [];
  /** key -> the previous sample's numbers, for the change since. */
  let previous = new Map();
  let lastTickAt = 0;
  let lag = { max: 0, over50: 0, over200: 0 };
  let longTasks = { count: 0, total: 0, max: 0 };
  let frames = { count: 0, blocking: 0, max: 0 };
  let busy = false;

  const send = (kind, text) => { harmony.debug.event(kind, text).catch(() => {}); };

  // --------------------------------------------------------------- formatting

  /**
   * One section of a snapshot as `key=value` pairs: counters as the change since
   * the previous sample, seconds as milliseconds, nested objects with a dotted
   * prefix. `key` identifies the section from one sample to the next.
   */
  function pairs(key, object, dt) {
    // A section's first sample has no earlier one to subtract: its counters are
    // everything since the connection began, and the log says so rather than
    // passing them off as two seconds' worth.
    const first = !previous.has(key);
    const before = previous.get(key) ?? {};
    const now = {};
    const out = [];
    const walk = (prefix, o) => {
      for (const [name, value] of Object.entries(o)) {
        if (value === undefined || value === null) continue;
        const path = prefix ? `${prefix}.${name}` : name;
        if (value && typeof value === 'object') {
          walk(path, value);
          continue;
        }
        if (typeof value === 'number') {
          now[path] = value;
          const was = before[path] ?? 0;
          if (COUNTERS.has(name)) {
            out.push(`${path}=+${round(value - was, 2)}`);
          } else if (SECOND_COUNTERS.has(name)) {
            out.push(`${path}=+${round((value - was) * 1000)}ms`);
          } else if (SECOND_VALUES.has(name)) {
            out.push(`${path}=${round(value * 1000)}ms`);
          } else {
            out.push(`${path}=${round(value, 3)}`);
          }
        } else {
          out.push(`${path}=${String(value).replace(/\s+/g, '_')}`);
        }
      }
    };
    walk('', object);
    previous.set(key, now);

    if (first) return `${out.join(' ')} (first sample: counters are totals since the start, not a change)`;

    // What the changes add up to.
    const d = (field) => (now[field] ?? 0) - (before[field] ?? 0);
    const derived = [];
    const secs = dt / 1000;
    for (const section of ['outAudio', 'outVideo']) {
      if (now[`${section}.bytesSent`] === undefined) continue;
      derived.push(`${section}.kbps=${round(d(`${section}.bytesSent`) * 8 / 1000 / secs, 0)}`);
    }
    if (now['outVideo.framesEncoded'] !== undefined) {
      const frames_ = d('outVideo.framesEncoded');
      derived.push(`outVideo.encodedFps=${round(frames_ / secs)}`);
      if (frames_ > 0) derived.push(`outVideo.encodeMsPerFrame=${round(d('outVideo.totalEncodeTime') * 1000 / frames_, 2)}`);
    }
    if (now['inAudio.totalSamplesReceived'] !== undefined) {
      const samples = d('inAudio.totalSamplesReceived');
      if (samples > 0) derived.push(`inAudio.concealedPct=${round(100 * d('inAudio.concealedSamples') / samples, 2)}`);
      const emitted = d('inAudio.jitterBufferEmittedCount');
      if (emitted > 0) derived.push(`inAudio.bufferMs=${round(d('inAudio.jitterBufferDelay') * 1000 / emitted, 0)}`);
      derived.push(`inAudio.kbps=${round(d('inAudio.bytesReceived') * 8 / 1000 / secs, 0)}`);
    }
    if (now['inVideo.framesDecoded'] !== undefined) {
      const decoded = d('inVideo.framesDecoded');
      derived.push(`inVideo.decodedFps=${round(decoded / secs)}`);
      if (decoded > 0) derived.push(`inVideo.decodeMsPerFrame=${round(d('inVideo.totalDecodeTime') * 1000 / decoded, 2)}`);
    }
    return [...out, ...derived].join(' ');
  }

  // ------------------------------------------------------------------ sampling

  function pageLine() {
    const parts = [
      `lagMax=${Math.round(lag.max)}ms`, `lagOver50=${lag.over50}`, `lagOver200=${lag.over200}`,
      `longTasks=${longTasks.count}`, `longTaskMax=${Math.round(longTasks.max)}ms`,
      `slowFrames=${frames.count}`, `slowFrameBlockMax=${Math.round(frames.max)}ms`,
    ];
    lag = { max: 0, over50: 0, over200: 0 };
    longTasks = { count: 0, total: 0, max: 0 };
    frames = { count: 0, blocking: 0, max: 0 };
    const mem = performance.memory;
    if (mem) parts.push(`jsHeap=${Math.round(mem.usedJSHeapSize / 1048576)}MB/${Math.round(mem.jsHeapSizeLimit / 1048576)}MB`);
    parts.push(`visible=${document.visibilityState}`, `focused=${document.hasFocus()}`, `online=${navigator.onLine}`);
    const c = navigator.connection;
    if (c) parts.push(`browserNet=${c.effectiveType ?? '?'}/rtt${c.rtt ?? '?'}ms/down${c.downlink ?? '?'}Mbps`);
    return parts.join(' ');
  }

  async function tick() {
    if (!on || busy) return;
    busy = true;
    const started = performance.now();
    const dt = lastTickAt ? started - lastTickAt : TICK_MS;
    lastTickAt = started;
    try {
      send('PAGE', pageLine());

      const effect = effectStats();
      if (effect) send('CAMFX', pairs('camfx', effect, dt));

      const v = voice();
      if (v?.channelId != null) {
        const snap = await v.debugSnapshot();
        // Chromium names the encoder only when it is a hardware one, so the
        // absence is the answer -- written out, because nobody reading a log
        // should have to know that.
        const named = (section, field) => {
          if (!section) return;
          section.encoder = section[field] ? `hardware:${section[field]}` : 'software-or-not-reported';
        };
        named(snap.cam?.outVideo, 'encoderImplementation');
        for (const s of snap.video) named(s.inVideo, 'decoderImplementation');
        const rtt = await v.rtt().catch(() => null);
        send('AUDIO', pairs('room', { ...snap.room, relayRtt_ms: rtt }, dt));
        if (snap.micTrack) send('AUDIO', `micTrack ${pairs('micTrack', snap.micTrack, dt)}`);
        if (snap.camTrack) send('AUDIO', `camTrack ${pairs('camTrack', snap.camTrack, dt)}`);
        for (const [name, ctx] of Object.entries(snap.audioContexts)) {
          if (ctx) send('AUDIO', `ctx.${name} ${pairs(`ctx.${name}`, ctx, dt)}`);
        }
        if (snap.mic) send('NET', `mic ${pairs('net:mic', snap.mic, dt)}`);
        if (snap.cam) send('NET', `cam ${pairs('net:cam', snap.cam, dt)}`);
        for (const s of snap.subs) send('NET', `voice#${s.mid} ${pairs(`net:voice:${s.mid}`, s, dt)}`);
        for (const s of snap.video) send('NET', `video:${s.key} ${pairs(`net:video:${s.key}`, s, dt)}`);
      }
    } catch (err) {
      send('LOG', `sample failed: ${String(err?.message ?? err).slice(0, 200)}`);
    } finally {
      // How long taking the sample itself took: a log that is the cause of
      // what it is looking for should say so.
      const cost = performance.now() - started;
      if (cost > 150) send('LOG', `that sample took ${Math.round(cost)}ms`);
      busy = false;
    }
  }

  // ------------------------------------------------------------------- watching

  function watchStalls() {
    // A timer that asks to run every 100 ms and notes how late it was: a page
    // whose main thread is kept busy runs it late, and so does everything else on it.
    let expected = performance.now() + 100;
    lagTimer = setInterval(() => {
      const late = performance.now() - expected;
      expected = performance.now() + 100;
      if (late > lag.max) lag.max = late;
      if (late > 50) lag.over50 += 1;
      if (late > 200) lag.over200 += 1;
    }, 100);

    const observe = (type, onEntry) => {
      try {
        const o = new PerformanceObserver((list) => list.getEntries().forEach(onEntry));
        o.observe({ type, buffered: false });
        observers.push(o);
      } catch { /* an engine without this entry type */ }
    };
    observe('longtask', (e) => {
      longTasks.count += 1;
      longTasks.total += e.duration;
      longTasks.max = Math.max(longTasks.max, e.duration);
    });
    observe('long-animation-frame', (e) => {
      frames.count += 1;
      frames.blocking += e.blockingDuration ?? 0;
      frames.max = Math.max(frames.max, e.blockingDuration ?? e.duration);
    });
  }

  function watchEvents() {
    const listen = (target, type, text) => {
      const handler = () => send('EVENT', typeof text === 'function' ? text() : text);
      target.addEventListener(type, handler);
      removers.push(() => target.removeEventListener(type, handler));
    };
    listen(window, 'online', 'network: online');
    listen(window, 'offline', 'network: offline');
    listen(document, 'visibilitychange', () => `page: ${document.visibilityState}`);
    listen(window, 'focus', 'window: focus');
    listen(window, 'blur', 'window: blur');
    listen(navigator.mediaDevices, 'devicechange', 'devices: the list of audio and video devices changed');
    const c = navigator.connection;
    if (c) listen(c, 'change', () => `browserNet: ${c.effectiveType}/rtt${c.rtt}ms/down${c.downlink}Mbps`);
  }

  async function headerExtras() {
    const extra = {};
    extra.page = `${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? '?'}  cores=${navigator.hardwareConcurrency}  deviceMemory=${navigator.deviceMemory ?? '?'}GB`;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const labels = (kind) => devices.filter((d) => d.kind === kind).map((d) => d.label || '(unnamed)').join(' ; ') || 'none';
      extra.mics = labels('audioinput');
      extra.speakers = labels('audiooutput');
      extra.cameras = labels('videoinput');
    } catch { /* no device access yet */ }
    const s = settings() ?? {};
    extra.settings = SETTINGS_SHOWN.filter((k) => s[k] !== undefined).map((k) => `${k}=${s[k]}`).join(' ')
      + ` background=${s.cameraBackground?.mode ?? 'off'}`;
    return extra;
  }

  // --------------------------------------------------------------------- control

  /** Start writing. Resolves with the file's name. */
  async function start() {
    if (on) return harmony.debug.status();
    const status = await harmony.debug.start(await headerExtras());
    on = true;
    previous = new Map();
    lastTickAt = 0;
    lag = { max: 0, over50: 0, over200: 0 };
    longTasks = { count: 0, total: 0, max: 0 };
    frames = { count: 0, blocking: 0, max: 0 };
    watchStalls();
    watchEvents();
    const v = voice();
    if (v) v.onNote = (what) => send('EVENT', `voice: ${what}`);
    send('EVENT', `logging on; in a call: ${v?.channelId != null ? 'yes' : 'no'}`);
    timer = setInterval(tick, TICK_MS);
    return status;
  }

  async function stop() {
    if (!on) return harmony.debug.status();
    on = false;
    clearInterval(timer);
    clearInterval(lagTimer);
    timer = null;
    lagTimer = null;
    observers.forEach((o) => o.disconnect());
    observers = [];
    removers.forEach((r) => r());
    removers = [];
    const v = voice();
    if (v) v.onNote = null;
    return harmony.debug.stop();
  }

  return {
    start,
    stop,
    /** Something worth a line in the log, from anywhere in the app. */
    event(kind, text) {
      if (on) send(kind, text);
    },
    get enabled() {
      return on;
    },
  };
}
