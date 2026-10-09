// `harmony` for the builds that have no main process: the browser and Android.
//
// The desktop app's renderer talks to Electron's main process through the
// object src/renderer/bridge.js builds from the preload. This builds the same
// object -- same names, same arguments, same answers -- out of what a page
// can do on its own, so app.js runs unchanged on top of either. Where the
// desktop has something a page cannot (picking a window to share, global
// hotkeys, the GPU), `capabilities` says so and the UI hides it; the methods
// still exist, and answer "not here", so nothing calls an undefined.
//
// DEFAULTS and VERSION come from build-info.js, which scripts/build-web.js
// generates from src/main/settings.js and package.json -- one source for the
// default settings, not two.

import { DEFAULTS, VERSION } from './build-info.js';
import { api, fetchBytes, normalizeBase } from './api.js';
import { RealtimeClient } from './realtime.js';
import { isNative, native } from './native.js';

const NATIVE = isNative();
const SETTINGS_KEY = 'harmony.settings';
const RELEASES = 'https://api.github.com/repos/PedroLucasMiguel/harmony/releases/latest';
const RELEASES_PAGE = 'https://github.com/PedroLucasMiguel/harmony/releases/latest';

const unsupported = (what) => {
  const error = new Error(`${what} is not available in this version of Harmony.`);
  error.code = 'unsupported';
  return error;
};

// --- settings ----------------------------------------------------------------

// Defaults that differ on a phone: the desktop's 115% is for reading a laptop
// from across a desk, and a phone has its own text-size setting.
const PLATFORM_DEFAULTS = { uiScale: 100 };

let settingsCache = null;

function readSettings() {
  if (settingsCache) return settingsCache;
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') ?? {};
  } catch {
    stored = {};
  }
  settingsCache = { ...DEFAULTS, ...PLATFORM_DEFAULTS, ...stored };
  return settingsCache;
}

function writeSettings(patch) {
  settingsCache = { ...readSettings(), ...(patch ?? {}) };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsCache));
  } catch (err) {
    console.warn('[settings] could not persist:', err.message);
  }
  return settingsCache;
}

// --- media -------------------------------------------------------------------

/*
 * Uploads load straight from the server by media key: GET /api/media/<hash>?k=
 * -- see server/src/media-keys.js. An <img> sends no headers, so the key is
 * what stands in for the door password and the session token. The browser's
 * own HTTP cache does what the desktop's media cache does; the server marks
 * every upload immutable.
 */
let mediaBase = '';
let mediaKey = '';

const mediaUrl = (hash) => {
  if (!mediaBase) return '';
  return mediaKey
    ? `${mediaBase}/api/media/${hash}?k=${encodeURIComponent(mediaKey)}`
    : `${mediaBase}/api/uploads/${hash}`;
};

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function saveMedia(hash, suggestedName) {
  if (!mediaBase) throw new Error('not connected to a server');
  const res = await fetch(mediaUrl(hash));
  if (!res.ok) throw new Error(`The server returned ${res.status} for that file.`);
  const blob = await res.blob();
  const name = String(suggestedName ?? '').trim().replace(/[\\/]/g, '_')
    || `${hash.slice(0, 12)}`;

  if (NATIVE) {
    const saved = await native.saveFile(name, blob.type || 'application/octet-stream', await blobToBase64(blob));
    return saved ? { saved: true, name: saved.name } : { saved: false };
  }
  // A browser: hand it over as a download, which is the browser's own
  // "save as". There is no path to show afterwards.
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return { saved: true, name };
}

// --- server logos ------------------------------------------------------------

/*
 * Kept in the Cache API by hash, so the server list can show a logo at start
 * up before any server has been asked -- what the desktop's logo cache does.
 * The Cache API only exists in a secure context; without it logos are kept
 * for the session only.
 */
const LOGO_CACHE = 'harmony-logos';
const logoUrls = new Map();

const logoKey = (hash) => `https://harmony.invalid/logo/${hash}`;

