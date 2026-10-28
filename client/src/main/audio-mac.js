// System audio minus one application, or one window's application alone, on
// macOS.
//
// The Windows capture addon has no macOS counterpart, and Chromium's own
// loopback cannot leave anything out or pick one thing. ScreenCaptureKit can: a
// content filter that excludes applications also excludes their audio, and one
// on a single window carries only the audio of the application that owns it
// (macOS has no sound per window; it is the application's, as on Windows).
// There is no Node
// binding for it, so a small Swift program (client/native/mac) does the
// capture and writes PCM to its stdout, which is spawned from here.
//
// A child process rather than an addon on purpose: nothing to rebuild per
// Electron version, and nothing in the main process to crash if
// ScreenCaptureKit misbehaves. It still counts as Harmony for the Screen
// Recording permission, since macOS attributes a child to the app that
// launched it, and that permission is already held for the picture.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const processes = require('./processes');
const { alignFrames } = require('./pcm');

const FORMAT = { sampleRate: 48000, channels: 2, bitsPerSample: 16 };

const HELPER = 'harmony-audio-capture';
/** Darwin 22 is macOS 13, the first with audio in ScreenCaptureKit. */
const MIN_DARWIN = 22;
/** Permission prompts and a cold ScreenCaptureKit are slow; this is not. */
const READY_TIMEOUT_MS = 8000;

/** Printed by the helper, keyed by its exit code. */
const EXIT_NOTES = {
  2: 'Screen Recording is not allowed for Harmony. Turn it on in System Settings > Privacy & Security; if it is already on, open the source picker and use "Reset and restart".',
  3: 'There is no display to capture audio from.',
  5: 'That window is not open any more.',
};

let child = null;

function helperPath() {
  const candidates = [
    // Packaged: electron-builder puts it beside the app (see extraResources).
    process.resourcesPath && path.join(process.resourcesPath, HELPER),
    // From a checkout: scripts/build-native.js puts it here.
    path.join(__dirname, '..', '..', 'build', 'native', HELPER),
  ];
  return candidates.find((file) => file && fs.existsSync(file)) ?? null;
}

function availability() {
  if (Number.parseInt(os.release(), 10) < MIN_DARWIN) {
    return { available: false, reason: 'Excluding an application from the audio needs macOS 13 or later.' };
  }
  if (!helperPath()) {
    return {
      available: false,
      reason: 'The audio capture helper is missing. Run "node scripts/build-native.js" in client/ (needs Xcode).',
    };
  }
  return { available: true, reason: null };
}

async function listProcesses() {
  return processes.withSelf(await processes.macApps());
}

function stop() {
  const running = child;
  if (!running) return;
  child = null;
  // Closing stdin is the polite way to stop it; it finishes the capture
  // before exiting. The kill is for a helper that is wedged.
  try { running.stdin.end(); } catch { /* already closed */ }
  const timer = setTimeout(() => running.kill('SIGKILL'), 2000);
  timer.unref?.();
  running.once('exit', () => clearTimeout(timer));
  running.kill('SIGTERM');
}

/**
 * What the helper is asked for. Pure, for the tests.
 *
 * A window wins over everything: its application's audio, and no tree to work
 * out -- ScreenCaptureKit knows which sound belongs to which application.
 */
function helperArgs({ excluded = [], windowId = null } = {}) {
  if (windowId) return ['--include-window', String(windowId)];
  return excluded.length ? ['--exclude-pids', excluded.join(',')] : [];
}

/**
 * The window number in a source id from the picker: "window:1234:0" -> 1234.
 * Null for anything else.
 */
function windowIdOf(sourceId) {
  const match = /^window:(\d+):/.exec(String(sourceId ?? ''));
  const id = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * @param {{excludePid?: number|null, windowId?: number|null}} opts
 * @param {(chunk: Buffer) => void} onChunk
 * @returns {Promise<{mode: string, format: object, note: string|null, pid?: number}>}
 */
async function start({ excludePid = null, windowId = null }, onChunk) {
  stop();

  const { available, reason } = availability();
  if (!available) return { mode: 'none', format: FORMAT, note: `${reason} Sharing without audio.` };

  const excluded = !windowId && excludePid ? [...(await processes.tree(excludePid))] : [];
  const args = helperArgs({ excluded, windowId });

  const running = spawn(helperPath(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
  child = running;
  running.stdout.on('data', alignFrames(onChunk));
  // What the helper says goes in the log: which application it is capturing,
  // whether any sound has arrived. Silence is the failure there is least to
  // go on for, and this is most of what there is.
  let pending = '';
  running.stderr.on('data', (data) => {
    pending += data;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() && line.trim() !== 'ready') console.log(`[audio] mac helper: ${line.trim()}`);
    }
  });

  const outcome = await new Promise((resolve) => {
    let stderr = '';
    const timer = setTimeout(() => resolve({ ok: false, why: 'it did not start in time' }), READY_TIMEOUT_MS);
    const settle = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    running.stderr.on('data', (data) => {
      stderr += data;
      if (/^ready$/m.test(stderr)) settle({ ok: true });
    });
    running.once('error', (err) => settle({ ok: false, why: err.message }));
    running.once('exit', (code) => {
      const detail = /^error: (.*)$/m.exec(stderr)?.[1];
      settle({ ok: false, code, why: EXIT_NOTES[code] ?? detail ?? `it exited with code ${code}` });
    });
  });

  if (!outcome.ok) {
    if (child === running) stop();
    return {
      mode: 'none',
      format: FORMAT,
      note: `Could not capture ${windowId ? "that window's audio" : 'system audio'}: ${outcome.why} Sharing without audio.`,
    };
  }

  // After the start, a capture that dies is somebody's audio going quiet
  // mid-stream. Nothing can be done about it from here but say so.
  running.once('exit', (code) => {
    if (child === running) {
      child = null;
      console.warn(`[audio] the macOS capture helper exited (${code})`);
    }
  });

  if (windowId) return { mode: 'application', format: FORMAT, note: null };
  return excluded.length
    ? { mode: 'system-excluding', format: FORMAT, note: null, pid: excludePid }
    : { mode: 'system', format: FORMAT, note: null };
}

module.exports = {
  start, stop, availability, listProcesses, helperArgs, windowIdOf, FORMAT,
};
