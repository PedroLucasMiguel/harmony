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
// Chunks are interleaved signed 16-bit little-endian PCM, stereo, 48 kHz.

const { resolveWindowPid } = require('./sources');

const FORMAT = { sampleRate: 48000, channels: 2, bitsPerSample: 16 };

let addon = null;
let loadError = null;
try {
  addon = require('loopback-capture');
} catch (err) {
  loadError = err.message;
}

let capture = null;

function availability() {
  if (addon) return { available: true, reason: null };
  if (process.platform !== 'win32') {
    return { available: false, reason: `Per-application audio is Windows-only (this is ${process.platform}).` };
  }
  return {
    available: false,
    reason: `The native audio module did not load: ${loadError ?? 'unknown error'}`,
  };
}

function stop() {
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

  const { available, reason } = availability();

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
