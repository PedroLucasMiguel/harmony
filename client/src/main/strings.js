// The few words the main process puts on screen itself: the tray menu, the
// taskbar thumbnail's tooltips, the first-close notice and the save dialog.
//
// The renderer owns the translations (renderer/locales); it sends this table
// whatever language is in use, on start-up and whenever the language changes
// (`strings:set`), and every key starting "main." in en.js is one of these.
// The English here is only what shows in the moment before that first call.

const DEFAULTS = {
  'main.open': 'Open Harmony',
  'main.mute': 'Mute',
  'main.unmute': 'Unmute',
  'main.deafen': 'Deafen',
  'main.undeafen': 'Undeafen',
  'main.disconnect': 'Disconnect',
  'main.quit': 'Quit Harmony',
  'main.muted': 'muted',
  'main.deafened': 'deafened',
  'main.still_running': 'Harmony is still running',
  'main.still_running_balloon': 'It keeps going down here, calls included. Right-click this icon to quit.',
  'main.still_running_notice': 'It keeps going in the tray, calls included. Right-click the icon to quit.',
  'main.save_attachment': 'Save attachment',
};

let current = { ...DEFAULTS };
const listeners = new Set();

/** The text for a key: the language in use, else English, else the key. */
const get = (key) => current[key] ?? DEFAULTS[key] ?? key;

/** Replace the table. Anything the renderer leaves out stays English. */
function set(table) {
  const next = { ...DEFAULTS };
  for (const [key, value] of Object.entries(table ?? {})) {
    if (key in DEFAULTS && typeof value === 'string' && value) next[key] = value;
  }
  current = next;
  for (const listener of listeners) listener();
  return true;
}

/** Called after the table changes, so a menu built from it can be built again. */
const onChange = (listener) => listeners.add(listener);

module.exports = { get, set, onChange, DEFAULTS };
