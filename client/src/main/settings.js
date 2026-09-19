// Tiny JSON-file settings store. Keeps the server address and the user's last
// username/quality choice between runs, which matters for the portable build --
// there is no installer to write them for us.

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(app.getPath('userData'), 'settings.json');

const DEFAULTS = {
  serverUrl: '',
  username: '',
  quality: 'balanced',
  // 'sharp' keeps resolution and drops frames; 'smooth' does the opposite.
  priority: 'sharp',
  // Last audio input used with a camera or capture card.
  audioInputId: '',
  // Rolling clip buffer. Off by default: it is memory the user did not ask for.
  clipsEnabled: false,
  // What to do when a window is shared but per-application audio is not
  // available (non-Windows, or the native module is missing).
  //   'silent' -- send no audio, never leak other apps' sound
  //   'system' -- fall back to whole-system audio
  windowAudioFallback: 'silent',
};

let cache = null;

function read() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function write(patch) {
  cache = { ...read(), ...patch };
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.warn('[settings] could not persist:', err.message);
  }
  return cache;
}

module.exports = { read, write, DEFAULTS };
