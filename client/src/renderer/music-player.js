// Music Buddy, on this computer: playing the track the server says is playing, from the place it says it has got to.
//
// Everybody in the voice channel does the same thing with the same two numbers. The server's snapshot says which track
// is current, which file it is (`hash`), and either `startedAt` -- the server's clock when it was at 0:00 -- or, while
// paused, `positionMs`. The snapshot also says what the server's clock read (`serverNow`) when it was sent, so this
// side keeps the difference between that and its own clock and can tell, at any moment, where in the track it ought to
// be. If the file is somewhere else (a late start, a stall, a slow decode) it is moved there; nothing is ever asked of
// the server for it.
//
// That goes for the person who pressed Play as much as for anybody: they do not start anything here. A press is a
// request, the server changes the state and tells everybody -- them too -- and every screen follows the same snapshot
// by the same arithmetic, so there is no "own" copy of the music for the one in control to be ahead or behind with.
//
// How long a snapshot took to arrive is measured, not guessed: calibrate() is given the round trip of a tiny request
// for the server's clock now and then, and half of the shortest recent one is taken as the time a push spends on the
// way. Added to the server's clock in the snapshot, that is what the server's clock reads now.
//
// The sound is the file played by an <audio> element, and the element goes through the same output as every other sound
// in the app (gain.js), so the master volume and the chosen speaker apply. It has its own volume, which is the
// music's, nothing else's.
//
// Tracks are not all recorded at one level, so the server measures each and says in the snapshot how many dB it takes to
// bring a track to a common one (`gainDb`). That is applied here under the listener's volume -- a track that is mastered
// loud is turned down, a quiet one up -- so the volume the listener chose is the volume of every track, not of the
// first. It is one gain (the volume times the track's), so changing track never moves the listener's own setting.

import { playMusicElement } from './gain.js';

/** How far off the file may be, in ms, before it is moved: less than that is not heard as a difference. */
export const DRIFT_MS = 250;

/** How many of the latest round trips to the server are kept: the shortest of them is the one nearest the truth. */
const RTT_SAMPLES = 5;

/** How often a playing track is checked against where it ought to be. */
const CHECK_MS = 5000;

/** The element the music plays from: in the page (so it can be looked at) and out of sight, one for the call. */
function defaultAudio() {
  const element = new Audio();
  element.id = 'music-audio';
  element.hidden = true;
  document.body.append(element);
  return element;
}

/**
 * @param {object} options
 * @param {(hash: string) => string} options.mediaUrl  where a file is played from
 * @param {() => number} [options.now]                this computer's clock, in ms
 * @param {() => HTMLAudioElement} [options.makeAudio]
 * @param {(audio: HTMLAudioElement) => {set: (g: number) => void, dispose: () => void}} [options.attach]
 * @param {(view: object|null) => void} [options.onChange]  the music changed (or the clock, or the volume)
 * @param {() => void} [options.onBlocked]   the browser would not start the sound without a click
 * @param {(error: Error) => void} [options.onError]
 */
