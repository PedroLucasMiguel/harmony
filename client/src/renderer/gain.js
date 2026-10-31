// Volume past 100%.
//
// A <video> element's `volume` is clamped to 1.0, so a stream that was quiet at
// the source can never be made loud enough. Routing the audio through a
// GainNode lifts that ceiling: the element stays muted and Web Audio does the
// playing, which is the only way to amplify a MediaStream in a renderer.
//
// The cost is that `video.volume` and `video.muted` stop being the source of
// truth, so everything that used to read them reads `sink.gain` instead.

/** Loudest we will go. Past this, most sources are more distortion than signal. */
export const MAX_GAIN = 3.5;

/**
 * Speaking detection.
 *
 * Three mechanisms, and all three turned out to be necessary once this met
 * a real voice rather than a test tone.
 *
 * 1. TWO THRESHOLDS. A single one makes the ring strobe, because the gaps
 *    between syllables genuinely are silence.
 * 2. AN ENVELOPE with a fast attack and a slow release. A 43 ms window lands
 *    inside one of those gaps often enough that instantaneous RMS flickers
 *    even well above the threshold.
 * 3. A HOLD, to carry across the longer gaps between words.
 *
 * The thresholds are deliberately low. The first version used 0.02, which is
 * about -34 dBFS: fine for Chromium's fake microphone, which is a full-scale
 * tone, and far too high for somebody speaking normally into a headset after
 * Opus at 32 kbps has been through it. The reported symptom was a ring that
 * "blinked twice" during a sentence, which is exactly what a threshold
 * sitting near the peaks of speech rather than its body looks like.
 */
const SPEAK_ON = 0.0075;
const SPEAK_OFF = 0.0035;
const SPEAK_HOLD_MS = 400;

/** How fast the envelope falls when the sound stops. Per read, at ~100 ms. */
const ENVELOPE_RELEASE = 0.65;

/** How often to look for an audio track that has not arrived yet. */
const RETRY_MS = 200;
/** And how long to keep looking before accepting the stream has no audio. */
const RETRY_GIVE_UP_MS = 30_000;

/**
 * Root-mean-square of what an analyser is hearing right now, 0..1.
 *
 * RMS rather than the peak: a single loud sample is a click, and peak makes
 * a keyboard sound like talking.
 */
function rms(analyser, buffer) {
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / buffer.length);
}

/** Wrap an analyser in the envelope and hysteresis above. */
function speechGate(analyser) {
  const buffer = new Float32Array(analyser.fftSize);
  let speaking = false;
  let until = 0;
  let envelope = 0;

  return () => {
    const level = rms(analyser, buffer);
    // Instant attack, gradual release: the envelope follows the loudest
    // thing heard recently rather than whatever this 43 ms happens to hold.
    envelope = level > envelope ? level : envelope * ENVELOPE_RELEASE;

    const now = performance.now();
    if (envelope > SPEAK_ON) {
      speaking = true;
      until = now + SPEAK_HOLD_MS;
    } else if (speaking && envelope < SPEAK_OFF && now > until) {
      speaking = false;
    }
    return { speaking, level: envelope };
  };
}

/**
 * Meter a stream WITHOUT playing it.
 *
 * For your own microphone: it is already going out over WebRTC, and routing
 * it to the destination as well is how you end up listening to yourself with
 * a few hundred milliseconds of delay. An AnalyserNode with nothing connected
 * downstream still runs, because it is a pull-free node that taps whatever
 * reaches it.
 */
export function createMeter(stream) {
  const analyser = captureContext().createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.2;

  let source = null;
  try {
    source = captureContext().createMediaStreamSource(stream);
    source.connect(analyser);
  } catch (err) {
    console.warn('[gain] could not meter stream:', err.message);
  }

  const read = speechGate(analyser);
  return {
    read,
    get speaking() {
      return read().speaking;
    },
    close() {
      try { source?.disconnect(); } catch { /* already gone */ }
      try { analyser.disconnect(); } catch { /* already gone */ }
      source = null;
    },
  };
}

