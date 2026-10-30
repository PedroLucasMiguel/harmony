// The global keyboard and mouse hook, shared by push to talk and the hotkeys that
// a global shortcut cannot take: the extra mouse buttons, the numpad's Enter, and
// the numpad with its Num Lock off.
//
// A global SHORTCUT (hotkeys.js) is told when a combination is pressed, never when
// it is let go, and it knows no mouse. Only a hook on the devices sees both, so this
// loads one -- uiohook-napi -- and, deliberately, only while somebody is listening:
//
//   * not at all unless a binding needs it;
//   * each listener answers for its own bindings and keeps nothing it sees;
//   * the hook only LISTENS: the key or button still reaches whatever has focus.
//
// It is optional on every front. The package is an optionalDependency; macOS needs
// the Accessibility permission to deliver events at all; X11 is needed on Linux.
// When any of those is missing this says why, and the callers fall back or report.
//
// Several listeners share one running hook: it starts with the first and stops
// with the last, so push to talk letting go does not stop the hotkeys.

const { systemPreferences } = require('electron');

const IS_MAC = process.platform === 'darwin';
const EVENTS = ['keydown', 'keyup', 'mousedown', 'mouseup'];

let mod = null;
let running = false;
let listeners = 0;

function load() {
  if (mod) return mod;
  try {
    mod = require('uiohook-napi');
  } catch (err) {
    console.warn('[key-hook] not available:', err.message);
    mod = null;
  }
  return mod;
}

/**
 * The hook's key table, or null with why not: `disabled` (tests, and anybody who
 * wants no hook at all) or `unavailable`.
 * @returns {{keys: Record<string, number>|null, error?: 'disabled'|'unavailable'}}
 */
function keycodes() {
  if (process.env.HARMONY_NO_KEY_HOOK) return { keys: null, error: 'disabled' };
  const m = load();
  return m ? { keys: m.UiohookKey } : { keys: null, error: 'unavailable' };
}

/**
 * Listen. `handlers` is any of {keydown, keyup, mousedown, mouseup}.
 *
 * @param {Partial<Record<'keydown'|'keyup'|'mousedown'|'mouseup', (e: object) => void>>} handlers
 * @param {{prompt?: boolean}} [options]  macOS: ask for the Accessibility permission when it is missing
 * @returns {{ok: true, off: () => void} | {ok: false, error: 'disabled'|'unavailable'|'permission'}}
 */
function subscribe(handlers, { prompt = true } = {}) {
  const { keys, error } = keycodes();
  if (!keys) return { ok: false, error };
  if (IS_MAC && !systemPreferences.isTrustedAccessibilityClient(prompt)) return { ok: false, error: 'permission' };

  const hook = mod.uIOhook;
  for (const type of EVENTS) if (handlers[type]) hook.on(type, handlers[type]);
  if (!running) {
    try {
      hook.start();
      running = true;
    } catch (err) {
      console.warn('[key-hook] could not start:', err.message);
      for (const type of EVENTS) if (handlers[type]) hook.removeListener(type, handlers[type]);
      return { ok: false, error: 'unavailable' };
    }
  }
  listeners += 1;

  let gone = false;
  return {
    ok: true,
    off() {
      if (gone) return;
      gone = true;
      for (const type of EVENTS) if (handlers[type]) hook.removeListener(type, handlers[type]);
      listeners -= 1;
      if (listeners <= 0 && running) {
        try {
          hook.stop();
        } catch { /* it never started */ }
        running = false;
        listeners = 0;
      }
    },
  };
}

module.exports = { keycodes, subscribe };
