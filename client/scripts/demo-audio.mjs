// The sound of the demo video: a soundtrack, and the clicks that go with the pointer.
//
//   node scripts/demo-audio.mjs [out.wav] [seconds]       (a sample of the music, to listen to)
//
// Both are made here, sample by sample, so there is nothing to license and nothing to download: the music is a few chords
// played by a pad, a bass, a plucked arpeggio and a soft beat, written out as notes below; the clicks are tiny bursts of
// noise and tone. record-demo.mjs lays the clicks where the pointer pressed things, and mixes the two.
//
// Everything is 48 kHz, stereo, as arrays of floats; a WAV is only written at the end.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const RATE = 48000;

// --- a little randomness that is the same every time, so the same recording sounds the same -------------------------------
function noiseSource(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 0xffffffff) * 2 - 1;
  };
}

/** The frequency of a note: A4 is 69 and 440 Hz. */
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
const TAU = Math.PI * 2;

// --- the piece ---------------------------------------------------------------------------------------------------------------------
const BPM = 96;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;

// Chords as notes (MIDI), one to a bar. Two progressions that share their sound: the first is the plain one, the second is
// the same four chords turned round, so a long piece does not feel like one loop.
const C = { name: 'Cmaj7', root: 36, notes: [60, 64, 67, 71] };
const G = { name: 'Gadd9', root: 43, notes: [62, 67, 71, 74] };
const Am = { name: 'Am7', root: 45, notes: [60, 64, 67, 69] };
const F = { name: 'Fmaj7', root: 41, notes: [60, 65, 69, 72] };
const E = { name: 'Em7', root: 40, notes: [59, 62, 67, 71] };
const PROGRESSIONS = [[C, G, Am, F], [Am, F, C, G], [C, E, F, G], [F, G, Am, E]];

/** How much of each part is playing, by the bar of the piece: it builds, rests once, builds again, and ends. */
function arrangement(bar, bars) {
  const last = bars - 1;
  const phase = bar % 16; // sections of 16 bars
  const section = Math.floor(bar / 16);
  const intro = bar < 4;
  const outro = bar >= last - 3;
  return {
    pad: 1,
    arp: intro ? (bar >= 2 ? 0.7 : 0) : outro ? 0.8 : 1,
    bass: intro || outro ? 0 : phase >= 4 || section > 0 ? 1 : 0.8,
    kick: intro || outro ? 0 : section === 0 && phase < 8 ? 0 : 1,
    clap: intro || outro || section === 0 ? 0 : phase >= 8 ? 1 : 0,
    hat: intro || outro ? 0 : section === 0 && phase < 4 ? 0 : 1,
    // a lull, a little before the middle, where the beat drops away
    lull: section === 1 && phase >= 12,
  };
}

/** The pieces of the sound. Each adds into a stereo pair of buffers: `l`, `r`, from `at` seconds. */
function addTo(l, r, at, samples, gain = 1, pan = 0) {
  const start = Math.round(at * RATE);
  const left = gain * Math.cos(((pan + 1) * Math.PI) / 4);
  const right = gain * Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = 0; i < samples.length; i += 1) {
    const at2 = start + i;
    if (at2 < 0 || at2 >= l.length) continue;
    l[at2] += samples[i] * left;
    r[at2] += samples[i] * right;
  }
}

/** A held note for a pad: a few slightly detuned waves under a slow swell. */
function padNote(freq, seconds) {
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  const detunes = [-6, -2, 3, 7].map((cents) => 2 ** (cents / 1200));
  const attack = 0.9;
  const release = 1.4;
  for (let i = 0; i < n; i += 1) {
    const t = i / RATE;
    let v = 0;
    for (const d of detunes) {
      const ph = TAU * freq * d * t;
      // a triangle-ish wave with its edges rounded off: warm and not buzzy
      v += Math.sin(ph) + 0.3 * Math.sin(2 * ph) + 0.08 * Math.sin(3 * ph);
    }
    const env = Math.min(1, t / attack) * Math.min(1, (seconds - t) / release);
    out[i] = (v / detunes.length) * env * env * (1 + 0.06 * Math.sin(TAU * 0.23 * t));
  }
  return out;
}