/**
 * Input volume and a noise gate, between the microphone and the publish.
 *
 * Chromium's own capture processing (echo cancellation, noise suppression,
 * AGC) happens BEFORE the track exists, so it is untouched by this -- what
 * arrives here is already cleaned up, and this only decides how loud it is
 * and whether it is let through at all.
 *
 * The gate is polled rather than built from a DynamicsCompressor or a
 * WorkletNode. A compressor cannot be made to close completely, and a
 * worklet would be a second file loaded over a custom protocol with its own
 * CSP question, for an envelope follower that is nine lines. 25 ms is far
 * shorter than a syllable.
 *
 * Opening is INSTANT and closing is slow, which is the right way round: a
 * gate that fades in eats the first consonant of every sentence, and one
 * that slams shut chops the end of a word and breathes between them.
 *
 * @param {MediaStream} stream the raw getUserMedia capture
 * @returns {{track: MediaStreamTrack, setGain: Function, setThreshold: Function,
 *            level: number, open: boolean, close: Function} | null} null if
 *   Web Audio refuses the stream, in which case the caller publishes the raw
 *   track and simply has no gain or gate.
 */
const GATE_POLL_MS = 25;
const GATE_HOLD_MS = 300;
const GATE_RELEASE = 0.55;

function polledMicChain(stream, { gain = 1, threshold = 0 } = {}, capture = captureContext()) {
  let source;
  try {
    source = capture.createMediaStreamSource(stream);
  } catch (err) {
    console.warn('[gain] could not process the microphone:', err.message);
    return null;
  }

  const analyser = capture.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.1;
  const volume = capture.createGain();
  const gate = capture.createGain();
  const dest = capture.createMediaStreamDestination();

  // The analyser sits FIRST, so the meter shows what the microphone hears
  // rather than what survived the gate -- which is what you need to see in
  // order to set the gate at all.
  source.connect(analyser);
  analyser.connect(volume);
  volume.connect(gate);
  gate.connect(dest);

  volume.gain.value = Math.max(0, Math.min(MAX_GAIN, gain));
  gate.gain.value = 1;

  const buffer = new Float32Array(analyser.fftSize);
  let level = 0;
  let open = true;
  let openUntil = 0;
  let cutoff = threshold;

  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (const sample of buffer) sum += sample * sample;
    const rms = Math.sqrt(sum / buffer.length);
    level = Math.max(rms, level * GATE_RELEASE);

    if (cutoff <= 0) {
      if (!open) {
        open = true;
        gate.gain.setTargetAtTime(1, capture.currentTime, 0.005);
      }
      return;
    }

    const now = Date.now();
    if (rms >= cutoff) openUntil = now + GATE_HOLD_MS;
    const shouldBeOpen = now < openUntil;
    if (shouldBeOpen === open) return;
    open = shouldBeOpen;
    // 5 ms to open, 120 ms to close.
    gate.gain.setTargetAtTime(open ? 1 : 0, capture.currentTime, open ? 0.005 : 0.04);
  }, GATE_POLL_MS);
  timer.unref?.();

  return {
    kind: 'polled',
    track: dest.stream.getAudioTracks()[0] ?? null,
    setGain(value) {
      volume.gain.value = Math.max(0, Math.min(MAX_GAIN, Number(value) || 0));
    },
    setThreshold(value) {
      cutoff = Math.max(0, Number(value) || 0);
    },
    get level() {
      return level;
    },
    get open() {
      return open;
    },
    close() {
      clearInterval(timer);
      for (const node of [source, analyser, volume, gate, dest]) {
        try { node.disconnect(); } catch { /* already gone */ }
      }
    },
  };
}

/** One load of the gate's code per context; a failure is remembered, not retried. */
const gateModules = new WeakMap();

function loadGate(capture) {
  if (!gateModules.has(capture)) {
    gateModules.set(capture, capture.audioWorklet.addModule('gate-worklet.js'));
  }
  return gateModules.get(capture);
}

function gateNode(capture) {
  return new AudioWorkletNode(capture, 'mic-gate', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: 'explicit',
    outputChannelCount: [1],
  });
}

/**
 * The same chain with the gate on the audio thread -- see gate-worklet.js.
 * Throws if the engine will not run it, and the caller falls back.
 */
