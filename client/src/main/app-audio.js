// Audio capture.
//
// The rule the client implements: sharing a whole screen sends the whole
// system's audio; sharing a single window sends only that application's audio.
//
// Chromium cannot do the second half -- its loopback capture is system-wide.
// Per-process capture needs the Windows WASAPI process-loopback API
// (AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK), which `loopback-capture`
// exposes as a native addon. It is an optional dependency: if it is missing or
// the platform is unsupported we say so plainly and let the caller decide
// between silence and system audio, rather than quietly leaking every other
// app's sound into the stream.
//
// Keeping one application OUT of a whole-screen share -- the default being
// Harmony itself, so the channel does not hear its own voices back -- is a
// separate question from capturing a single window, and it is the half that has
// a counterpart elsewhere: audio-mac.js (ScreenCaptureKit) and audio-linux.js
// (PipeWire). Capturing only one window's audio is still Windows-only.
//
// Chunks are interleaved signed 16-bit little-endian PCM, stereo, 48 kHz.

const { resolveWindowPid } = require('./sources');

const FORMAT = { sampleRate: 48000, channels: 2, bitsPerSample: 16 };

/*
 * Loaded on first use, not when this module is required.
 *
 * index.js requires this file before the window exists, so a top-level
 * require put a native DLL load -- and the antivirus scan Windows does on
 * loading one from a fresh path -- between double-clicking the app and
 * seeing it. Nothing needs the addon until somebody asks whether per-app
 * audio is available, which the renderer does after it has painted.
 */
let addon = null;
let loadError = null;
let loaded = false;

function loadAddon() {
  if (loaded) return addon;
  loaded = true;
  try {
    addon = require('loopback-capture');
  } catch (err) {
    loadError = err.message;
  }
  return addon;
}

let capture = null;

/** The platform's way of excluding an app from system audio, where the addon is not it. */
function excluder() {
  if (process.platform === 'darwin') return require('./audio-mac');
  if (process.platform === 'linux') return require('./audio-linux');
  return null;
}

/** The Windows addon: capturing ONE application's audio, and excluding one. */
function addonAvailability() {
  if (loadAddon()) return { available: true, reason: null };
  if (process.platform !== 'win32') {
    return { available: false, reason: `Per-application audio is Windows-only (this is ${process.platform}).` };
  }
  return {
    available: false,
    reason: `The native audio module did not load: ${loadError ?? 'unknown error'}`,
  };
}

/**
 * What this machine can do about audio.
 *
 *   available  capture a single window's audio (the Windows addon)
 *   exclusion  leave one application out of a whole-screen share's audio --
 *              the addon on Windows, a platform backend on macOS and Linux
 */
async function availability() {
  const native = addonAvailability();
  if (native.available) return { ...native, exclusion: true, exclusionReason: null };

  const backend = excluder();
  const found = backend ? await backend.availability() : { available: false, reason: null };
  return { ...native, exclusion: found.available, exclusionReason: found.reason };
}

function stop() {
  excluder()?.stop();
  if (!capture) return;
  try {
    capture.stop();
  } catch (err) {
    console.warn('[audio] stop failed:', err.message);
  }
  capture = null;
}

/**
 * @param {object} opts
 * @param {'screen'|'window'|'camera'} opts.kind
 * @param {string} opts.sourceId
 * @param {string} opts.sourceName
 * @param {'silent'|'system'} opts.fallback  what to do if per-app capture is impossible
 * @param {number|null} opts.excludePid  screen shares only: keep this process
 *   tree out of the captured audio (a voice-chat app, typically)
 * @param {(chunk: Buffer) => void} onChunk
 * @returns {Promise<{mode: string, format: object, note: string|null}>}
 */
async function start({ kind, sourceId, sourceName, fallback = 'silent', excludePid = null }, onChunk) {
  stop();

  // A camera or capture card takes its sound from an input device, which the
  // renderer handles through Web Audio. Nothing to capture here.
  if (kind === 'camera') {
    return { mode: 'device', format: FORMAT, note: null };
  }

  const { available, reason } = addonAvailability();

  // No addon, but the platform has its own way of leaving an app out of the
  // mix. Only for a screen: a single window's audio is not something either
  // of them can isolate, so that case carries on to the fallback below.
  const backend = excluder();
  if (!available && kind === 'screen' && backend && (await backend.availability()).available) {
    return backend.start({ excludePid }, onChunk);
  }

  if (!available) {
    // No native capture at all. A screen share can still fall back to
    // Chromium's own loopback (handled in the renderer); a window share obeys
    // the configured fallback.
    return {
      mode: kind === 'screen' || fallback === 'system' ? 'chromium-loopback' : 'none',
      format: FORMAT,
      note: excludePid ? `${reason} Excluding an app's audio is not possible without it.` : reason,
    };
  }

  capture = new addon.LoopbackCapture();

  if (kind === 'screen') {
    if (excludePid) {
      // includeProcessTree: false selects Windows'
      // PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE -- everything the
      // machine is playing except this process and its children.
      try {
        capture.start(excludePid, false, onChunk);
        return { mode: 'system-excluding', format: FORMAT, note: null, pid: excludePid };
      } catch (err) {
        stop();
        capture = new addon.LoopbackCapture();
        capture.startSystemAudio(onChunk);
        return {
          mode: 'system',
          format: FORMAT,
          note: `Could not exclude that app (${err.message}); sharing all system audio.`,
        };
      }
    }
    capture.startSystemAudio(onChunk);
    return { mode: 'system', format: FORMAT, note: null };
  }

  const pid = await resolveWindowPid(sourceId, sourceName);

  if (!pid) {
    stop();
    const note = `Could not identify the process behind "${sourceName}".`;
    if (fallback === 'system') {
      capture = new addon.LoopbackCapture();
      capture.startSystemAudio(onChunk);
      return { mode: 'system', format: FORMAT, note: `${note} Falling back to system audio.` };
    }
    return { mode: 'none', format: FORMAT, note: `${note} Sharing without audio.` };
  }

  try {
    // includeProcessTree: true -- browsers and Electron apps play audio from
    // child processes, so capturing only the parent PID would yield silence.
    capture.start(pid, true, onChunk);
  } catch (err) {
    stop();
    return { mode: 'none', format: FORMAT, note: `Audio capture failed: ${err.message}` };
  }

  return { mode: 'application', format: FORMAT, note: null, pid };
}

module.exports = { start, stop, availability, FORMAT };
