// Push to talk's key matching, with nothing from Electron in it so that it can
// be tested by feeding it key events.
//
// A binding is an Electron accelerator as the hotkey recorder writes it --
// "Ctrl+Shift+V", "F13", "Space" -- and the events are the global key hook's:
// a numeric keycode and four modifier flags. The two vocabularies meet here.

/** Recorder key names that are not simply the hook's, mapped to the hook's. */
const NAMED = {
  Space: 'Space', Tab: 'Tab', Enter: 'Enter', Backspace: 'Backspace', Delete: 'Delete',
  Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight',
  Scrolllock: 'ScrollLock', PrintScreen: 'PrintScreen', Capslock: 'CapsLock',
  '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash',
  ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', '`': 'Backquote',
  numadd: 'NumpadAdd', numsub: 'NumpadSubtract', nummult: 'NumpadMultiply',
  numdiv: 'NumpadDivide', numdec: 'NumpadDecimal', numenter: 'NumpadEnter', Numlock: 'NumLock',
};

/**
 * What a numpad key says when Num Lock is off: the same key, reported as the
 * navigation key printed on it. A binding on "Num 7" is the one key either way.
 */
const NUMLOCK_OFF = {
  Numpad0: 'NumpadInsert', Numpad1: 'NumpadEnd', Numpad2: 'NumpadArrowDown', Numpad3: 'NumpadPageDown',
  Numpad4: 'NumpadArrowLeft', Numpad6: 'NumpadArrowRight', Numpad7: 'NumpadHome',
  Numpad8: 'NumpadArrowUp', Numpad9: 'NumpadPageUp', NumpadDecimal: 'NumpadDelete',
};

/** The extra buttons of a mouse, as the recorder writes them: "Mouse4" is the fourth (back), "Mouse5" the fifth. */
const MOUSE_BUTTON = /^Mouse(\d+)$/;

/** The hook's name for a recorder key, or null if there is none (media keys). */
function hookKeyName(key) {
  if (/^[A-Z]$/.test(key) || /^\d$/.test(key) || /^F([1-9]|1\d|2[0-4])$/.test(key)) return key;
  const numpad = /^num(\d)$/.exec(key);
  if (numpad) return `Numpad${numpad[1]}`;
  return NAMED[key] ?? null;
}

const MODIFIERS = {
  ctrl: 'ctrl', control: 'ctrl',
  alt: 'alt', option: 'alt',
  shift: 'shift',
  command: 'meta', cmd: 'meta', super: 'meta', meta: 'meta', win: 'meta',
};

/**
 * @param {string} accelerator
 * @param {Record<string, number>} keycodes the hook's UiohookKey table
 * @returns {{codes: number[], aliases: number[], button: number|null, ctrl: boolean, alt: boolean, shift: boolean, meta: boolean} | null}
 *   `aliases` are the codes the same key sends with Num Lock off; `button` is set for a mouse button, and then there are no codes
 */
function parse(accelerator, keycodes) {
  const parts = String(accelerator ?? '').split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const key = parts.pop();
  const binding = { codes: [], aliases: [], button: null, ctrl: false, alt: false, shift: false, meta: false };
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (!modifier) return null;
    binding[modifier] = true;
  }
  const mouse = MOUSE_BUTTON.exec(key);
  if (mouse) {
    // The left and right buttons are the ones every click uses: never a binding.
    const button = Number(mouse[1]);
    if (button < 3) return null;
    binding.button = button;
    return binding;
  }
  const name = hookKeyName(key);
  if (!name || keycodes[name] === undefined) return null;
  binding.codes.push(keycodes[name]);
  const off = NUMLOCK_OFF[name];
  if (off && typeof keycodes[off] === 'number') {
    binding.aliases.push(keycodes[off]);
    binding.codes.push(keycodes[off]);
  }
  // The recorder does not tell Enter from the numpad's, so either is it.
  if (name === 'Enter' && typeof keycodes.NumpadEnter === 'number') binding.codes.push(keycodes.NumpadEnter);
  return binding;
}

const modifiersMatch = (binding, e) =>
  Boolean(e.ctrlKey) === binding.ctrl
  && Boolean(e.altKey) === binding.alt
  && Boolean(e.shiftKey) === binding.shift
  && Boolean(e.metaKey) === binding.meta;

/**
 * Turns key events into "held" / "not held".
 *
 * EXACT modifiers: with Ctrl+V bound, Ctrl+Shift+V is not it, and a bare V
 * binding does not fire for Ctrl+V -- the keys somebody uses for something
 * else must not open their microphone. Pressing is only reported once, however
 * long the key repeats; releasing is the key coming up OR a required modifier
 * letting go first, which is how people actually let go of a combination.
 *
 * @param {ReturnType<typeof parse>} binding
 * @param {(held: boolean) => void} onChange
 */
function createMatcher(binding, onChange) {
  let held = false;
  return {
    get held() {
      return held;
    },
    keydown(e) {
      if (held || !binding.codes.includes(e.keycode) || !modifiersMatch(binding, e)) return;
      held = true;
      onChange(true);
    },
    keyup(e) {
      if (!held) return;
      if (binding.codes.includes(e.keycode) || !modifiersMatch(binding, e)) {
        held = false;
        onChange(false);
      }
    },
    mousedown(e) {
      if (held || binding.button === null || e.button !== binding.button || !modifiersMatch(binding, e)) return;
      held = true;
      onChange(true);
    },
    mouseup(e) {
      if (!held || binding.button === null) return;
      if (e.button === binding.button || !modifiersMatch(binding, e)) {
        held = false;
        onChange(false);
      }
    },
    /** Hook stopped or binding replaced: nothing is held any more. */
    reset() {
      if (!held) return;
      held = false;
      onChange(false);
    },
  };
}

module.exports = { parse, createMatcher, hookKeyName };