function workletMicChain(stream, { gain = 1, threshold = 0 }, capture) {
  const source = capture.createMediaStreamSource(stream);
  let gate;
  try {
    gate = gateNode(capture);
  } catch (err) {
    source.disconnect();
    throw err;
  }
  const volume = capture.createGain();
  const dest = capture.createMediaStreamDestination();
  const cutoff = gate.parameters.get('threshold');
  cutoff.value = Math.max(0, threshold);
  volume.gain.value = Math.max(0, Math.min(MAX_GAIN, gain));

  // The gate looks at the signal BEFORE the volume, as the polled one did: the
  // threshold is in terms of what the microphone hears, not of what is sent.
  source.connect(gate);
  gate.connect(volume);
  volume.connect(dest);

  let level = 0;
  let open = true;
  gate.port.onmessage = (event) => {
    level = event.data.level;
    open = event.data.open;
  };

  return {
    kind: 'worklet',
    track: dest.stream.getAudioTracks()[0] ?? null,
    setGain(value) {
      volume.gain.value = Math.max(0, Math.min(MAX_GAIN, Number(value) || 0));
    },
    setThreshold(value) {
      cutoff.value = Math.max(0, Number(value) || 0);
    },
    get level() {
      return level;
    },
    get open() {
      return open;
    },
    close() {
      gate.port.onmessage = null;
      for (const node of [source, gate, volume, dest]) {
        try { node.disconnect(); } catch { /* already gone */ }
      }
    },
  };
}

/** Whether the engine can process the frames of a track in a worker (Chromium's insertable streams for audio). */
export const canProcessInWorker = () => typeof MediaStreamTrackProcessor === 'function'
  && typeof MediaStreamTrackGenerator === 'function' && typeof Worker === 'function';

/** How long the worker has to show that sound is passing through it before it is given up on. */
const WORKER_PROOF_MS = 3000;

/**
 * Input volume and the gate applied to the frames of the track itself, in a
 * worker -- see gate-worker.js for why that, and not the chain above or a switch
 * on the published track, is what a busy machine does not turn into crackle.
 *
 * Same shape as the chain, so the caller does not care which it holds. It
 * resolves once sound has actually come out of the worker, and rejects if it
 * cannot run or nothing comes out: publishing a track that never carries
 * anything would be worse than not having a volume, and the caller falls back.
 *
 * @param {object} options
 * @param {() => void} [options.onBroken]  the worker stopped after it had started
 * @param {boolean} [options.denoise]  strong noise suppression in front of the gate (denoise.js)
 * @param {(state: 'ready'|'failed'|'unsupported') => void} [options.onAi]  what became of it
 * @returns {Promise<object>}
 */
export function workerMicChain(stream, { gain = 1, threshold = 0, denoise = false, onBroken, onAi } = {}) {
  const input = stream.getAudioTracks()[0];
  if (!input || !canProcessInWorker()) return Promise.reject(new Error('no audio frames to process'));

  return new Promise((resolve, reject) => {
    const worker = new Worker('gate-worker.js');
    let generator;
    let level = 0;
    let cpu = null;
    let open = threshold <= 0;
    let started = false;
    let timer = null;

    const chain = {
      kind: 'worker',
      get track() {
        return generator;
      },
      setGain(value) {
        worker.postMessage({ gain: Math.max(0, Math.min(MAX_GAIN, Number(value) || 0)) });
      },
      setThreshold(value) {
        worker.postMessage({ threshold: Math.max(0, Number(value) || 0) });
      },
      setDenoise(on) {
        worker.postMessage({ denoise: Boolean(on) });
      },
      get level() {
        return level;
      },
      get open() {
        return open;
      },
      /** The share of one core the worker has been taking, in percent, or null before it has said. */
      get cpu() {
        return cpu;
      },
      close() {
        clearTimeout(timer);
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        generator?.stop();
      },
    };

    const fail = (reason) => {
      chain.close();
      if (started) onBroken?.(reason);
      else reject(new Error(String(reason?.message ?? reason)));
    };

    worker.onerror = (event) => fail(event.message || 'the gate worker failed');
    worker.onmessage = (event) => {
      if (event.data.error) {
        fail(event.data.error);
        return;
      }
      if (event.data.ai) {
        onAi?.(event.data.ai, event.data);
        return;
      }
      if ('cpu' in event.data) {
        cpu = event.data.cpu;
        return;
      }
      level = event.data.level;
      open = event.data.open;
      if (!started) {
        started = true;
        clearTimeout(timer);
        resolve(chain);
      }
    };
    timer = setTimeout(() => fail('no sound came out of the gate worker'), WORKER_PROOF_MS);

    try {
      const processor = new MediaStreamTrackProcessor({ track: input });
      generator = new MediaStreamTrackGenerator({ kind: 'audio' });
      worker.postMessage({ threshold: Math.max(0, threshold), gain: Math.max(0, Math.min(MAX_GAIN, gain)), denoise: Boolean(denoise) });
      worker.postMessage(
        { readable: processor.readable, writable: generator.writable },
        [processor.readable, generator.writable],
      );
    } catch (err) {
      fail(err);
    }
  });
}

