// The microphone's noise gate, on the audio thread.
//
// It used to be a 25 ms setInterval on the page's main thread, and a main thread
// that is busy -- the camera's background effect segmenting every frame is
// the heavy case -- runs that timer late and in bunches: the gate then opens and
// closes at the wrong moments, and what leaves is chopped and crackly. Here it
// is decided in the same block of samples it is applied to, so nothing the page
// is doing can reach it.
//
// What it does is what the polled version did:
//   * the level is the RMS of the last 1024 samples, read BEFORE the gate;
//   * above the threshold it opens at once, and stays open for 300 ms after the
//     last time it was above (so the ends of words are not chopped);
//   * it opens in about 5 ms and closes in about 40 ms, so neither is a click;
//   * a threshold of 0 means no gate: sound goes straight through.
//
// The page is told the level and whether the gate is open about every 25 ms,
// for the meter. That message is the only thing the page can delay, and it
// delays a drawing, not a sound.

const WINDOW_BLOCKS = 8; // 8 x 128 samples = the 1024 the analyser used
const HOLD_SECONDS = 0.3;
const OPEN_TAU = 0.005;
const CLOSE_TAU = 0.04;
const LEVEL_FALL_SECONDS = 0.025; // the meter falls to 55% in this long
const LEVEL_FALL = 0.55;
const REPORT_SECONDS = 0.025;

class MicGate extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'threshold', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.energy = new Float32Array(WINDOW_BLOCKS);
    this.slot = 0;
    this.level = 0;
    this.open = true;
    this.openUntil = 0;
    this.gain = 1;
    this.sinceReport = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    const frames = output[0]?.length ?? 128;
    const seconds = frames / sampleRate;

    // Mean square of this block, over every channel it has.
    let sum = 0;
    let count = 0;
    for (const channel of input) {
      for (let i = 0; i < channel.length; i += 1) sum += channel[i] * channel[i];
      count += channel.length;
    }
    this.energy[this.slot] = count ? sum / count : 0;
    this.slot = (this.slot + 1) % WINDOW_BLOCKS;
    let total = 0;
    for (let i = 0; i < WINDOW_BLOCKS; i += 1) total += this.energy[i];
    const rms = Math.sqrt(total / WINDOW_BLOCKS);
    this.level = Math.max(rms, this.level * Math.pow(LEVEL_FALL, seconds / LEVEL_FALL_SECONDS));

    const threshold = parameters.threshold[0];
    if (threshold <= 0) {
      this.open = true;
    } else {
      if (rms >= threshold) this.openUntil = currentTime + HOLD_SECONDS;
      this.open = currentTime < this.openUntil;
    }

    const target = this.open ? 1 : 0;
    const coefficient = 1 - Math.exp(-1 / ((this.open ? OPEN_TAU : CLOSE_TAU) * sampleRate));
    for (let c = 0; c < output.length; c += 1) {
      const from = input[c] ?? input[0];
      const to = output[c];
      let g = this.gain;
      for (let i = 0; i < to.length; i += 1) {
        g += (target - g) * coefficient;
        to[i] = from ? from[i] * g : 0;
      }
      if (c === output.length - 1) this.gain = g;
    }

    this.sinceReport += seconds;
    if (this.sinceReport >= REPORT_SECONDS) {
      this.sinceReport = 0;
      this.port.postMessage({ level: this.level, open: this.open });
    }
    return true;
  }
}

registerProcessor('mic-gate', MicGate);
