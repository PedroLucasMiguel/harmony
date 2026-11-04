// What the microphone's worker (gate-worker.js) and its worklet (gate-worklet.js) share, for the two
// things that listen to the room and decide for themselves:
//
//   * AutoThreshold   the noise gate's threshold, found rather than set -- the "automatic" input
//                     sensitivity. It learns how loud the room is when nobody is talking and how loud
//                     the voice gets when somebody is, and puts the threshold between the two.
//   * Agc             automatic gain control: a gain that follows the voice, so that a microphone that
//                     is too quiet is brought up to a usable level, and one that is too loud is brought
//                     down, without anybody touching the input volume.
//
// Pure arithmetic, no audio context, no DOM: both run inside a worker or an audio worklet, and the tests
// run them on synthetic sound.

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** Seconds of level in each bucket the room's noise floor is looked up in, and how many buckets are kept. */
const BUCKET_SECONDS = 1;
const BUCKETS = 8;
/** The level is smoothed a little first, so the quietest instant between two syllables is not a single sample. */
const SMOOTH_SECONDS = 0.04;

/**
 * The quietest and the loudest the smoothed level has been over the last few seconds: the first is the
 * room's noise (somebody who talks always stops for breath, and the quietest moment of it is the room),
 * the second is the voice.
 */
export class LevelTracker {
  constructor() {
    this.smooth = 0;
    this.heard = 0;
    this.elapsed = 0;
    this.bucketMin = Infinity;
    this.bucketMax = 0;
    /** @type {number[]} */
    this.mins = [];
    /** @type {number[]} */
    this.maxes = [];
  }

  /** @param {number} level an RMS, 0..1  @param {number} seconds how much sound it is of */
  update(level, seconds) {
    this.smooth = this.heard === 0 ? level : this.smooth + (level - this.smooth) * (1 - Math.exp(-seconds / SMOOTH_SECONDS));
    this.heard += seconds;
    this.bucketMin = Math.min(this.bucketMin, this.smooth);
    this.bucketMax = Math.max(this.bucketMax, this.smooth);
    this.elapsed += seconds;
    if (this.elapsed >= BUCKET_SECONDS) {
      this.mins.push(this.bucketMin);
      this.maxes.push(this.bucketMax);
      if (this.mins.length > BUCKETS - 1) {
        this.mins.shift();
        this.maxes.shift();
      }
      this.elapsed = 0;
      this.bucketMin = Infinity;
      this.bucketMax = 0;
    }
  }

  /** The room, when nobody is talking. */
  get floor() {
    return Math.min(this.bucketMin, ...this.mins);
  }

  /** The voice, when somebody is. */
  get peak() {
    return Math.max(this.bucketMax, ...this.maxes);
  }
}

/** The lowest and the highest threshold the automatic sensitivity will choose: a very clean line, a very noisy one. */
export const AUTO_MIN = 0.0008;
export const AUTO_MAX = 0.06;
/** How far above the room's noise the threshold sits when the voice is loud enough to allow it: about 10 dB. */
const ABOVE_FLOOR = 3;
/** And the least it may sit above it, for a voice that is hardly louder than the room: 4 dB. */
const LEAST_ABOVE_FLOOR = 1.6;
/** It never goes above this share of the voice's own level, or a quiet talker would be cut. */
const SHARE_OF_VOICE = 0.35;

export class AutoThreshold {
  constructor() {
    this.tracker = new LevelTracker();
    this.value = AUTO_MAX;
  }

  /**
   * @param {number} level the RMS of the last stretch of sound, read before the gate
   * @param {number} seconds how much sound that was
   * @returns {number} the threshold to use for the next piece
   */
  update(level, seconds) {
    this.tracker.update(level, seconds);
    const floor = this.tracker.floor;
    const peak = this.tracker.peak;
    let threshold = floor * ABOVE_FLOOR;
    if (peak > 0) threshold = Math.max(floor * LEAST_ABOVE_FLOOR, Math.min(threshold, peak * SHARE_OF_VOICE));
    this.value = clamp(threshold, AUTO_MIN, AUTO_MAX);
    return this.value;
  }
}