/**
 * The gate as a valve on the track that is published, not a stage in front of it.
 *
 * The chain above puts everything that is sent through an AudioContext, and
 * that context is only as steady as the machine: with the page and the
 * processor busy its audio thread falls behind, and what is sent has gaps in
 * it -- the crackle a listener hears while the sender's computer is loaded.
 * Taking the chain out of the path takes that away, but the gate needs the
 * level of the microphone to decide with.
 *
 * So this listens on the side. The same worklet measures a clone of the
 * microphone track, its output going nowhere (a gain of zero into the
 * destination, which is what keeps the node running), and says when the gate
 * would open or close; the caller switches the real track on and off. A
 * context that falls behind now only makes the gate late, and never damages
 * the sound that is sent.
 *
 * @param {MediaStream} stream a stream of a CLONE of the microphone track, kept
 *   enabled: the real track is switched off when the gate shuts, and a meter on
 *   that one could never see the sound that reopens it.
 * @returns {Promise<{level: number, open: boolean, setThreshold: Function, close: Function}>}
 *   rejects if the engine will not run the worklet, and the caller falls back to the chain
 */
export async function createMicValve(stream, { threshold = 0, onChange } = {}) {
  const capture = captureContext();
  await loadGate(capture);
  const source = capture.createMediaStreamSource(stream);
  let gate;
  try {
    gate = gateNode(capture);
  } catch (err) {
    source.disconnect();
    throw err;
  }
  const silence = capture.createGain();
  silence.gain.value = 0;
  const cutoff = gate.parameters.get('threshold');
  cutoff.value = Math.max(0, threshold);
  source.connect(gate);
  gate.connect(silence);
  silence.connect(capture.destination);

  let level = 0;
  // Shut until the sound says otherwise, as the gate in the chain is: a room
  // must not be broadcast for the length of one report.
  let open = threshold <= 0;
  gate.port.onmessage = (event) => {
    level = event.data.level;
    if (event.data.open === open) return;
    open = event.data.open;
    onChange?.(open);
  };

  return {
    get level() {
      return level;
    },
    get open() {
      return open;
    },
    setThreshold(value) {
      cutoff.value = Math.max(0, Number(value) || 0);
    },
    close() {
      gate.port.onmessage = null;
      for (const node of [source, gate, silence]) {
        try { node.disconnect(); } catch { /* already gone */ }
      }
    },
  };
}

let gateWarned = false;

/**
 * Input volume and the noise gate, between the microphone and the publish.
 * See polledMicChain for what each is for; the gate runs on the audio thread
 * where the engine allows it and on a timer where it does not.
 *
 * @returns {Promise<object|null>} null if Web Audio refuses the stream
 */
export async function createMicChain(stream, options = {}) {
  const capture = captureContext();
  try {
    await loadGate(capture);
    return workletMicChain(stream, options, capture);
  } catch (err) {
    if (!gateWarned) {
      gateWarned = true;
      console.warn('[gain] the gate could not run on the audio thread; using a timer:', err?.message ?? err);
    }
    const chain = polledMicChain(stream, options, capture);
    if (chain) chain.kind = 'polled';
    return chain;
  }
}

/**
 * The little noises: arriving, leaving, going live, muting.
 *
 * SYNTHESISED, not played from files. There is nothing to ship, cache or 404
 * on, the renderer's CSP allows no remote media, and a few notes are easier
 * to keep pleasant than any recording.
 *
 * 2.x played each note as a bare sine at 7% of full scale. A sine has no
 * harmonics, and the ear judges loudness largely by them -- so those cues
 * were both quiet and thin, easy to miss under a game and easy to mistake
 * for one another. Each note is now a small additive voice: the fundamental,
 * its octave and its twelfth, with a fast pitch settle at the onset that
 * gives it the soft "bloop" of a struck note rather than the beep of a test
 * tone. Played at ~32% of full scale, through a limiter, so two cues landing
 * together cannot clip.
 *
 * The mapping is the one every app of this kind uses, so it is already
 * learned: rising means arriving or switching on, falling means leaving or
 * switching off. Two notes for other people, three for you -- your own
 * arrival is the one you most need to be sure of.
 *
 * Each cue is { notes: [[frequency Hz, delay s], ...], length s, level }.
 */