async function warmLogos() {
  if (!globalThis.caches) return;
  try {
    const cache = await caches.open(LOGO_CACHE);
    for (const request of await cache.keys()) {
      const hash = request.url.split('/').pop();
      const res = await cache.match(request);
      if (res) logoUrls.set(hash, URL.createObjectURL(await res.blob()));
    }
  } catch {
    /* an empty list is fine */
  }
}

async function ensureLogo(server, serverPassword, hash) {
  if (!/^[0-9a-f]{64}$/.test(String(hash))) return null;
  if (logoUrls.has(hash)) return logoUrls.get(hash);
  const blob = await fetchBytes(server, '/api/server/logo', { serverPassword: serverPassword ?? '' });
  try {
    const cache = globalThis.caches ? await caches.open(LOGO_CACHE) : null;
    await cache?.put(logoKey(hash), new Response(blob, { headers: { 'Content-Type': blob.type } }));
  } catch {
    /* kept for this session only */
  }
  const url = URL.createObjectURL(blob);
  logoUrls.set(hash, url);
  return url;
}

// --- realtime ----------------------------------------------------------------

const realtime = new RealtimeClient();

// A phone loses its socket to the screen turning off and to changing
// networks; coming back from either is when to reconnect, not 15 s later.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) realtime.nudge();
});
window.addEventListener('online', () => realtime.nudge());

// --- updates (Android only) ---------------------------------------------------

/*
 * The same status the desktop updater reports (src/main/updater.js), so the
 * same UI draws it. An APK cannot replace itself, so this is the macOS shape:
 * "manual", and the action opens the download in the system browser, where
 * Android's own installer takes it from there.
 */
const updateListeners = new Set();
let updateStatus = { state: NATIVE ? 'idle' : 'unsupported', current: VERSION };

function setUpdate(patch) {
  updateStatus = { current: currentVersion, ...patch };
  for (const fn of updateListeners) fn(updateStatus);
}