/** A plucked note: a sine with a bright start that dies away quickly. */
function pluck(freq, seconds = 0.9) {
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / RATE;
    const ph = TAU * freq * t;
    const bright = Math.exp(-t * 16);
    const body = Math.exp(-t * 4.2);
    out[i] = (Math.sin(ph) * body + 0.45 * Math.sin(2 * ph) * bright * 0.8 + 0.18 * Math.sin(3 * ph) * bright)
      * Math.min(1, t / 0.003);
  }
  return out;
}

function bassNote(freq, seconds) {
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / RATE;
    const ph = TAU * freq * t;
    const env = Math.min(1, t / 0.012) * Math.exp(-t * 2.2) * Math.min(1, (seconds - t) / 0.06);
    out[i] = (Math.sin(ph) + 0.28 * Math.sin(2 * ph)) * env;
  }
  return out;
}

function kick() {
  const n = Math.round(0.4 * RATE);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / RATE;
    const f = 48 + 90 * Math.exp(-t * 32);
    phase += (TAU * f) / RATE;
    out[i] = Math.sin(phase) * Math.exp(-t * 9) * Math.min(1, t / 0.002);
  }
  return out;
}

function hat(noise, open = false) {
  const seconds = open ? 0.18 : 0.045;
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / RATE;
    const x = noise();
    // a high-pass by differencing, twice: nothing below the hiss survives
    const hp = x - prev;
    prev = x;
    out[i] = hp * Math.exp(-t * (open ? 22 : 90));
  }
  return out;
}

function clap(noise) {
  const n = Math.round(0.22 * RATE);
  const out = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i += 1) {
    const t = i / RATE;
    // three quick taps and a tail, through a band that keeps the middle
    const taps = [0, 0.011, 0.022].reduce((a, d) => a + (t >= d ? Math.exp(-(t - d) * 120) : 0), 0);
    lp += 0.35 * (noise() - lp);
    out[i] = (lp - 0.2 * noise()) * (taps * 0.5 + Math.exp(-t * 18) * 0.45);
  }
  return out;
}

/** A reverb of the cheapest kind: parallel combs, then two all-passes, a little different on each side. */
function reverb(buffer, side, { mix = 0.28, size = 1 } = {}) {
  const combs = (side === 0 ? [1557, 1617, 1491, 1422] : [1580, 1640, 1514, 1445]).map((d) => Math.round(d * size));
  const gain = 0.82;
  const out = new Float32Array(buffer.length);
  for (const delay of combs) {
    const line = new Float32Array(delay);
    let damp = 0;
    let pos = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      const echoed = line[pos];
      damp += 0.35 * (echoed - damp);
      line[pos] = buffer[i] + damp * gain;
      out[i] += echoed * 0.25;
      pos = (pos + 1) % delay;
    }
  }
  for (const delay of [225, 556]) {
    const line = new Float32Array(delay);
    let pos = 0;
    for (let i = 0; i < out.length; i += 1) {
      const echoed = line[pos];
      const input = out[i];
      line[pos] = input + echoed * 0.5;
      out[i] = echoed - input * 0.5;
      pos = (pos + 1) % delay;
    }
  }
  const dry = new Float32Array(buffer);
  for (let i = 0; i < buffer.length; i += 1) buffer[i] = dry[i] * (1 - mix * 0.5) + out[i] * mix * 1.6;
}

