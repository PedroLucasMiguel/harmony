// The Android app's own plugin, when there is one.
//
// Capacitor injects `window.Capacitor` into the WebView, and with it a
// nativePromise() that calls a plugin method by name -- so this needs neither
// @capacitor/core nor a bundler. In a plain browser there is no Capacitor and
// every call here is a quiet no-op.
//
// The plugin is HarmonyNativePlugin.java in client/android. It does what a
// page cannot: keep a voice call alive with the screen off, open a link in
// the system browser, and save a file to Downloads.

const PLUGIN = 'HarmonyNative';

const cap = () => window.Capacitor;

/** Running inside the Android app, with its plugin loaded. */
export const isNative = () =>
  Boolean(cap()?.isNativePlatform?.() && cap()?.isPluginAvailable?.(PLUGIN));

export function call(method, options = {}) {
  if (!isNative()) return Promise.resolve(null);
  return cap().nativePromise(PLUGIN, method, options);
}

export const native = {
  /** Keep the process, microphone, Wi-Fi and audio alive while in a call. */
  startVoice: (title, text) => call('startVoice', { title, text }),
  stopVoice: () => call('stopVoice'),
  openExternal: (url) => call('openExternal', { url }),
  /** @returns {Promise<{ name: string, uri: string } | null>} */
  saveFile: (name, mimeType, base64) => call('saveFile', { name, mimeType, data: base64 }),
  /** @returns {Promise<{ version: string, build: number } | null>} */
  info: () => call('getInfo'),
  /** Back to the home screen, the app still running -- a call with it. */
  moveToBack: () => call('moveToBack'),
  /**
   * Share the screen into a channel: Android's own prompt, then a native
   * WebRTC publish to `url` (ScreenShare.java). Rejects with code
   * 'cancelled' if the prompt is refused.
   */
  startScreenShare: (options) => call('startScreenShare', options),
  stopScreenShare: () => call('stopScreenShare'),
};
