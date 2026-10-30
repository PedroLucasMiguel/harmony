// Global hotkeys: mute, deafen, soundpad clips.
//
// GLOBAL, through Electron's globalShortcut, because the moment somebody
// wants a mute key is the moment Harmony does not have focus -- they are in
// the game. A key handled in the renderer would only work while they were
// looking at Harmony, which is when they need it least.
//
// The cost of global is that a registered combination is taken from every
// other application while Harmony runs: Windows delivers it to us and to
// nobody else. That is why the renderer refuses a plain letter without a
// modifier (it would stop that letter being typed anywhere), and why a
// combination another program already owns is reported back rather than
// silently doing nothing -- RegisterHotKey fails for it, and the person
// needs to know to pick another.
//
// The renderer owns WHAT is bound; this module only holds the registrations.
// set() replaces the whole set every time, so there is no add/remove
// bookkeeping to drift out of step with the settings file.

const { globalShortcut } = require('electron');

const { parse, createMatcher } = require('./ptt-match');
const keyHook = require('./key-hook');

/*
 * What a global shortcut cannot take goes through the key hook instead (key-hook.js):
 * the mouse's extra buttons, the numpad's own Enter, and the numpad with Num Lock off
 * (the same key, reported as the navigation key printed on it). The hook only
 * listens, so these keys keep doing what they did for every other program.
 */
const HOOK_ONLY = /^(Mouse\d+|numenter)$/;
const NUMPAD = /^num(\d|dec|add|sub|mult|div)$/;

/** @type {(id: string) => void} */
let fire = () => {};

/** What is registered right now, for unregistering exactly that. */
let active = [];
/** The hook's listener, while any binding needs it. */
let hooked = null;

function onFire(handler) {
  fire = handler;
}

/**
 * Replace every registration.
 *
 * @param {{id: string, accelerator: string}[]} bindings
 * @returns {{id: string, accelerator: string, ok: boolean, error?: string}[]}
 */
function set(bindings) {
  clear();
  const seen = new Set();
  /** @type {{id: string, accel: string, only: boolean}[]} */
  const wantsHook = [];
  const results = (Array.isArray(bindings) ? bindings : []).map(({ id, accelerator }) => {
    const accel = String(accelerator ?? '').trim();
    if (!id || !accel) return { id, accelerator: accel, ok: false, error: 'empty' };
    // The same combination twice would register once and quietly drop the
    // second; say so instead.
    if (seen.has(accel.toLowerCase())) return { id, accelerator: accel, ok: false, error: 'duplicate' };
    seen.add(accel.toLowerCase());

    const key = accel.split('+').pop();
    if (HOOK_ONLY.test(key)) {
      // Decided once the hook is up: nothing else can take it.
      wantsHook.push({ id, accel, only: true });
      return { id, accelerator: accel, ok: false, error: 'hook' };
    }
    try {
      const ok = globalShortcut.register(accel, () => fire(id));
      if (!ok) return { id, accelerator: accel, ok: false, error: 'in_use' };
      active.push(accel);
      // The same key with Num Lock off is another key to a global shortcut.
      if (NUMPAD.test(key)) wantsHook.push({ id, accel, only: false });
      return { id, accelerator: accel, ok: true };
    } catch {
      // An accelerator Electron cannot parse throws rather than returning
      // false. The renderer builds them, so this is a bug if it happens.
      return { id, accelerator: accel, ok: false, error: 'invalid' };
    }
  });

  if (wantsHook.length) listenWithHook(wantsHook, results);
  return results;
}

/**
 * Put the hook behind the bindings that need it. A binding only the hook can take
 * is reported as it turns out; one that was already registered as a shortcut (a
 * numpad key) only gains its Num-Lock-off twin, and a missing hook is no
 * loss to it -- so it never prompts for a permission, and says nothing.
 */
function listenWithHook(wantsHook, results) {
  const { keys } = keyHook.keycodes();
  const needed = wantsHook.some((w) => w.only);
  const matchers = [];
  for (const { id, accel, only } of wantsHook) {
    const binding = keys ? parse(accel, keys) : null;
    const result = results.find((r) => r.id === id);
    if (!binding) {
      if (only && result) result.error = keys ? 'invalid' : 'hook';
      continue;
    }
    // Registered already: only the codes a shortcut does not see.
    if (!only) {
      if (!binding.aliases.length) continue;
      binding.codes = binding.aliases;
    }
    matchers.push({ id, only, matcher: createMatcher(binding, (held) => { if (held) fire(id); }) });
  }
  if (!matchers.length) return;

  const heard = keyHook.subscribe({
    keydown: (e) => matchers.forEach((m) => m.matcher.keydown(e)),
    keyup: (e) => matchers.forEach((m) => m.matcher.keyup(e)),
    mousedown: (e) => matchers.forEach((m) => m.matcher.mousedown(e)),
    mouseup: (e) => matchers.forEach((m) => m.matcher.mouseup(e)),
  }, { prompt: needed });
  for (const m of matchers) {
    if (!m.only) continue;
    const result = results.find((r) => r.id === m.id);
    if (!result) continue;
    if (heard.ok) {
      result.ok = true;
      delete result.error;
    } else {
      result.error = heard.error === 'permission' ? 'permission' : 'hook';
    }
  }
  if (heard.ok) hooked = heard;
}

function clear() {
  hooked?.off();
  hooked = null;
  for (const accel of active) {
    try {
      globalShortcut.unregister(accel);
    } catch { /* already gone */ }
  }
  active = [];
}

module.exports = { set, clear, onFire };
