// Which key press means "quit Harmony", with nothing from Electron in it so that it can be tested by feeding it key
// events.
//
// Closing the window only hides it to the tray (voice-tray.js), and the system's own "close" -- the X, or Alt+F4 -- looks
// the same to the app: both arrive as a `close` on the window. Alt+F4 is the one a person uses to say "get rid of this
// program", though, so it is told apart by its key, which the page's `before-input-event` sees before the system acts on
// it, and made to quit.
//
// Windows and Linux only: the key means nothing on macOS, where Cmd+Q is the quit and is the menu's.

/**
 * @param {{type: string, code?: string, key?: string, shift: boolean, alt: boolean, control: boolean, meta: boolean}} input
 *   a webContents `before-input-event` input
 * @param {string} platform process.platform
 */
function quitsApp(input, platform) {
  if (platform === 'darwin') return false;
  if (input.type !== 'keyDown') return false;
  // By the physical key where there is one, and by what it types where there is not.
  if (input.code !== 'F4' && !(input.code === undefined && input.key === 'F4')) return false;
  // Alt and nothing else: Ctrl+F4 closes a tab of something, Alt+Shift+F4 is nobody's.
  return input.alt && !input.control && !input.meta && !input.shift;
}

module.exports = { quitsApp };