/** A ping-pong echo for the arpeggio: each repeat on the other side, a little darker. */
function pingPong(l, r, delaySeconds, feedback = 0.38, mix = 0.5) {
  const d = Math.round(delaySeconds * RATE);
  const outL = new Float32Array(l.length);
  const outR = new Float32Array(r.length);
  let lpL = 0;
  let lpR = 0;
  for (let i = 0; i < l.length; i += 1) {
    const fromL = i >= d ? outR[i - d] : 0;
    const fromR = i >= d ? outL[i - d] : 0;
    lpL += 0.5 * (fromL - lpL);
    lpR += 0.5 * (fromR - lpR);
    outL[i] = l[i] * 0.5 + lpL * feedback;
    outR[i] = r[i] * 0.5 + lpR * feedback;
  }
  for (let i = 0; i < l.length; i += 1) {
    l[i] += outL[i] * mix;
    r[i] += outR[i] * mix;
  }
}

/**
 * The soundtrack: `seconds` long, with the ends faded.
 * @returns {{ l: Float32Array, r: Float32Array }}
 */
export function renderSoundtrack(seconds) {
  const total = Math.ceil(seconds * RATE) + RATE;
  const bars = Math.ceil(seconds / BAR) + 1;
  const noise = noiseSource(7);
  const rand = noiseSource(11);

  // Each part in a buffer of its own, so that each can be given the room it needs.
  const mk = () => ({ l: new Float32Array(total), r: new Float32Array(total) });
  const pads = mk();
  const arps = mk();
  const lows = mk();
  const beat = mk();
  const hats = mk();

  for (let bar = 0; bar < bars; bar += 1) {
    const progression = PROGRESSIONS[Math.floor(bar / 4) % PROGRESSIONS.length];
    const chord = progression[bar % 4];
    const part = arrangement(bar, bars);
    const t0 = bar * BAR;

    // the pad: the chord, spread over two octaves, held for the bar and a bit
    if (part.pad) {
      chord.notes.forEach((note, i) => {
        addTo(pads.l, pads.r, t0 - 0.05, padNote(hz(note), BAR + 0.55), 0.11 * part.pad, -0.55 + i * 0.37);
      });
      addTo(pads.l, pads.r, t0 - 0.05, padNote(hz(chord.root + 12), BAR + 0.55), 0.09, 0);
    }

    // the arpeggio: eighth notes up and down through the chord, an octave higher
    if (part.arp) {
      const order = [0, 1, 2, 3, 2, 1, 2, 3];
      for (let i = 0; i < 8; i += 1) {
        // an eighth is left out here and there, so it breathes
        if (part.lull ? i % 2 === 1 : (i === 5 && bar % 2 === 0)) continue;
        const note = chord.notes[order[i]] + 12;
        const pan = Math.sin(((bar * 8 + i) * Math.PI) / 5) * 0.45;
        addTo(arps.l, arps.r, t0 + i * (BEAT / 2), pluck(hz(note)), 0.16 * part.arp * (i % 4 === 0 ? 1 : 0.78), pan);
      }
    }

    // the bass: the root on the beat, and again before the next chord
    if (part.bass && !part.lull) {
      const lengths = [[0, 1.5], [1.5, 0.9], [2.5, 0.9], [3.5, 0.5]];
      lengths.forEach(([beatAt, beats], i) => {
        if (i === 3 && bar % 2 === 0) return;
        const note = i === 2 && bar % 4 === 3 ? chord.root + 7 : chord.root;
        addTo(lows.l, lows.r, t0 + beatAt * BEAT, bassNote(hz(note), beats * BEAT), 0.34 * part.bass, 0);
      });
    }

    // the beat: a kick on one and the "and" of two, a clap on two and four, hats on the eighths
    if (part.kick && !part.lull) {
      for (const at of [0, 1.5, 2, 3.5]) {
        if (at === 3.5 && bar % 4 !== 3) continue;
        addTo(beat.l, beat.r, t0 + at * BEAT, kick(), 0.42 * part.kick, 0);
      }
    }
    if (part.clap) {
      for (const at of [1, 3]) addTo(beat.l, beat.r, t0 + at * BEAT, clap(noise), 0.2, 0.1);
    }
    if (part.hat) {
      for (let i = 0; i < 8; i += 1) {
        const open = i === 7 && bar % 2 === 1;
        const swing = i % 2 === 1 ? BEAT * 0.03 : 0;
        const accent = i % 2 === 0 ? 1 : 0.62;
        addTo(hats.l, hats.r, t0 + i * (BEAT / 2) + swing, hat(noise, open), 0.05 * accent * (0.85 + 0.3 * Math.abs(rand())), i % 2 ? 0.25 : -0.25);
      }
    }
  }

  // Space: the pad and the arpeggio are in a room, the arpeggio has its echo; the low end and the beat stay dry.
  for (const part of [pads, arps]) {
    reverb(part.l, 0, { mix: part === pads ? 0.35 : 0.3 });
    reverb(part.r, 1, { mix: part === pads ? 0.35 : 0.3 });
  }
  pingPong(arps.l, arps.r, BEAT * 0.75);

  const l = new Float32Array(total);
  const r = new Float32Array(total);
  for (const part of [pads, arps, lows, beat, hats]) {
    for (let i = 0; i < total; i += 1) {
      l[i] += part.l[i];
      r[i] += part.r[i];
    }
  }

  // The pad swells out of the bass and the kick a little, as a sidechain would, so the low end stays clear.
  for (let bar = 0; bar < bars; bar += 1) {
    const part = arrangement(bar, bars);
    if (!part.kick || part.lull) continue;
    for (const at of [0, 1.5, 2]) {
      const start = Math.round((bar * BAR + at * BEAT) * RATE);
      const length = Math.round(0.22 * RATE);
      for (let i = 0; i < length && start + i < total; i += 1) {
        const duck = 1 - 0.28 * Math.exp((-i / length) * 5);
        l[start + i] *= duck;
        r[start + i] *= duck;
      }
    }
  }

  // The ends: a slow rise in, a long fall out, and a soft ceiling so nothing is ever harsh.
  const n = Math.round(seconds * RATE);
  const fadeIn = 3 * RATE;
  const fadeOut = 6 * RATE;
  let peak = 0;
  for (let i = 0; i < n; i += 1) peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
  const norm = peak > 0 ? 0.85 / peak : 1;
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const env = Math.min(1, i / fadeIn) * Math.min(1, (n - i) / fadeOut);
    const shape = env * env * (3 - 2 * env);
    outL[i] = Math.tanh(l[i] * norm * 1.1) * shape;
    outR[i] = Math.tanh(r[i] * norm * 1.1) * shape;
  }
  return { l: outL, r: outR };
}