/** Where the voice is brought to, as an RMS: -20 dBFS, what speech in a call is normally sent at. */
const TARGET = 0.1;
/** At most 30 dB up -- a microphone that quiet has little else than noise to give, and the noise is brought up too. */
export const AGC_MAX_GAIN = 31.6;
/** And at most 12 dB down, for a microphone that is far too hot. */
export const AGC_MIN_GAIN = 0.25;
/** How fast the gain falls when the voice is louder than it should be (so a shout is not a blast) and how fast it rises. */
const FALL_DB_PER_SECOND = 40;
const RISE_DB_PER_SECOND = 6;
/**
 * The room's noise is brought up with the voice, and is not to be brought up past this (-34 dBFS): a
 * microphone whose room is louder than that gets less gain, because it would only be louder noise.
 */
const NOISE_CEILING = 0.02;
/** Sound counts as a voice when it is this far above the room: below that the gain is left where it is. */
const VOICE_OVER_FLOOR = 2.5;
/** No gain is worked out for sound quieter than this, however quiet the room is. */
const VOICE_LEAST = 0.0006;
/** A peak that would pass this after the gain is not let through: the gain is brought down for that piece. */
const CEILING = 0.95;
/** The soft limiter that is the last thing before the sound goes out: it starts here and never reaches 1. */
const KNEE = 0.8;

const toDb = (x) => 20 * Math.log10(x);
const fromDb = (db) => 10 ** (db / 20);

/** Squeeze what passes the knee towards 1, smoothly, so that nothing is ever clipped flat. */
export function softLimit(sample) {
  const magnitude = Math.abs(sample);
  if (magnitude <= KNEE) return sample;
  const room = 1 - KNEE;
  const squeezed = KNEE + room * Math.tanh((magnitude - KNEE) / room);
  return sample < 0 ? -squeezed : squeezed;
}

export class Agc {
  constructor() {
    this.tracker = new LevelTracker();
    /** The linear gain the voice calls for, as it stood at the end of the last piece. */
    this.gain = 1;
    /** What was actually applied to it: the same, or less for a piece that would have gone over the ceiling. */
    this.applied = 1;
    /** How loud the voice has been lately, as an RMS; 0 before there has been one. */
    this.voice = 0;
  }

  /**
   * Work out the gain for one piece of sound and say where it goes from and to.
   *
   * @param {number} rms the RMS of the piece, before any gain
   * @param {number} peak the largest sample in it, before any gain
   * @param {number} seconds how long it is
   * @returns {{from: number, to: number}} the gain at its start and at its end: ramp between them
   */
  next(rms, peak, seconds) {
    const from = this.applied;
    this.tracker.update(rms, seconds);
    const floor = this.tracker.floor;
    // Voice is what is above the room, in this very piece: a pause between two words is not.
    const isVoice = this.tracker.heard > 0.3 && rms > Math.max(floor * VOICE_OVER_FLOOR, VOICE_LEAST);
    let wanted = this.gain;
    if (isVoice) {
      // How loud the voice is, as it has been over the last moments of voice: quick to follow it up,
      // slower to follow it down, and left alone in a pause.
      this.voice = this.voice === 0 ? rms : this.voice + (rms - this.voice) * (1 - Math.exp(-seconds / (rms > this.voice ? 0.05 : 0.4)));
      const most = this.tracker.heard > 1 && floor > 0 ? clamp(NOISE_CEILING / floor, 1, AGC_MAX_GAIN) : AGC_MAX_GAIN;
      const ideal = clamp(TARGET / this.voice, AGC_MIN_GAIN, most);
      const here = toDb(this.gain);
      const there = toDb(ideal);
      const step = (there < here ? FALL_DB_PER_SECOND : RISE_DB_PER_SECOND) * seconds;
      wanted = fromDb(here + clamp(there - here, -step, step));
    }
    this.gain = clamp(wanted, AGC_MIN_GAIN, AGC_MAX_GAIN);
    // Whatever the gain calls for, this piece must not go over the ceiling. Only this piece: a click
    // on the desk must not leave the voice that follows it turned down for seconds.
    let to = this.gain;
    if (peak * to > CEILING) to = Math.max(CEILING / peak, AGC_MIN_GAIN);
    this.applied = to;
    return { from, to };
  }
}
