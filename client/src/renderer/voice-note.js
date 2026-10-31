// Voice messages: recorded in the composer, drawn in the chat as a player.
//
// A voice message is an ordinary attachment -- an audio/webm file with a
// recognisable name -- so it travels the way any file does: through the channel's
// upload, or sealed in a private conversation. Nothing about it is known to the
// server. What makes it a voice message is the name (see isVoiceNote), and the
// duration and the waveform are worked out from the sound itself when it is drawn.
//
// Shared by the channels and the private conversations.

export const VOICE_PREFIX = 'voice-message-';
/** The longest recording. At this the recording stops, paused, ready to send. */
export const MAX_VOICE_SECONDS = 15 * 60;
/** Shorter than this is a slip of the finger, not a message. */
const MIN_VOICE_MS = 700;
/** Opus at a speech bit rate: about 250 KB a minute. */
const VOICE_BITS_PER_SECOND = 32_000;

/** What a recording is called: dated, so a downloaded one sorts and does not collide. */
export function voiceNoteName(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${VOICE_PREFIX}${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.webm`;
}

/** Whether an attachment is a voice message: a sound that is called like one. */
export function isVoiceNote(name, mediaType) {
  return mediaType === 'audio' && String(name ?? '').startsWith(VOICE_PREFIX);
}

/** Whether this engine can record at all. */
export const canRecordVoice = () => typeof MediaRecorder === 'function'
  && Boolean(navigator.mediaDevices?.getUserMedia);

const clock = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** One recording: the microphone, the encoder, and the level for the picture. */
export class VoiceRecorder {
  #stream = null;
  #recorder = null;
  #chunks = [];
  #ctx = null;
  #analyser = null;
  #samples = null;
  #startedAt = 0;
  #banked = 0;
  #paused = false;

  async start(deviceId = '') {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    try {
      this.#stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { ...audio, deviceId: { exact: deviceId } } : audio,
      });
    } catch (err) {
      // The chosen microphone is gone: the system's is better than no message.
      if (!deviceId || !['OverconstrainedError', 'NotFoundError'].includes(err?.name)) throw err;
      this.#stream = await navigator.mediaDevices.getUserMedia({ audio });
    }
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    this.#recorder = new MediaRecorder(this.#stream, { mimeType, audioBitsPerSecond: VOICE_BITS_PER_SECOND });
    this.#recorder.ondataavailable = (event) => {
      if (event.data?.size) this.#chunks.push(event.data);
    };
    // A slice a second, so a crash or a long recording is not one piece held until the end.
    this.#recorder.start(1000);

    try {
      // No device to follow or lose: this only listens, for the picture.
      let ctx;
      try {
        ctx = new AudioContext({ sinkId: { type: 'none' } });
      } catch {
        ctx = new AudioContext();
      }
      this.#ctx = ctx;
      this.#analyser = ctx.createAnalyser();
      this.#analyser.fftSize = 1024;
      ctx.createMediaStreamSource(this.#stream).connect(this.#analyser);
      this.#samples = new Float32Array(this.#analyser.fftSize);
    } catch { /* no picture, still a recording */ }
    this.#startedAt = performance.now();
  }

  get paused() {
    return this.#paused;
  }

  get elapsedMs() {
    return this.#banked + (this.#paused ? 0 : performance.now() - this.#startedAt);
  }

  /** How loud it is right now, 0..1. Nothing while paused. */
  get level() {
    if (this.#paused || !this.#analyser) return 0;
    this.#analyser.getFloatTimeDomainData(this.#samples);
    let sum = 0;
    for (const v of this.#samples) sum += v * v;
    return Math.sqrt(sum / this.#samples.length);
  }

  pause() {
    if (this.#paused || !this.#recorder) return;
    this.#recorder.pause();
    this.#banked += performance.now() - this.#startedAt;
    this.#paused = true;
  }

  resume() {
    if (!this.#paused || !this.#recorder) return;
    this.#recorder.resume();
    this.#startedAt = performance.now();
    this.#paused = false;
  }

  /** @returns {Promise<{file: File, ms: number}>} */
  async stop() {
    const ms = this.#recorder ? this.elapsedMs : 0;
    const recorder = this.#recorder;
    if (recorder && recorder.state !== 'inactive') {
      await new Promise((done) => {
        recorder.onstop = done;
        recorder.stop();
      });
    }
    const blob = new Blob(this.#chunks, { type: 'audio/webm' });
    this.#release();
    return { file: new File([blob], voiceNoteName(), { type: 'audio/webm' }), ms };
  }

  cancel() {
    try {
      if (this.#recorder && this.#recorder.state !== 'inactive') this.#recorder.stop();
    } catch { /* already stopped */ }
    this.#release();
  }

  #release() {
    this.#recorder = null;
    this.#chunks = [];
    this.#stream?.getTracks().forEach((track) => track.stop());
    this.#stream = null;
    this.#ctx?.close().catch(() => {});
    this.#ctx = null;
    this.#analyser = null;
  }
}

/**
 * The bar that takes the composer's place while a message is being recorded:
 * discard, the time, how loud it is, pause, send.
 *
 * @param {object} options
 * @param {HTMLElement} options.bar  where it is built (empty, hidden)
 * @param {HTMLElement} options.composer  gets `data-recording` while it is on, for the styles
 * @param {(key: string) => string} options.t
 * @param {() => string} options.deviceId  the microphone chosen in the settings
 * @param {(file: File) => void} options.onSend
 * @param {(message: string) => void} options.onError
 * @param {() => void} [options.onChange]  it opened or closed
 */
export function createRecorderBar({ bar, composer, t, deviceId, onSend, onError, onChange = () => {} }) {
  const button = (className, icon, label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `composer-btn ${className}`;
    b.dataset.icon = icon;
    b.title = label;
    b.setAttribute('aria-label', label);
    return b;
  };
  const trash = button('voice-trash', 'trash', t('voice.discard'));
  const dot = document.createElement('span');
  dot.className = 'voice-dot';
  const time = document.createElement('span');
  time.className = 'voice-time';
  time.textContent = '0:00';
  const canvas = document.createElement('canvas');
  canvas.className = 'voice-live';
  const pause = button('voice-pause', 'pause', t('voice.pause'));
  const send = button('composer-send voice-send', 'paper-plane-right', t('voice.send'));
  bar.replaceChildren(trash, dot, time, canvas, pause, send);

  /** @type {VoiceRecorder|null} */
  let recorder = null;
  let timer = null;
  let history = [];
  let finishing = false;
  // The microphone is open and the encoder running: before that there is nothing to pause or send.
  let ready = false;

  const close = () => {
    clearInterval(timer);
    timer = null;
    recorder = null;
    ready = false;
    bar.removeAttribute('data-ready');
    history = [];
    bar.hidden = true;
    delete composer.dataset.recording;
    document.removeEventListener('keydown', onKey, true);
    onChange();
  };

  function draw() {
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    if (canvas.width !== Math.round(width * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const g = canvas.getContext('2d');
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, width, height);
    const color = getComputedStyle(canvas).color;
    g.fillStyle = color;
    const step = 5;
    const slots = Math.floor(width / step);
    for (let i = 0; i < slots; i += 1) {
      // The newest on the right; before the first, a dotted line.
      const from = history.length - (slots - i);
      const level = from >= 0 ? history[from] : null;
      const barHeight = level === null ? 2 : Math.max(2, Math.min(height, Math.sqrt(level) * height * 2.2));
      g.globalAlpha = level === null ? 0.35 : 1;
      g.fillRect(i * step, (height - barHeight) / 2, 3, barHeight);
    }
    g.globalAlpha = 1;
  }

  function tick() {
    if (!recorder) return;
    history.push(recorder.level);
    if (history.length > 400) history.shift();
    time.textContent = clock(recorder.elapsedMs);
    if (recorder.elapsedMs >= MAX_VOICE_SECONDS * 1000 && !recorder.paused) setPaused(true);
    draw();
  }

  function setPaused(on) {
    if (!recorder || !ready) return;
    if (on) recorder.pause();
    else recorder.resume();
    bar.toggleAttribute('data-paused', on);
    pause.dataset.icon = on ? 'microphone' : 'pause';
    const label = t(on ? 'voice.resume' : 'voice.pause');
    pause.title = label;
    pause.setAttribute('aria-label', label);
  }

  function discard() {
    recorder?.cancel();
    close();
  }

  async function finish() {
    if (!recorder || !ready || finishing) return;
    finishing = true;
    const done = recorder;
    try {
      const { file, ms } = await done.stop();
      close();
      if (ms < MIN_VOICE_MS) onError(t('voice.too_short'));
      else onSend(file);
    } finally {
      finishing = false;
    }
  }

  function onKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      discard();
    } else if (event.key === 'Enter' && !event.shiftKey && !event.target?.closest?.('dialog')) {
      event.preventDefault();
      event.stopPropagation();
      finish();
    }
  }

  trash.addEventListener('click', discard);
  pause.addEventListener('click', () => setPaused(!recorder?.paused));
  send.addEventListener('click', finish);

  return {
    get active() {
      return Boolean(recorder);
    },
    async start() {
      if (recorder) return;
      if (!canRecordVoice()) {
        onError(t('voice.cannot_record'));
        return;
      }
      const next = new VoiceRecorder();
      recorder = next;
      bar.hidden = false;
      composer.dataset.recording = '';
      time.textContent = '0:00';
      bar.removeAttribute('data-paused');
      pause.dataset.icon = 'pause';
      onChange();
      try {
        await next.start(deviceId());
      } catch (err) {
        // Closed while it was asking (a click on the trash): nothing to report.
        if (recorder === next) {
          close();
          onError(err?.name === 'NotAllowedError' ? t('voice.mic_blocked') : t('voice.mic_failed'));
        }
        return;
      }
      if (recorder !== next) {
        next.cancel();
        return;
      }
      ready = true;
      bar.setAttribute('data-ready', '');
      timer = setInterval(tick, 80);
      document.addEventListener('keydown', onKey, true);
      tick();
    },
    /** Drop what is being recorded, if anything: the conversation it was for is gone. */
    cancel() {
      if (recorder) discard();
    },
  };
}

// ---------------------------------------------------------------------------
// Playing
// ---------------------------------------------------------------------------

const BARS = 40;
const SPEEDS = [1, 1.5, 2];
/** What is decoded of a voice message for drawing it: how long, and its waveform. */
const analysed = new Map();
/** The WAV a message is played from, newest last. Kept few: each is a few MB. */
const wavUrls = new Map();
const WAV_KEPT = 6;
/** Players by message, so a chat that is drawn again keeps what is playing. */
const sessions = new Map();
let playing = null;
const DECODE_RATE = 24_000;

async function decode(bytes) {
  const context = new OfflineAudioContext(1, 1, DECODE_RATE);
  return context.decodeAudioData(bytes.slice(0));
}

/** The channels mixed down, one value per sample. */
function mono(buffer) {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i += 1) out[i] += data[i] / buffer.numberOfChannels;
  }
  return out;
}

function peaksOf(samples) {
  const size = Math.max(1, Math.floor(samples.length / BARS));
  const peaks = [];
  for (let b = 0; b < BARS; b += 1) {
    let sum = 0;
    const from = b * size;
    const to = Math.min(samples.length, from + size);
    for (let i = from; i < to; i += 1) sum += samples[i] * samples[i];
    peaks.push(Math.sqrt(sum / Math.max(1, to - from)));
  }
  const top = Math.max(...peaks, 1e-6);
  return peaks.map((p) => Math.max(0.12, Math.sqrt(p / top)));
}

/** 16-bit mono PCM in a WAV: something an <audio> can seek in and slow down, which a recorded webm is not. */
function wavOf(samples, rate) {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const text = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

async function analyse(key, load) {
  if (analysed.has(key)) return analysed.get(key);
  const buffer = await decode(await load());
  const result = { duration: buffer.duration, peaks: peaksOf(mono(buffer)) };
  analysed.set(key, result);
  return result;
}

async function sourceUrl(key, load) {
  const kept = wavUrls.get(key);
  if (kept) {
    // Newest last.
    wavUrls.delete(key);
    wavUrls.set(key, kept);
    return kept;
  }
  const bytes = await load();
  let blob;
  try {
    const buffer = await decode(bytes);
    blob = wavOf(mono(buffer), buffer.sampleRate);
  } catch {
    blob = new Blob([bytes], { type: 'audio/webm' });
  }
  const url = URL.createObjectURL(blob);
  wavUrls.set(key, url);
  while (wavUrls.size > WAV_KEPT) {
    const [oldKey, oldUrl] = wavUrls.entries().next().value;
    // What is playing is not let go of.
    if (sessions.get(oldKey)?.audio && !sessions.get(oldKey).audio.paused) break;
    wavUrls.delete(oldKey);
    URL.revokeObjectURL(oldUrl);
    sessions.delete(oldKey);
  }
  return url;
}

/**
 * A voice message: play, the waveform (press it to move around), the time, the speed.
 *
 * Nothing is fetched or decoded until it is on screen, and what is worked out is
 * kept by `key`, so a chat that is drawn again does not do it again -- or stop
 * the message that is playing.
 *
 * @param {object} options
 * @param {string} options.key  identifies this message's sound
 * @param {() => Promise<ArrayBuffer>} options.load  its bytes
 * @param {() => string} [options.sinkId]  the speakers chosen in the settings
 * @param {() => number} [options.volume]  the volume of the application, 1 being as it is; a sound
 *   element cannot be louder than itself, so what is above 1 plays at full
 * @param {(key: string) => string} options.t
 * @returns {HTMLElement}
 */
export function voiceNote({ key, load, sinkId = () => '', volume = () => 1, t }) {
  const wrap = document.createElement('span');
  wrap.className = 'attachment voice-note';

  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'voice-play';
  play.dataset.icon = 'play';
  play.title = t('voice.play');
  play.setAttribute('aria-label', t('voice.play'));

  const wave = document.createElement('span');
  wave.className = 'voice-bars';
  wave.setAttribute('role', 'slider');
  wave.setAttribute('aria-label', t('voice.message'));
  wave.tabIndex = 0;
  const bars = Array.from({ length: BARS }, () => {
    const bar = document.createElement('span');
    bar.className = 'voice-bar';
    wave.append(bar);
    return bar;
  });

  const time = document.createElement('span');
  time.className = 'voice-length';
  time.textContent = '…';

  const speed = document.createElement('button');
  speed.type = 'button';
  speed.className = 'voice-speed';
  speed.title = t('voice.speed');
  speed.setAttribute('aria-label', t('voice.speed'));
  speed.textContent = '1×';

  wrap.append(play, wave, time, speed);

  let info = analysed.get(key) ?? null;

  const entry = () => sessions.get(key);
  const label = (rate) => `${rate}×`.replace('1.5', '1.5');

  function paintBars(progress) {
    const peaks = info?.peaks;
    bars.forEach((bar, i) => {
      bar.style.height = `${Math.round((peaks ? peaks[i] : 0.2) * 100)}%`;
      bar.toggleAttribute('data-done', (i + 0.5) / BARS <= progress);
    });
    wave.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
  }

  function sync() {
    const e = entry();
    const audio = e?.audio;
    const duration = info?.duration ?? 0;
    const active = Boolean(audio) && !audio.paused;
    play.dataset.icon = active ? 'pause' : 'play';
    play.title = t(active ? 'voice.pause_playback' : 'voice.play');
    play.setAttribute('aria-label', play.title);
    wrap.toggleAttribute('data-playing', active);
    const at = audio && (active || audio.currentTime > 0) ? audio.currentTime : 0;
    paintBars(duration ? Math.min(1, at / duration) : 0);
    time.textContent = info ? clock((active || at > 0 ? at : duration) * 1000) : '…';
    speed.textContent = label(e?.rate ?? 1);
  }

  async function ensureAudio() {
    let e = entry();
    if (e?.audio) return e;
    const url = await sourceUrl(key, load);
    e = entry() ?? { listeners: new Set(), rate: 1 };
    const audio = new Audio(url);
    audio.preservesPitch = true;
    const tell = () => {
      for (const listener of [...e.listeners]) {
        if (listener.wrap.isConnected) listener.sync();
        else e.listeners.delete(listener);
      }
    };
    audio.addEventListener('timeupdate', tell);
    audio.addEventListener('play', tell);
    audio.addEventListener('pause', tell);
    audio.addEventListener('ended', () => {
      audio.currentTime = 0;
      tell();
    });
    e.audio = audio;
    sessions.set(key, e);
    return e;
  }

  const me = { wrap, sync };
  const join = () => {
    const e = entry() ?? { listeners: new Set(), rate: 1 };
    if (!entry()) sessions.set(key, e);
    e.listeners.add(me);
  };
  join();

  async function toggle() {
    const e = await ensureAudio();
    e.listeners.add(me);
    const { audio } = e;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (playing && playing !== audio) playing.pause();
    playing = audio;
    audio.playbackRate = e.rate;
    audio.volume = Math.max(0, Math.min(1, Number(volume()) || 0));
    try {
      if (typeof audio.setSinkId === 'function') await audio.setSinkId(sinkId() || '');
    } catch { /* the default speakers */ }
    if (info && audio.currentTime >= info.duration - 0.05) audio.currentTime = 0;
    await audio.play().catch(() => {});
  }

  async function seek(fraction) {
    const e = await ensureAudio();
    e.listeners.add(me);
    if (!info) return;
    e.audio.currentTime = Math.max(0, Math.min(1, fraction)) * info.duration;
    sync();
  }

  play.addEventListener('click', (event) => {
    event.stopPropagation();
    toggle();
  });
  wave.addEventListener('click', (event) => {
    event.stopPropagation();
    const box = wave.getBoundingClientRect();
    seek((event.clientX - box.left) / box.width);
  });
  wave.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || !info) return;
    event.preventDefault();
    const e = entry();
    const now = e?.audio?.currentTime ?? 0;
    seek((now + (event.key === 'ArrowRight' ? 3 : -3)) / info.duration);
  });
  speed.addEventListener('click', async (event) => {
    event.stopPropagation();
    const e = await ensureAudio();
    e.listeners.add(me);
    e.rate = SPEEDS[(SPEEDS.indexOf(e.rate) + 1) % SPEEDS.length];
    e.audio.playbackRate = e.rate;
    sync();
  });

  async function open() {
    try {
      info = await analyse(key, load);
    } catch {
      time.textContent = '--:--';
      return;
    }
    sync();
  }

  paintBars(0);
  sync();
  if (info) {
    sync();
  } else if (typeof IntersectionObserver === 'function') {
    const watcher = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      watcher.disconnect();
      open();
    }, { rootMargin: '200px' });
    watcher.observe(wrap);
  } else {
    open();
  }

  return wrap;
}
