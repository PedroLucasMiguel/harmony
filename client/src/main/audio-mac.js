// System audio minus one application, on macOS.
//
// The Windows capture addon has no macOS counterpart, and Chromium's own
// loopback cannot leave anything out. ScreenCaptureKit can: a content filter
// that excludes applications also excludes their audio. There is no Node
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
  2: 'Allow Screen Recording for Harmony in System Settings > Privacy & Security, then share again.',
  3: 'There is no display to capture audio from.',
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
 * @param {{excludePid: number|null}} opts
 * @param {(chunk: Buffer) => void} onChunk
 * @returns {Promise<{mode: string, format: object, note: string|null, pid?: number}>}
 */
async function start({ excludePid = null }, onChunk) {
  stop();

  const { available, reason } = availability();
  if (!available) return { mode: 'none', format: FORMAT, note: `${reason} Sharing without audio.` };

  const excluded = excludePid ? [...(await processes.tree(excludePid))] : [];
  const args = excluded.length ? ['--exclude-pids', excluded.join(',')] : [];

  const running = spawn(helperPath(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
  child = running;
  running.stdout.on('data', alignFrames(onChunk));

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
      note: `Could not capture system audio: ${outcome.why} Sharing without audio.`,
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

  return excluded.length
    ? { mode: 'system-excluding', format: FORMAT, note: null, pid: excludePid }
    : { mode: 'system', format: FORMAT, note: null };
}

module.exports = { start, stop, availability, listProcesses, FORMAT };