const C5 = 523.25;
const D5 = 587.33;
const E5 = 659.25;
const G5 = 783.99;
const A5 = 880.0;
const B5 = 987.77;
const D6 = 1174.66;
const E6 = 1318.51;
const F6 = 1396.91;
const G4 = 392.0;
const D4 = 293.66;
const A4 = 440.0;

const CUES = {
  // Somebody else arrived / left. Up a fifth, down a fifth.
  join: { notes: [[D5, 0], [A5, 0.09]], length: 0.32, level: 1 },
  leave: { notes: [[A5, 0], [D5, 0.09]], length: 0.32, level: 1 },

  // You connected / disconnected. A full triad, so it cannot be mistaken
  // for somebody else coming and going.
  connect: { notes: [[C5, 0], [E5, 0.07], [G5, 0.14]], length: 0.4, level: 1 },
  disconnect: { notes: [[G5, 0], [E5, 0.07], [C5, 0.14]], length: 0.4, level: 1 },

  // A stream started / stopped -- yours or anybody's in the channel.
  // Higher and brighter than the arrivals: it is news, not presence.
  streamStart: { notes: [[E5, 0], [B5, 0.07], [E6, 0.14]], length: 0.45, level: 0.95 },
  streamStop: { notes: [[E6, 0], [B5, 0.07], [E5, 0.14]], length: 0.45, level: 0.95 },

  // Your microphone. Short and close together, because it answers a key you
  // just pressed and should be done before your next word.
  mute: { notes: [[A5, 0], [D5, 0.055]], length: 0.2, level: 0.85 },
  unmute: { notes: [[D5, 0], [A5, 0.055]], length: 0.2, level: 0.85 },

  // Your ears. Lower than mute, so the two are told apart without looking.
  deafen: { notes: [[A4, 0], [D4, 0.07]], length: 0.28, level: 0.9 },
  undeafen: { notes: [[D4, 0], [A4, 0.07]], length: 0.28, level: 0.9 },

  /*
   * Somebody wrote your name.
   *
   * Three notes going up twice, and the only cue that is asking for
   * something rather than reporting it -- it has to be recognisable from
   * another room.
   */
  mention: { notes: [[A5, 0], [D6, 0.08], [F6, 0.16]], length: 0.3, level: 0.9 },
};

/** Loudest a cue gets at 100%, as a fraction of full scale. */
const CUE_PEAK = 0.32;

/** The partials of one note: [multiple of the fundamental, relative level]. */
const PARTIALS = [[1, 1], [2, 0.32], [3, 0.1]];

/** 0..2, from the "sound effects volume" setting. */
let cueVolume = 1;

export function setCueVolume(volume) {
  cueVolume = Math.max(0, Math.min(2, Number(volume) || 0));
}

/*
 * Every cue goes through one limiter on its way out. Two cues can land
 * together -- somebody joins as somebody else starts streaming -- and at
 * these levels the sum would otherwise clip.
 */
let cueBus = null;
function bus(ctx) {
  if (cueBus?.context === ctx) return cueBus;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 4;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;
  limiter.connect(ctx.destination);
  cueBus = limiter;
  return cueBus;
}

export function playCue(name, volume = 1) {
  const cue = CUES[name];
  if (!cue) return;
  const level = Math.max(0, Math.min(2, volume)) * cueVolume * CUE_PEAK * cue.level;
  if (level <= 0) return;
  const ctx = context();
  const out = bus(ctx);

  for (const [frequency, delay] of cue.notes) {
    const start = ctx.currentTime + 0.01 + delay;
    const end = start + cue.length;

    const envelope = ctx.createGain();
    // Ramps rather than steps: a discontinuity in a waveform is a click.
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(level, start + 0.006);
    envelope.gain.exponentialRampToValueAtTime(level * 0.35, start + cue.length * 0.35);
    envelope.gain.exponentialRampToValueAtTime(0.0001, end);
    envelope.connect(out);

    const oscillators = PARTIALS.map(([multiple, weight]) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      // The settle: a few per cent sharp at the strike, down to pitch in
      // 40 ms. Inaudible as a glide, audible as a softer attack.
      osc.frequency.setValueAtTime(frequency * multiple * 1.03, start);
      osc.frequency.exponentialRampToValueAtTime(frequency * multiple, start + 0.04);
      const partial = ctx.createGain();
      // Higher partials die faster, as they do on anything struck.
      partial.gain.setValueAtTime(weight, start);
      partial.gain.exponentialRampToValueAtTime(
        Math.max(0.0001, weight * 0.05),
        start + cue.length / multiple,
      );
      osc.connect(partial);
      partial.connect(envelope);
      osc.start(start);
      osc.stop(end + 0.02);
      return { osc, partial };
    });

    // Oscillators are one-shot; without this the graph grows by a few dead
    // nodes per cue for the life of the context.
    oscillators[0].osc.addEventListener('ended', () => {
      try {
        for (const { osc, partial } of oscillators) {
          osc.disconnect();
          partial.disconnect();
        }
        envelope.disconnect();
      } catch { /* already gone */ }
    });
  }
}