export function createMusicPlayer({
  mediaUrl, now = Date.now, makeAudio = defaultAudio, attach = playMusicElement,
  onChange = () => {}, onBlocked = () => {}, onError = () => {},
}) {
  /** The last snapshot, what the server's clock read when it was sent, and what ours read when it arrived. */
  let music = null;
  /** The recent round trips to the server, in ms, and from them how long a push takes to arrive. */
  let rtts = [];
  let latencyMs = 0;
  let audio = null;
  let chain = null;
  let loaded = null;
  let checker = null;
  let gain = 1;
  /** The loudness correction of the track that is playing, as a multiplier: 1 where the track was not measured. */
  let levelling = 1;

  /** The listener's volume and the track's correction, as one gain on the element's output. */
  function applyGain() {
    chain?.set(gain * levelling);
    if (audio) audio.dataset.gain = (gain * levelling).toFixed(3);
  }

  /** What the server's clock reads now: its reading in the snapshot, plus the way it travelled, plus the time since. */
  const serverNow = () => (music ? music.serverNow + latencyMs + (now() - music.at) : now());

  const current = () => {
    const state = music?.state;
    return state?.current ? state.queue.find((t) => t.id === state.current) ?? null : null;
  };

  /** Where in the current track the music ought to be, in ms. */
  function positionMs() {
    const state = music?.state;
    if (!state) return 0;
    if (state.status === 'playing') return Math.max(0, serverNow() - state.startedAt);
    if (state.status === 'paused') return state.positionMs;
    return 0;
  }

  function view() {
    const state = music?.state;
    if (!state) return null;
    return {
      status: state.status,
      track: current(),
      positionMs: positionMs(),
      shuffle: state.shuffle,
      repeat: state.repeat,
      queue: state.queue,
      current: state.current,
      rev: state.rev,
      latencyMs,
    };
  }

  const changed = () => onChange(view());

  function ensureAudio() {
    if (audio) return;
    audio = makeAudio();
    audio.preload = 'auto';
    audio.addEventListener('error', () => onError(new Error(audio?.error?.message || 'could not play the track')));
    audio.addEventListener('loadedmetadata', () => place());
    chain = attach(audio);
    applyGain();
    checker = setInterval(() => {
      if (music?.state.status === 'playing') place();
    }, CHECK_MS);
  }

  /** Put the file where it ought to be, and playing or not as it ought to be. */
  function place() {
    if (!audio || !loaded) return;
    const status = music?.state.status;
    if (audio.readyState < 1) return; // loadedmetadata calls this again
    const want = positionMs() / 1000;
    if (Number.isFinite(audio.duration) && want >= audio.duration) {
      audio.pause();
      return;
    }
    if (Math.abs(audio.currentTime - want) * 1000 > DRIFT_MS) audio.currentTime = want;
    if (status === 'playing') {
      audio.play().catch((err) => {
        if (err?.name === 'NotAllowedError') onBlocked();
        else if (err?.name !== 'AbortError') onError(err);
      });
    } else {
      audio.pause();
    }
  }

  /** Nothing to play: silence, and the file let go of. */
  function halt() {
    if (!audio) return;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    loaded = null;
  }

  function sync() {
    const track = current();
    const status = music?.state.status;
    if (!track?.hash || !['playing', 'paused'].includes(status)) {
      halt();
      return;
    }
    ensureAudio();
    const wanted = typeof track.gainDb === 'number' ? 10 ** (track.gainDb / 20) : 1;
    if (wanted !== levelling) {
      levelling = wanted;
      applyGain();
    }
    // The same track again (the previous one pressed, a seek) is not loaded again: it is only moved.
    const key = `${track.id}:${track.hash}`;
    if (loaded !== key) {
      loaded = key;
      audio.src = mediaUrl(track.hash);
      audio.load();
    }
    place();
  }

  return {
    /** A `music:state` from the server (or the snapshot that came with joining), or null for no music. */
    apply(message) {
      music = message?.state ? { state: message.state, serverNow: message.serverNow, at: now() } : null;
      sync();
      changed();
    },

    /**
     * A heartbeat from the server: where the music is, without the queue. It sets right a client that has drifted, and
     * it is the same arithmetic as a full snapshot. False when it is not for the snapshot held (something changed that
     * this client has not heard of): the caller asks for the whole of it.
     */
    tick(message) {
      if (!music || music.state.rev !== message.rev) return false;
      music = {
        state: { ...music.state, status: message.status, startedAt: message.startedAt, positionMs: message.positionMs },
        serverNow: message.serverNow,
        at: now(),
      };
      sync();
      changed();
      return true;
    },

    /** A round trip to the server's clock, in ms: how far away it is. */
    calibrate(rttMs) {
      if (!(rttMs >= 0)) return;
      rtts = [...rtts, rttMs].slice(-RTT_SAMPLES);
      latencyMs = Math.min(...rtts) / 2;
      if (music?.state.status === 'playing') place();
    },

    /** The music's volume as a gain, 0 to MAX_GAIN; 0 is silence (and is what deafened is). */
    setGain(value) {
      gain = Math.max(0, Number(value) || 0);
      applyGain();
    },

    /** Where the music ought to be, now: for drawing a progress bar. */
    positionMs,
    view,

    /** The call is over: all of it let go of. */
    stop() {
      halt();
      if (checker) clearInterval(checker);
      checker = null;
      chain?.dispose();
      chain = null;
      audio?.remove();
      audio = null;
      music = null;
      rtts = [];
      latencyMs = 0;
      changed();
    },

    /** For the tests: what is actually playing. */
    get audio() { return audio; },
  };
}
