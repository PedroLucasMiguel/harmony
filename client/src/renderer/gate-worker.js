// The microphone's input volume and noise gate, applied to the track that is sent.
//
// This is the same gate as gate-worklet.js -- the level is the RMS of the last
// 1024 samples, above the threshold it opens in about 5 ms, it stays open for
// 300 ms after the last time the sound was above, and it closes in about 40 ms
// -- but it works on the frames of the track itself instead of on an audio
// context's thread. The two differ in what a busy machine does to them:
//
//   * an AudioContext in the path has an audio thread that must deliver every
//     block on time, and when the machine is loaded it does not: what is sent
//     has gaps (the crackle). A worker only has to get to the next frame
//     eventually, and the frames it is behind on wait for it.
//   * switching the published track on and off is never late, but it cuts the
//     waveform where it stands: every opening and closing is a click, which is
//     what a gate set between 0 and 100 sounded like.
//
// Here the sound is faded, and nothing real-time sits in the path.
//
// The page sends {readable, writable} once (the two ends of the stream, see
// workerMicChain in gain.js), then {threshold} and {gain} as the sliders move.
// It is told {level, open} about every 25 ms of sound, for the meter.
//
// In front of the gate there may be a noise suppressor (denoise.js: RNNoise): {denoise: true}
// switches it on and off, and {ai: 'ready'|'failed'|'unsupported'} says what became of it. It
// is only loaded when asked for, and only runs at 48 kHz, which is what a microphone gives.

const WINDOW = 1024;
const HOLD_SECONDS = 0.3;
const OPEN_TAU = 0.005;
const CLOSE_TAU = 0.04;
// Volume changes are eased too: a jump from one level to another is a click.
const VOLUME_TAU = 0.01;
const LEVEL_FALL_SECONDS = 0.025; // the meter falls to 55% in this long
const LEVEL_FALL = 0.55;
const REPORT_SECONDS = 0.025;

let threshold = 0;
let volume = 1;
let wantDenoise = false;
/** @type {Promise<object|null>|null} */
let denoiserLoading = null;
let denoiser = null;
let warnedRate = false;

/** Load the suppressor once, the first time it is wanted. Resolves to null when it cannot run. */
function loadDenoiser() {
  if (!denoiserLoading) {
    denoiserLoading = import('./denoise.js')
      .then(async (mod) => {
        const rnnoise = await mod.loadRnnoise();
        denoiser = { mod, rnnoise, instance: null, rate: mod.RATE };
        self.postMessage({ ai: 'ready' });
        return denoiser;
      })
      .catch((err) => {
        self.postMessage({ ai: 'failed', reason: String(err?.message ?? err) });
        return null;
      });
  }
  return denoiserLoading;
}

self.onmessage = (event) => {
  const message = event.data;
  if (message.readable) {
    run(message.readable, message.writable).catch((err) => {
      self.postMessage({ error: String(err?.message ?? err) });
    });
    return;
  }
  if ('threshold' in message) threshold = Math.max(0, Number(message.threshold) || 0);
  if ('gain' in message) volume = Math.max(0, Number(message.gain) || 0);
  if ('denoise' in message) {
    wantDenoise = Boolean(message.denoise);
    if (wantDenoise) loadDenoiser();
  }
};

async function run(readable, writable) {
  const reader = readable.getReader();
  const writer = writable.getWriter();

  // Mean square of the last WINDOW samples, all channels mixed.
  const squares = new Float32Array(WINDOW);
  let slot = 0;
  let total = 0;

  let level = 0;
  let open = threshold <= 0;
  let gate = open ? 1 : 0;
  let smoothVolume = volume;
  let clock = 0;
  let openUntil = 0;
  let sinceReport = 0;

  for (;;) {
    const { value: data, done } = await reader.read();
    if (done) break;

    const frames = data.numberOfFrames;
    const channels = data.numberOfChannels;
    const rate = data.sampleRate;
    const samples = new Float32Array(frames * channels);
    for (let c = 0; c < channels; c += 1) {
      data.copyTo(samples.subarray(c * frames, (c + 1) * frames), { planeIndex: c, format: 'f32-planar' });
    }

    // The noise suppressor first: what the gate and the meter hear is what is left.
    if (wantDenoise && denoiser && rate === denoiser.rate) {
      denoiser.instance ??= denoiser.mod.createDenoiser(denoiser.rnnoise);
      const mono = new Float32Array(frames);
      for (let c = 0; c < channels; c += 1) {
        for (let i = 0; i < frames; i += 1) mono[i] += samples[c * frames + i] / channels;
      }
      const clean = denoiser.instance.process(mono);
      for (let c = 0; c < channels; c += 1) samples.set(clean, c * frames);
    } else if (wantDenoise && denoiser && !warnedRate) {
      // A microphone that is not at 48 kHz goes through as it is, and the page is told why.
      warnedRate = true;
      self.postMessage({ ai: 'unsupported', rate });
    }

    const openStep = 1 - Math.exp(-1 / (OPEN_TAU * rate));
    const closeStep = 1 - Math.exp(-1 / (CLOSE_TAU * rate));
    const volumeStep = 1 - Math.exp(-1 / (VOLUME_TAU * rate));
    const second = 1 / rate;

    for (let i = 0; i < frames; i += 1) {
      let sum = 0;
      for (let c = 0; c < channels; c += 1) {
        const v = samples[c * frames + i];
        sum += v * v;
      }
      const square = sum / channels;
      total += square - squares[slot];
      squares[slot] = square;
      slot = (slot + 1) % WINDOW;
      clock += second;

      // The running total drifts a little in floating point; it is only a level.
      const rms = Math.sqrt(Math.max(0, total) / WINDOW);
      level = Math.max(rms, level * Math.pow(LEVEL_FALL, second / LEVEL_FALL_SECONDS));

      if (threshold <= 0) {
        open = true;
      } else {
        if (rms >= threshold) openUntil = clock + HOLD_SECONDS;
        open = clock < openUntil;
      }
      gate += ((open ? 1 : 0) - gate) * (open ? openStep : closeStep);
      smoothVolume += (volume - smoothVolume) * volumeStep;

      const g = gate * smoothVolume;
      for (let c = 0; c < channels; c += 1) samples[c * frames + i] *= g;
    }

    const out = new AudioData({
      format: 'f32-planar',
      sampleRate: rate,
      numberOfFrames: frames,
      numberOfChannels: channels,
      timestamp: data.timestamp,
      data: samples,
    });
    data.close();
    await writer.write(out);
    out.close();

    sinceReport += frames * second;
    if (sinceReport >= REPORT_SECONDS) {
      sinceReport = 0;
      self.postMessage({ level, open });
    }
  }
  await writer.close().catch(() => {});
}