/**
 * Hear your own screen share.
 *
 * Into the PLAYBACK context, the same one every incoming stream goes to, so
 * that the output device picker and deafen both reach it. There is no echo
 * risk: a screen's audio is not coming back in through a microphone, which
 * is exactly why this is safe here and would not be for your own voice.
 */
export function monitorStream(stream, gain = 1) {
  let source;
  try {
    source = context().createMediaStreamSource(stream);
  } catch (err) {
    console.warn('[gain] could not monitor:', err.message);
    return null;
  }
  const node = context().createGain();
  node.gain.value = Math.max(0, Math.min(MAX_GAIN, gain));
  source.connect(node);
  node.connect(context().destination);
  return {
    set(value) {
      node.gain.value = Math.max(0, Math.min(MAX_GAIN, Number(value) || 0));
    },
    close() {
      try { source.disconnect(); } catch { /* already gone */ }
      try { node.disconnect(); } catch { /* already gone */ }
    },
  };
}

/**
 * A second AudioContext, for the microphone only, with no output at all.
 *
 * The microphone chain and its meter used to live in the playback context
 * below, and so shared its fate: that context is pointed at an output device
 * and re-pointed whenever the devices change, and every re-point restarts its
 * rendering -- under a MediaStreamAudioDestinationNode that is feeding the
 * encoder. On a slow link the call's first seconds are exactly when a camera
 * opens or a switch is flipped and the device list changes, with the publish
 * still settling. A context with sinkId { type: 'none' } has no device to
 * follow or lose, so what leaves for the encoder no longer depends on
 * anything about the speakers. Engines that do not know the option get an
 * ordinary context, which is what everything used to be.
 */
let captureCtx = null;

function captureContext() {
  if (!captureCtx) {
    try {
      captureCtx = new AudioContext({ latencyHint: 'interactive', sinkId: { type: 'none' } });
    } catch {
      captureCtx = new AudioContext({ latencyHint: 'interactive' });
    }
  }
  if (captureCtx.state === 'suspended') captureCtx.resume().catch(() => {});
  return captureCtx;
}

let ctx = null;

/**
 * What the two audio contexts are doing, for the debug log: whether they are
 * running, how much they add, and -- where the engine reports it -- how often
 * playback ran dry, which is what a crackle is.
 */
export function audioContextStats() {
  const one = (c) => {
    if (!c) return null;
    const o = {
      state: c.state,
      sampleRate: c.sampleRate,
      baseLatency_ms: c.baseLatency != null ? Number((c.baseLatency * 1000).toFixed(1)) : null,
      outputLatency_ms: c.outputLatency != null ? Number((c.outputLatency * 1000).toFixed(1)) : null,
    };
    try {
      const p = c.playbackStats;
      if (p) {
        o.underrunEvents = p.underrunEvents;
        o.underrun_ms = p.underrunDuration != null ? Math.round(p.underrunDuration * 1000) : undefined;
        o.avgLatency_ms = p.averageLatency != null ? Math.round(p.averageLatency * 1000) : undefined;
        o.maxLatency_ms = p.maximumLatency != null ? Math.round(p.maximumLatency * 1000) : undefined;
      }
    } catch { /* an engine without playback stats */ }
    return o;
  };
  return { capture: one(captureCtx), playback: one(ctx) };
}

/**
 * One AudioContext for every stream being played.
 *
 * Created on first use rather than at load: a context made before any user
 * gesture starts suspended, and Chromium counts the click that joined a stream
 * as activation, so by the time anything needs playing there is a gesture to
 * ride on.
 */
