// Push to talk's global key hook.
//
// A global SHORTCUT (hotkeys.js) is told when a combination is pressed and never
// when it is let go, which is half of what push to talk is. Only a hook on the
// keyboard sees both, so this loads one -- uiohook-napi -- and, deliberately,
// only while it is needed:
//
//   * not at all unless the person turned push to talk on and picked a key;
//   * running only while they are in a voice channel (the renderer starts and
//     stops it with the call);
//   * and answering only for the one bound key. Nothing else it sees is kept,
//     logged or sent anywhere, and nothing is passed on but "held" or "not".
//
// The binding may be a button of the mouse as well ("Mouse4", the one under the thumb).
//
// The hook only LISTENS: the key still reaches whatever has focus, so a bare V
// bound here still types a V. That is why, unlike a global shortcut, it needs no
// modifier.
//
// It is optional on every front. The package is an optionalDependency; macOS
// needs the Accessibility permission to deliver key events at all; X11 is
// needed on Linux. When any of those is missing this says why, and the
// renderer falls back to the key while Harmony has focus.

const { execFile } = require('node:child_process');
const { app, shell } = require('electron');

const { parse, createMatcher } = require('./ptt-match');
const keyHook = require('./key-hook');

const IS_MAC = process.platform === 'darwin';
const BUNDLE_ID = 'com.harmony.client';
const SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

let matcher = null;
let sub = null;

/**
 * Start watching for one binding: a key, or a button of the mouse.
 *
 * @param {string} accelerator
 * @param {(held: boolean) => void} onChange
 * @returns {{ok: boolean, error?: 'disabled'|'unavailable'|'invalid'|'permission'}}
 */
function start(accelerator, onChange) {
  stop();
  const { keys, error } = keyHook.keycodes();
  if (!keys) return { ok: false, error };
  const binding = parse(accelerator, keys);
  if (!binding) return { ok: false, error: 'invalid' };

  matcher = createMatcher(binding, onChange);
  const heard = keyHook.subscribe({
    keydown: (e) => matcher?.keydown(e),
    keyup: (e) => matcher?.keyup(e),
    mousedown: (e) => matcher?.mousedown(e),
    mouseup: (e) => matcher?.mouseup(e),
  });
  if (!heard.ok) {
    matcher = null;
    return { ok: false, error: heard.error };
  }
  sub = heard;
  return { ok: true };
}

/** Stop, and say "not held" if the key was down: nothing may be left open. */
function stop() {
  matcher?.reset();
  matcher = null;
  sub?.off();
  sub = null;
}

function openSettings() {
  if (!IS_MAC) return false;
  shell.openExternal(SETTINGS_URL);
  return true;
}

/**
 * Forget macOS's stored Accessibility entry for Harmony, as the screen
 * recording one is (screen-permission.js): an entry left by an earlier copy of
 * the app can read as switched on and still refuse this one.
 */
function resetAccess() {
  if (!IS_MAC || !app.isPackaged) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('tccutil', ['reset', 'Accessibility', BUNDLE_ID], (err) => resolve(!err));
  });
}

module.exports = { start, stop, openSettings, resetAccess };
