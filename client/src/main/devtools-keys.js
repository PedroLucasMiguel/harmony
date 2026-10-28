// Which key presses open the developer tools, with nothing from Electron in it
// so that it can be tested by feeding it key events.
//
// The tools used to open through Electron's default menu, whose accelerator
// matches the CHARACTER a key produces. That is why Ctrl+Shift+I did nothing for
// some people: a layout that puts something else on the I key, an input method
// holding the combination, another program having claimed it. These match the
// PHYSICAL key instead (`code`), which is the same on every layout, and add a
// second combination for when the first is taken.
//
//   Ctrl+Shift+I    Cmd+Shift+I  on macOS
//   Ctrl+Alt+I      Cmd+Alt+I    on macOS (Cmd+Option+I, the usual one there)
//
// F12 is left alone on purpose: it is a key people bind for push to talk and
// the camera, and the window must keep receiving it when they press it.

/**
 * @param {{type: string, code: string, shift: boolean, alt: boolean, control: boolean, meta: boolean, isAutoRepeat?: boolean}} input
 *   a webContents `before-input-event` input
 * @param {string} platform process.platform
 */
function opensDevTools(input, platform) {
  if (input.type !== 'keyDown' || input.isAutoRepeat || input.code !== 'KeyI') return false;
  const mac = platform === 'darwin';
  // Exactly the primary modifier: AltGr arrives as Ctrl+Alt, and Ctrl+Cmd is
  // somebody else's shortcut.
  if (mac ? !input.meta || input.control : !input.control || input.meta) return false;
  return input.shift !== input.alt;
}

module.exports = { opensDevTools };