function context() {
  if (!ctx) ctx = new AudioContext();
  // Autoplay policy can still park it; resuming is free when already running.
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/**
 * Route a received stream's audio through a gain node.
 *
 * @param {MediaStream} stream
 * @returns {{set: (v: number) => void, value: number, speaking: boolean, close: () => void}}
 */
export function createSink(stream) {
  const node = context().createGain();
  node.gain.value = 1;
  node.connect(context().destination);

  /*
   * The analyser sits BEFORE the gain node, so what it reports is what the
   * speaker is sending rather than how loudly we have chosen to play them.
   * After the gain node, muting somebody locally would also stop their
   * speaking ring -- and "is this person talking" is exactly what you want to
   * know about somebody you have muted.
   */
  const analyser = context().createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.2;
  analyser.connect(node);
  const read = speechGate(analyser);

  /*
   * Hook the audio up when it exists, which is not necessarily now.
   *
   * createMediaStreamSource captures whatever audio track the stream holds
   * at the moment it is called, and WHEP delivers audio and video as
   * separate `track` events -- so the audio often is not there yet.
   *
   * The first version waited for the stream's `addtrack` event. That event
   * NEVER FIRES HERE: `MediaStream.addTrack()` called from script does not
   * raise it, by specification, and the streams being played are built by
   * webrtc.js doing exactly that. So whenever the audio track happened to
   * arrive after this ran, the source was never connected -- no analyser,
   * and more to the point no sound, permanently and silently.
   *
   * That is what "I still cannot hear a thing" was. It was intermittent and
   * asymmetric because it is a race: whichever side's track lost it went
   * quiet while every roster, indicator and connection state looked perfect.
   *
   * So: keep the event (harmless, and correct for streams the user agent
   * builds), and poll as well, because the event cannot be relied on.
   */
  let source = null;
  let retry = null;

  const stopRetrying = () => {
    if (retry) clearInterval(retry);
    retry = null;
  };

  const connect = () => {
    if (source) return stopRetrying();
    if (stream.getAudioTracks().length === 0) return undefined;
    try {
      source = context().createMediaStreamSource(stream);
      source.connect(analyser);
      stopRetrying();
    } catch (err) {
      console.warn('[gain] could not route stream audio:', err.message);
    }
    return undefined;
  };

  connect();
  stream.addEventListener('addtrack', connect);
  if (!source) {
    retry = setInterval(connect, RETRY_MS);
    retry.unref?.();
    // A stream that never carries audio is ordinary -- a camera, a silent
    // screen share -- so stop looking rather than polling for the life of
    // the call.
    setTimeout(stopRetrying, RETRY_GIVE_UP_MS);
  }

  const sink = {
    value: 1,
    /** True while this stream is carrying speech. See speechGate. */
    get speaking() {
      return source ? read().speaking : false;
    },
    /**
     * Whether the stream's audio is actually routed yet.
     *
     * Worth exposing rather than inferring: `connected === false` is the
     * difference between "nobody is talking" and "this person cannot be
     * heard at all", and from the outside those look identical.
     */
    get connected() {
      return source !== null;
    },
    /** The current envelope, for diagnosing a silent-but-connected stream. */
    get level() {
      return source ? read().level : 0;
    },
    set(value) {
      const clamped = Math.max(0, Math.min(MAX_GAIN, value));
      sink.value = clamped;
      // setTargetAtTime rather than a bare assignment: stepping gain straight
      // from 0 to 3.5 is an audible click.
      node.gain.setTargetAtTime(clamped, context().currentTime, 0.015);
    },
    close() {
      stopRetrying();
      stream.removeEventListener('addtrack', connect);
      try {
        source?.disconnect();
      } catch {
        /* already gone */
      }
      try {
        analyser.disconnect();
      } catch {
        /* already gone */
      }
      try {
        node.disconnect();
      } catch {
        /* already gone */
      }
      source = null;
    },
  };
  return sink;
}

/** Decoded clips, so the second press of a soundpad button is instant. */
const samples = new Map();

/**
 * Play a one-shot sound into the PLAYBACK context.
 *
 * This is the single easiest thing to get wrong in the soundpad, so it is
 * worth being explicit: the clip goes here, into the context that plays what
 * you HEAR. It must never be routed into AudioBridge's gain node, which is the
 * OUTGOING mix being published. Doing that re-broadcasts the clip to everyone
 * who is already playing it locally, and they hear it twice, slightly out of
 * phase.
 *
 * The URL is `harmony://app/media/<hash>`, which is same-origin -- so `fetch`
 * is allowed by the CSP's `'self'` and no network permission is needed.
 *
 * @param {string} url
 * @param {{gain?: number}} options
 */
export async function playSample(url, { gain = 1 } = {}) {
  let buffer = samples.get(url);
  if (!buffer) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`could not load the clip (${response.status})`);
    buffer = await context().decodeAudioData(await response.arrayBuffer());
    samples.set(url, buffer);
  }

  const source = context().createBufferSource();
  source.buffer = buffer;
  const node = context().createGain();
  node.gain.value = Math.max(0, Math.min(MAX_GAIN, gain));
  source.connect(node);
  node.connect(context().destination);
  source.start();
  // Overlapping presses are fine -- each gets its own source node -- but the
  // nodes have to be released or they accumulate for the life of the context.
  source.addEventListener('ended', () => {
    try {
      source.disconnect();
      node.disconnect();
    } catch { /* already torn down */ }
  });
  return source;
}