function newer(candidate, current) {
  const parts = (v) => String(v).replace(/^v/, '').split(/[.-]/).slice(0, 3).map((n) => Number(n) || 0);
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

async function checkUpdates() {
  if (!NATIVE) {
    setUpdate({ state: 'unsupported', error: 'This version of Harmony is updated by reloading the page.' });
    return updateStatus;
  }
  if (updateStatus.state === 'checking') return updateStatus;
  setUpdate({ state: 'checking' });
  try {
    const res = await fetch(RELEASES, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
    const release = await res.json();
    const version = String(release.tag_name ?? '').replace(/^v/, '');
    const apk = (release.assets ?? []).find((a) => /\.apk$/i.test(a.name));
    if (version && apk && newer(version, currentVersion)) {
      setUpdate({ state: 'available', version, manual: true, url: apk.browser_download_url });
    } else {
      setUpdate({ state: 'latest' });
    }
  } catch (err) {
    setUpdate({ state: 'error', error: err.message });
  }
  return updateStatus;
}

async function openUpdate() {
  await openExternal(updateStatus.url || RELEASES_PAGE);
  return updateStatus;
}

async function openExternal(url) {
  if (NATIVE) await native.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}

// --- start-up ----------------------------------------------------------------

let currentVersion = VERSION;
if (NATIVE) {
  // The APK's own version is the one that matters for updates: it is what
  // Android installed, whatever this copy of the page was built as.
  currentVersion = (await native.info().catch(() => null))?.version ?? VERSION;
  updateStatus = { ...updateStatus, current: currentVersion };
  setTimeout(() => checkUpdates(), 15_000);
  setInterval(() => checkUpdates(), 6 * 60 * 60 * 1000);
}
await warmLogos();

// --- the object ----------------------------------------------------------------

export const harmony = {
  platform: NATIVE ? 'android' : 'web',

  /*
   * What this build can do. The desktop answers true to all of it; here the
   * UI hides whatever is false (see applyCapabilities in app.js).
   */
  capabilities: {
    // Android shares through its own capture (ScreenShare.java); a browser
    // tab here could use getDisplayMedia, but not through the desktop's
    // picker, which is what the share button opens.
    screenShare: NATIVE,
    nativeScreenShare: NATIVE,
    appAudio: false,
    hotkeys: false,
    clips: false,
    gpu: false,
    scale: false,
    updates: NATIVE,
    reveal: false,
  },

  settings: {
    get: async () => readSettings(),
    set: async (patch) => writeSettings(patch),
  },

  gpu: {
    status: async () => { throw unsupported('GPU settings'); },
  },

  relaunch: async () => {
    window.location.reload();
    return true;
  },
  // Chromium's page zoom is a desktop thing; a phone has its own text size.
  setScale: async () => 100,

  logos: {
    ensure: (server, serverPassword, hash) => ensureLogo(server, serverPassword, hash),
  },
  logoUrl: (hash) => logoUrls.get(hash) ?? '',
  version: async () => currentVersion,

  updates: {
    get: async () => updateStatus,
    check: () => checkUpdates(),
    download: () => openUpdate(),
    install: async () => false,
    open: () => openUpdate(),
    onStatus(handler) {
      updateListeners.add(handler);
      return () => updateListeners.delete(handler);
    },
  },

  hotkeys: {
    set: async (bindings) =>
      (bindings ?? []).map((b) => ({ id: b.id, ok: false, error: 'unsupported' })),
    onFired: () => () => {},
  },

  onWindowVisibility(handler) {
    const listener = () => handler(!document.hidden);
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },

  sources: {
    list: async () => [],
    processes: async () => [],
    select: async () => false,
    clear: async () => true,
  },

  audio: {
    availability: async () => ({
      available: false,
      reason: 'Sharing an application\'s sound needs the desktop app.',
    }),
    start: async () => { throw unsupported('Application audio'); },
    stop: async () => true,
    onPcm: () => () => {},
  },

  clips: {
    save: async () => { throw unsupported('Saving clips'); },
    reveal: async () => true,
  },

  api,

  media: {
    async setServer(server) {
      mediaBase = server ? normalizeBase(server) : '';
      mediaKey = '';
      if (!mediaBase) return true;
      try {
        mediaKey = (await api.mediaKey(server))?.key ?? '';
      } catch {
        // An older server has no media keys: pictures will not load, but
        // nothing else depends on them.
        mediaKey = '';
      }
      return true;
    },
    keep: async () => true,
    stats: async () => null,
    upload: (server, bytes, contentType) => api.uploadFile(server, bytes, contentType),
    save: (hash, suggestedName) => saveMedia(hash, suggestedName),
    reveal: async () => true,
  },

  mediaUrl,

  realtime: {
    connect: (server, token) => realtime.connect(server, token),
    request: (type, payload) => realtime.request(type, payload),
    disconnect: async () => {
      realtime.disconnect();
      return true;
    },
    onEvent: (handler) => realtime.on('event', handler),
  },

  /**
   * Android only: publishing the screen natively. `onEnded` fires when it
   * stops without being asked -- the system's own "stop", or a failure.
   */
  screenShare: {
    start: (options) => native.startScreenShare(options),
    stop: () => native.stopScreenShare().catch(() => null),
    onEnded(handler) {
      const listener = (event) => handler(event.reason ?? 'stopped');
      window.addEventListener('harmonyscreenshare', listener);
      return () => window.removeEventListener('harmonyscreenshare', listener);
    },
  },

  /** Android only: the voice call's foreground service. No-ops elsewhere. */
  voiceService: {
    start: (title, text) => native.startVoice(title, text).catch(() => null),
    stop: () => native.stopVoice().catch(() => null),
  },

  openExternal,

  /** Android's back button with nothing left to close. Absent elsewhere. */
  ...(NATIVE ? { moveToBack: () => native.moveToBack().catch(() => null) } : {}),
};
