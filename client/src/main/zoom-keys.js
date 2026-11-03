// Which key presses change the size of the interface, fed key events directly (no Electron in it, so it can be tested).
//
// Ctrl+- made the interface smaller (Electron's default menu has it), but Ctrl++ did nothing for many people: the menu's
// accelerator wants the character "+", which on most layouts is Shift and another key, and a layout that puts it
// elsewhere never produces it. These match the key by what it is on the keyboard (`code`) as well as by the character it
// gives, so Ctrl+= (the + key without Shift), Ctrl+Shift+= (what is usually called Ctrl++), the numpad's + and - and a
// layout with + of its own all work, and Ctrl+0 puts the size back.
//
//   Ctrl (Cmd on macOS) with + / = / numpad +   -> bigger
//   Ctrl (Cmd on macOS) with - / numpad -       -> smaller
//   Ctrl (Cmd on macOS) with 0 / numpad 0       -> the usual size

const BIGGER = new Set(['Equal', 'NumpadAdd']);
const SMALLER = new Set(['Minus', 'NumpadSubtract']);
const RESET = new Set(['Digit0', 'Numpad0']);

/**
 * @param {{type: string, key?: string, code: string, shift: boolean, alt: boolean, control: boolean, meta: boolean}} input
 *   a webContents `before-input-event` input
 * @param {string} platform process.platform
 * @returns {'bigger'|'smaller'|'reset'|null}
 */
function zoomKey(input, platform) {
  if (input.type !== 'keyDown') return null;
  const mac = platform === 'darwin';
  // Exactly the primary modifier. AltGr arrives as Ctrl+Alt on Windows, and it types characters instead.
  if (mac ? !input.meta || input.control : !input.control || input.meta) return null;
  if (input.alt) return null;
  const key = input.key ?? '';
  if (BIGGER.has(input.code) || key === '+' || key === '=') return 'bigger';
  if (SMALLER.has(input.code) || key === '-' || key === '_') return 'smaller';
  if (RESET.has(input.code)) return 'reset';
  return null;
}

module.exports = { zoomKey };