/** Join sounds still playing, so leaving the room can end them. */
const activeJoinSounds = new Set();

/**
 * Another member's join sound: a recording they chose, played instead of the
 * ordinary join tone.
 *
 * Through the same limiter and the same "sound effects volume" as the tones,
 * since it replaces one, and into the playback context so that the output
 * device is respected. Cut off at `maxSeconds` whatever the file says, because
 * what the server checked is somebody else's promise and this is our ears.
 * Rejects if the file cannot be fetched or decoded, so the caller can fall
 * back to the tone rather than play nothing.
 *
 * @param {string} url
 * @param {{maxSeconds?: number}} options
 */
export async function playJoinSound(url, { maxSeconds = 10 } = {}) {
  let buffer = samples.get(url);
  if (!buffer) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`could not load the sound (${response.status})`);
    buffer = await context().decodeAudioData(await response.arrayBuffer());
    samples.set(url, buffer);
  }
  const level = cueVolume * CUE_PEAK * 2.2;
  if (level <= 0) return null;

  const ctx = context();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const node = ctx.createGain();
  node.gain.value = level;
  source.connect(node);
  node.connect(bus(ctx));
  const duration = Math.min(buffer.duration, maxSeconds);
  source.start(0, 0, duration);
  activeJoinSounds.add(source);
  source.addEventListener('ended', () => {
    activeJoinSounds.delete(source);
    try {
      source.disconnect();
      node.disconnect();
    } catch { /* already torn down */ }
  });
  return source;
}

/**
 * Why a cue might be silent, in numbers: the state of the context the cues play
 * through, where it is going, and what has been asked of it.
 */
export function cueStatus() {
  const c = ctx;
  return {
    context: c ? c.state : 'not created yet',
    sinkId: c && typeof c.sinkId === 'string' ? (c.sinkId || 'default') : null,
    volume: cueVolume,
    playingJoinSounds: activeJoinSounds.size,
    cachedJoinSounds: samples.size,
  };
}

/** Silence any join sound still playing: leaving the room ends them. */
export function stopJoinSounds() {
  for (const source of activeJoinSounds) {
    try { source.stop(); } catch { /* already ended */ }
  }
  activeJoinSounds.clear();
}

/**
 * Send everything we play to a particular output device.
 *
 * One call covers every voice subscription, every screen share's audio and
 * the soundpad, because they all share the one AudioContext -- which is the
 * reason that context exists rather than a node graph per stream.
 *
 * Returns false rather than throwing when the device is gone: unplugging
 * headphones mid-call is an ordinary event, not an error, and the caller's
 * job is then to fall back rather than to report a failure.
 */
export async function setOutputDevice(deviceId) {
  const ctx = context();
  if (typeof ctx.setSinkId !== 'function') return false;
  // Already there. Chromium rebuilds the context's output for a setSinkId even
  // to the device it is on, and every devicechange used to ask for exactly
  // that -- which is a restart of everything playing, for nothing.
  if (typeof ctx.sinkId === 'string' && ctx.sinkId === (deviceId || '')) return true;
  try {
    // '' is the system default. setSinkId takes the empty string for that,
    // the same as an <audio> element does.
    await ctx.setSinkId(deviceId || '');
    return true;
  } catch (err) {
    console.warn('[gain] could not switch output:', err.message);
    return false;
  }
}

/** Percent for the UI, from the 0..MAX_GAIN scale. */
export const asPercent = (gain) => Math.round(gain * 100);