// --- the clicks -----------------------------------------------------------------------------------------------------------------
/**
 * What is heard when things are pressed, as short sounds:
 *
 *   click   the mouse: a tick and a tiny knock
 *   key     a key in a text box: lighter, and a little different each time
 *   send    a message is sent: two soft notes going up
 *   toggle  a switch is flipped: a single low pop
 *   whoosh  a card or a panel sweeping in
 */
export function clickSound(kind, variant = 0) {
  const noise = noiseSource(1000 + variant);
  const make = (seconds, fn) => {
    const n = Math.round(seconds * RATE);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i += 1) out[i] = fn(i / RATE, i);
    return out;
  };
  switch (kind) {
    case 'key': {
      const pitch = 1500 + (variant % 5) * 170 + noise() * 60;
      return make(0.05, (t) => {
        const env = Math.exp(-t * 150);
        return (noise() * 0.5 + Math.sin(TAU * pitch * t) * 0.7) * env * 0.5;
      });
    }
    case 'send': {
      return make(0.34, (t) => {
        const a = Math.sin(TAU * 659.25 * t) * Math.exp(-t * 16);
        const b = t > 0.07 ? Math.sin(TAU * 987.77 * (t - 0.07)) * Math.exp(-(t - 0.07) * 13) : 0;
        return (a * 0.6 + b * 0.7) * Math.min(1, t / 0.002) * 0.75;
      });
    }
    case 'toggle': {
      return make(0.12, (t) => {
        const f = 260 - 90 * t / 0.12;
        return (Math.sin(TAU * f * t) * Math.exp(-t * 42) + noise() * 0.3 * Math.exp(-t * 400)) * 0.9;
      });
    }
    case 'whoosh': {
      let lp = 0;
      return make(0.7, (t) => {
        const a = Math.sin((Math.PI * t) / 0.7) ** 2;
        lp += (0.05 + 0.5 * a * a) * (noise() - lp);
        return lp * a * 1.4;
      });
    }
    case 'click':
    default: {
      const pitch = 1050 + noise() * 80;
      return make(0.09, (t) => {
        const tick = noise() * Math.exp(-t * 700);
        const knock = Math.sin(TAU * pitch * t) * Math.exp(-t * 95);
        const thump = Math.sin(TAU * 170 * t) * Math.exp(-t * 60);
        return (tick * 0.55 + knock * 0.42 + thump * 0.3) * Math.min(1, t / 0.0006);
      });
    }
  }
}

