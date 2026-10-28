// macOS Screen Recording permission: is it really granted, and getting
// unstuck when it is switched on and still refused.
//
// The failure this exists for: System Settings shows Harmony ENABLED under
// Screen & System Audio Recording, and macOS keeps refusing (or asking) all the
// same. The switch is the entry's visible half; the other half is the code
// requirement macOS stored when it was created, and an entry made by an
// earlier build -- the first update that changed how the app is signed, for one
// -- no longer matches the app that is running. Nothing in the app can mend a
// stale entry, and toggling it does not either. Resetting the app's entry
// does: macOS then asks afresh, and the new entry is made for this build.
//
// Only macOS has any of this; everywhere else the permission is simply held.

const { execFile } = require('node:child_process');
const { app, shell, systemPreferences } = require('electron');

const IS_MAC = process.platform === 'darwin';

/** The bundle id electron-builder.yml gives the packaged app (appId). */
const BUNDLE_ID = 'com.harmony.client';

/** The pane of System Settings with the list in it. */
const SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

/**
 * 'granted', 'denied', 'not-determined' or 'restricted'. 'granted' off macOS,
 * where nothing asks.
 */
function status() {
  if (!IS_MAC) return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus('screen');
  } catch {
    // An answer we cannot get is not a reason to block somebody.
    return 'granted';
  }
}

function openSettings() {
  if (!IS_MAC) return false;
  shell.openExternal(SETTINGS_URL);
  return true;
}

const tccutil = (client) => new Promise((resolve) => {
  execFile('tccutil', ['reset', 'ScreenCapture', client], (err) => resolve(!err));
});

/**
 * Forget what macOS has stored for Harmony's screen recording, so the next
 * attempt asks again. Harmony's own entry, and the audio helper's in case it
 * was ever listed by itself; nothing of any other application.
 *
 * Only a packaged build: a development Electron is not com.harmony.client, and
 * resetting "com.github.Electron" would be somebody else's permission.
 *
 * @returns {Promise<boolean>} whether the reset went through
 */
async function reset() {
  if (!IS_MAC || !app.isPackaged) return false;
  const ok = await tccutil(BUNDLE_ID);
  await tccutil('harmony-audio-capture');
  return ok;
}

module.exports = { status, openSettings, reset };