/**
 * The clicks of the video, at the times they happened.
 * @param {{ at: number, kind: string }[]} events  `at` is seconds into the video
 * @returns {{ l: Float32Array, r: Float32Array }}
 */
export function renderClicks(events, seconds) {
  const n = Math.round(seconds * RATE);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  events.forEach((event, i) => {
    const gain = { click: 0.7, key: 0.32, send: 0.5, toggle: 0.65, whoosh: 0.22 }[event.kind] ?? 0.6;
    // Each a little to one side, so a run of keys is not one fixed point in the middle.
    const pan = Math.sin(i * 1.7) * 0.25;
    addTo(l, r, event.at, clickSound(event.kind, i), gain, pan);
  });
  return { l, r };
}

/** Floats to a 16-bit stereo WAV. */
export function wavOf({ l, r }) {
  const n = l.length;
  const buffer = Buffer.alloc(44 + n * 4);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + n * 4, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(RATE, 24);
  buffer.writeUInt32LE(RATE * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(n * 4, 40);
  const clip = (x) => Math.max(-1, Math.min(1, x));
  for (let i = 0; i < n; i += 1) {
    buffer.writeInt16LE(Math.round(clip(l[i]) * 32767), 44 + i * 4);
    buffer.writeInt16LE(Math.round(clip(r[i]) * 32767), 46 + i * 4);
  }
  return buffer;
}

/**
 * The whole sound of a video: the music under the clicks.
 * @param {{ at: number, kind: string }[]} events
 */
export function renderDemoAudio(events, seconds, { music = 0.5 } = {}) {
  const track = renderSoundtrack(seconds);
  const clicks = renderClicks(events, seconds);
  const l = new Float32Array(track.l.length);
  const r = new Float32Array(track.r.length);
  for (let i = 0; i < l.length; i += 1) {
    l[i] = Math.tanh(track.l[i] * music + clicks.l[i] * 0.9);
    r[i] = Math.tanh(track.r[i] * music + clicks.r[i] * 0.9);
  }
  return { l, r };
}

// Run on its own: the music alone, to hear it.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ?? 'demo-music.wav';
  const seconds = Number(process.argv[3] ?? 60);
  const started = Date.now();
  const sample = renderDemoAudio(
    [{ at: 4, kind: 'click' }, { at: 4.6, kind: 'key' }, { at: 4.7, kind: 'key' }, { at: 4.8, kind: 'key' }, { at: 6, kind: 'send' }, { at: 8, kind: 'toggle' }, { at: 9, kind: 'whoosh' }],
    seconds,
  );
  writeFileSync(out, wavOf(sample));
  console.log(`Wrote ${out} (${seconds}s) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
